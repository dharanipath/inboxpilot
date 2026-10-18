import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";

import type { SyncJobData, SyncService } from "./sync.js";

export const SYNC_QUEUE = "sync";

/** BullMQ needs its own connections with maxRetriesPerRequest=null. */
export function createSyncQueue(connection: Redis, prefix = "bull"): Queue<SyncJobData> {
  return new Queue<SyncJobData>(SYNC_QUEUE, { connection, prefix });
}

export function createSyncWorker(
  connection: Redis,
  sync: SyncService,
  concurrency: number,
  prefix = "bull",
): Worker<SyncJobData> {
  return new Worker<SyncJobData>(SYNC_QUEUE, (job) => sync.process(job.data), {
    connection,
    concurrency,
    prefix,
  });
}

export function enqueueWith(queue: Queue<SyncJobData>) {
  return async (data: SyncJobData): Promise<void> => {
    await queue.add("sync", data, {
      jobId: data.runId,
      attempts: 1, // the worker records failures itself; retries happen per agent call
      removeOnComplete: 200,
      removeOnFail: 200,
    });
  };
}
