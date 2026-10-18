import type { ProviderUsage, TraceStep } from "../agent/types.js";

const SEVERITY: Record<TraceStep["status"], number> = { skipped: 0, ok: 1, degraded: 2, failed: 3 };

/** Merge per-chunk agent traces into one trace per step (sum time/counts, worst status). */
export function mergeTraces(traces: TraceStep[][]): TraceStep[] {
  const merged = new Map<string, TraceStep & { details: Set<string> }>();
  for (const trace of traces) {
    for (const s of trace) {
      const m = merged.get(s.step);
      if (!m) {
        merged.set(s.step, {
          ...s,
          counts: s.counts ? { ...s.counts } : null,
          details: new Set(s.detail ? [s.detail] : []),
        });
        continue;
      }
      m.duration_ms += s.duration_ms;
      if (SEVERITY[s.status] > SEVERITY[m.status]) m.status = s.status;
      if (s.detail) m.details.add(s.detail);
      if (s.counts) {
        m.counts ??= {};
        for (const [k, v] of Object.entries(s.counts)) m.counts[k] = (m.counts[k] ?? 0) + v;
      }
    }
  }
  return [...merged.values()].map(({ details, ...step }) => ({
    ...step,
    detail: details.size ? [...details].join("; ") : null,
  }));
}

export function mergeUsage(usages: ProviderUsage[][]): ProviderUsage[] {
  const out = new Map<string, ProviderUsage>();
  for (const list of usages) {
    for (const u of list) {
      const m = out.get(u.provider);
      if (!m) {
        out.set(u.provider, { ...u, cache_hits: u.cache_hits ?? 0 });
        continue;
      }
      m.calls += u.calls;
      m.failures += u.failures;
      m.latency_ms += u.latency_ms;
      m.cache_hits = (m.cache_hits ?? 0) + (u.cache_hits ?? 0);
      if (u.last_error) m.last_error = u.last_error;
    }
  }
  return [...out.values()];
}
