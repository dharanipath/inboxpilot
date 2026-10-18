import { useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";

import { ApiError } from "@/api/client";
import { keys, useStartSync } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useUi } from "@/store/ui";

export function useSync() {
  const start = useStartSync();
  const setActiveRun = useUi((s) => s.setActiveRun);
  const qc = useQueryClient();
  return {
    pending: start.isPending,
    run: (body: { reprocess?: boolean } = {}) =>
      start.mutate(body, {
        onSuccess: ({ jobId }) => {
          setActiveRun(jobId);
          void qc.invalidateQueries({ queryKey: keys.runs });
        },
        onError: (err) => {
          if (
            err instanceof ApiError &&
            err.status === 409 &&
            typeof err.extra.jobId === "string"
          ) {
            setActiveRun(err.extra.jobId); // follow the sync that is already running
            toast({ title: "A sync is already running", description: "Showing its progress." });
          } else {
            toast({ title: "Couldn't start a sync", description: err.message, tone: "error" });
          }
        },
      }),
  };
}

export function SyncButton({ running }: { running: boolean }) {
  const sync = useSync();
  const busy = sync.pending || running;
  return (
    <Button
      onClick={() => sync.run()}
      disabled={busy}
      size="sm"
      aria-label={busy ? "Syncing your inbox" : "Sync inbox"}
    >
      {busy ? (
        <Loader2 className="animate-spin" aria-hidden="true" />
      ) : (
        <RefreshCw aria-hidden="true" />
      )}
      <span className="hidden sm:inline">{busy ? "Syncing…" : "Sync"}</span>
    </Button>
  );
}
