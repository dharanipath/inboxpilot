import { randomUUID } from "node:crypto";

import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { PrismaClient, User } from "@prisma/client";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type { Redis } from "ioredis";

import type { AgentApi } from "./agent/client.js";
import { type SessionUser, Sessions } from "./auth/session.js";
import type { Config } from "./config.js";
import type { SyncEvents } from "./jobs/events.js";
import type { GoogleOAuth } from "./google/oauth.js";
import type { GoogleTokens } from "./google/tokens.js";
import type { SyncService } from "./jobs/sync.js";
import { HttpProblem, registerProblemHandlers, unauthorized } from "./lib/problem.js";
import { assistantRoutes } from "./routes/assistant.js";
import { llmRoutes } from "./routes/llm.js";
import { authRoutes } from "./routes/auth.js";
import { emailRoutes } from "./routes/emails.js";
import { healthRoutes } from "./routes/health.js";
import { meRoutes } from "./routes/me.js";
import { syncRoutes } from "./routes/sync.js";
import { taskRoutes } from "./routes/tasks.js";
import type { LlmKeys } from "./llm/keys.js";
import type { BriefingService } from "./services/briefing.js";

declare module "fastify" {
  interface FastifyRequest {
    session: SessionUser | null;
  }
}

export interface AppDeps {
  config: Config;
  prisma: PrismaClient;
  redis: Redis;
  agent: AgentApi;
  sync: SyncService;
  events: SyncEvents;
  briefing: BriefingService;
  llmKeys: LlmKeys;
  sessions: Sessions;
  /** null when Google sign-in is not configured: the app then cannot sign anyone in. */
  google: { oauth: GoogleOAuth; tokens: GoogleTokens } | null;
}

export interface RouteContext extends AppDeps {
  authenticate: (req: FastifyRequest) => Promise<void>;
  currentUser: (req: FastifyRequest) => Promise<User>;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const loggerOptions = (level: string): FastifyServerOptions["logger"] => ({
  level,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "*.refreshToken",
      "*.refresh_token",
      "*.body_text",
      "*.token",
      "*.api_key",
      "*.provider_keys",
    ],
    censor: "[redacted]",
  },
});

export async function buildApp(
  deps: AppDeps,
  log: Pick<FastifyServerOptions, "logger" | "loggerInstance"> = { logger: false },
): Promise<FastifyInstance> {
  const app = Fastify({
    ...log,
    trustProxy: true,
    bodyLimit: 256 * 1024,
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  // Only JSON bodies: a text/plain or form POST is a "simple" cross-site request (no preflight).
  app.removeContentTypeParser("text/plain");

  registerProblemHandlers(app);
  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: deps.config.rateLimitPerMin,
    timeWindow: "1 minute",
    redis: deps.redis,
    nameSpace: "rl:",
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      message: `Rate limit exceeded; retry in ${ctx.after}`,
    }),
  });

  app.decorateRequest("session", null);

  app.addHook("onRequest", async (req) => {
    // CSRF defence in depth (with SameSite=Lax cookies): reject mutating requests from foreign origins
    const origin = req.headers.origin;
    if (MUTATING.has(req.method) && origin && !deps.config.webOrigins.includes(origin)) {
      throw new HttpProblem(403, "Forbidden", "Cross-origin request rejected");
    }
  });
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  const authenticate = async (req: FastifyRequest): Promise<void> => {
    const session = await deps.sessions.verify(req.cookies.ip_session);
    if (!session) throw unauthorized();
    req.session = session;
  };
  const currentUser = async (req: FastifyRequest): Promise<User> => {
    if (!req.session) await authenticate(req);
    const user = await deps.prisma.user.findUnique({ where: { id: req.session?.userId ?? "" } });
    if (!user) throw unauthorized();
    return user;
  };

  const ctx: RouteContext = { ...deps, authenticate, currentUser };
  await app.register(healthRoutes(ctx));
  await app.register(authRoutes(ctx));
  await app.register(meRoutes(ctx));
  await app.register(syncRoutes(ctx));
  await app.register(taskRoutes(ctx));
  await app.register(emailRoutes(ctx));
  await app.register(assistantRoutes(ctx));
  await app.register(llmRoutes(ctx));
  return app;
}
