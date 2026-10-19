import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient, User } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

import { AgentError, type AgentApi } from "../agent/client.js";
import type { EmailInput, ExtractResponse, ProviderUsage, TraceStep } from "../agent/types.js";
import { pruneRulesTasks, upsertTasks, withoutRulesDuplicates } from "../db/tasks.js";
import { HttpProblem } from "../lib/problem.js";
import { GmailError } from "../google/gmail.js";
import { OAuthError } from "../google/oauth.js";
import type { LlmKeys } from "../llm/keys.js";
import type { MailSource } from "../mail/source.js";
import type { BriefingService } from "../services/briefing.js";
import { userContext } from "../services/context.js";
import type { SyncEvents } from "./events.js";
import { mergeTraces, mergeUsage } from "./trace.js";

export interface SyncJobData {
  runId: string;
  requestId?: string;
}

export interface SyncDeps {
  prisma: PrismaClient;
  redis: Redis;
  agent: AgentApi;
  events: SyncEvents;
  briefing: BriefingService;
  sources: Partial<Record<string, MailSource>>;
  enqueue: (data: SyncJobData) => Promise<void>;
  log: FastifyBaseLogger;
  maxEmails: number;
  chunkSize: number;
  now?: () => Date;
  llmKeys: LlmKeys;
}

export interface SyncOptions {
  days: number;
  reprocess: boolean;
  /** "auto" = background check (jobs/autosync.ts); a check that finds nothing new leaves no run */
  trigger?: "manual" | "auto";
}

const LOCK_TTL_S = 15 * 60;
const BODY_TTL_S = 3600;
const lockKey = (userId: string) => `synclock:${userId}`;
const bodyKey = (userId: string, msgId: string) => `body:${userId}:${msgId}`;

export class SyncService {
  private readonly now: () => Date;

  constructor(private readonly d: SyncDeps) {
    this.now = d.now ?? (() => new Date());
  }

  /** Queue a sync. One running sync per user: a second request gets 409 with the live job id. */
  async start(userId: string, opts: SyncOptions, requestId?: string): Promise<{ runId: string }> {
    const runId = randomUUID();
    const acquired = await this.d.redis.set(lockKey(userId), runId, "EX", LOCK_TTL_S, "NX");
    if (acquired !== "OK") {
      const current = await this.d.redis.get(lockKey(userId));
      throw new HttpProblem(409, "Sync already running", "Wait for the current sync to finish.", {
        jobId: current,
      });
    }
    try {
      await this.d.prisma.syncRun.create({
        data: {
          id: runId,
          userId,
          status: "queued",
          days: opts.days,
          stats: { reprocess: opts.reprocess, trigger: opts.trigger ?? "manual" },
        },
      });
      await this.d.events.publish(runId, "queued");
      await this.d.enqueue({ runId, ...(requestId ? { requestId } : {}) });
    } catch (err) {
      await this.release(userId, runId);
      throw err;
    }
    return { runId };
  }

  /** Worker body. Never throws: failures are recorded on the run and streamed as an event. */
  async process({ runId, requestId }: SyncJobData): Promise<void> {
    const run = await this.d.prisma.syncRun.findUnique({
      where: { id: runId },
      include: { user: true },
    });
    if (!run) return;
    const { user } = run;
    const startedAt = Date.now();
    const meta = (run.stats ?? {}) as { reprocess?: boolean; trigger?: string };
    const reprocess = Boolean(meta.reprocess);
    const trigger = meta.trigger === "auto" ? "auto" : "manual";
    const fetchedIds: string[] = [];
    try {
      await this.d.prisma.syncRun.update({ where: { id: runId }, data: { status: "running" } });
      const now = this.now();

      await this.d.events.publish(runId, "fetching", { days: run.days });
      const source = this.d.sources[user.authMode];
      if (!source)
        throw new HttpProblem(
          501,
          "Not implemented",
          `No mail source for ${user.authMode} accounts yet`,
        );
      const listing = await source.listRecent(user, {
        days: run.days,
        max: this.d.maxEmails,
        now,
        since: reprocess ? null : user.gmailHistoryId,
      });
      const { emails } = listing;
      fetchedIds.push(...emails.map((e) => e.id));

      const rowIds = await this.recordEmails(user.id, emails);
      const done = await this.alreadyProcessed(user.id, emails);
      const todo = reprocess ? emails : emails.filter((e) => !done.has(e.id));
      await this.d.events.publish(runId, "triage", {
        mode: listing.mode,
        fetched: emails.length,
        new: todo.length,
        already_processed: emails.length - todo.length,
      });

      // bodies live in Redis only (1 h TTL), never in Postgres
      await this.stashBodies(user.id, todo);

      const traces: TraceStep[][] = [];
      const usages: ProviderUsage[][] = [];
      let written = 0;
      let skipped = 0;
      for (let i = 0; i < todo.length; i += this.d.chunkSize) {
        const chunk = await this.loadBodies(user.id, todo.slice(i, i + this.d.chunkSize));
        await this.d.events.publish(runId, "extracting", { done: i, total: todo.length });
        const res = await this.extractWithRetry(user, chunk, now, requestId);
        const extract = res.trace.find((s) => s.step === "extract");
        if (extract && extract.status !== "ok" && extract.detail) {
          await this.d.events.publish(runId, "provider_switch", { detail: extract.detail });
        }
        // did a real model (not the rules reader) read this chunk?
        const modelRead = res.provider_usage.some(
          (u) => u.provider !== "heuristic" && (u.calls > u.failures || (u.cache_hits ?? 0) > 0),
        );
        let toWrite = res.tasks;
        if (modelRead) {
          const chunkRows = chunk.flatMap((e) => rowIds.get(e.id) ?? []);
          await pruneRulesTasks(
            this.d.prisma,
            user.id,
            chunkRows,
            res.tasks.map((t) => t.id),
          );
        } else {
          toWrite = await withoutRulesDuplicates(this.d.prisma, user.id, res.tasks, rowIds);
        }
        written += await upsertTasks(this.d.prisma, user.id, toWrite, rowIds);
        skipped += res.skipped.length;
        await this.markProcessed(user.id, chunk, res);
        traces.push(res.trace);
        usages.push(res.provider_usage);
      }

      await this.d.events.publish(runId, "saving", { tasks: written });
      await this.d.briefing.invalidate(user, now);
      const briefing = todo.length ? await this.d.briefing.get(user, now, requestId) : null;

      const stats = {
        reprocess,
        trigger,
        mode: listing.mode,
        fetched: emails.length,
        processed: todo.length,
        already_processed: emails.length - todo.length,
        tasks_written: written,
        skipped_emails: skipped,
        duration_ms: Date.now() - startedAt,
      };
      const checkpoint = this.d.prisma.user.update({
        where: { id: user.id },
        // the checkpoint only advances after a fully successful run, so nothing is skipped
        data: {
          lastSyncAt: new Date(),
          ...(listing.checkpoint ? { gmailHistoryId: listing.checkpoint } : {}),
        },
      });
      if (trigger === "auto" && todo.length === 0) {
        // a background check that found nothing new: advance the checkpoint, keep no run record
        await this.d.events.publish(runId, "done", stats);
        await this.d.prisma.$transaction([
          checkpoint,
          this.d.prisma.syncRun.delete({ where: { id: runId } }),
        ]);
        return;
      }
      await this.d.prisma.$transaction([
        this.d.prisma.syncRun.update({
          where: { id: runId },
          data: {
            status: "succeeded",
            stats,
            trace: mergeTraces(traces) as unknown as Prisma.InputJsonValue,
            providerUsage: mergeUsage(usages) as unknown as Prisma.InputJsonValue,
            ...(briefing ? { briefing: briefing as unknown as Prisma.InputJsonValue } : {}),
            finishedAt: new Date(),
          },
        }),
        checkpoint,
        this.d.prisma.auditLog.create({
          data: { userId: user.id, action: "sync", meta: { runId, ...stats } },
        }),
      ]);
      await this.d.events.publish(runId, "done", stats);
    } catch (err) {
      const message = safeMessage(err);
      this.d.log.error({ err, runId }, "sync failed");
      await this.d.prisma.syncRun
        .update({
          where: { id: runId },
          data: { status: "failed", error: message, finishedAt: new Date() },
        })
        .catch(() => undefined);
      await this.d.events.publish(runId, "error", { message });
    } finally {
      await this.dropBodies(user.id, fetchedIds);
      await this.release(user.id, runId);
    }
  }

  private async recordEmails(userId: string, emails: EmailInput[]): Promise<Map<string, string>> {
    if (emails.length) {
      await this.d.prisma.email.createMany({
        data: emails.map((e) => ({
          userId,
          gmailId: e.id,
          threadId: e.thread_id,
          fromName: e.from_name ?? null,
          fromEmail: e.from_email,
          subject: e.subject,
          receivedAt: new Date(e.received_at),
        })),
        skipDuplicates: true,
      });
    }
    const rows = await this.d.prisma.email.findMany({
      where: { userId, gmailId: { in: emails.map((e) => e.id) } },
      select: { id: true, gmailId: true },
    });
    return new Map(rows.map((r) => [r.gmailId, r.id]));
  }

  private async alreadyProcessed(userId: string, emails: EmailInput[]): Promise<Set<string>> {
    const rows = await this.d.prisma.email.findMany({
      where: {
        userId,
        gmailId: { in: emails.map((e) => e.id) },
        status: { in: ["processed", "skipped"] },
      },
      select: { gmailId: true },
    });
    return new Set(rows.map((r) => r.gmailId));
  }

  /**
   * Every email sent to the agent is now handled. Mark the whole chunk processed first: an email
   * whose task was merged into an earlier one in its thread appears in neither tasks nor skipped,
   * and must not be re-extracted on every sync. Then record the agent's skip reasons.
   */
  private async markProcessed(
    userId: string,
    chunk: EmailInput[],
    res: ExtractResponse,
  ): Promise<void> {
    const at = new Date();
    await this.d.prisma.email.updateMany({
      where: { userId, gmailId: { in: chunk.map((e) => e.id) } },
      data: { status: "processed", skipReason: null, processedAt: at },
    });
    for (const s of res.skipped) {
      await this.d.prisma.email.updateMany({
        where: { userId, gmailId: s.email_id },
        data: { status: "skipped", skipReason: s.reason, processedAt: at },
      });
    }
  }

  private async stashBodies(userId: string, emails: EmailInput[]): Promise<void> {
    if (!emails.length) return;
    const multi = this.d.redis.multi();
    for (const e of emails) multi.set(bodyKey(userId, e.id), e.body_text, "EX", BODY_TTL_S);
    await multi.exec();
  }

  private async loadBodies(userId: string, emails: EmailInput[]): Promise<EmailInput[]> {
    const bodies = await this.d.redis.mget(emails.map((e) => bodyKey(userId, e.id)));
    return emails.map((e, i) => ({ ...e, body_text: bodies[i] ?? e.body_text }));
  }

  private async dropBodies(userId: string, ids: string[]): Promise<void> {
    if (ids.length) await this.d.redis.del(...ids.map((id) => bodyKey(userId, id)));
  }

  private async extractWithRetry(
    user: User,
    emails: EmailInput[],
    now: Date,
    requestId?: string,
  ): Promise<ExtractResponse> {
    const request = {
      user: userContext(user, now),
      emails,
      options: {
        horizon_days: 7,
        use_llm_briefing: false, // one briefing over all open tasks is made after the sync
        ...(await this.d.llmKeys.options(user)), // model order + the user's own API keys
      },
    };
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.d.agent.extract(request, requestId);
      } catch (err) {
        const transient =
          err instanceof AgentError && (err.status === undefined || err.status >= 500);
        if (!transient || attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  private async release(userId: string, runId: string): Promise<void> {
    // only release our own lock
    if ((await this.d.redis.get(lockKey(userId))) === runId)
      await this.d.redis.del(lockKey(userId));
  }
}

function safeMessage(err: unknown): string {
  if (err instanceof HttpProblem || err instanceof AgentError || err instanceof GmailError) {
    return err.message;
  }
  if (err instanceof OAuthError) return `Google sign-in error: ${err.code}`;
  return "Sync failed unexpectedly";
}
