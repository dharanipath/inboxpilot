import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { api, isUnauthorized } from "./client";
import type {
  AskResult,
  RecentEmailPage,
  Briefing,
  ModelChangeResult,
  ProvidersPage,
  RememberedAccount,
  SyncRun,
  Task,
  TaskPage,
  TaskPatch,
  User,
} from "./types";

export const keys = {
  me: ["me"] as const,
  tasks: (scope: string) => ["tasks", scope] as const,
  allTasks: ["tasks"] as const,
  briefing: ["briefing"] as const,
  emails: (days: number) => ["emails", days] as const,
  allEmails: ["emails"] as const,
  runs: ["runs"] as const,
  run: (id: string) => ["runs", id] as const,
  providers: ["providers"] as const,
};

/** Fallback refresh; normally a finished sync's SSE event refreshes everything at once. */
export const REFRESH_MS = 60_000;
export const RUNS_POLL_MS = 15_000;

const noRetryOn401 = (count: number, err: unknown) => !isUnauthorized(err) && count < 2;

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => api<User>("/api/me"),
    retry: noRetryOn401,
    staleTime: 60_000,
    // last_sync_at moves with every background check, including ones that find no new mail
    // (those leave no run behind for the runs poll to notice)
    refetchInterval: RUNS_POLL_MS,
  });
}

/** All open tasks (buckets are computed by the server in the user's timezone). */
export function useOpenTasks() {
  return useQuery({
    queryKey: keys.tasks("open"),
    queryFn: () => api<TaskPage>("/api/tasks?status=open&range=all&limit=200"),
    retry: noRetryOn401,
    refetchInterval: REFRESH_MS,
  });
}

export function useDoneTasks() {
  return useQuery({
    queryKey: keys.tasks("done"),
    queryFn: () => api<TaskPage>("/api/tasks?status=done&range=all&limit=200"),
    retry: noRetryOn401,
  });
}

/** Done, dismissed and still-snoozed tasks: what the user can put back with Reopen. */
export function useClosedTasks() {
  return useQuery({
    queryKey: keys.tasks("closed"),
    queryFn: () => api<TaskPage>("/api/tasks?status=closed&range=all&limit=200"),
    retry: noRetryOn401,
    refetchInterval: REFRESH_MS,
  });
}

export function useBriefing() {
  return useQuery({
    queryKey: keys.briefing,
    queryFn: () => api<Briefing>("/api/briefing"),
    retry: noRetryOn401,
    refetchInterval: REFRESH_MS,
  });
}

export function useRuns() {
  return useQuery({
    queryKey: keys.runs,
    queryFn: () => api<{ items: SyncRun[] }>("/api/sync/runs?limit=20"),
    retry: noRetryOn401,
    // background syncs start on the server: notice them quickly so the live trace can follow
    refetchInterval: RUNS_POLL_MS,
  });
}

export function useRun(id: string | null) {
  return useQuery({
    queryKey: keys.run(id ?? "none"),
    queryFn: () => api<SyncRun>(`/api/sync/${id ?? ""}`),
    enabled: Boolean(id),
  });
}

export function useProviders() {
  return useQuery({
    queryKey: keys.providers,
    queryFn: () => api<ProvidersPage>("/api/providers"),
    retry: false,
    // while a model is paused, check often so the banner clears as soon as it is back
    refetchInterval: (q) =>
      q.state.data?.providers.some((p) => p.circuit === "open") ? RUNS_POLL_MS : 60_000,
  });
}

/** After any model change, the providers list, the user and the briefing may all differ. */
function useProvidersUpdate<V, R extends ProvidersPage>(fn: (vars: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (page) => {
      qc.setQueryData(keys.providers, page);
      void qc.invalidateQueries({ queryKey: keys.me });
      void qc.invalidateQueries({ queryKey: keys.briefing });
    },
  });
}

export function useSetModel() {
  return useProvidersUpdate((model: string) =>
    api<ModelChangeResult>("/api/llm/model", { method: "PUT", json: { model } }),
  );
}

/** Mail received in the past `days` days, with what InboxPilot did with each email. */
export function useEmails(days = 7) {
  return useQuery({
    queryKey: keys.emails(days),
    queryFn: () => api<RecentEmailPage>(`/api/emails?days=${days}`),
    retry: noRetryOn401,
    refetchInterval: REFRESH_MS,
  });
}

/** Everything that depends on task state. */
export function invalidateTaskData(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.allTasks }),
    qc.invalidateQueries({ queryKey: keys.briefing }),
    qc.invalidateQueries({ queryKey: keys.allEmails }),
  ]);
}

/**
 * Optimistic: the task leaves the open list (done/dismissed/snoozed) immediately, or leaves the
 * closed list when reopened, and both lists are restored if the server rejects the change.
 */
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TaskPatch }) =>
      api<Task>(`/api/tasks/${id}`, { method: "PATCH", json: patch }),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.allTasks });
      const previous = qc.getQueryData<TaskPage>(keys.tasks("open"));
      const previousClosed = qc.getQueryData<TaskPage>(keys.tasks("closed"));
      const without = (page: TaskPage): TaskPage => ({
        ...page,
        items: page.items.filter((t) => t.id !== id),
      });
      const leavesOpen = (patch.status && patch.status !== "open") || patch.snoozed_until;
      if (previous && leavesOpen) qc.setQueryData(keys.tasks("open"), without(previous));
      if (previousClosed && patch.status === "open")
        qc.setQueryData(keys.tasks("closed"), without(previousClosed));
      return { previous, previousClosed };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(keys.tasks("open"), ctx.previous);
      if (ctx?.previousClosed) qc.setQueryData(keys.tasks("closed"), ctx.previousClosed);
    },
    onSettled: () => invalidateTaskData(qc),
  });
}

export function useStartSync() {
  return useMutation({
    mutationFn: (body: { days?: number; reprocess?: boolean } = {}) =>
      api<{ jobId: string }>("/api/sync", { method: "POST", json: body }),
  });
}

export function useAsk() {
  return useMutation({
    mutationFn: (question: string) =>
      api<AskResult>("/api/ask", { method: "POST", json: { question } }),
  });
}

/** Normal logout keeps "Continue as …" on this browser; `forget` removes it too. */
export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: { forget?: boolean } | undefined) =>
      api<void>("/api/auth/logout", { method: "POST", json: { forget: Boolean(opts?.forget) } }),
    onSettled: () => qc.clear(),
  });
}

/** The account this browser remembers, or null. */
export function useRemembered() {
  return useQuery({
    queryKey: ["remembered"],
    queryFn: async () => (await api<RememberedAccount | undefined>("/api/auth/remembered")) ?? null,
    retry: false,
    staleTime: Infinity,
  });
}

/** "Continue as …": one request, no trip to Google. */
export function useResume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<User>("/api/auth/resume", { method: "POST", json: {} }),
    onSuccess: (user) => qc.setQueryData(keys.me, user),
  });
}

export function useForgetBrowser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/api/auth/forget", { method: "POST", json: {} }),
    onSuccess: () => qc.setQueryData(["remembered"], null),
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/api/me", { method: "DELETE" }),
    onSuccess: () => qc.clear(),
  });
}
