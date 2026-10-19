import { Prisma, type PrismaClient } from "@prisma/client";

import type { AgentTask, DateSource, Priority, TaskType } from "../agent/types.js";
import { rescore } from "../lib/priority.js";
import {
  addDays,
  bucketFor,
  type Bucket,
  dateOnly,
  LOW_CONFIDENCE,
  toDbDate,
} from "../lib/time.js";

export type TaskStatus = "open" | "done" | "snoozed" | "dismissed";

const taskWithEmail = Prisma.validator<Prisma.TaskDefaultArgs>()({
  include: {
    email: {
      select: {
        gmailId: true,
        threadId: true,
        fromName: true,
        fromEmail: true,
        subject: true,
        receivedAt: true,
      },
    },
  },
});
export type TaskRow = Prisma.TaskGetPayload<typeof taskWithEmail>;

/** What GET /api/tasks returns: the contract Task (with a read-time bucket) plus user state. */
export interface TaskDto extends AgentTask {
  status: TaskStatus;
  snoozed_until: string | null;
  gmail_url: string;
  updated_at: string;
}

export function toAgentTask(row: TaskRow, today: string): AgentTask {
  const due = dateOnly(row.dueDate);
  // urgency moves every day: re-score from the stored date-independent base (SPEC Q11)
  const scored = rescore(
    {
      score: row.priorityScore,
      priority: row.priority as Priority,
      reasons: row.priorityReasons as string[],
      base: row.priorityBase,
    },
    due,
    row.confidence,
    today,
  );
  return {
    id: row.id,
    email_id: row.email.gmailId,
    title: row.title,
    details: row.details,
    type: row.type as TaskType,
    due_phrase: row.duePhrase,
    due_date: due,
    due_at: row.dueAt ? row.dueAt.toISOString() : null,
    has_time: row.hasTime,
    date_source: row.dateSource as DateSource,
    priority: scored.priority,
    priority_score: scored.score,
    priority_base: row.priorityBase,
    priority_reasons: scored.reasons,
    confidence: row.confidence,
    evidence: row.evidence,
    bucket: bucketFor(due, row.confidence, today),
    source: {
      from_name: row.email.fromName,
      from_email: row.email.fromEmail ?? "",
      subject: row.email.subject ?? "",
      received_at: row.email.receivedAt.toISOString(),
      thread_id: row.email.threadId,
    },
    extracted_by: row.extractedBy,
  };
}

export function toDto(row: TaskRow, today: string): TaskDto {
  return {
    ...toAgentTask(row, today),
    status: row.status as TaskStatus,
    snoozed_until: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
    gmail_url: `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(row.email.threadId)}`,
    updated_at: row.updatedAt.toISOString(),
  };
}

export type Range = "today" | "week" | "overdue" | "later" | "undated" | "review" | "all";
export type StatusFilter = "open" | "done" | "dismissed" | "snoozed" | "closed" | "all";

/** "Open" includes snoozed tasks whose snooze has expired. */
export function statusWhere(status: StatusFilter, now: Date): Prisma.TaskWhereInput {
  switch (status) {
    case "all":
      return {};
    case "open":
      return { OR: [{ status: "open" }, { status: "snoozed", snoozedUntil: { lte: now } }] };
    case "snoozed":
      return { status: "snoozed", snoozedUntil: { gt: now } };
    case "closed": // everything the user took off the list and can put back (Reopen)
      return {
        OR: [
          { status: { in: ["done", "dismissed"] } },
          { status: "snoozed", snoozedUntil: { gt: now } },
        ],
      };
    default:
      return { status };
  }
}

/** Range filter in SQL, using the same bucket rules as lib/time.ts bucketFor(). */
export function rangeWhere(range: Range, today: string): Prisma.TaskWhereInput {
  const confident = { confidence: { gte: LOW_CONFIDENCE } };
  const t = toDbDate(today);
  switch (range) {
    case "today":
      return { ...confident, dueDate: t };
    case "week":
      return { ...confident, dueDate: { gt: t, lte: toDbDate(addDays(today, 7)) } };
    case "overdue":
      return { ...confident, dueDate: { lt: t } };
    case "later":
      return { ...confident, dueDate: { gt: toDbDate(addDays(today, 7)) } };
    case "undated":
      return { ...confident, dueDate: null };
    case "review":
      return { confidence: { lt: LOW_CONFIDENCE } };
    case "all":
      return {};
  }
}

export async function listTasks(
  prisma: PrismaClient,
  userId: string,
  where: Prisma.TaskWhereInput,
  page: { offset: number; limit: number },
): Promise<TaskRow[]> {
  return prisma.task.findMany({
    ...taskWithEmail,
    where: { userId, ...where },
    orderBy: [
      { dueDate: { sort: "asc", nulls: "last" } },
      { priorityScore: "desc" },
      { dueAt: { sort: "asc", nulls: "last" } },
      { id: "asc" },
    ],
    skip: page.offset,
    take: page.limit,
  });
}

export async function getTask(
  prisma: PrismaClient,
  userId: string,
  id: string,
): Promise<TaskRow | null> {
  return prisma.task.findUnique({ ...taskWithEmail, where: { userId_id: { userId, id } } });
}

export async function openTasks(
  prisma: PrismaClient,
  userId: string,
  now: Date,
  limit = 500,
): Promise<TaskRow[]> {
  return listTasks(prisma, userId, statusWhere("open", now), { offset: 0, limit });
}

export function countBuckets(rows: TaskRow[], today: string): Record<Bucket, number> {
  const counts: Record<Bucket, number> = {
    overdue: 0,
    today: 0,
    week: 0,
    later: 0,
    undated: 0,
    needs_review: 0,
  };
  for (const r of rows) counts[bucketFor(dateOnly(r.dueDate), r.confidence, today)] += 1;
  return counts;
}

const isRulesTask = (extractedBy: string) => extractedBy.startsWith("heuristic");

/**
 * A re-read that fell back to the rules reader must not add tasks beside the ones a real model
 * already found for the same email (their ids differ, so they would show up twice). Returns the
 * tasks to write.
 */
export async function withoutRulesDuplicates(
  prisma: PrismaClient,
  userId: string,
  tasks: AgentTask[],
  emailRowIds: Map<string, string>,
): Promise<AgentTask[]> {
  const rules = tasks.filter((t) => isRulesTask(t.extracted_by));
  if (!rules.length) return tasks;
  const ids = [...new Set(rules.flatMap((t) => emailRowIds.get(t.email_id) ?? []))];
  const existing = await prisma.task.findMany({
    where: { userId, emailId: { in: ids }, NOT: { extractedBy: { startsWith: "heuristic" } } },
    select: { emailId: true },
  });
  const covered = new Set(existing.map((r) => r.emailId));
  return tasks.filter(
    (t) => !isRulesTask(t.extracted_by) || !covered.has(emailRowIds.get(t.email_id) ?? ""),
  );
}

/**
 * After a real model has read these emails: remove their older rules-reader tasks that the user
 * has not touched (still open, date not edited) and that the model did not find again.
 */
export async function pruneRulesTasks(
  prisma: PrismaClient,
  userId: string,
  emailRowIds: string[],
  keepIds: string[],
): Promise<number> {
  if (!emailRowIds.length) return 0;
  const res = await prisma.task.deleteMany({
    where: {
      userId,
      emailId: { in: emailRowIds },
      status: "open",
      dueOverridden: false,
      extractedBy: { startsWith: "heuristic" },
      id: { notIn: keepIds },
    },
  });
  return res.count;
}

/**
 * Insert or refresh tasks from an agent run. The user's state is NEVER touched:
 * status and snooze are not in the UPDATE set, and a due date the user edited
 * (due_overridden) is kept. Re-syncing therefore never duplicates or reopens a task.
 */
export async function upsertTasks(
  prisma: PrismaClient,
  userId: string,
  tasks: AgentTask[],
  emailRowIds: Map<string, string>,
): Promise<number> {
  let written = 0;
  for (const t of tasks) {
    const emailId = emailRowIds.get(t.email_id);
    if (!emailId) continue;
    written += await prisma.$executeRaw`
      INSERT INTO "tasks" (
        "id", "user_id", "email_id", "title", "details", "type", "due_date", "due_at", "has_time",
        "due_phrase", "date_source", "priority", "priority_score", "priority_base", "priority_reasons",
        "confidence", "evidence", "extracted_by", "status", "updated_at"
      ) VALUES (
        ${t.id}, ${userId}::uuid, ${emailId}::uuid, ${t.title}, ${t.details ?? null}, ${t.type},
        ${t.due_date}::date, ${t.due_at}::timestamptz, ${t.has_time}, ${t.due_phrase},
        ${t.date_source}, ${t.priority}, ${t.priority_score}, ${t.priority_base ?? null}::smallint,
        ${JSON.stringify(t.priority_reasons)}::jsonb,
        ${t.confidence}, ${t.evidence}, ${t.extracted_by}, 'open', now()
      )
      ON CONFLICT ("user_id", "id") DO UPDATE SET
        "email_id" = EXCLUDED."email_id",
        "title" = EXCLUDED."title",
        "details" = EXCLUDED."details",
        "type" = EXCLUDED."type",
        "due_phrase" = EXCLUDED."due_phrase",
        "due_date" = CASE WHEN "tasks"."due_overridden" THEN "tasks"."due_date" ELSE EXCLUDED."due_date" END,
        "due_at" = CASE WHEN "tasks"."due_overridden" THEN "tasks"."due_at" ELSE EXCLUDED."due_at" END,
        "has_time" = CASE WHEN "tasks"."due_overridden" THEN "tasks"."has_time" ELSE EXCLUDED."has_time" END,
        "date_source" = CASE WHEN "tasks"."due_overridden" THEN "tasks"."date_source" ELSE EXCLUDED."date_source" END,
        "priority" = EXCLUDED."priority",
        "priority_score" = EXCLUDED."priority_score",
        "priority_base" = EXCLUDED."priority_base",
        "priority_reasons" = EXCLUDED."priority_reasons",
        "confidence" = EXCLUDED."confidence",
        "evidence" = EXCLUDED."evidence",
        "extracted_by" = EXCLUDED."extracted_by",
        "updated_at" = now()
    `;
  }
  return written;
}
