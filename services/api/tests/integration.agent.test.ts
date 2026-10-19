/**
 * Cross-service test: real gateway + real Python agent (heuristic provider, no LLM keys)
 * + real Postgres/Redis. Skipped when services/agent/.venv is not set up.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { type Container, createContainer } from "../src/container.js";
import { localDate } from "../src/lib/time.js";
import { FixtureMailSource } from "./fixtures/inbox.js";
import { login, waitForRun } from "./helpers.js";

const AGENT_DIR = resolve(import.meta.dirname, "..", "..", "agent");
const PYTHON = [
  resolve(AGENT_DIR, ".venv", "Scripts", "python.exe"),
  resolve(AGENT_DIR, ".venv", "bin", "python"),
].find((p) => existsSync(p));

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => ok(port));
    });
    srv.on("error", fail);
  });
}

describe.skipIf(!PYTHON)("gateway ↔ real Python agent", () => {
  let agentProc: ChildProcess | undefined;
  let container: Container | undefined;
  let app: FastifyInstance | undefined;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const port = await freePort();
    // the agent must run with no LLM keys: heuristic only, never a real model
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !/_API_KEY$|^GITHUB_TOKEN$|^OLLAMA_BASE_URL$|^REDIS_URL$|^LLM_PROVIDERS$/.test(k),
      ),
    );
    env.INTERNAL_API_KEY = "test-internal-key";
    env.LLM_PROVIDERS = "heuristic";
    agentProc = spawn(
      PYTHON ?? "python",
      [
        "-m",
        "uvicorn",
        "app.main:create_app",
        "--factory",
        "--port",
        String(port),
        "--log-level",
        "warning",
      ],
      {
        cwd: AGENT_DIR,
        env,
        stdio: "ignore",
      },
    );
    const agentUrl = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${agentUrl}/v1/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (i > 150) throw new Error("agent did not start");
      await new Promise((r) => setTimeout(r, 100));
    }

    const config = { ...loadConfig(), agentUrl };
    const c = createContainer(config, {
      log: {
        level: "silent",
        info() {},
        warn() {},
        error() {},
        debug() {},
        fatal() {},
        trace() {},
        silent() {},
        child() {
          return this;
        },
      } as never,
      queuePrefix: "bullint",
      sources: { google: new FixtureMailSource() },
    });
    container = c;
    await c.deps.prisma.$executeRawUnsafe(
      'TRUNCATE "audit_log", "sync_runs", "tasks", "emails", "users" RESTART IDENTITY CASCADE',
    );
    const a = await buildApp(c.deps);
    app = a;
    await a.ready();
    http = request(a.server);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await container?.close();
    agentProc?.kill();
  });

  it("syncs the fixture inbox end to end and the results make sense", async () => {
    if (!container) throw new Error("setup failed");
    const { cookie, userId } = await login({ container } as never, "Asia/Kolkata");

    const started = await http.post("/api/sync").set("cookie", cookie).send({}).expect(202);
    const runId = (started.body as { jobId: string }).jobId;
    expect(await waitForRun({ container } as never, runId, 30_000)).toBe("succeeded");

    const run = (await http.get(`/api/sync/${runId}`).set("cookie", cookie).expect(200)).body as {
      trace: { step: string; status: string }[];
      provider_usage: { provider: string }[];
      briefing: { generated_by: string } | null;
    };
    expect(run.trace.map((s) => s.step)).toEqual([
      "preprocess",
      "triage",
      "extract",
      "ground",
      "dates",
      "priority",
      "plan",
    ]);
    expect(run.provider_usage.map((u) => u.provider)).toEqual(["heuristic"]);
    expect(run.briefing?.generated_by).toBe("template");

    const { prisma } = container.deps;
    const emails = new Map(
      (await prisma.email.findMany({ where: { userId } })).map((e) => [e.gmailId, e]),
    );
    expect(emails.get("msg-06")?.skipReason).toBe("newsletter");
    expect(emails.get("msg-07")?.skipReason).toBe("promotion");
    expect(emails.get("msg-08")?.skipReason).toBe("automated"); // OTP
    expect(emails.get("msg-09")?.status).toBe("skipped"); // prompt injection: no task
    expect([...emails.values()].every((e) => e.status !== "pending")).toBe(true);

    const items = (await http.get("/api/tasks?limit=200").set("cookie", cookie).expect(200)).body
      .items as {
      email_id: string;
      bucket: string;
      priority_reasons: string[];
      due_at: string | null;
      evidence: string;
      source: { thread_id: string };
    }[];
    expect(items.length).toBeGreaterThan(10);
    expect(items.some((i) => i.email_id === "msg-09")).toBe(false);
    expect(items.filter((i) => i.source.thread_id === "thread-contract")).toHaveLength(1); // deduped
    const ceo = items.find((i) => i.email_id === "msg-28");
    expect(ceo?.priority_reasons).toContain("VIP sender");
    expect(ceo?.priority_reasons).toContain("Marked urgent");
    expect(items.every((i) => !/\d{5} ?\d{5}/.test(i.evidence))).toBe(true); // no raw phone/account numbers

    const localHour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "numeric",
        hourCycle: "h23",
      }).format(new Date()),
    );
    if (localHour >= 2) {
      // fixture mail is sent 1-3 h ago; near midnight "today" in the email can be yesterday
      const expense = items.find((i) => i.email_id === "msg-13");
      expect(expense?.bucket).toBe("today");
      expect(expense?.due_at && localDate("Asia/Kolkata", new Date(expense.due_at))).toBe(
        localDate("Asia/Kolkata"),
      );
    }

    const ask = await http
      .post("/api/ask")
      .set("cookie", cookie)
      .send({ question: "What do I owe Priya?" })
      .expect(200);
    expect(ask.body.generated_by).toBe("rules");
    expect((ask.body.tasks as unknown[]).length).toBeGreaterThan(0);

    const providers = await http.get("/api/providers").set("cookie", cookie).expect(200);
    expect(
      (providers.body.providers as { name: string; configured: boolean }[])
        .filter((p) => p.configured)
        .map((p) => p.name),
    ).toEqual(["heuristic"]);

    const health = await http.get("/api/health").expect(200);
    expect(health.body.status).toBe("ok");
  }, 60_000);
});
