import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

import { invalidateTaskData, keys, useRuns } from "@/api/hooks";
import { useUi } from "@/store/ui";

import { initialProgress, type Progress } from "./progress";
import { useSyncEvents } from "./useSyncEvents";

const SyncProgressContext = createContext<Progress>(initialProgress());

/**
 * One EventSource per page, shared by the Sync button and the agent panel.
 *
 * Auto-refresh: the server checks every inbox in the background. When the runs poll sees a
 * run we haven't seen yet, either follow it live (still running: its "done" event refreshes
 * everything) or, if it already finished, refresh tasks, briefing and mail straight away.
 */
export function SyncProgressProvider({ children }: { children: ReactNode }) {
  const activeRunId = useUi((s) => s.activeRunId);
  const setActiveRun = useUi((s) => s.setActiveRun);
  const qc = useQueryClient();
  const runs = useRuns();
  const latest = runs.data?.items[0];
  const seen = useRef<string | null | undefined>(undefined); // undefined = first load

  useEffect(() => {
    if (!runs.data) return;
    const id = latest?.id ?? null;
    if (seen.current === undefined) {
      seen.current = id; // what was already there when the page opened
      return;
    }
    if (!latest || id === seen.current) return;
    seen.current = id;
    if (latest.status === "queued" || latest.status === "running") {
      if (latest.id !== activeRunId) setActiveRun(latest.id);
    } else {
      void invalidateTaskData(qc);
      void qc.invalidateQueries({ queryKey: keys.me });
    }
  }, [runs.data, latest, activeRunId, setActiveRun, qc]);

  const progress = useSyncEvents(activeRunId);
  return <SyncProgressContext.Provider value={progress}>{children}</SyncProgressContext.Provider>;
}

export const useSyncProgress = (): Progress => useContext(SyncProgressContext);
