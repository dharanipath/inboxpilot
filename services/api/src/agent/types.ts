/**
 * TypeScript view of packages/contracts/extract.schema.json (v1).
 * Agent responses are also validated against the JSON Schema at runtime (contract.ts),
 * and tests/contract.test.ts checks these types against the shared fixtures.
 */

export type TaskType =
  "deadline" | "meeting" | "payment" | "review" | "reply" | "send" | "call" | "follow_up" | "other";
export type Priority = "P0" | "P1" | "P2" | "P3";
export type Bucket = "overdue" | "today" | "week" | "later" | "undated" | "needs_review";
export type DateSource = "resolver" | "llm" | "none" | "user";

export interface UserContext {
  email: string;
  name?: string | null;
  timezone: string;
  now: string;
  vip_senders?: string[];
}

export interface EmailInput {
  id: string;
  thread_id: string;
  from_name?: string | null;
  from_email: string;
  to?: string[];
  cc?: string[];
  subject: string;
  body_text: string;
  received_at: string;
  labels?: string[];
  list_unsubscribe?: boolean;
}

export interface ExtractOptions {
  horizon_days?: number;
  use_llm_briefing?: boolean;
  providers?: string[] | null;
  /** the user's own API keys, by provider (ADR 0006). Secrets: never log. */
  provider_keys?: Record<string, string> | null;
}

export interface ExtractRequest {
  user: UserContext;
  emails: EmailInput[];
  options?: ExtractOptions;
}

export interface TaskSource {
  from_name?: string | null;
  from_email: string;
  subject: string;
  received_at: string;
  thread_id: string;
}

export interface AgentTask {
  id: string;
  email_id: string;
  title: string;
  details?: string | null;
  type: TaskType;
  due_phrase: string | null;
  due_date: string | null;
  due_at: string | null;
  has_time: boolean;
  date_source: DateSource;
  priority: Priority;
  priority_score: number;
  priority_base?: number | null;
  priority_reasons: string[];
  confidence: number;
  evidence: string;
  bucket: Bucket;
  source: TaskSource;
  extracted_by: string;
}

export interface SkippedEmail {
  email_id: string;
  reason: string;
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

export interface BucketCounts {
  overdue: number;
  today: number;
  week: number;
  later: number;
  undated: number;
  needs_review?: number;
}

export interface Briefing {
  headline: string;
  summary: string;
  generated_by: string;
  counts: BucketCounts;
}

export interface ExtractResponse {
  run_id: string;
  tasks: AgentTask[];
  skipped: SkippedEmail[];
  trace: TraceStep[];
  provider_usage: ProviderUsage[];
  briefing: Briefing;
}

export interface AskRequest {
  user: UserContext;
  question: string;
  tasks: AgentTask[];
  options?: ExtractOptions;
}

export interface AskResponse {
  answer: string;
  cited_task_ids: string[];
  generated_by: string;
}

export interface BriefingRequest {
  user: UserContext;
  tasks: AgentTask[];
  options?: ExtractOptions;
}

export interface ProviderStatus {
  name: string;
  model: string;
  configured: boolean;
  key_source: "server" | "user" | "none";
  available: boolean;
  circuit: "closed" | "open";
  circuit_reason?: "rate_limited" | "auth" | "no_credit" | "failures" | null;
  cooldown_s: number;
  calls: number;
  failures: number;
  cache_hits: number;
  avg_latency_ms: number;
  last_error?: string | null;
}

export interface ProvidersResponse {
  providers: ProviderStatus[];
}

export interface ProvidersRequest {
  provider_keys?: Record<string, string> | null;
}

export interface ProviderTestRequest {
  name: string;
  api_key: string;
}

export type ProbeOutcome = "ok" | "rate_limited" | "auth" | "timeout" | "error" | "invalid";

export interface ProviderTestResponse {
  name: string;
  model: string;
  outcome: ProbeOutcome;
  retry_after_s?: number | null;
  message?: string | null;
}
