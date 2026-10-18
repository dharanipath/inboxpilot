/** Calendar maths in the user's timezone. Buckets are computed at READ time (SPEC F7). */

export type Bucket = "overdue" | "today" | "week" | "later" | "undated" | "needs_review";
export const LOW_CONFIDENCE = 0.5;
export const HORIZON_DAYS = 7;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD of `at` in timezone `tz`. */
export function localDate(tz: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: isValidTimeZone(tz) ? tz : "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000,
  );
}

/** Postgres DATE values come back from Prisma as UTC-midnight Dates. */
export function dateOnly(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function toDbDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function bucketFor(
  dueDate: string | null,
  confidence: number,
  today: string,
  horizonDays = HORIZON_DAYS,
): Bucket {
  if (confidence < LOW_CONFIDENCE) return "needs_review";
  if (dueDate === null) return "undated";
  const days = daysBetween(today, dueDate);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= horizonDays) return "week";
  return "later";
}
