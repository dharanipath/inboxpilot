import { describe, expect, it } from "vitest";

import type { SyncEvent, SyncEventType } from "@/api/types";
import { finishedRun } from "@/test/server";

import { applyEvent, initialProgress, type Progress, withTrace } from "./progress";

let seq = 0;
const ev = (type: SyncEventType, data?: Record<string, unknown>): SyncEvent => ({
  seq: ++seq,
  type,
  at: "2026-10-16T00:00:00Z",
  ...(data ? { data } : {}),
});
const status = (p: Progress) => Object.fromEntries(p.stages.map((s) => [s.id, s.status]));

describe("sync progress reducer", () => {
  it("walks the pipeline from queued to done", () => {
    seq = 0;
    let p = initialProgress();
    p = applyEvent(p, ev("queued"));
    expect(p.phase).toBe("running");
    p = applyEvent(p, ev("fetching", { days: 14 }));
    expect(status(p).fetch).toBe("active");
    p = applyEvent(p, ev("triage", { fetched: 28, new: 20, already_processed: 8 }));
    expect(status(p)).toMatchObject({ fetch: "done", triage: "done", extract: "pending" });
    expect(p.stages[1]?.detail).toBe("20 new · 8 seen");
    p = applyEvent(p, ev("extracting", { done: 12, total: 20 }));
    expect(status(p)).toMatchObject({
      extract: "active",
      ground: "active",
      dates: "active",
      priority: "active",
    });
    expect(p.extracted).toEqual({ done: 12, total: 20 });
    p = applyEvent(p, ev("saving", { tasks: 14 }));
    expect(status(p)).toMatchObject({ extract: "done", plan: "active" });
    expect(p.stages.find((st) => st.id === "ground")?.detail).toBe(""); // no stale "Batch N"
    expect(p.extracted).toEqual({ done: 20, total: 20 });
    p = applyEvent(p, ev("done", { tasks_written: 14 }));
    expect(p.phase).toBe("done");
    expect(Object.values(status(p)).every((s) => s === "done")).toBe(true);
  });

  it("keeps a model fallback visible after the run finishes", () => {
    seq = 0;
    let p = applyEvent(initialProgress(), ev("queued"));
    p = applyEvent(p, ev("extracting", { done: 0, total: 6 }));
    p = applyEvent(p, ev("provider_switch", { detail: "gemini rate-limited → groq" }));
    p = applyEvent(p, ev("saving", { tasks: 3 }));
    p = applyEvent(p, ev("done"));
    expect(p.fallback).toBe("gemini rate-limited → groq");
    expect(status(p).extract).toBe("degraded");
  });

  it("on error, steps that were still running stop spinning", () => {
    let p = initialProgress();
    p = applyEvent(p, ev("queued", {}));
    p = applyEvent(p, ev("extracting", { done: 0, total: 1, batch: 1 }));
    expect(p.stages.filter((s) => s.status === "active").length).toBeGreaterThan(1);
    p = applyEvent(p, ev("error", { message: "Sync failed unexpectedly" }));
    expect(p.stages.filter((s) => s.status === "active")).toEqual([]);
    expect(p.stages.filter((s) => s.status === "failed")).toHaveLength(1);
    expect(p.stages.filter((s) => s.detail === "Didn't run").length).toBeGreaterThan(0);
  });

  it("ignores replayed events and marks the active step failed on error", () => {
    seq = 0;
    let p = applyEvent(initialProgress(), ev("queued"));
    const fetching = ev("fetching", { days: 14 });
    p = applyEvent(p, fetching);
    expect(applyEvent(p, fetching)).toBe(p); // duplicate seq from a reconnect
    p = applyEvent(p, ev("error", { message: "Gmail API error 500" }));
    expect(p.phase).toBe("error");
    expect(p.error).toBe("Gmail API error 500");
    expect(status(p).fetch).toBe("failed");
  });

  it("marks agent steps done when nothing was new", () => {
    seq = 0;
    let p = applyEvent(initialProgress(), ev("queued"));
    p = applyEvent(p, ev("triage", { fetched: 28, new: 0, already_processed: 28 }));
    expect(status(p)).toMatchObject({ extract: "done", ground: "done", priority: "done" });
  });

  it("fills durations and statuses from the stored trace", () => {
    const p = withTrace(initialProgress(), finishedRun.trace);
    const extract = p.stages.find((s) => s.id === "extract");
    expect(extract).toMatchObject({
      status: "degraded",
      durationMs: 2140,
      detail: "gemini rate-limited → groq",
    });
    expect(p.stages.find((s) => s.id === "plan")?.durationMs).toBe(5);
    expect(p.stages.find((s) => s.id === "fetch")?.durationMs).toBeUndefined();
  });
});
