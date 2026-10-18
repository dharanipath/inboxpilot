import type { PrismaClient, User } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

import type { AgentApi } from "../agent/client.js";
import { countBuckets, openTasks, toAgentTask } from "../db/tasks.js";
import { type Bucket, localDate } from "../lib/time.js";
import type { LlmKeys } from "../llm/keys.js";
import { userContext } from "./context.js";

export interface BriefingView {
  headline: string;
  summary: string;
  generated_by: string;
  generated_at: string;
  counts: Record<Bucket, number>;
  today: string;
}

const TTL_S = 6 * 3600;
const key = (userId: string, today: string) => `briefing:${userId}:${today}`;

/**
 * Daily briefing over ALL open tasks. Counts are always computed live from the database;
 * the text comes from the agent (/v1/briefing), cached per user per local day, with a
 * template fallback when the agent is unreachable.
 */
export class BriefingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly agent: AgentApi,
    private readonly log: FastifyBaseLogger,
    private readonly llmKeys: LlmKeys,
  ) {}

  async get(user: User, now = new Date(), requestId?: string): Promise<BriefingView> {
    const today = localDate(user.timezone, now);
    const rows = await openTasks(this.prisma, user.id, now);
    const counts = countBuckets(rows, today);

    const cached = await this.redis.get(key(user.id, today));
    if (cached) return { ...(JSON.parse(cached) as BriefingView), counts, today };

    let text: Pick<BriefingView, "headline" | "summary" | "generated_by">;
    try {
      const b = await this.agent.briefing(
        {
          user: userContext(user, now),
          tasks: rows.map((r) => toAgentTask(r, today)),
          options: {
            horizon_days: 7,
            use_llm_briefing: true,
            ...(await this.llmKeys.options(user)),
          },
        },
        requestId,
      );
      text = { headline: b.headline, summary: b.summary, generated_by: b.generated_by };
    } catch (err) {
      this.log.warn({ err }, "agent briefing failed; using gateway template");
      return { ...fallback(counts), generated_at: now.toISOString(), counts, today };
    }
    const view: BriefingView = { ...text, generated_at: now.toISOString(), counts, today };
    await this.redis.set(key(user.id, today), JSON.stringify(view), "EX", TTL_S);
    return view;
  }

  async invalidate(user: Pick<User, "id" | "timezone">, now = new Date()): Promise<void> {
    await this.redis.del(key(user.id, localDate(user.timezone, now)));
  }
}

function fallback(
  counts: Record<Bucket, number>,
): Pick<BriefingView, "headline" | "summary" | "generated_by"> {
  const parts = [counts.today ? `${counts.today} due today` : "Nothing due today"];
  if (counts.overdue) parts.push(`${counts.overdue} overdue`);
  return {
    headline: parts.join(", "),
    summary: `${counts.week} more due this week. The assistant is offline, so this is a summary of counts only.`,
    generated_by: "gateway-template",
  };
}
