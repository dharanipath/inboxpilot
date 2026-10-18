import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";

import { useRun, useRuns } from "@/api/hooks";
import type { SyncRun } from "@/api/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

import { initialProgress, type Progress, type Stage, withTrace } from "./progress";
import { useSyncProgress } from "./context";

const ICON: Record<Stage["status"], typeof Circle> = {
  pending: Circle,
  active: Loader2,
  done: CheckCircle2,
  degraded: AlertTriangle,
  failed: XCircle,
};
const TONE: Record<Stage["status"], string> = {
  pending: "text-muted-foreground/50",
  active: "text-primary animate-spin",
  done: "text-success",
  degraded: "text-warning",
  failed: "text-destructive",
};

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** Progress for a finished run, rebuilt from what was stored. */
export function progressFromRun(run: SyncRun): Progress {
  const base = initialProgress();
  const finished = run.status === "succeeded" || run.status === "failed";
  const stats = run.stats ?? {};
  const p: Progress = {
    ...base,
    phase: run.status === "failed" ? "error" : finished ? "done" : "running",
    error: run.error,
    stats,
    stages: base.stages.map((s) => {
      if (run.status === "failed") return { ...s, status: "pending" };
      if (s.id === "fetch") return { ...s, status: "done", detail: `${num(stats.fetched)} emails` };
      if (s.id === "triage")
        return {
          ...s,
          status: "done",
          detail: `${num(stats.processed)} new · ${num(stats.already_processed)} seen`,
        };
      return { ...s, status: finished ? "done" : "pending" };
    }),
  };
  return run.trace.length ? withTrace(p, run.trace) : p;
}

export function AgentRunPanel() {
  const activeRunId = useUi((s) => s.activeRunId);
  const runs = useRuns();
  const live = useSyncProgress();
  const latest = runs.data?.items[0] ?? null;
  const runId = activeRunId ?? latest?.id ?? null;
  const finishedRun = useRun(
    live.phase === "done" || live.phase === "error" || !activeRunId ? runId : null,
  );

  let progress: Progress | null = null;
  if (activeRunId && live.phase !== "idle") {
    progress =
      finishedRun.data && live.phase === "done" ? withTrace(live, finishedRun.data.trace) : live;
  } else if (latest) {
    progress = progressFromRun(finishedRun.data ?? latest);
  }
  const run = finishedRun.data ?? (activeRunId ? null : latest);

  return (
    <Card role="region" aria-labelledby="agent-run-title">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle id="agent-run-title">Agent run</CardTitle>
        <RunStatus phase={progress?.phase ?? "idle"} />
      </CardHeader>
      <CardContent className="space-y-3">
        {runs.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        ) : !progress ? (
          <p className="text-sm text-muted-foreground">
            No syncs yet. Press Sync to run the agent on your inbox.
          </p>
        ) : (
          <>
            <ol className="relative space-y-0.5" aria-label="Pipeline steps" aria-live="polite">
              {progress.stages.map((s, i) => (
                <StageRow key={s.id} stage={s} last={i === progress.stages.length - 1} />
              ))}
            </ol>
            {progress.extracted && progress.phase === "running" ? (
              <div
                role="progressbar"
                aria-label="Emails sent to the agent"
                aria-valuemin={0}
                aria-valuemax={progress.extracted.total}
                aria-valuenow={progress.extracted.done}
                className="h-1.5 overflow-hidden rounded-full bg-secondary"
              >
                <motion.div
                  className="h-full bg-primary"
                  animate={{
                    width: `${(progress.extracted.done / Math.max(1, progress.extracted.total)) * 100}%`,
                  }}
                />
              </div>
            ) : null}
            {progress.fallback ? (
              <p className="flex items-start gap-2 rounded-md bg-warning/10 p-2 text-xs text-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  <strong>Model fallback:</strong> {progress.fallback}
                </span>
              </p>
            ) : null}
            {progress.error ? (
              <p role="alert" className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                {progress.error}
              </p>
            ) : null}
            {run ? <RunFooter run={run} /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StageRow({ stage, last }: { stage: Stage; last: boolean }) {
  const Icon = ICON[stage.status];
  return (
    <motion.li layout className="relative flex items-start gap-3 py-1.5" data-status={stage.status}>
      {!last ? (
        <span
          aria-hidden="true"
          className="absolute left-[9px] top-7 h-[calc(100%-1rem)] w-px bg-border"
        />
      ) : null}
      <Icon
        className={cn("relative mt-0.5 size-[19px] shrink-0 bg-card", TONE[stage.status])}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "text-sm",
              stage.status === "pending" ? "text-muted-foreground" : "font-medium",
            )}
          >
            {stage.label}
            <span className="sr-only"> — {stage.status}</span>
          </span>
          {stage.durationMs !== undefined ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {stage.durationMs} ms
            </span>
          ) : null}
        </div>
        {stage.detail ? (
          <p className="truncate text-xs text-muted-foreground">{stage.detail}</p>
        ) : null}
      </div>
    </motion.li>
  );
}

function RunStatus({ phase }: { phase: Progress["phase"] }) {
  const map = {
    idle: { label: "Idle", className: "text-muted-foreground" },
    running: { label: "Running", className: "border-primary/30 text-primary" },
    done: { label: "Done", className: "border-success/30 text-success" },
    error: { label: "Failed", className: "border-destructive/30 text-destructive" },
  } as const;
  return <Badge className={map[phase].className}>{map[phase].label}</Badge>;
}

function RunFooter({ run }: { run: SyncRun }) {
  const stats = run.stats ?? {};
  const seconds =
    typeof stats.duration_ms === "number" ? (stats.duration_ms / 1000).toFixed(1) : null;
  return (
    <div className="space-y-2 border-t pt-3 text-xs text-muted-foreground">
      <p>
        {relativeTime(run.started_at)}
        {seconds ? ` · ${seconds} s` : ""}
        {typeof stats.tasks_written === "number" ? ` · ${stats.tasks_written} tasks` : ""}
        {typeof stats.mode === "string" ? ` · ${stats.mode} sync` : ""}
      </p>
      {run.provider_usage.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Models used">
          {run.provider_usage.map((u) => (
            <li key={u.provider}>
              <Badge className={u.failures ? "border-warning/40" : ""}>
                {u.provider} · {u.calls} call{u.calls === 1 ? "" : "s"}
                {u.failures ? ` · ${u.failures} failed` : ""}
                {u.cache_hits ? ` · ${u.cache_hits} cached` : ""}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
