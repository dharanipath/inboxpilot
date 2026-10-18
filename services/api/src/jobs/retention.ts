import type { PrismaClient } from "@prisma/client";
import { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

/** Data retention policy (docs/SECURITY.md). Email bodies are never stored, so they need no rule. */
export const RETENTION = {
  closedTaskDays: 30, // done / dismissed tasks
  emailMetadataDays: 30, // only once none of the email's tasks remain
  syncRunDays: 30,
  auditDays: 90,
} as const;

export interface RetentionResult {
  tasks: number;
  emails: number;
  syncRuns: number;
  auditEntries: number;
  devices: number;
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

export async function runRetention(
  prisma: PrismaClient,
  now = new Date(),
): Promise<RetentionResult> {
  const tasks = await prisma.task.deleteMany({
    where: {
      status: { in: ["done", "dismissed"] },
      updatedAt: { lt: daysAgo(now, RETENTION.closedTaskDays) },
    },
  });
  // open tasks keep their source email (the evidence link and sender)
  const emails = await prisma.email.deleteMany({
    where: { receivedAt: { lt: daysAgo(now, RETENTION.emailMetadataDays) }, tasks: { none: {} } },
  });
  const syncRuns = await prisma.syncRun.deleteMany({
    where: { startedAt: { lt: daysAgo(now, RETENTION.syncRunDays) } },
  });
  const auditEntries = await prisma.auditLog.deleteMany({
    where: { at: { lt: daysAgo(now, RETENTION.auditDays) } },
  });
  const devices = await prisma.rememberedDevice.deleteMany({ where: { expiresAt: { lt: now } } });
  const result = {
    tasks: tasks.count,
    emails: emails.count,
    syncRuns: syncRuns.count,
    auditEntries: auditEntries.count,
    devices: devices.count,
  };
  await prisma.auditLog.create({ data: { action: "retention", meta: { ...result } } });
  return result;
}

export const MAINTENANCE_QUEUE = "maintenance";

/** Nightly at 03:00 server time. Upserting the scheduler is idempotent across restarts. */
export async function scheduleRetention(
  connection: Redis,
  prisma: PrismaClient,
  log: FastifyBaseLogger,
  prefix = "bull",
): Promise<{ queue: Queue; worker: Worker }> {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix });
  await queue.upsertJobScheduler(
    "retention-nightly",
    { pattern: "0 3 * * *" },
    { name: "retention" },
  );
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async () => {
      const result = await runRetention(prisma);
      log.info({ retention: result }, "retention job finished");
    },
    { connection, prefix, concurrency: 1 },
  );
  return { queue, worker };
}
