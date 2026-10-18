import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runAutoSync } from "../src/jobs/autosync.js";
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
beforeAll(async () => {
  t = await makeTestApp();
});
beforeEach(async () => {
  await resetState(t);
});
afterAll(async () => {
  await t.close();
});

const MIN = 60_000;
const latestRun = (userId: string) =>
  t.container.deps.prisma.syncRun.findFirst({ where: { userId }, orderBy: { startedAt: "desc" } });

describe("background auto-sync", () => {
  it("checks every connected inbox that is due, and only those", async () => {
    const { prisma, sync } = t.container.deps;
    const never = await login(t); // never synced: due
    const fresh = await login(t); // synced a moment ago: not due
    await prisma.user.update({ where: { id: fresh.userId }, data: { lastSyncAt: new Date() } });
    const revoked = await login(t); // Google access revoked: no token, never checked
    await prisma.user.update({ where: { id: revoked.userId }, data: { refreshTokenEnc: null } });

    const result = await runAutoSync(prisma, sync, 120);
    expect(result).toEqual({ started: 1, skipped: 0 });
    const run = await latestRun(never.userId);
    expect(run?.stats).toMatchObject({ trigger: "auto" });
    expect(await waitForRun(t, run?.id ?? "")).toBe("succeeded");
    expect(await prisma.task.count({ where: { userId: never.userId } })).toBeGreaterThan(0);
    expect(await latestRun(fresh.userId)).toBeNull();
    expect(await latestRun(revoked.userId)).toBeNull();
  });

  it("a background check that finds nothing new leaves no run behind but advances last sync", async () => {
    const { prisma, sync } = t.container.deps;
    const { cookie, userId } = await login(t);
    await syncAndWait(t, cookie); // first sync processes everything
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const later = new Date(Date.now() + 10 * MIN);
    expect(await runAutoSync(prisma, sync, 120, later)).toEqual({ started: 1, skipped: 0 });
    for (let i = 0; i < 200 && (await prisma.syncRun.count({ where: { userId } })) > 1; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await prisma.syncRun.count({ where: { userId } })).toBe(1); // only the manual run
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.lastSyncAt?.getTime()).toBeGreaterThan(before.lastSyncAt?.getTime() ?? 0);
  });

  it("backs off after a failed run and skips users who are already syncing", async () => {
    const { prisma, sync } = t.container.deps;
    const failing = await login(t);
    t.agent.failExtract = new Error("agent down");
    const { status } = await syncAndWait(t, failing.cookie);
    expect(status).toBe("failed");
    t.agent.failExtract = null;
    await prisma.user.update({ where: { id: failing.userId }, data: { lastSyncAt: null } });

    const busy = await login(t);
    await t.container.deps.redis.set(`synclock:${busy.userId}`, "someone-else", "EX", 60);

    expect(await runAutoSync(prisma, sync, 120)).toEqual({ started: 0, skipped: 2 });
    // after the back-off window it is checked again
    expect(await runAutoSync(prisma, sync, 120, new Date(Date.now() + 11 * MIN))).toMatchObject({
      started: 1,
    });
  });
});

describe("GET /api/emails (the 7 days before today)", () => {
  interface EmailItem {
    id: string;
    received_at: string;
    local_date: string;
    status: string;
    skip_reason: string | null;
    gmail_url: string;
    tasks: { id: string; status: string; title: string }[];
  }
  const DAY = 86_400_000;

  /** Sync the fixture inbox, then pin a few emails to known ages (the rest go far back). */
  async function syncWithAges(cookie: string, userId: string, ages: Record<string, number>) {
    await syncAndWait(t, cookie);
    const { prisma } = t.container.deps;
    await prisma.email.updateMany({
      where: { userId },
      data: { receivedAt: new Date(Date.now() - 20 * DAY) },
    });
    for (const [gmailId, ms] of Object.entries(ages)) {
      await prisma.email.updateMany({
        where: { userId, gmailId },
        data: { receivedAt: new Date(Date.now() - ms) },
      });
    }
  }

  it("lists the past days' mail newest first with what happened to each one, never today's", async () => {
    const { cookie, userId } = await login(t);
    await syncWithAges(cookie, userId, {
      "msg-02": 60_000, // today: belongs to Upcoming, not here
      "msg-01": 1 * DAY,
      "msg-07": 2 * DAY,
      "msg-03": 7 * DAY,
      "msg-04": 9 * DAY, // too old
    });
    const res = await t.http.get("/api/emails?days=7").set("cookie", cookie).expect(200);
    const items = res.body.items as EmailItem[];
    const today = localDate("Asia/Kolkata");
    expect(res.body).toMatchObject({
      days: 7,
      today,
      from: addDays(today, -7),
      timezone: "Asia/Kolkata",
    });
    expect(items.map((e) => e.id)).toEqual(["msg-01", "msg-07", "msg-03"]);
    expect(items.every((e) => e.local_date < today)).toBe(true);

    const promo = items.find((e) => e.id === "msg-07");
    expect(promo).toMatchObject({ status: "skipped", skip_reason: expect.any(String), tasks: [] });
    const withTask = items.find((e) => e.id === "msg-01");
    expect(withTask?.status).toBe("processed");
    expect(withTask?.tasks).toHaveLength(1);
    expect(withTask?.gmail_url).toMatch(/^https:\/\/mail\.google\.com\//);
    expect(withTask?.local_date).toBe(addDays(today, -1));

    // done tasks stay visible here (it is a history view)
    const taskId = withTask?.tasks[0]?.id ?? "";
    await t.http
      .patch(`/api/tasks/${taskId}`)
      .set("cookie", cookie)
      .send({ status: "done" })
      .expect(200);
    const again = await t.http.get("/api/emails").set("cookie", cookie).expect(200);
    const reread = (again.body.items as EmailItem[]).find((e) => e.id === "msg-01");
    expect(reread?.tasks[0]?.status).toBe("done");
  });

  it("respects the window, isolates users and validates input", async () => {
    const { cookie, userId } = await login(t);
    await syncWithAges(cookie, userId, { "msg-02": 60_000, "msg-01": 1 * DAY, "msg-03": 3 * DAY });
    const lastDay = (await t.http.get("/api/emails?days=1").set("cookie", cookie)).body
      .items as EmailItem[];
    expect(lastDay.map((e) => e.id)).toEqual(["msg-01"]); // yesterday only

    const other = await login(t);
    expect((await t.http.get("/api/emails").set("cookie", other.cookie)).body.items).toEqual([]);
    await t.http.get("/api/emails?days=31").set("cookie", cookie).expect(400);
    await t.http.get("/api/emails").expect(401);
  });
});
