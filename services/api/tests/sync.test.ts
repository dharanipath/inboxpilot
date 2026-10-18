import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AgentError } from "../src/agent/client.js";
import { fixtureInbox } from "./fixtures/inbox.js";
import { addDays, localDate } from "../src/lib/time.js";
import {
  login,
  makeTestApp,
  resetState,
  syncAndWait,
  type TestApp,
  waitForRun,
} from "./helpers.js";

let t: TestApp;
let base: string;
beforeAll(async () => {
  t = await makeTestApp();
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await resetState(t);
});
afterAll(async () => {
  await t.close();
});

const INBOX_SIZE = fixtureInbox(new Date(), "UTC").length;
const NOISE = fixtureInbox(new Date(), "UTC").filter(
  (e) => e.list_unsubscribe || e.labels?.some((l) => l.startsWith("CATEGORY_")),
).length;

interface SseEvent {
  id: string;
  event: string;
  data: { seq: number; type: string; data?: Record<string, unknown> };
}

/** Minimal SSE client: collects events until the server closes the stream. */
function readSse(
  path: string,
  cookie: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  contentType: string;
  events: SseEvent[];
}> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${path}`, { headers: { cookie, ...headers } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (buf += chunk));
      res.on("end", () => {
        const events = buf
          .split("\n\n")
          .filter((b) => b.startsWith("id:"))
          .map((block) => {
            const field = (name: string) =>
              block
                .split("\n")
                .find((l) => l.startsWith(`${name}: `))
                ?.slice(name.length + 2) ?? "";
            return {
              id: field("id"),
              event: field("event"),
              data: JSON.parse(field("data")) as SseEvent["data"],
            };
          });
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"]),
          events,
        });
      });
    });
    req.on("error", reject);
  });
}

describe("POST /api/sync + SSE", () => {
  it("runs the fixture inbox through the agent and streams progress until done", async () => {
    const { cookie, userId } = await login(t);
    t.agent.degradedDetail = "gemini rate-limited → groq";
    const res = await t.http
      .post("/api/sync")
      .set("cookie", cookie)
      .set("x-request-id", "sync-req-1")
      .send({})
      .expect(202);
    const { jobId } = res.body as { jobId: string };
    expect(res.body).toMatchObject({ events: `/api/sync/${jobId}/events` });

    const sse = await readSse(`/api/sync/${jobId}/events`, cookie);
    expect(sse.status).toBe(200);
    expect(sse.contentType).toMatch(/text\/event-stream/);
    const types = sse.events.map((e) => e.event);
    expect(types[0]).toBe("queued");
    expect(types).toEqual(
      expect.arrayContaining(["fetching", "triage", "extracting", "provider_switch", "saving"]),
    );
    expect(types.at(-1)).toBe("done");
    expect(sse.events.map((e) => e.data.seq)).toEqual(sse.events.map((_, i) => i + 1)); // ordered, no gaps

    expect(await waitForRun(t, jobId)).toBe("succeeded");
    const { prisma } = t.container.deps;
    expect(await prisma.task.count({ where: { userId } })).toBe(INBOX_SIZE - NOISE);
    const emails = await prisma.email.findMany({ where: { userId } });
    expect(emails).toHaveLength(INBOX_SIZE);
    expect(emails.every((e) => e.status !== "pending")).toBe(true);
    expect(emails.filter((e) => e.status === "skipped")).toHaveLength(NOISE);

    // batches of 12, request id propagated, briefing turned off per chunk
    expect(t.agent.extractCalls.map((c) => c.emails.length)).toEqual([12, 12, INBOX_SIZE - 24]);
    expect(t.agent.extractCalls[0]?.options).toMatchObject({ use_llm_briefing: false });
    expect(t.agent.briefingCalls).toHaveLength(1); // one briefing over ALL open tasks

    const run = await t.http.get(`/api/sync/${jobId}`).set("cookie", cookie).expect(200);
    expect(run.body.status).toBe("succeeded");
    expect(run.body.stats).toMatchObject({
      fetched: INBOX_SIZE,
      processed: INBOX_SIZE,
      tasks_written: INBOX_SIZE - NOISE,
    });
    const extract = (
      run.body.trace as { step: string; status: string; counts: Record<string, number> }[]
    ).find((s) => s.step === "extract");
    expect(extract).toMatchObject({ status: "degraded", counts: { items: INBOX_SIZE - NOISE } });
    expect(run.body.provider_usage).toEqual([
      expect.objectContaining({ provider: "fake", calls: 3 }),
    ]);

    const me = await t.http.get("/api/me").set("cookie", cookie).expect(200);
    expect(me.body.last_sync_at).not.toBeNull();
  });

  it("never stores email bodies in Postgres and drops them from Redis after the run", async () => {
    const { cookie } = await login(t);
    await syncAndWait(t, cookie);
    const columns = await t.container.deps.prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'`;
    expect(columns.map((c) => c.column_name)).not.toContain("body_text");
    expect(columns.map((c) => c.column_name)).not.toContain("body");
    expect(await t.container.deps.redis.keys("body:*")).toEqual([]);
  });

  it("replays history to late subscribers and honours Last-Event-ID", async () => {
    const { cookie } = await login(t);
    const { runId } = await syncAndWait(t, cookie);
    const all = await readSse(`/api/sync/${runId}/events`, cookie);
    expect(all.events.at(-1)?.event).toBe("done");
    const tail = await readSse(`/api/sync/${runId}/events`, cookie, { "last-event-id": "3" });
    expect(tail.events[0]?.data.seq).toBe(4);
  });

  it("synthesises the terminal event when the event log has expired", async () => {
    const { cookie } = await login(t);
    const { runId } = await syncAndWait(t, cookie);
    await t.container.deps.redis.del(`syncev:${runId}`);
    const sse = await readSse(`/api/sync/${runId}/events`, cookie);
    expect(sse.events.map((e) => e.event)).toEqual(["done"]);
  });

  it("allows one running sync per user (409 with the live job id)", async () => {
    const { cookie } = await login(t);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = t.agent.extract.bind(t.agent);
    t.agent.extract = async (req) => {
      await gate;
      return original(req);
    };
    try {
      const first = await t.http.post("/api/sync").set("cookie", cookie).send({}).expect(202);
      const second = await t.http.post("/api/sync").set("cookie", cookie).send({}).expect(409);
      expect(second.body).toMatchObject({ title: "Sync already running", jobId: first.body.jobId });
      // another user is not blocked
      const other = await login(t);
      await t.http.post("/api/sync").set("cookie", other.cookie).send({}).expect(202);
      release();
      await waitForRun(t, (first.body as { jobId: string }).jobId);
    } finally {
      t.agent.extract = original;
      release();
    }
    await syncAndWait(t, cookie); // lock released
  });

  it("re-sync is idempotent: processed emails are skipped and nothing is duplicated", async () => {
    const { cookie, userId } = await login(t);
    await syncAndWait(t, cookie);
    const before = await t.container.deps.prisma.task.count({ where: { userId } });
    const calls = t.agent.extractCalls.length;

    const { runId } = await syncAndWait(t, cookie);
    expect(t.agent.extractCalls.length).toBe(calls); // nothing new to extract
    expect(await t.container.deps.prisma.task.count({ where: { userId } })).toBe(before);
    const run = await t.http.get(`/api/sync/${runId}`).set("cookie", cookie).expect(200);
    expect(run.body.stats).toMatchObject({ processed: 0, already_processed: INBOX_SIZE });
  });

  it("reprocess never reopens a done task or overwrites a user-edited due date", async () => {
    const { cookie, userId } = await login(t, "Asia/Kolkata");
    await syncAndWait(t, cookie);
    const list = await t.http.get("/api/tasks").set("cookie", cookie).expect(200);
    const [a, b] = list.body.items as { id: string }[];
    if (!a || !b) throw new Error("expected tasks");
    const userDue = addDays(localDate("Asia/Kolkata"), 3);
    await t.http
      .patch(`/api/tasks/${a.id}`)
      .set("cookie", cookie)
      .send({ status: "done" })
      .expect(200);
    await t.http
      .patch(`/api/tasks/${b.id}`)
      .set("cookie", cookie)
      .send({ due_date: userDue })
      .expect(200);

    t.agent.specs.set("msg-01", { title: "Changed title from a new model" });
    await syncAndWait(t, cookie, { reprocess: true });
    expect(t.agent.extractCalls.length).toBe(6);

    const { prisma } = t.container.deps;
    expect(await prisma.task.count({ where: { userId } })).toBe(INBOX_SIZE - NOISE);
    const doneTask = await prisma.task.findUniqueOrThrow({
      where: { userId_id: { userId, id: a.id } },
    });
    expect(doneTask.status).toBe("done");
    const edited = await prisma.task.findUniqueOrThrow({
      where: { userId_id: { userId, id: b.id } },
    });
    expect(edited.dueDate?.toISOString().slice(0, 10)).toBe(userDue);
    expect(edited.dateSource).toBe("user");
    const retitled = await prisma.task.findFirstOrThrow({
      where: { userId, email: { gmailId: "msg-01" } },
    });
    expect(retitled.title).toBe("Changed title from a new model"); // extraction fields do refresh
  });

  it("records a failed run, streams an error event and releases the lock", async () => {
    const { cookie } = await login(t);
    t.agent.failExtract = new AgentError(
      "agent POST /v1/extract failed: 422 Request validation failed",
      422,
    );
    const res = await t.http.post("/api/sync").set("cookie", cookie).send({}).expect(202);
    const { jobId } = res.body as { jobId: string };
    const sse = await readSse(`/api/sync/${jobId}/events`, cookie);
    expect(sse.events.at(-1)).toMatchObject({ event: "error" });
    expect(sse.events.at(-1)?.data.data?.message).toContain("422");
    expect(await waitForRun(t, jobId)).toBe("failed");
    t.agent.failExtract = null;
    expect((await syncAndWait(t, cookie)).status).toBe("succeeded");
  });

  it("retries a transient agent failure once", async () => {
    const { cookie } = await login(t);
    const original = t.agent.extract.bind(t.agent);
    let failures = 1;
    t.agent.extract = (req) => {
      if (failures-- > 0) return Promise.reject(new AgentError("agent unreachable"));
      return original(req);
    };
    try {
      expect((await syncAndWait(t, cookie)).status).toBe("succeeded");
    } finally {
      t.agent.extract = original;
    }
  });

  it("lists runs, scopes runs to their owner and validates input", async () => {
    const { cookie } = await login(t);
    const { runId } = await syncAndWait(t, cookie);
    const runs = await t.http.get("/api/sync/runs").set("cookie", cookie).expect(200);
    expect(runs.body.items).toHaveLength(1);
    expect(runs.body.items[0]).toMatchObject({ id: runId, status: "succeeded" });

    const other = await login(t);
    await t.http.get(`/api/sync/${runId}`).set("cookie", other.cookie).expect(404);
    const sse = await t.http.get(`/api/sync/${runId}/events`).set("cookie", other.cookie);
    expect(sse.status).toBe(404);
    await t.http.get("/api/sync/not-a-uuid").set("cookie", cookie).expect(400);
    await t.http.post("/api/sync").set("cookie", cookie).send({ days: 90 }).expect(400);
    await t.http.post("/api/sync").send({}).expect(401);
  });
});
