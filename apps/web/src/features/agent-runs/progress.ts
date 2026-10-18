/**
 * Pure reducer: SSE sync events → the agent pipeline the UI animates.
 * The gateway streams fetch/triage/extract/save milestones; the agent's per-batch steps
 * (ground, dates, prioritise) run inside "extracting", and the stored trace fills in exact
 * durations once the run is done.
 */
import type { SyncEvent, TraceStep } from "@/api/types";

export type StageId = "fetch" | "triage" | "extract" | "ground" | "dates" | "priority" | "plan";
export type StageStatus = "pending" | "active" | "done" | "degraded" | "failed";

export interface Stage {
  id: StageId;
  label: string;
  status: StageStatus;
  detail?: string;
  durationMs?: number;
}

export interface Progress {
  phase: "idle" | "running" | "done" | "error";
  stages: Stage[];
  extracted: { done: number; total: number } | null;
  fallback: string | null;
  error: string | null;
  stats: Record<string, unknown> | null;
  lastSeq: number;
}

const STAGES: [StageId, string][] = [
  ["fetch", "Fetch"],
  ["triage", "Triage"],
  ["extract", "Extract"],
  ["ground", "Ground"],
  ["dates", "Dates"],
  ["priority", "Prioritise"],
  ["plan", "Plan"],
];
const AGENT_BATCH: StageId[] = ["extract", "ground", "dates", "priority"];

export function initialProgress(): Progress {
  return {
    phase: "idle",
    stages: STAGES.map(([id, label]) => ({ id, label, status: "pending" })),
    extracted: null,
    fallback: null,
    error: null,
    stats: null,
    lastSeq: 0,
  };
}

function set(p: Progress, ids: StageId[], status: StageStatus, detail?: string): Stage[] {
  return p.stages.map((s) =>
    ids.includes(s.id)
      ? {
          ...s,
          // a fallback (degraded) is sticky: finishing does not hide that it happened
          status: s.status === "degraded" && status === "done" ? "degraded" : status,
          ...(detail !== undefined ? { detail } : {}),
        }
      : s,
  );
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export function applyEvent(p: Progress, e: SyncEvent): Progress {
  if (e.seq <= p.lastSeq) return p; // replayed or duplicate
  const next: Progress = { ...p, lastSeq: e.seq };
  const d = e.data ?? {};
  switch (e.type) {
    case "queued":
      return { ...initialProgress(), phase: "running", lastSeq: e.seq };
    case "fetching":
      return {
        ...next,
        phase: "running",
        stages: set(next, ["fetch"], "active", `Last ${num(d.days)} days`),
      };
    case "triage": {
      let stages = set(next, ["fetch"], "done", `${num(d.fetched)} emails`);
      stages = set(
        { ...next, stages },
        ["triage"],
        "done",
        `${num(d.new)} new · ${num(d.already_processed)} seen`,
      );
      if (num(d.new) === 0) stages = set({ ...next, stages }, AGENT_BATCH, "done", "Nothing new");
      return { ...next, stages };
    }
    case "extracting": {
      const total = num(d.total);
      const done = num(d.done);
      const stages = set(
        next,
        AGENT_BATCH,
        "active",
        `Batch ${Math.floor(done / Math.max(1, total)) + 1}`,
      );
      return {
        ...next,
        stages: set({ ...next, stages }, ["extract"], "active", `${done}/${total} emails`),
        extracted: { done, total },
      };
    }
    case "provider_switch": {
      const detail = typeof d.detail === "string" ? d.detail : "fell back to another model";
      return { ...next, fallback: detail, stages: set(next, ["extract"], "degraded", detail) };
    }
    case "saving": {
      // "Batch N" only means something while batches are running
      const batchDone = set(next, ["ground", "dates", "priority"], "done", "");
      const stages = set({ ...next, stages: batchDone }, ["extract"], "done");
      return {
        ...next,
        extracted: next.extracted ? { ...next.extracted, done: next.extracted.total } : null,
        stages: set({ ...next, stages }, ["plan"], "active", `${num(d.tasks)} tasks saved`),
      };
    }
    case "done":
      return {
        ...next,
        phase: "done",
        stats: d,
        stages: next.stages.map((s) => ({
          ...s,
          status: s.status === "degraded" ? "degraded" : "done",
        })),
      };
    case "error": {
      const message = typeof d.message === "string" ? d.message : "Sync failed";
      const active =
        next.stages.find((s) => s.status === "active") ??
        next.stages.find((s) => s.status === "pending");
      return {
        ...next,
        phase: "error",
        error: message,
        // the first unfinished step failed; other in-flight steps stopped with it
        stages: next.stages.map((s) =>
          s.id === active?.id
            ? { ...s, status: "failed", detail: message }
            : s.status === "active"
              ? { ...s, status: "pending", detail: "Didn't run" }
              : s,
        ),
      };
    }
  }
}

const TRACE_TO_STAGE: Record<string, StageId> = {
  triage: "triage",
  extract: "extract",
  ground: "ground",
  dates: "dates",
  priority: "priority",
  plan: "plan",
};

/** Fill exact per-step durations and statuses from the stored agent trace. */
export function withTrace(p: Progress, trace: TraceStep[]): Progress {
  const byStage = new Map(
    trace.flatMap((t) => (TRACE_TO_STAGE[t.step] ? [[TRACE_TO_STAGE[t.step], t] as const] : [])),
  );
  return {
    ...p,
    stages: p.stages.map((s) => {
      const t = byStage.get(s.id);
      if (!t) return s;
      const status: StageStatus =
        t.status === "degraded" ? "degraded" : t.status === "failed" ? "failed" : "done";
      return {
        ...s,
        durationMs: t.duration_ms,
        status,
        ...(t.detail && s.id !== "triage" ? { detail: t.detail } : {}),
      };
    }),
  };
}
