import { EventEmitter } from "node:events";

import type { Redis } from "ioredis";

export type SyncEventType =
  "queued" | "fetching" | "triage" | "extracting" | "provider_switch" | "saving" | "done" | "error";

export interface SyncEvent {
  seq: number;
  type: SyncEventType;
  at: string;
  data?: Record<string, unknown>;
}

export const TERMINAL: ReadonlySet<SyncEventType> = new Set(["done", "error"]);
const LOG_TTL_S = 3600;

const logKey = (runId: string) => `syncev:${runId}`;
const channel = (runId: string) => `sync:${runId}`;

/**
 * Progress events for a sync run.
 * - Every event is appended to a Redis list (replay for late subscribers) and published.
 * - One shared subscriber connection per process fans events out in-process, so N open SSE
 *   streams cost one Redis connection, not N.
 */
export class SyncEvents {
  private readonly emitter = new EventEmitter();
  private started: Promise<void> | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly subscriber: Redis,
  ) {
    this.emitter.setMaxListeners(0);
  }

  async publish(
    runId: string,
    type: SyncEventType,
    data?: Record<string, unknown>,
  ): Promise<SyncEvent> {
    const body = { type, at: new Date().toISOString(), ...(data ? { data } : {}) };
    // seq = position in the replay log, so replayed and live events share one ordering
    const seq = await this.redis.rpush(logKey(runId), JSON.stringify(body));
    const event: SyncEvent = { seq, ...body };
    await this.redis
      .multi()
      .expire(logKey(runId), LOG_TTL_S)
      .publish(channel(runId), JSON.stringify(event))
      .exec();
    return event;
  }

  async history(runId: string): Promise<SyncEvent[]> {
    const raw = await this.redis.lrange(logKey(runId), 0, -1);
    return raw.map((r, i) => ({ seq: i + 1, ...(JSON.parse(r) as Omit<SyncEvent, "seq">) }));
  }

  /** Live events for one run. Returns an unsubscribe function. */
  async subscribe(runId: string, onEvent: (e: SyncEvent) => void): Promise<() => void> {
    await this.ensureStarted();
    const name = channel(runId);
    this.emitter.on(name, onEvent);
    return () => this.emitter.off(name, onEvent);
  }

  private ensureStarted(): Promise<void> {
    this.started ??= (async () => {
      this.subscriber.on("pmessage", (_pattern: string, ch: string, message: string) => {
        try {
          this.emitter.emit(ch, JSON.parse(message) as SyncEvent);
        } catch {
          /* ignore malformed messages */
        }
      });
      await this.subscriber.psubscribe("sync:*");
    })();
    return this.started;
  }
}
