/** MSW mock of the gateway (no network in unit tests). */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import type {
  Briefing,
  ProviderStatus,
  ProvidersPage,
  RecentEmail,
  RecentEmailPage,
  SyncRun,
  Task,
  TaskPage,
  User,
} from "@/api/types";

export const TODAY = "2026-10-16";
export const TZ = "Asia/Kolkata";

export const user: User = {
  id: "u1",
  email: "sam@gmail.example",
  name: "Sam Rao",
  auth_mode: "google",
  timezone: TZ,
  vip_senders: ["ceo@acme.example"],
  llm_providers: [],
  last_sync_at: "2026-10-16T03:00:00Z",
  created_at: "2026-10-16T02:00:00Z",
  auto_sync_interval_s: 120,
};

let n = 0;
export function makeTask(over: Partial<Task> = {}): Task {
  n += 1;
  return {
    id: `t_${String(n).padStart(40, "0")}`,
    email_id: `msg-${n}`,
    title: `Task ${n}`,
    details: null,
    type: "send",
    due_phrase: "by Friday",
    due_date: TODAY,
    due_at: null,
    has_time: false,
    date_source: "resolver",
    priority: "P2",
    priority_score: 40,
    priority_reasons: ["Due today", "Send request"],
    confidence: 0.9,
    evidence: `Can you send item ${n} by Friday?`,
    bucket: "today",
    source: {
      from_name: "Priya Shah",
      from_email: "priya@acme.example",
      subject: "Subject",
      received_at: "2026-10-15T05:00:00Z",
      thread_id: `thr-${n}`,
    },
    extracted_by: "heuristic/rules-v1",
    status: "open",
    snoozed_until: null,
    gmail_url: `https://mail.google.com/mail/u/0/#inbox/thr-${n}`,
    updated_at: "2026-10-16T03:00:00Z",
    ...over,
  };
}

export const page = (items: Task[]): TaskPage => ({
  items,
  next_cursor: null,
  today: TODAY,
  timezone: TZ,
});

export const briefing: Briefing = {
  headline: "2 things today, 1 overdue",
  summary: "Start with “Send the deck” (due today, P1).",
  generated_by: "template",
  generated_at: "2026-10-16T03:00:00Z",
  counts: { overdue: 1, today: 2, week: 1, later: 0, undated: 0, needs_review: 0 },
  today: TODAY,
};

const status = (over: Partial<ProviderStatus> & Pick<ProviderStatus, "name">): ProviderStatus => ({
  model: `${over.name}-model`,
  label: over.name,
  configured: false,
  key_source: "none",
  available: false,
  circuit: "closed",
  circuit_reason: null,
  cooldown_s: 0,
  calls: 0,
  failures: 0,
  cache_hits: 0,
  avg_latency_ms: 0,
  keyable: true,
  key_hint: null,
  ...over,
});

export const providers: ProviderStatus[] = [
  status({ name: "gemini", model: "gemini-2.5-flash", label: "Google Gemini" }),
  status({ name: "groq", model: "llama-3.3-70b-versatile", label: "Groq" }),
  status({
    name: "heuristic",
    model: "rules-v1",
    label: "Rules only (no AI)",
    configured: true,
    available: true,
    keyable: false,
    calls: 3,
    avg_latency_ms: 1,
  }),
];
export const providerStatus = status;

export const providersPage = (
  list: ProviderStatus[] = providers,
  mode = "auto",
): ProvidersPage => ({ mode, keys_enabled: true, providers: list });

export const finishedRun: SyncRun = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "succeeded",
  days: 14,
  stats: {
    fetched: 28,
    processed: 28,
    already_processed: 0,
    tasks_written: 22,
    duration_ms: 3200,
    mode: "full",
  },
  trace: [
    { step: "preprocess", agent: "PreprocessAgent", status: "ok", duration_ms: 4 },
    { step: "triage", agent: "TriageAgent", status: "ok", duration_ms: 2 },
    {
      step: "extract",
      agent: "ExtractionAgent",
      status: "degraded",
      duration_ms: 2140,
      detail: "gemini rate-limited → groq",
    },
    { step: "ground", agent: "GroundingAgent", status: "ok", duration_ms: 3 },
    { step: "dates", agent: "TemporalAgent", status: "ok", duration_ms: 2 },
    { step: "priority", agent: "PriorityAgent", status: "ok", duration_ms: 1 },
    { step: "plan", agent: "PlannerAgent", status: "ok", duration_ms: 5 },
  ],
  provider_usage: [
    {
      provider: "gemini",
      model: "gemini-2.5-flash",
      calls: 1,
      failures: 1,
      latency_ms: 300,
      last_error: "429",
    },
    { provider: "groq", model: "llama", calls: 3, failures: 0, latency_ms: 1800 },
  ],
  briefing: null,
  error: null,
  started_at: "2026-10-16T03:00:00Z",
  finished_at: "2026-10-16T03:00:03Z",
};

export function makeEmail(over: Partial<RecentEmail> = {}): RecentEmail {
  n += 1;
  return {
    id: `msg-${n}`,
    thread_id: `thr-${n}`,
    from_name: "Priya Shah",
    from_email: "priya@acme.example",
    subject: `Subject ${n}`,
    received_at: "2026-10-16T03:00:00Z",
    local_date: TODAY,
    status: "processed",
    skip_reason: null,
    gmail_url: `https://mail.google.com/mail/u/0/#inbox/thr-${n}`,
    tasks: [],
    ...over,
  };
}

export const emailPage = (items: RecentEmail[]): RecentEmailPage => ({
  items,
  days: 7,
  from: "2026-10-09",
  today: TODAY,
  timezone: TZ,
});

export const handlers = [
  http.get("/api/me", () => HttpResponse.json(user)),
  http.get("/api/tasks", ({ request }) =>
    HttpResponse.json(page(new URL(request.url).searchParams.get("status") === "done" ? [] : [])),
  ),
  http.get("/api/briefing", () => HttpResponse.json(briefing)),
  http.get("/api/providers", () => HttpResponse.json(providersPage())),
  http.get("/api/sync/runs", () => HttpResponse.json({ items: [] })),
  http.get("/api/emails", () => HttpResponse.json(emailPage([]))),
  http.get("/api/auth/remembered", () => new HttpResponse(null, { status: 204 })),
];

export const server = setupServer(...handlers);
export { http, HttpResponse };
