import { ChevronRight, History } from "lucide-react";

import { useRuns } from "@/api/hooks";
import type { SyncRun } from "@/api/types";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { EmptyPanel } from "@/features/tasks/TaskBoard";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<SyncRun["status"], string> = {
  queued: "text-muted-foreground",
  running: "border-primary/30 text-primary",
  succeeded: "border-success/30 text-success",
  failed: "border-destructive/30 text-destructive",
};

const STEP_TONE: Record<string, string> = {
  ok: "text-success",
  degraded: "text-warning",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
};

export function RunsPage() {
  const runs = useRuns();
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agent runs</h1>
        <p className="text-sm text-muted-foreground">
          Every sync stores its full agent trace: each step, its duration, and which model did the
          extraction.
        </p>
      </div>
      {runs.isLoading ? (
        Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-16" />)
      ) : !runs.data?.items.length ? (
        <EmptyPanel
          icon={<History />}
          title="No runs yet"
          body="Sync your inbox from the dashboard to see the agent at work."
        />
      ) : (
        <ul className="space-y-3">
          {runs.data.items.map((r) => (
            <RunItem key={r.id} run={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

function RunItem({ run }: { run: SyncRun }) {
  const stats = run.stats ?? {};
  const seconds =
    typeof stats.duration_ms === "number" ? `${(stats.duration_ms / 1000).toFixed(1)} s` : "–";
  return (
    <li>
      <details className="group rounded-lg border bg-card shadow-sm">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 p-4">
          <ChevronRight
            className="size-4 transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
          <Badge className={STATUS_TONE[run.status]}>{run.status}</Badge>
          <span className="text-sm font-medium">{relativeTime(run.started_at)}</span>
          <span className="text-xs text-muted-foreground">
            {num(stats.fetched)} fetched · {num(stats.processed)} processed ·{" "}
            {num(stats.tasks_written)} tasks · {seconds}
            {typeof stats.mode === "string" ? ` · ${stats.mode}` : ""}
          </span>
        </summary>
        <div className="space-y-4 border-t p-4">
          {run.error ? (
            <p role="alert" className="rounded bg-destructive/10 p-2 text-sm text-destructive">
              {run.error}
            </p>
          ) : null}
          {run.trace.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Agent trace</caption>
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-4 font-medium">Step</th>
                    <th className="py-1 pr-4 font-medium">Status</th>
                    <th className="py-1 pr-4 text-right font-medium">Time</th>
                    <th className="py-1 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {run.trace.map((s) => (
                    <tr key={s.step} className="border-t">
                      <td className="py-1.5 pr-4">{s.agent}</td>
                      <td className={cn("py-1.5 pr-4", STEP_TONE[s.status])}>{s.status}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{s.duration_ms} ms</td>
                      <td className="py-1.5 text-xs text-muted-foreground">
                        {[
                          s.detail,
                          s.counts
                            ? Object.entries(s.counts)
                                .map(([k, v]) => `${k} ${v}`)
                                .join(", ")
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No agent steps ran (nothing new to process).
            </p>
          )}
          {run.provider_usage.length ? (
            <div>
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Models
              </h3>
              <ul className="flex flex-wrap gap-2">
                {run.provider_usage.map((u) => (
                  <li key={u.provider}>
                    <Badge className={u.failures ? "border-warning/40" : ""}>
                      {u.provider}/{u.model} · {u.calls} calls · {u.latency_ms} ms
                      {u.failures ? ` · ${u.failures} failed (${u.last_error ?? "error"})` : ""}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </details>
    </li>
  );
}
