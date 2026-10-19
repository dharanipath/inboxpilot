import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

import { invalidateTaskData, keys, useMe, useRuns } from "@/api/hooks";
import { useUi } from "@/store/ui";

import { initialProgress, type Progress } from "./progress";
import { useSyncEvents } from "./useSyncEvents";

const SyncProgressContext = createContext<Progress>(initialProgress());

/**
 * One EventSource per page, shared by the Sync button and the agent panel.
 *
 * Auto-refresh: the server checks every inbox in the background, so the page must not depend on
 * catching a run while it is running (a check that finds no mail lasts about a second, a stream
 * can drop, and the page may open mid-sync). It refreshes whenever the server's state changes:
 *   - a run that finished which this page has not handled yet (covers every case above), or
 *   - a newer `last_sync_at` (every background check moves it, even when it leaves no run).
 * A run seen while it is still running is also followed live, for the agent panel.
 */
export function SyncProgressProvider({ children }: { children: ReactNode }) {
  const activeRunId = useUi((s) => s.activeRunId);
  const setActiveRun = useUi((s) => s.setActiveRun);
  const qc = useQueryClient();
  const runs = useRuns();
  const me = useMe();
  const latest = runs.data?.items[0];
  const seen = useRef<string | null | undefined>(undefined); // newest run id; undefined = first load
  const handled = useRef<string | null | undefined>(undefined); // newest FINISHED run refreshed for
  const lastSync = useRef<string | null | undefined>(undefined);

  // follow a run that starts in the background, live
  useEffect(() => {
    if (!runs.data) return;
    const id = latest?.id ?? null;
    if (seen.current === undefined) {
      seen.current = id; // what was already there when the page opened
      return;
    }
    if (!latest || id === seen.current) return;
    seen.current = id;
    if ((latest.status === "queued" || latest.status === "running") && latest.id !== activeRunId) {
      setActiveRun(latest.id);
    }
  }, [runs.data, latest, activeRunId, setActiveRun]);

  // refresh once for every run that finishes, whether or not it was followed live
  useEffect(() => {
    if (!runs.data) return;
    const finished = runs.data.items.find((r) => r.status === "succeeded" || r.status === "failed");
    const id = finished?.id ?? null;
    if (handled.current === undefined) {
      handled.current = id; // already on screen when the page opened
      return;
    }
    if (id === handled.current) return;
    handled.current = id;
    void invalidateTaskData(qc);
    void qc.invalidateQueries({ queryKey: keys.me });
  }, [runs.data, qc]);

  // a background check that found nothing new still moves last_sync_at: refresh the data it covers
  const syncedAt = me.data?.last_sync_at;
  useEffect(() => {
    if (me.data === undefined) return;
    const at = syncedAt ?? null;
    if (lastSync.current === undefined) {
      lastSync.current = at;
      return;
    }
    if (at === lastSync.current) return;
    lastSync.current = at;
    void invalidateTaskData(qc);
  }, [me.data, syncedAt, qc]);

  const progress = useSyncEvents(activeRunId);
  return <SyncProgressContext.Provider value={progress}>{children}</SyncProgressContext.Provider>;
}

export const useSyncProgress = (): Progress => useContext(SyncProgressContext);
