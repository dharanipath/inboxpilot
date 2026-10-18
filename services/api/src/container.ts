import { PrismaClient } from "@prisma/client";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";

import { type AgentApi, HttpAgentClient } from "./agent/client.js";
import { ContractValidator, defaultContractsDir, loadContractSchema } from "./agent/contract.js";
import type { AppDeps } from "./app.js";
import { Sessions } from "./auth/session.js";
import type { Config } from "./config.js";
import { GmailClient } from "./google/gmail.js";
import { AUTH_URL, emulatorFetch, emulatorUrl, GoogleOAuth } from "./google/oauth.js";
import { GmailMailSource } from "./google/source.js";
import { GoogleTokens } from "./google/tokens.js";
import { SyncEvents } from "./jobs/events.js";
import { createSyncQueue, createSyncWorker, enqueueWith } from "./jobs/queue.js";
import { type SyncJobData, SyncService } from "./jobs/sync.js";
import type { MailSource } from "./mail/source.js";
import { BriefingService } from "./services/briefing.js";
import { TokenCipher } from "./lib/crypto.js";
import { LlmKeys } from "./llm/keys.js";

export interface Container {
  deps: AppDeps;
  queue: Queue<SyncJobData>;
  worker: Worker<SyncJobData> | null;
  close(): Promise<void>;
}

export interface ContainerOptions {
  log: FastifyBaseLogger;
  agent?: AgentApi;
  sources?: Partial<Record<string, MailSource>>;
  startWorker?: boolean;
  queuePrefix?: string;
  /** Inject fetch for every Google call (tests use a fake Google). */
  googleFetch?: typeof fetch;
}

/** Wires every real dependency. Tests use the same wiring with a fake agent. */
export function createContainer(config: Config, opts: ContainerOptions): Container {
  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: false });
  const subscriber = redis.duplicate();
  // BullMQ requires dedicated connections that never give up on a command
  const queueConn = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const workerConn = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

  const validator = new ContractValidator(
    loadContractSchema(config.contractsDir ?? defaultContractsDir()),
  );
  const agent =
    opts.agent ??
    new HttpAgentClient({
      baseUrl: config.agentUrl,
      internalKey: config.internalApiKey,
      timeoutMs: config.agentTimeoutMs,
      validator,
    });
  const events = new SyncEvents(redis, subscriber);

  let google: AppDeps["google"] = null;
  let gmailSource: GmailMailSource | null = null;
  if (config.google) {
    const emulator = config.googleEmulatorUrl;
    const googleFetch = opts.googleFetch ?? (emulator ? emulatorFetch(emulator) : undefined);
    const oauth = new GoogleOAuth(
      config.google,
      googleFetch,
      emulator ? emulatorUrl(emulator, AUTH_URL) : AUTH_URL,
    );
    const tokens = new GoogleTokens(prisma, redis, new TokenCipher(config.google.tokenKey), oauth);
    google = { oauth, tokens };
    gmailSource = new GmailMailSource(
      (user) =>
        new GmailClient(
          { get: () => tokens.accessToken(user.id), invalidate: () => tokens.invalidate(user.id) },
          {
            ...(googleFetch ? { fetchImpl: googleFetch } : {}),
            backoffBaseMs: config.gmailBackoffBaseMs,
          },
        ),
      config.gmailFetchConcurrency,
    );
  }
  const llmKeys = new LlmKeys(prisma, config.tokenKey ? new TokenCipher(config.tokenKey) : null);
  const briefing = new BriefingService(prisma, redis, agent, opts.log, llmKeys);
  const queue = createSyncQueue(queueConn, opts.queuePrefix);
  const sync = new SyncService({
    prisma,
    redis,
    agent,
    events,
    briefing,
    llmKeys,
    sources: opts.sources ?? (gmailSource ? { google: gmailSource } : {}),
    enqueue: enqueueWith(queue),
    log: opts.log,
    maxEmails: config.syncMaxEmails,
    chunkSize: config.syncChunkSize,
  });
  const worker =
    opts.startWorker === false
      ? null
      : createSyncWorker(workerConn, sync, config.syncWorkerConcurrency, opts.queuePrefix);

  return {
    deps: {
      config,
      prisma,
      redis,
      agent,
      sync,
      events,
      briefing,
      llmKeys,
      sessions: new Sessions(config.jwtSecret, redis),
      google,
    },
    queue,
    worker,
    async close() {
      await worker?.close();
      await queue.close();
      await Promise.allSettled([
        redis.quit(),
        subscriber.quit(),
        queueConn.quit(),
        workerConn.quit(),
      ]);
      await prisma.$disconnect();
    },
  };
}
