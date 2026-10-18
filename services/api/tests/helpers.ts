import type { FastifyInstance } from "fastify";
import request from "supertest";

import { buildApp } from "../src/app.js";
import { type Config, loadConfig } from "../src/config.js";
import { type Container, createContainer } from "../src/container.js";
import type { MailSource } from "../src/mail/source.js";
import { FakeAgent } from "./fake-agent.js";
import { FixtureMailSource } from "./fixtures/inbox.js";

const silent = {
  level: "silent",
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  silent: () => undefined,
  child() {
    return silent;
  },
};

export interface TestApp {
  app: FastifyInstance;
  container: Container;
  agent: FakeAgent;
  http: ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function makeTestApp(
  opts: {
    agent?: FakeAgent;
    sources?: Partial<Record<string, MailSource>>;
    config?: Partial<Config>;
    googleFetch?: typeof fetch;
  } = {},
): Promise<TestApp> {
  const config = { ...loadConfig(), ...opts.config };
  const agent = opts.agent ?? new FakeAgent();
  const container = createContainer(config, {
    log: silent as never,
    agent,
    // users read the fixture inbox, unless a test drives the real Gmail client against fake Google
    ...(opts.sources
      ? { sources: opts.sources }
      : opts.googleFetch
        ? {}
        : { sources: { google: new FixtureMailSource() } }),
    queuePrefix: "bulltest",
    ...(opts.googleFetch ? { googleFetch: opts.googleFetch } : {}),
  });
  const app = await buildApp(container.deps);
  await app.ready();
  return {
    app,
    container,
    agent,
    http: request(app.server),
    async close() {
      await app.close();
      await container.close();
    },
  };
}

/** Fresh state between tests: empty tables, and every Redis key except the queue's own. */
export async function resetState(t: TestApp): Promise<void> {
  const { prisma, redis } = t.container.deps;
  await prisma.$executeRawUnsafe(
    'TRUNCATE "audit_log", "sync_runs", "tasks", "emails", "users" RESTART IDENTITY CASCADE',
  );
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "COUNT", 500);
    cursor = next;
    const mine = keys.filter((k) => !k.startsWith("bulltest:"));
    if (mine.length) await redis.del(...mine);
  } while (cursor !== "0");
  t.agent.reset();
}

let users = 0;

/**
 * TEST ONLY: create a signed-in Google user directly (the app has no other way in than Google
 * sign-in, which google-flow.test.ts covers end to end). Returns the session cookie.
 */
export async function login(
  t: TestApp,
  timezone = "Asia/Kolkata",
): Promise<{ cookie: string; userId: string }> {
  const { prisma, sessions } = t.container.deps;
  users += 1;
  const user = await prisma.user.create({
    data: {
      email: `sam${users}-${Date.now()}@gmail.example`,
      name: "Sam Rao",
      authMode: "google",
      timezone,
      vipSenders: ["ceo@acme.example"],
      refreshTokenEnc: new Uint8Array([1]), // marks the inbox as connected (fixture source ignores it)
    },
  });
  const { token } = await sessions.issue(user.id, "google");
  return { cookie: `ip_session=${token}`, userId: user.id };
}

export async function waitForRun(t: TestApp, runId: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await t.container.deps.prisma.syncRun.findUnique({ where: { id: runId } });
    if (run && (run.status === "succeeded" || run.status === "failed")) return run.status;
    if (Date.now() > deadline)
      throw new Error(`run ${runId} did not finish (status ${run?.status})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function syncAndWait(
  t: TestApp,
  cookie: string,
  body: Record<string, unknown> = {},
): Promise<{ runId: string; status: string }> {
  const res = await t.http.post("/api/sync").set("cookie", cookie).send(body).expect(202);
  const runId = (res.body as { jobId: string }).jobId;
  return { runId, status: await waitForRun(t, runId) };
}
