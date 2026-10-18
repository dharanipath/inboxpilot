import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runRetention } from "../src/jobs/retention.js";
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

const DAY = 86_400_000;

describe("retention job", () => {
  it("applies the policy and keeps everything still in use", async () => {
    const { prisma } = t.container.deps;
    const { cookie, userId } = await login(t);
    await syncAndWait(t, cookie);
    const old = new Date(Date.now() - 45 * DAY);
    const [closed, open] = await prisma.task.findMany({
      where: { userId },
      take: 2,
      orderBy: { id: "asc" },
    });
    if (!closed || !open) throw new Error("expected tasks");

    // an old closed task, an old open task, an old orphan email, an old run and an old audit entry
    await prisma.$executeRaw`UPDATE "tasks" SET "status" = 'done', "updated_at" = ${old} WHERE "id" = ${closed.id}`;
    await prisma.$executeRaw`UPDATE "tasks" SET "updated_at" = ${old} WHERE "id" = ${open.id}`;
    await prisma.email.updateMany({ where: { userId }, data: { receivedAt: old } });
    await prisma.syncRun.updateMany({ where: { userId }, data: { startedAt: old } });
    await prisma.auditLog.create({
      data: { userId, action: "login", at: new Date(Date.now() - 100 * DAY) },
    });
    const emailsBefore = await prisma.email.count({ where: { userId } });
    const tasksBefore = await prisma.task.count({ where: { userId } });

    const result = await runRetention(prisma);

    expect(result.tasks).toBe(1); // only the closed one
    expect(
      await prisma.task.findUnique({ where: { userId_id: { userId, id: open.id } } }),
    ).not.toBeNull();
    expect(await prisma.task.count({ where: { userId } })).toBe(tasksBefore - 1);
    // emails that still have open tasks are kept; the rest go
    const emailsAfter = await prisma.email.count({ where: { userId } });
    expect(emailsAfter).toBe(tasksBefore - 1);
    expect(result.emails).toBe(emailsBefore - emailsAfter);
    expect(result.syncRuns).toBe(1);
    expect(result.auditEntries).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "retention" } })).toBe(1);
  });
});
