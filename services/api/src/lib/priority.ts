/**
 * Read-time re-scoring (SPEC Q11). The agent scores at sync time; urgency changes every day,
 * so the gateway re-applies it to the agent's date-independent `priority_base`.
 * Mirrors services/agent/app/pipeline/prioritize.py `combine`; both are tested against
 * packages/contracts/fixtures/priority_cases.json.
 */
import type { Priority } from "../agent/types.js";
import { daysBetween } from "./time.js";

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

export function urgency(dueDate: string | null, today: string): [points: number, label: string] {
  if (dueDate === null) return [4, "No due date"];
  const days = daysBetween(today, dueDate);
  if (days < 0) return [45, `Overdue by ${plural(-days, "day")}`];
  if (days === 0) return [40, "Due today"];
  if (days === 1) return [32, "Due tomorrow"];
  const label = `Due in ${days} days`;
  if (days <= 3) return [24, label];
  if (days <= 7) return [14, label];
  return [6, label];
}

export function priorityForScore(score: number): Priority {
  if (score >= 70) return "P0";
  if (score >= 50) return "P1";
  if (score >= 30) return "P2";
  return "P3";
}

export function combine(
  base: number,
  dueDate: string | null,
  confidence: number,
  today: string,
): { score: number; priority: Priority; label: string } {
  const [points, label] = urgency(dueDate, today);
  const conf = Math.min(Math.max(confidence, 0), 1);
  // floor(x + 0.5) to match Python exactly (no banker's rounding on either side)
  const score = Math.min(100, Math.max(0, Math.floor((points + base) * (0.6 + 0.4 * conf) + 0.5)));
  return { score, priority: priorityForScore(score), label };
}

/** Re-score a stored task for `today`. Without a stored base (older rows), keep the sync-time score. */
export function rescore(
  stored: { score: number; priority: Priority; reasons: string[]; base: number | null },
  dueDate: string | null,
  confidence: number,
  today: string,
): { score: number; priority: Priority; reasons: string[] } {
  if (stored.base === null)
    return { score: stored.score, priority: stored.priority, reasons: stored.reasons };
  const { score, priority, label } = combine(stored.base, dueDate, confidence, today);
  // the agent always puts the urgency reason first
  return { score, priority, reasons: [label, ...stored.reasons.slice(1)] };
}
