import type { PrismaClient } from "@prisma/client";
import { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

import { HttpProblem } from "../lib/problem.js";
import type { SyncService } from "./sync.js";

/** After a failed run, wait this long before checking that inbox again automatically. */
export const FAILURE_BACKOFF_MS = 10 * 60_000;
const MAX_USERS_PER_TICK = 100;

/**
 * Background inbox checks: every connected Gmail account whose last sync is older than the
 * interval gets an incremental sync (Gmail history since the stored checkpoint, so it is
 * cheap). Users who revoked access have no token and are skipped.
 */
export async function runAutoSync(
  prisma: PrismaClient,
  sync: SyncService,
  intervalS: number,
  now = new Date(),
): Promise<{ started: number; skipped: number }> {
  const due = new Date(now.getTime() - intervalS * 1000);
  const users = await prisma.user.findMany({
    where: {
      authMode: "google",
      refreshTokenEnc: { not: null },
      OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: due } }],
    },
    select: { id: true },
    orderBy: { lastSyncAt: { sort: "asc", nulls: "first" } },
    take: MAX_USERS_PER_TICK,
  });
  let started = 0;
  let skipped = 0;
  for (const { id } of users) {
    const recentFailure = await prisma.syncRun.findFirst({
      where: {
        userId: id,
        status: "failed",
        startedAt: { gt: new Date(now.getTime() - FAILURE_BACKOFF_MS) },
      },
      select: { id: true },
    });
    if (recentFailure) {
      skipped += 1;
      continue;
    }
    try {
      await sync.start(id, { days: 14, reprocess: false, trigger: "auto" });
      started += 1;
    } catch (err) {
      if (err instanceof HttpProblem && err.status === 409)
        skipped += 1; // already syncing
      else throw err;
    }
  }
  return { started, skipped };
}

export const AUTOSYNC_QUEUE = "autosync";

/** Ticks at least once a minute (more often for short intervals); disabled when intervalS = 0. */
export async function scheduleAutoSync(
  connection: Redis,
  prisma: PrismaClient,
  sync: SyncService,
  intervalS: number,
  log: FastifyBaseLogger,
  prefix = "bull",
): Promise<{ queue: Queue; worker: Worker } | null> {
  const queue = new Queue(AUTOSYNC_QUEUE, { connection, prefix });
  if (intervalS <= 0) {
    await queue.removeJobScheduler("autosync-tick");
    await queue.close();
    return null;
  }
  const tickMs = Math.min(60, Math.max(5, intervalS)) * 1000;
  await queue.upsertJobScheduler("autosync-tick", { every: tickMs }, { name: "tick" });
  const worker = new Worker(
    AUTOSYNC_QUEUE,
    async () => {
      const result = await runAutoSync(prisma, sync, intervalS);
      if (result.started) log.info({ autosync: result }, "background inbox checks started");
    },
    { connection, prefix, concurrency: 1 },
  );
  return { queue, worker };
}
