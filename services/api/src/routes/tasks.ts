import type { Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { RouteContext } from "../app.js";
import { getTask, listTasks, rangeWhere, statusWhere, toDto } from "../db/tasks.js";
import { HttpProblem, notFound } from "../lib/problem.js";
import { localDate, toDbDate } from "../lib/time.js";

const TASK_TYPES = [
  "deadline",
  "meeting",
  "payment",
  "review",
  "reply",
  "send",
  "call",
  "follow_up",
  "other",
] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SCAN = 2000; // open tasks per user are far fewer; this bounds the in-memory pass

const TasksQuery = z.object({
  range: z.enum(["today", "week", "overdue", "later", "undated", "review", "all"]).default("all"),
  status: z.enum(["open", "done", "dismissed", "snoozed", "closed", "all"]).default("open"),
  type: z.enum(TASK_TYPES).optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

const TaskParams = z.object({ id: z.string().regex(/^t_[0-9a-f]{40}$/, "invalid task id") });

const PatchBody = z
  .object({
    status: z.enum(["open", "done", "dismissed"]).optional(),
    snoozed_until: z.string().datetime({ offset: true }).optional(),
    due_date: z.string().regex(ISO_DATE).nullable().optional(),
    due_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "nothing to update")
  .refine((b) => !(b.status && b.snoozed_until), "use either status or snoozed_until");

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const { o } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as { o?: unknown };
    if (typeof o === "number" && Number.isInteger(o) && o >= 0) return o;
  } catch {
    /* fall through */
  }
  throw new HttpProblem(400, "Invalid request", "Invalid cursor");
}

const encodeCursor = (offset: number) =>
  Buffer.from(JSON.stringify({ o: offset })).toString("base64url");

export const taskRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    /** Buckets are computed now, in the user's timezone, so "Today" is right tomorrow too. */
    app.get("/api/tasks", async (req) => {
      const user = await ctx.currentUser(req);
      const q = TasksQuery.parse(req.query);
      const now = new Date();
      const today = localDate(user.timezone, now);
      const where: Prisma.TaskWhereInput = {
        AND: [
          statusWhere(q.status, now),
          rangeWhere(q.range, today),
          q.type ? { type: q.type } : {},
        ],
      };
      // Priority is re-scored for today on read (SPEC Q11), so priority filtering and the
      // within-day order happen after re-scoring, in memory (bounded per user).
      const offset = decodeCursor(q.cursor);
      const rows = await listTasks(ctx.prisma, user.id, where, { offset: 0, limit: MAX_SCAN });
      const all = rows
        .map((r) => toDto(r, today))
        .filter((t) => !q.priority || t.priority === q.priority)
        .sort(
          (a, b) =>
            (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") ||
            b.priority_score - a.priority_score ||
            (a.due_at ?? "").localeCompare(b.due_at ?? "") ||
            a.id.localeCompare(b.id),
        );
      const more = all.length > offset + q.limit;
      return {
        items: all.slice(offset, offset + q.limit),
        next_cursor: more ? encodeCursor(offset + q.limit) : null,
        today,
        timezone: user.timezone,
      };
    });

    app.get("/api/tasks/:id", async (req) => {
      const user = await ctx.currentUser(req);
      const { id } = TaskParams.parse(req.params);
      const row = await getTask(ctx.prisma, user.id, id);
      if (!row) throw notFound("Task");
      return toDto(row, localDate(user.timezone));
    });

    /** Done / snooze / dismiss / edit due date. Re-sync never overwrites any of these. */
    app.patch("/api/tasks/:id", async (req) => {
      const user = await ctx.currentUser(req);
      const { id } = TaskParams.parse(req.params);
      const body = PatchBody.parse(req.body);
      const now = new Date();

      const data: Prisma.TaskUpdateManyMutationInput = {};
      if (body.status) Object.assign(data, { status: body.status, snoozedUntil: null });
      if (body.snoozed_until) {
        const until = new Date(body.snoozed_until);
        if (until <= now)
          throw new HttpProblem(400, "Invalid request", "snoozed_until must be in the future");
        Object.assign(data, { status: "snoozed", snoozedUntil: until });
      }
      if (body.due_date !== undefined || body.due_at !== undefined) {
        const dueAt = body.due_at ? new Date(body.due_at) : null;
        const dueDate = body.due_date ?? (dueAt ? localDate(user.timezone, dueAt) : null);
        Object.assign(data, {
          dueDate: dueDate ? toDbDate(dueDate) : null,
          dueAt,
          hasTime: dueAt !== null,
          dateSource: "user",
          dueOverridden: true,
        });
      }

      const updated = await ctx.prisma.task.updateMany({
        where: { userId: user.id, id },
        data,
      });
      if (!updated.count) throw notFound("Task");
      await ctx.briefing.invalidate(user, now);
      const row = await getTask(ctx.prisma, user.id, id);
      if (!row) throw notFound("Task");
      return toDto(row, localDate(user.timezone, now));
    });
  };
