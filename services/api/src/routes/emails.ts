import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { RouteContext } from "../app.js";
import { listTasks, statusWhere, type TaskDto, toDto } from "../db/tasks.js";
import { addDays, localDate } from "../lib/time.js";

const EmailsQuery = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export interface EmailDto {
  id: string;
  thread_id: string;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  received_at: string;
  /** calendar date the email arrived, in the user's timezone */
  local_date: string;
  status: string;
  skip_reason: string | null;
  gmail_url: string;
  tasks: TaskDto[];
}

export const emailRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    /**
     * Mail received in the N full days before today (default 7, in the user's timezone; today's
     * mail belongs to the Upcoming view) and what InboxPilot did with each one: the tasks it
     * produced (any status), or why it was skipped. Metadata only: bodies are never stored.
     */
    app.get("/api/emails", async (req) => {
      const user = await ctx.currentUser(req);
      const q = EmailsQuery.parse(req.query);
      const now = new Date();
      const today = localDate(user.timezone, now);
      const from = addDays(today, -q.days); // inclusive; today itself is excluded
      // a time window a day wider on each side, then the exact local-date filter
      const candidates = await ctx.prisma.email.findMany({
        where: {
          userId: user.id,
          receivedAt: {
            gte: new Date(now.getTime() - (q.days + 2) * 86_400_000),
            lt: now,
          },
        },
        orderBy: { receivedAt: "desc" },
      });
      const emails = candidates
        .map((e) => ({ ...e, localDate: localDate(user.timezone, e.receivedAt) }))
        .filter((e) => e.localDate >= from && e.localDate < today)
        .slice(0, q.limit);
      const rows = await listTasks(
        ctx.prisma,
        user.id,
        { AND: [statusWhere("all", now), { emailId: { in: emails.map((e) => e.id) } }] },
        { offset: 0, limit: 2000 },
      );
      const byEmail = new Map<string, TaskDto[]>();
      for (const row of rows) {
        const list = byEmail.get(row.emailId) ?? [];
        list.push(toDto(row, today));
        byEmail.set(row.emailId, list);
      }
      const items: EmailDto[] = emails.map((e) => ({
        id: e.gmailId,
        thread_id: e.threadId,
        from_name: e.fromName,
        from_email: e.fromEmail,
        subject: e.subject,
        received_at: e.receivedAt.toISOString(),
        local_date: e.localDate,
        status: e.status,
        skip_reason: e.skipReason,
        gmail_url: `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(e.threadId)}`,
        tasks: (byEmail.get(e.id) ?? []).sort((a, b) => b.priority_score - a.priority_score),
      }));
      return { items, days: q.days, from, today, timezone: user.timezone };
    });
  };
