import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addDays, localDate } from "../src/lib/time.js";
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

const TZ = "Pacific/Kiritimati"; // UTC+14: "today" here is often a different date than in UTC

interface Item {
  id: string;
  email_id: string;
  bucket: string;
  status: string;
  due_date: string | null;
  date_source: string;
  gmail_url: string;
  snoozed_until: string | null;
}

/** Sync the fixture inbox with chosen due dates (relative to the user's today) and confidences. */
async function seeded(): Promise<{ cookie: string; today: string; byEmail: Map<string, Item> }> {
  const { cookie } = await login(t, TZ);
  const today = localDate(TZ);
  const specs: [string, number | null, number?][] = [
    ["msg-01", -2], // overdue
    ["msg-02", 0], // today
    ["msg-03", 1], // week
    ["msg-04", 7], // week (edge)
    ["msg-05", 8], // later
    ["msg-08", null], // undated
    ["msg-09", 0, 0.3], // needs review
  ];
  for (const [id, offset, confidence] of specs) {
    t.agent.specs.set(id, {
      due_date: offset === null ? null : addDays(today, offset),
      ...(confidence ? { confidence } : {}),
    });
  }
  await syncAndWait(t, cookie);
  const all = await t.http.get("/api/tasks?limit=200").set("cookie", cookie).expect(200);
  const byEmail = new Map((all.body.items as Item[]).map((i) => [i.email_id, i]));
  return { cookie, today, byEmail };
}

const ids = (body: { items: Item[] }) => body.items.map((i) => i.email_id).sort();

describe("GET /api/tasks", () => {
  it("computes buckets at read time in the user's timezone", async () => {
    const { cookie, today, byEmail } = await seeded();
    expect(byEmail.get("msg-01")?.bucket).toBe("overdue");
    expect(byEmail.get("msg-02")?.bucket).toBe("today");
    expect(byEmail.get("msg-04")?.bucket).toBe("week");
    expect(byEmail.get("msg-05")?.bucket).toBe("later");
    expect(byEmail.get("msg-08")?.bucket).toBe("undated");
    expect(byEmail.get("msg-09")?.bucket).toBe("needs_review");

    const res = await t.http.get("/api/tasks?range=today").set("cookie", cookie).expect(200);
    expect(res.body).toMatchObject({ today, timezone: TZ });
    expect(ids(res.body)).toEqual(["msg-02"]); // low-confidence msg-09 is NOT in Today
    expect(ids((await t.http.get("/api/tasks?range=overdue").set("cookie", cookie)).body)).toEqual([
      "msg-01",
    ]);
    expect(ids((await t.http.get("/api/tasks?range=week").set("cookie", cookie)).body)).toEqual([
      "msg-03",
      "msg-04",
    ]);
    expect(ids((await t.http.get("/api/tasks?range=later").set("cookie", cookie)).body)).toEqual([
      "msg-05",
    ]);
    expect(ids((await t.http.get("/api/tasks?range=review").set("cookie", cookie)).body)).toEqual([
      "msg-09",
    ]);
  });

  it("the same task moves buckets when the user's timezone changes", async () => {
    const { cookie, byEmail } = await seeded();
    const task = byEmail.get("msg-02");
    expect(task?.bucket).toBe("today");
    // Kiritimati (UTC+14) to Pago Pago (UTC-11) is 25 hours: "today" there is always yesterday here
    await t.http
      .patch("/api/me/settings")
      .set("cookie", cookie)
      .send({ timezone: "Pacific/Pago_Pago" })
      .expect(200);
    const after = await t.http
      .get(`/api/tasks/${task?.id ?? ""}`)
      .set("cookie", cookie)
      .expect(200);
    expect(after.body.bucket).toBe("week");
  });

  it("filters by type and priority, paginates with a cursor and links every task to its Gmail thread", async () => {
    const { cookie } = await seeded();
    const page1 = await t.http.get("/api/tasks?limit=5").set("cookie", cookie).expect(200);
    expect(page1.body.items).toHaveLength(5);
    expect(page1.body.next_cursor).toBeTruthy();
    const page2 = await t.http
      .get(`/api/tasks?limit=5&cursor=${String(page1.body.next_cursor)}`)
      .set("cookie", cookie)
      .expect(200);
    const seen = new Set([...page1.body.items, ...page2.body.items].map((i: Item) => i.id));
    expect(seen.size).toBe(10);
    expect((page1.body.items as Item[])[0]?.gmail_url).toMatch(
      /^https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox\//,
    );

    const none = await t.http.get("/api/tasks?type=payment").set("cookie", cookie).expect(200);
    expect(none.body.items).toEqual([]); // the fake agent only produces "other"
    const p2 = await t.http
      .get("/api/tasks?priority=P2&limit=200")
      .set("cookie", cookie)
      .expect(200);
    expect(p2.body.items.length).toBeGreaterThan(10);

    await t.http.get("/api/tasks?cursor=garbage").set("cookie", cookie).expect(400);
    await t.http.get("/api/tasks?range=yesterday").set("cookie", cookie).expect(400);
    await t.http.get("/api/tasks?limit=1000").set("cookie", cookie).expect(400);
  });
});

describe("PATCH /api/tasks/:id", () => {
  it("marks done / dismissed / reopens, and status filters follow", async () => {
    const { cookie, byEmail } = await seeded();
    const id = byEmail.get("msg-02")?.id ?? "";
    const done = await t.http
      .patch(`/api/tasks/${id}`)
      .set("cookie", cookie)
      .send({ status: "done" })
      .expect(200);
    expect(done.body.status).toBe("done");
    const open = await t.http.get("/api/tasks?range=today").set("cookie", cookie).expect(200);
    expect(open.body.items).toEqual([]);
    const doneList = await t.http.get("/api/tasks?status=done").set("cookie", cookie).expect(200);
    expect(ids(doneList.body)).toEqual(["msg-02"]);

    await t.http
      .patch(`/api/tasks/${id}`)
      .set("cookie", cookie)
      .send({ status: "dismissed" })
      .expect(200);
    await t.http
      .patch(`/api/tasks/${id}`)
      .set("cookie", cookie)
      .send({ status: "open" })
      .expect(200);
    expect(ids((await t.http.get("/api/tasks?range=today").set("cookie", cookie)).body)).toEqual([
      "msg-02",
    ]);
  });

  it("snoozes until a time; the task returns once the snooze expires", async () => {
    const { cookie, byEmail } = await seeded();
    const id = byEmail.get("msg-02")?.id ?? "";
    const until = new Date(Date.now() + 3600_000).toISOString();
    const res = await t.http
      .patch(`/api/tasks/${id}`)
      .set("cookie", cookie)
      .send({ snoozed_until: until })
      .expect(200);
    expect(res.body).toMatchObject({ status: "snoozed", snoozed_until: until });
    expect((await t.http.get("/api/tasks?range=today").set("cookie", cookie)).body.items).toEqual(
      [],
    );
    expect(ids((await t.http.get("/api/tasks?status=snoozed").set("cookie", cookie)).body)).toEqual(
      ["msg-02"],
    );

    const { prisma } = t.container.deps;
    await prisma.task.updateMany({
      where: { id },
      data: { snoozedUntil: new Date(Date.now() - 1000) },
    });
    expect(ids((await t.http.get("/api/tasks?range=today").set("cookie", cookie)).body)).toEqual([
      "msg-02",
    ]);

    const past = new Date(Date.now() - 1000).toISOString();
    await t.http
      .patch(`/api/tasks/${id}`)
      .set("cookie", cookie)
      .send({ snoozed_until: past })
      .expect(400);
  });

  it("lists done, dismissed and snoozed tasks as closed; Reopen restores each exactly", async () => {
    const { cookie } = await seeded();
    const before = (await t.http.get("/api/tasks?status=open&limit=200").set("cookie", cookie)).body
      .items as Record<string, unknown>[];
    const [a, b, c] = before;
    if (!a || !b || !c) throw new Error("expected tasks");
    const patch = (id: unknown, body: object) =>
      t.http
        .patch(`/api/tasks/${String(id)}`)
        .set("cookie", cookie)
        .send(body)
        .expect(200);
    await patch(a.id, { status: "done" });
    await patch(b.id, { status: "dismissed" });
    await patch(c.id, { snoozed_until: new Date(Date.now() + 3600_000).toISOString() });

    const closed = (await t.http.get("/api/tasks?status=closed").set("cookie", cookie)).body
      .items as { id: string; status: string }[];
    expect(closed.map((x) => [x.id, x.status]).sort()).toEqual(
      [
        [a.id, "done"],
        [b.id, "dismissed"],
        [c.id, "snoozed"],
      ].sort(),
    );

    for (const x of [a, b, c]) await patch(x.id, { status: "open" });
    expect((await t.http.get("/api/tasks?status=closed").set("cookie", cookie)).body.items).toEqual(
      [],
    );
    const after = (await t.http.get("/api/tasks?status=open&limit=200").set("cookie", cookie)).body
      .items as Record<string, unknown>[];
    const strip = (x: Record<string, unknown>) => ({ ...x, updated_at: null });
    expect(after.map(strip)).toEqual(before.map(strip)); // same fields, same order, as original
  });

  it("edits the due date (date or datetime) and marks it as user-set", async () => {
    const { cookie, today, byEmail } = await seeded();
    const id = byEmail.get("msg-08")?.id ?? "";
    const res = await t.http
      .patch(`/api/tasks/${id}`)
      .set("cookie", cookie)
      .send({ due_date: today })
      .expect(200);
    expect(res.body).toMatchObject({
      due_date: today,
      bucket: "today",
      date_source: "user",
      has_time: false,
    });

    const at = new Date(`${addDays(today, 2)}T10:00:00Z`).toISOString();
    const timed = await t.http
      .patch(`/api/tasks/${id}`)
      .set("cookie", cookie)
      .send({ due_at: at })
      .expect(200);
    expect(timed.body).toMatchObject({ has_time: true, due_at: at });
    expect(timed.body.due_date).toBe(localDate(TZ, new Date(at)));

    const cleared = await t.http
      .patch(`/api/tasks/${id}`)
      .set("cookie", cookie)
      .send({ due_date: null })
      .expect(200);
    expect(cleared.body).toMatchObject({ due_date: null, bucket: "undated" });
  });

  it("validates bodies and ids, and isolates users from each other", async () => {
    const { cookie, byEmail } = await seeded();
    const id = byEmail.get("msg-02")?.id ?? "";
    await t.http.patch(`/api/tasks/${id}`).set("cookie", cookie).send({}).expect(400);
    await t.http
      .patch(`/api/tasks/${id}`)
      .set("cookie", cookie)
      .send({ status: "snoozed" })
      .expect(400);
    await t.http
      .patch(`/api/tasks/${id}`)
      .set("cookie", cookie)
      .send({ priority: "P0" })
      .expect(400);
    await t.http
      .patch(`/api/tasks/${id}`)
      .set("cookie", cookie)
      .send({ status: "done", snoozed_until: new Date(Date.now() + 1e6).toISOString() })
      .expect(400);
    await t.http
      .patch("/api/tasks/not-an-id")
      .set("cookie", cookie)
      .send({ status: "done" })
      .expect(400);
    await t.http
      .patch(`/api/tasks/t_${"0".repeat(40)}`)
      .set("cookie", cookie)
      .send({ status: "done" })
      .expect(404);

    const other = await login(t);
    await t.http.get(`/api/tasks/${id}`).set("cookie", other.cookie).expect(404);
    await t.http
      .patch(`/api/tasks/${id}`)
      .set("cookie", other.cookie)
      .send({ status: "done" })
      .expect(404);
    expect((await t.http.get("/api/tasks").set("cookie", other.cookie)).body.items).toEqual([]);
  });
});

describe("priority is re-scored for today (SPEC Q11)", () => {
  it("rises as the due date approaches, with no re-sync, and filters use the new priority", async () => {
    const { cookie, userId } = await login(t, TZ);
    const today = localDate(TZ);
    // agent stored P2/40 at sync time; base 30 (payment + VIP) is what matters now
    t.agent.specs.set("msg-01", { due_date: addDays(today, 1), base: 30, confidence: 1 });
    await syncAndWait(t, cookie);

    type Scored = Item & { priority: string; priority_score: number; priority_reasons: string[] };
    const get = async (): Promise<Scored> => {
      const res = await t.http.get("/api/tasks?limit=200").set("cookie", cookie);
      const found = (res.body as { items: Scored[] }).items.find((i) => i.email_id === "msg-01");
      if (!found) throw new Error("msg-01 task missing");
      return found;
    };
    const tomorrow = await get();
    expect(tomorrow).toMatchObject({ priority: "P1", priority_score: 62 }); // (32 + 30) * 1.0
    expect(tomorrow.priority_reasons[0]).toBe("Due tomorrow");

    // a day passes: same row, now due today
    await t.container.deps.prisma.task.updateMany({
      where: { userId, email: { gmailId: "msg-01" } },
      data: { dueDate: new Date(`${today}T00:00:00Z`) },
    });
    const dueToday = await get();
    expect(dueToday).toMatchObject({ priority: "P0", priority_score: 70 });
    expect(dueToday.priority_reasons[0]).toBe("Due today");

    const p0 = await t.http.get("/api/tasks?priority=P0").set("cookie", cookie).expect(200);
    expect((p0.body as { items: Item[] }).items.map((i) => i.email_id)).toEqual(["msg-01"]);
    // tasks the agent sent without a base keep their sync-time priority
    const p2 = await t.http
      .get("/api/tasks?priority=P2&limit=200")
      .set("cookie", cookie)
      .expect(200);
    expect(p2.body.items.length).toBeGreaterThan(10);
  });
});
