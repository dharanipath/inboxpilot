import type { FastifyPluginAsync } from "fastify";

import type { RouteContext } from "../app.js";

export const healthRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/health", { config: { rateLimit: false } }, async (_req, reply) => {
      const [db, redis, agent] = await Promise.all([
        ctx.prisma.$queryRaw`SELECT 1`.then(
          () => true,
          () => false,
        ),
        ctx.redis.ping().then(
          () => true,
          () => false,
        ),
        ctx.agent.health(),
      ]);
      // DB and Redis are required; without the agent the app still serves existing tasks
      const status = db && redis ? (agent ? "ok" : "degraded") : "down";
      return reply
        .status(status === "down" ? 503 : 200)
        .send({ status, checks: { db, redis, agent } });
    });
  };
