/** Date labels in the USER's timezone (from their settings), never the browser's. */
import type { Priority, RecentEmail, Task, TaskType } from "@/api/types";

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000,
  );
}

function fmtDate(iso: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

export function localDateOf(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function timeLabel(isoDateTime: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoDateTime));
}

/** "Today", "Tomorrow", or "Tue 20 Oct". */
export function dayLabel(iso: string, today: string): string {
  const diff = daysBetween(today, iso);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return fmtDate(iso, { weekday: "short", day: "numeric", month: "short" });
}

export function dueLabel(
  task: Pick<Task, "due_date" | "due_at" | "has_time">,
  today: string,
  tz: string,
): string {
  if (!task.due_date) return "No due date";
  const diff = daysBetween(today, task.due_date);
  if (diff < 0) return `Overdue · ${-diff} day${diff === -1 ? "" : "s"}`;
  const day = dayLabel(task.due_date, today);
  return task.has_time && task.due_at ? `${day}, ${timeLabel(task.due_at, tz)}` : day;
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const s = Math.round((now.getTime() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function greeting(now: Date, tz: string): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(
      now,
    ),
  );
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function longDate(iso: string): string {
  return fmtDate(iso, { weekday: "long", day: "numeric", month: "long" });
}

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      b.priority_score - a.priority_score ||
      (a.due_at ?? "").localeCompare(b.due_at ?? ""),
  );
}

export interface DayGroup {
  date: string;
  label: string;
  tasks: Task[];
}

/** Group dated tasks by due date (ascending), tasks within a day by priority. */
export function groupByDay(tasks: Task[], today: string): DayGroup[] {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.due_date) continue;
    map.set(t.due_date, [...(map.get(t.due_date) ?? []), t]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({ date, label: dayLabel(date, today), tasks: sortTasks(list) }));
}

export interface StripDay {
  date: string;
  weekday: string;
  day: string;
  count: number;
  urgent: number;
  /** extra words for the screen-reader label, e.g. "2 tasks" */
  extra?: string;
}

/** Today + the next 6 days, with task counts (overdue tasks are not on the strip). */
export function weekStrip(tasks: Task[], today: string): StripDay[] {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i);
    const onDay = tasks.filter((t) => t.due_date === date && t.bucket !== "needs_review");
    return {
      date,
      weekday: i === 0 ? "Today" : fmtDate(date, { weekday: "short" }),
      day: fmtDate(date, { day: "numeric" }),
      count: onDay.length,
      urgent: onDay.filter((t) => t.priority === "P0" || t.priority === "P1").length,
    };
  });
}

/**
 * The 7 days from `from` (inclusive), oldest first, with the number of emails received each day.
 * `urgent` counts emails that produced a P0 or P1 task.
 */
export function pastStrip(emails: RecentEmail[], from: string): StripDay[] {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(from, i);
    const onDay = emails.filter((e) => e.local_date === date);
    const tasks = onDay.reduce((n, e) => n + e.tasks.length, 0);
    return {
      date,
      weekday: fmtDate(date, { weekday: "short" }),
      day: fmtDate(date, { day: "numeric" }),
      count: onDay.length,
      urgent: onDay.filter((e) => e.tasks.some((t) => t.priority === "P0" || t.priority === "P1"))
        .length,
      extra: `${tasks} task${tasks === 1 ? "" : "s"}`,
    };
  });
}

export const PRIORITY_META: Record<Priority, { label: string; className: string }> = {
  P0: { label: "Urgent", className: "bg-p0/10 text-p0 ring-p0/30" },
  P1: { label: "High", className: "bg-p1/10 text-p1 ring-p1/30" },
  P2: { label: "Medium", className: "bg-p2/10 text-p2 ring-p2/30" },
  P3: { label: "Low", className: "bg-p3/10 text-p3 ring-p3/30" },
};

export const TYPE_LABEL: Record<TaskType, string> = {
  deadline: "Deadline",
  meeting: "Meeting",
  payment: "Payment",
  review: "Review",
  reply: "Reply",
  send: "Send",
  call: "Call",
  follow_up: "Follow-up",
  other: "Other",
};

/** Minutes the timezone is ahead of UTC at `at` (e.g. +330 for Asia/Kolkata). */
export function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The instant that is `hh:mm` on local date `iso` in `tz` (DST-safe to the minute). */
export function zonedTime(iso: string, hh: number, mm: number, tz: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - tzOffsetMinutes(new Date(guess), tz) * 60_000;
  // re-check once: the offset can differ on the far side of a DST switch
  return new Date(guess - tzOffsetMinutes(new Date(first), tz) * 60_000);
}

export interface SnoozeOption {
  label: string;
  until: Date;
}

/** Later today (+3 h), tomorrow 9 AM, next Monday 9 AM, all in the user's timezone. */
export function snoozeOptions(now: Date, tz: string): SnoozeOption[] {
  const today = localDateOf(now, tz);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const toMonday = (8 - weekday) % 7 || 7;
  return [
    { label: "Later today", until: new Date(now.getTime() + 3 * 3_600_000) },
    { label: "Tomorrow morning", until: zonedTime(addDays(today, 1), 9, 0, tz) },
    { label: "Next week", until: zonedTime(addDays(today, toMonday), 9, 0, tz) },
  ];
}
