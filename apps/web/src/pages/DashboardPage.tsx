import { AlertCircle } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";

import { useDoneTasks, useOpenTasks } from "@/api/hooks";
import type { User } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/primitives";
import { AskBox } from "@/features/ask/AskBox";
import { AgentRunPanel } from "@/features/agent-runs/AgentRunPanel";
import { useSyncProgress } from "@/features/agent-runs/context";
import { useSync } from "@/features/agent-runs/SyncButton";
import { BriefingCard } from "@/features/briefing/BriefingCard";
import { RecentMail } from "@/features/emails/RecentMail";
import { LimitBanner } from "@/features/ai/LimitBanner";
import { ModelSelect } from "@/features/ai/ModelSelect";
import { ReconnectBanner } from "@/features/gmail/ReconnectBanner";
import { ClosedTasks } from "@/features/tasks/ClosedTasks";
import { KpiTiles, WeekStrip } from "@/features/tasks/Overview";
import { TaskBoard } from "@/features/tasks/TaskBoard";
import { useTaskActions } from "@/features/tasks/useTaskActions";
import { greeting, localDateOf, longDate, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Tab = "upcoming" | "past";
const TABS: { id: Tab; label: string }[] = [
  { id: "upcoming", label: "Upcoming" },
  { id: "past", label: "Past 7 days" },
];

export function autoSyncNote(intervalS: number | undefined): string {
  if (!intervalS) return "";
  const minutes = Math.round(intervalS / 60);
  return intervalS < 60
    ? ` · checks for new mail every ${intervalS} s`
    : ` · checks for new mail every ${minutes} min`;
}

export function DashboardPage() {
  const user = useOutletContext<User>();
  const open = useOpenTasks();
  const done = useDoneTasks();
  const actions = useTaskActions();
  const sync = useSync();
  const progress = useSyncProgress();
  const [tab, setTab] = useState<Tab>("upcoming");
  const firstSync = useRef(false);

  // first visit after connecting Gmail: read the inbox right away instead of waiting for the
  // first background check, so the live agent trace is visible immediately
  useEffect(() => {
    if (!user.last_sync_at && !firstSync.current) {
      firstSync.current = true;
      sync.run();
    }
  }, [user.last_sync_at, sync]);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = tab === "upcoming" ? "past" : "upcoming";
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  const now = useNow(30_000); // keeps "synced 2 min ago" moving while the page stays open
  const today = open.data?.today ?? localDateOf(now, user.timezone);
  const firstName = (user.name ?? "").replace(/\s*\(.*\)$/, "").split(" ")[0];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {greeting(now, user.timezone)}
              {firstName ? `, ${firstName}` : ""}
            </h1>
            <p className="text-sm text-muted-foreground">
              {longDate(today)} · {user.timezone}
              {user.last_sync_at
                ? ` · synced ${relativeTime(user.last_sync_at, now)}`
                : " · not synced yet"}
              {autoSyncNote(user.auto_sync_interval_s)}
            </p>
          </div>
        </div>

        {user.gmail_connected === false ? <ReconnectBanner timezone={user.timezone} /> : null}
        <div className="flex items-center gap-2 sm:hidden">
          <label htmlFor="mobile-model" className="text-xs text-muted-foreground">
            Model that reads your mail
          </label>
          <ModelSelect id="mobile-model" className="min-w-0 flex-1" />
        </div>
        <LimitBanner />
        <BriefingCard />

        <div
          role="tablist"
          aria-label="Task views"
          className="inline-flex rounded-md border bg-card p-0.5"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              title={
                t.id === "upcoming"
                  ? "Overdue, today and the next 7 days"
                  : "Mail from the 7 days before today, with its tasks"
              }
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={onTabKey}
              className={cn(
                "rounded px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors",
                tab === t.id && "bg-secondary text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "past" ? (
          <div role="tabpanel" id="panel-past" aria-labelledby="tab-past">
            <RecentMail timezone={user.timezone} />
          </div>
        ) : open.isLoading ? (
          <BoardSkeleton />
        ) : open.isError ? (
          <div
            role="alert"
            className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
          >
            <AlertCircle className="size-5 text-destructive" aria-hidden="true" />
            <span className="flex-1">We couldn't load your tasks.</span>
            <Button size="sm" variant="outline" onClick={() => void open.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <div
            role="tabpanel"
            id="panel-upcoming"
            aria-labelledby="tab-upcoming"
            className="space-y-6"
          >
            <KpiTiles open={open.data?.items ?? []} doneCount={done.data?.items.length ?? 0} />
            <WeekStrip open={open.data?.items ?? []} today={today} />
            <TaskBoard
              tasks={open.data?.items ?? []}
              today={today}
              timezone={user.timezone}
              actions={actions}
              emptyAction={
                <Button
                  size="sm"
                  onClick={() => sync.run()}
                  disabled={progress.phase === "running"}
                >
                  {progress.phase === "running" ? "Syncing…" : "Sync now"}
                </Button>
              }
            />
            <ClosedTasks today={today} timezone={user.timezone} actions={actions} />
          </div>
        )}
      </div>

      <aside
        className="space-y-6 lg:sticky lg:top-20 lg:self-start"
        aria-label="Agent and assistant"
      >
        <AgentRunPanel />
        <AskBox today={today} timezone={user.timezone} />
      </aside>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading tasks">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-20" />
      ))}
    </div>
  );
}

/** The current time, refreshed every `ms`, so relative times on screen stay true. */
export function useNow(ms: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
