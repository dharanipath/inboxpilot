import { createHash } from "node:crypto";

import { AgentError, type AgentApi } from "../src/agent/client.js";
import { ContractValidator } from "../src/agent/contract.js";
import type {
  AgentTask,
  AskRequest,
  AskResponse,
  Briefing,
  BriefingRequest,
  EmailInput,
  ExtractRequest,
  ExtractResponse,
  ProvidersRequest,
  ProvidersResponse,
  ProviderTestRequest,
  ProviderTestResponse,
} from "../src/agent/types.js";

const validator = new ContractValidator();

export function taskId(emailId: string, evidence: string): string {
  const norm = evidence.toLowerCase().replace(/\s+/g, " ").trim();
  return `t_${createHash("sha1").update(`${emailId}\n${norm}`).digest("hex")}`;
}

export interface FakeTaskSpec {
  title?: string;
  due_date?: string | null;
  confidence?: number;
  priority?: AgentTask["priority"];
  base?: number;
}

/**
 * Deterministic stand-in for the Python agent. Every response is validated against the shared
 * contract, so the fake cannot drift from what the real agent returns.
 * Default rule: one task per email (evidence = first sentence) unless labelled promo/newsletter.
 */
export class FakeAgent implements AgentApi {
  extractCalls: ExtractRequest[] = [];
  askCalls: AskRequest[] = [];
  briefingCalls: BriefingRequest[] = [];
  failExtract: Error | null = null;
  failBriefing = false;
  degradedDetail: string | null = null;
  specs = new Map<string, FakeTaskSpec>();

  reset(): void {
    this.extractCalls = [];
    this.askCalls = [];
    this.briefingCalls = [];
    this.failExtract = null;
    this.failBriefing = false;
    this.degradedDetail = null;
    this.specs.clear();
    this.limited.clear();
    this.testCalls = [];
    this.providerCalls = [];
    this.serverKeys.clear();
  }

  extract(req: ExtractRequest): Promise<ExtractResponse> {
    validator.assert("ExtractRequest", req);
    this.extractCalls.push(req);
    if (this.failExtract) return Promise.reject(this.failExtract);
    const tasks: AgentTask[] = [];
    const skipped: ExtractResponse["skipped"] = [];
    for (const e of req.emails) {
      if (e.list_unsubscribe || e.labels?.some((l) => l.startsWith("CATEGORY_"))) {
        skipped.push({ email_id: e.id, reason: e.list_unsubscribe ? "newsletter" : "promotion" });
        continue;
      }
      tasks.push(this.taskFor(e));
    }
    const res: ExtractResponse = {
      run_id: `run_fake${this.extractCalls.length}`,
      tasks,
      skipped,
      trace: [
        {
          step: "preprocess",
          agent: "PreprocessAgent",
          status: "ok",
          duration_ms: 1,
          detail: null,
          counts: { in: req.emails.length },
        },
        {
          step: "extract",
          agent: "ExtractionAgent",
          status: this.degradedDetail ? "degraded" : "ok",
          duration_ms: 5,
          detail: this.degradedDetail ?? "fake/v1",
          counts: { items: tasks.length },
        },
      ],
      provider_usage: [
        {
          provider: "fake",
          model: "v1",
          calls: 1,
          failures: 0,
          latency_ms: 5,
          cache_hits: 0,
          last_error: null,
        },
      ],
      briefing: {
        headline: "fake",
        summary: "fake",
        generated_by: "template",
        counts: { overdue: 0, today: 0, week: 0, later: 0, undated: 0, needs_review: 0 },
      },
    };
    return Promise.resolve(validator.assert("ExtractResponse", res));
  }

  ask(req: AskRequest): Promise<AskResponse> {
    validator.assert("AskRequest", req);
    this.askCalls.push(req);
    const first = req.tasks[0];
    return Promise.resolve(
      validator.assert("AskResponse", {
        answer: first ? `Start with ${first.title}.` : "Nothing matches.",
        cited_task_ids: first ? [first.id, "t_unknown"] : [],
        generated_by: "fake",
      }),
    );
  }

  briefing(req: BriefingRequest): Promise<Briefing> {
    validator.assert("BriefingRequest", req);
    this.briefingCalls.push(req);
    if (this.failBriefing) return Promise.reject(new AgentError("agent unreachable"));
    const counts = { overdue: 0, today: 0, week: 0, later: 0, undated: 0, needs_review: 0 };
    for (const t of req.tasks) counts[t.bucket] += 1;
    return Promise.resolve(
      validator.assert("Briefing", {
        headline: `${req.tasks.length} open tasks`,
        summary: "Fake briefing.",
        generated_by: "fake",
        counts,
      }),
    );
  }

  /** provider -> cooldown seconds: that provider's *user* keys are out of free quota */
  limited = new Map<string, number>();
  testCalls: ProviderTestRequest[] = [];
  providerCalls: ProvidersRequest[] = [];
  /** the server's own .env keys (none by default, like a fresh install) */
  serverKeys = new Set<string>();

  providers(req: ProvidersRequest = {}): Promise<ProvidersResponse> {
    validator.assert("ProvidersRequest", req);
    this.providerCalls.push(req);
    const keys = req.provider_keys ?? {};
    const row = (name: string, model: string) => {
      const own = Boolean(keys[name]);
      const configured = own || this.serverKeys.has(name);
      const cooldown = own ? (this.limited.get(name) ?? 0) : 0;
      return {
        name,
        model,
        configured,
        key_source: own ? "user" : configured ? "server" : "none",
        available: configured && cooldown === 0,
        circuit: cooldown ? "open" : "closed",
        circuit_reason: cooldown ? "rate_limited" : null,
        cooldown_s: cooldown,
        calls: 0,
        failures: 0,
        cache_hits: 0,
        avg_latency_ms: 0,
        last_error: null,
      } as const;
    };
    return Promise.resolve(
      validator.assert("ProvidersResponse", {
        providers: [
          row("gemini", "gemini-2.5-flash"),
          row("groq", "llama-3.3-70b-versatile"),
          {
            ...row("heuristic", "rules-v1"),
            configured: true,
            available: true,
            key_source: "none",
          },
        ],
      }),
    );
  }

  /** Scripted by the key's prefix: bad… rejected, limited… out of quota, down… provider error,
   *  slow… timed out. */
  testProvider(req: ProviderTestRequest): Promise<ProviderTestResponse> {
    validator.assert("ProviderTestRequest", req);
    this.testCalls.push(req);
    const model = req.name === "gemini" ? "gemini-2.5-flash" : "llama-3.3-70b-versatile";
    const outcome = req.api_key.startsWith("bad")
      ? "auth"
      : req.api_key.startsWith("limited")
        ? "rate_limited"
        : req.api_key.startsWith("down")
          ? "error"
          : req.api_key.startsWith("slow")
            ? "timeout"
            : "ok";
    if (outcome === "rate_limited") this.limited.set(req.name, 42);
    return Promise.resolve(
      validator.assert("ProviderTestResponse", {
        name: req.name,
        model,
        outcome,
        retry_after_s: outcome === "rate_limited" ? 42 : null,
        message:
          outcome === "ok"
            ? null
            : outcome === "error"
              ? `${req.name}: HTTP 404 NOT_FOUND`
              : `${req.name}: ${outcome}`,
      }),
    );
  }

  health(): Promise<boolean> {
    return Promise.resolve(true);
  }

  private taskFor(e: EmailInput): AgentTask {
    const spec = this.specs.get(e.id) ?? {};
    const evidence = (e.body_text.split(/(?<=[.?!])\s/)[0] ?? e.body_text).trim() || e.subject;
    const due = spec.due_date ?? null;
    return {
      id: taskId(e.id, evidence),
      email_id: e.id,
      title: (spec.title ?? `Handle: ${e.subject}`).slice(0, 80),
      details: null,
      type: "other",
      due_phrase: null,
      due_date: due,
      due_at: null,
      has_time: false,
      date_source: due ? "resolver" : "none",
      priority: spec.priority ?? "P2",
      priority_score: 40,
      priority_base: spec.base ?? null,
      priority_reasons: ["Fake reason"],
      confidence: spec.confidence ?? 0.9,
      evidence,
      bucket: due ? "week" : "undated",
      source: {
        from_name: e.from_name ?? null,
        from_email: e.from_email,
        subject: e.subject,
        received_at: e.received_at,
        thread_id: e.thread_id,
      },
      extracted_by: "fake/v1",
    };
  }
}
