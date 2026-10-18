import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AgentError } from "../src/agent/client.js";
import { login, makeTestApp, resetState, syncAndWait, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
beforeEach(async () => {
  await resetState(t);
});
afterAll(async () => {
  await t.close();
});

describe("settings", () => {
  it("updates timezone, VIP senders and provider order with validation", async () => {
    const { cookie } = await login(t);
    const res = await t.http
      .patch("/api/me/settings")
      .set("cookie", cookie)
      .send({
        timezone: "America/New_York",
        vip_senders: ["Boss@Corp.com", "@client.io", "boss@corp.com"],
        llm_providers: ["groq", "gemini"],
      })
      .expect(200);
    expect(res.body).toMatchObject({
      timezone: "America/New_York",
      vip_senders: ["boss@corp.com", "@client.io"],
      llm_providers: ["groq", "gemini"],
    });

    // the provider order is passed to the agent on the next sync
    await syncAndWait(t, cookie);
    expect(t.agent.extractCalls[0]?.options?.providers).toEqual(["groq", "gemini"]);
    expect(t.agent.extractCalls[0]?.user.vip_senders).toEqual(["boss@corp.com", "@client.io"]);

    for (const bad of [
      { timezone: "Not/AZone" },
      { vip_senders: ["not an email"] },
      { llm_providers: ["chatgpt-pro"] },
      { unknown: 1 },
      {},
    ]) {
      await t.http.patch("/api/me/settings").set("cookie", cookie).send(bad).expect(400);
    }
  });
});

describe("DELETE /api/me", () => {
  it("deletes every row for the user, revokes the session and keeps an audit record", async () => {
    const { cookie, userId } = await login(t);
    const other = await login(t);
    await syncAndWait(t, cookie);
    await syncAndWait(t, other.cookie);
    const { prisma } = t.container.deps;

    await t.http.delete("/api/me").set("cookie", cookie).expect(204);
    expect(await prisma.user.count({ where: { id: userId } })).toBe(0);
    expect(await prisma.email.count({ where: { userId } })).toBe(0);
    expect(await prisma.task.count({ where: { userId } })).toBe(0);
    expect(await prisma.syncRun.count({ where: { userId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { userId, action: "delete_account" } })).toBe(1);
    await t.http.get("/api/me").set("cookie", cookie).expect(401);

    // the other user is untouched
    expect(await prisma.task.count({ where: { userId: other.userId } })).toBeGreaterThan(0);
  });
});

describe("briefing", () => {
  it("covers all open tasks, is cached per day, and counts are always live", async () => {
    const { cookie } = await login(t);
    await syncAndWait(t, cookie);
    const callsAfterSync = t.agent.briefingCalls.length;
    expect(callsAfterSync).toBe(1);

    const b = await t.http.get("/api/briefing").set("cookie", cookie).expect(200);
    expect(b.body).toMatchObject({
      generated_by: "fake",
      headline: expect.stringMatching(/open tasks$/),
    });
    expect(t.agent.briefingCalls.length).toBe(callsAfterSync); // served from cache
    const total = Object.values(b.body.counts as Record<string, number>).reduce((a, n) => a + n, 0);

    const first = (await t.http.get("/api/tasks").set("cookie", cookie)).body.items[0] as {
      id: string;
    };
    await t.http
      .patch(`/api/tasks/${first.id}`)
      .set("cookie", cookie)
      .send({ status: "done" })
      .expect(200);
    const after = await t.http.get("/api/briefing").set("cookie", cookie).expect(200);
    const totalAfter = Object.values(after.body.counts as Record<string, number>).reduce(
      (a, n) => a + n,
      0,
    );
    expect(totalAfter).toBe(total - 1);
    expect(t.agent.briefingCalls.length).toBe(callsAfterSync + 1); // edit invalidated the text
    expect(t.agent.briefingCalls.at(-1)?.tasks.some((tk) => tk.id === first.id)).toBe(false);
  });

  it("falls back to a gateway template when the agent is down", async () => {
    const { cookie } = await login(t);
    t.agent.failBriefing = true;
    const b = await t.http.get("/api/briefing").set("cookie", cookie).expect(200);
    expect(b.body).toMatchObject({
      generated_by: "gateway-template",
      headline: "Nothing due today",
    });
  });
});

describe("ask + providers + health", () => {
  it("answers from the user's own tasks and drops citations it cannot resolve", async () => {
    const { cookie } = await login(t);
    await syncAndWait(t, cookie);
    const res = await t.http
      .post("/api/ask")
      .set("cookie", cookie)
      .send({ question: "What do I owe Priya?" })
      .expect(200);
    expect(res.body.generated_by).toBe("fake");
    expect(res.body.tasks).toHaveLength(1); // "t_unknown" citation dropped
    const sent = t.agent.askCalls[0];
    expect(sent?.question).toBe("What do I owe Priya?");
    expect(sent?.tasks.every((tk) => tk.bucket.length > 0)).toBe(true);

    await t.http.post("/api/ask").set("cookie", cookie).send({ question: "" }).expect(400);
    await t.http
      .post("/api/ask")
      .set("cookie", cookie)
      .send({ question: "x".repeat(501) })
      .expect(400);
  });

  it("returns 502 problem+json when the agent cannot answer", async () => {
    const { cookie } = await login(t);
    const original = t.agent.ask.bind(t.agent);
    t.agent.ask = () => Promise.reject(new AgentError("agent unreachable"));
    try {
      const res = await t.http
        .post("/api/ask")
        .set("cookie", cookie)
        .send({ question: "hi" })
        .expect(502);
      expect(res.body.title).toBe("Assistant unavailable");
    } finally {
      t.agent.ask = original;
    }
  });

  it("proxies provider status for signed-in users only", async () => {
    await t.http.get("/api/providers").expect(401);
    const { cookie } = await login(t);
    const res = await t.http.get("/api/providers").set("cookie", cookie).expect(200);
    expect(res.body.mode).toBe("auto");
    expect(res.body.providers).toContainEqual(
      expect.objectContaining({ name: "heuristic", configured: true, label: "Rules only (no AI)" }),
    );
  });

  it("reports dependency health", async () => {
    const ok = await t.http.get("/api/health").expect(200);
    expect(ok.body).toEqual({ status: "ok", checks: { db: true, redis: true, agent: true } });
    const original = t.agent.health.bind(t.agent);
    t.agent.health = () => Promise.resolve(false);
    try {
      const degraded = await t.http.get("/api/health").expect(200);
      expect(degraded.body.status).toBe("degraded");
    } finally {
      t.agent.health = original;
    }
  });
});
