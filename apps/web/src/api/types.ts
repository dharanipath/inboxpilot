/** Shapes returned by the gateway (/api/*). Task mirrors packages/contracts Task + user state. */

export type TaskType =
  "deadline" | "meeting" | "payment" | "review" | "reply" | "send" | "call" | "follow_up" | "other";
export type Priority = "P0" | "P1" | "P2" | "P3";
export type Bucket = "overdue" | "today" | "week" | "later" | "undated" | "needs_review";
export type TaskStatus = "open" | "done" | "snoozed" | "dismissed";

export interface Task {
  id: string;
  email_id: string;
  title: string;
  details?: string | null;
  type: TaskType;
  due_phrase: string | null;
  due_date: string | null;
  due_at: string | null;
  has_time: boolean;
  date_source: "resolver" | "llm" | "none" | "user";
  priority: Priority;
  priority_score: number;
  priority_reasons: string[];
  confidence: number;
  evidence: string;
  bucket: Bucket;
  source: {
    from_name?: string | null;
    from_email: string;
    subject: string;
    received_at: string;
    thread_id: string;
  };
  extracted_by: string;
  status: TaskStatus;
  snoozed_until: string | null;
  gmail_url: string;
  updated_at: string;
}

export interface TaskPage {
  items: Task[];
  next_cursor: string | null;
  today: string;
  timezone: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  auth_mode: "google";
  timezone: string;
  vip_senders: string[];
  llm_providers: string[];
  last_sync_at: string | null;
  created_at: string;
  /** background inbox check interval (0 = off) */
  auto_sync_interval_s?: number;
  /** false once Google expired or revoked access: background checks stop until reconnected */
  gmail_connected?: boolean;
}

export type BucketCounts = Record<Bucket, number>;

export interface Briefing {
  headline: string;
  summary: string;
  generated_by: string;
  generated_at: string;
  counts: BucketCounts;
  today: string;
}

export interface TraceStep {
  step: string;
  agent: string;
  status: "ok" | "degraded" | "skipped" | "failed";
  duration_ms: number;
  detail?: string | null;
  counts?: Record<string, number> | null;
}

export interface ProviderUsage {
  provider: string;
  model: string;
  calls: number;
  failures: number;
  latency_ms: number;
  cache_hits?: number;
  last_error?: string | null;
}

export interface SyncRun {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  days: number;
  stats: Record<string, unknown> | null;
  trace: TraceStep[];
  provider_usage: ProviderUsage[];
  briefing: Briefing | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface ProviderStatus {
  name: string;
  model: string;
  configured: boolean;
  /** whose key: the server's .env, the user's own, or none */
  key_source: "server" | "user" | "none";
  available: boolean;
  circuit: "closed" | "open";
  /** why it is paused: free limit used up, key rejected, or repeated errors */
  circuit_reason?: "rate_limited" | "auth" | "no_credit" | "failures" | null;
  cooldown_s: number;
  calls: number;
  failures: number;
  cache_hits: number;
  avg_latency_ms: number;
  last_error?: string | null;
  label: string;
  /** takes an API key the user can add in Settings */
  keyable: boolean;
  /** e.g. "••••7a1f": the key itself never reaches the browser */
  key_hint: string | null;
}

/** The account this browser remembers (for one-click "Continue as …"). */
export interface RememberedAccount {
  email: string;
  name: string | null;
  /** false: Google ended access, so the way back in is "Reconnect Gmail" */
  gmail_connected: boolean;
}

export interface ProvidersPage {
  /** "auto", "heuristic" (rules only) or a provider name */
  mode: string;
  keys_enabled: boolean;
  providers: ProviderStatus[];
}

export interface ModelChangeResult extends ProvidersPage {
  /** picking a working model re-reads recent mail with it: the run id, or null */
  resync: string | null;
}

export interface AskResult {
  answer: string;
  generated_by: string;
  cited_task_ids: string[];
  tasks: Task[];
}

export type SyncEventType =
  "queued" | "fetching" | "triage" | "extracting" | "provider_switch" | "saving" | "done" | "error";

export interface SyncEvent {
  seq: number;
  type: SyncEventType;
  at: string;
  data?: Record<string, unknown>;
}

export interface TaskPatch {
  status?: "open" | "done" | "dismissed";
  snoozed_until?: string;
  due_date?: string | null;
  due_at?: string | null;
}

/** An email received in the past N days and what InboxPilot did with it. */
export interface RecentEmail {
  id: string;
  thread_id: string;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  received_at: string;
  local_date: string;
  status: "pending" | "processed" | "skipped" | "failed";
  skip_reason: string | null;
  gmail_url: string;
  tasks: Task[];
}

export interface RecentEmailPage {
  items: RecentEmail[];
  days: number;
  /** first day of the window (inclusive); the window ends the day before `today` */
  from: string;
  today: string;
  timezone: string;
}
