import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { RouteContext } from "../app.js";
import { AgentError } from "../agent/client.js";
import { ContractViolation } from "../agent/contract.js";
import { openTasks, toAgentTask, toDto } from "../db/tasks.js";
import { HttpProblem } from "../lib/problem.js";
import { localDate } from "../lib/time.js";
import { userContext } from "../services/context.js";

const AskBody = z.object({ question: z.string().trim().min(1).max(500) }).strict();

export function agentUnavailable(err: unknown): never {
  if (err instanceof AgentError || err instanceof ContractViolation) {
    throw new HttpProblem(
      502,
      "Assistant unavailable",
      "The agent service could not answer right now.",
    );
  }
  throw err;
}

export const assistantRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/briefing", async (req) => {
      const user = await ctx.currentUser(req);
      return ctx.briefing.get(user, new Date(), req.id);
    });

    /** "What do I owe Priya?" — answered from the user's own tasks only, with citations. */
    app.post(
      "/api/ask",
      { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
      async (req) => {
        const user = await ctx.currentUser(req);
        const { question } = AskBody.parse(req.body);
        const now = new Date();
        const today = localDate(user.timezone, now);
        const rows = await openTasks(ctx.prisma, user.id, now);
        const res = await ctx.agent
          .ask(
            {
              user: userContext(user, now),
              question,
              tasks: rows.map((r) => toAgentTask(r, today)),
              options: await ctx.llmKeys.options(user),
            },
            req.id,
          )
          .catch(agentUnavailable);
        const byId = new Map(rows.map((r) => [r.id, r]));
        return {
          answer: res.answer,
          generated_by: res.generated_by,
          cited_task_ids: res.cited_task_ids,
          tasks: res.cited_task_ids.flatMap((id) => {
            const row = byId.get(id);
            return row ? [toDto(row, today)] : [];
          }),
        };
      },
    );
  };
