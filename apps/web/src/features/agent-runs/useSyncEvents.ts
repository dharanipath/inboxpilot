import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer } from "react";

import { invalidateTaskData, keys } from "@/api/hooks";
import type { SyncEvent, SyncEventType } from "@/api/types";

import { applyEvent, initialProgress, type Progress } from "./progress";

const TYPES: SyncEventType[] = [
  "queued",
  "fetching",
  "triage",
  "extracting",
  "provider_switch",
  "saving",
  "done",
  "error",
];

type Action = { kind: "event"; event: SyncEvent } | { kind: "reset" };

function reducer(state: Progress, action: Action): Progress {
  return action.kind === "reset" ? initialProgress() : applyEvent(state, action.event);
}

/** Live progress for one sync run over SSE. EventSource reconnects with Last-Event-ID by itself. */
export function useSyncEvents(runId: string | null): Progress {
  const [progress, dispatch] = useReducer(reducer, undefined, initialProgress);
  const qc = useQueryClient();

  useEffect(() => {
    dispatch({ kind: "reset" });
    if (!runId) return;
    const es = new EventSource(`/api/sync/${runId}/events`);
    const onMessage = (raw: Event) => {
      // the browser also fires a native "error" Event on network trouble: only MessageEvents carry data
      if (!(raw instanceof MessageEvent) || typeof raw.data !== "string") return;
      let event: SyncEvent;
      try {
        event = JSON.parse(raw.data) as SyncEvent;
      } catch {
        return;
      }
      dispatch({ kind: "event", event });
      if (event.type === "done" || event.type === "error") {
        es.close(); // otherwise EventSource would reconnect after the server ends the stream
        void invalidateTaskData(qc);
        void qc.invalidateQueries({ queryKey: keys.runs });
        void qc.invalidateQueries({ queryKey: keys.me });
        void qc.invalidateQueries({ queryKey: keys.providers });
      }
    };
    for (const t of TYPES) es.addEventListener(t, onMessage);
    return () => es.close();
  }, [runId, qc]);

  return progress;
}
