import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ContractValidator, defaultContractsDir } from "../src/agent/contract.js";
import { loadConfig } from "../src/config.js";
import { FixtureMailSource, fixtureInbox } from "./fixtures/inbox.js";
import { mergeTraces, mergeUsage } from "../src/jobs/trace.js";
import { combine, rescore } from "../src/lib/priority.js";
import {
  addDays,
  bucketFor,
  dateOnly,
  daysBetween,
  isValidTimeZone,
  localDate,
} from "../src/lib/time.js";

describe("time", () => {
  it("computes the local date in the user's timezone", () => {
    const at = new Date("2026-10-15T20:00:00Z"); // 01:30 on the 16th in IST
    expect(localDate("Asia/Kolkata", at)).toBe("2026-10-16");
    expect(localDate("UTC", at)).toBe("2026-10-15");
    expect(localDate("America/Los_Angeles", at)).toBe("2026-10-15");
    expect(localDate("Not/AZone", at)).toBe("2026-10-15"); // falls back to UTC
  });

  it("does calendar arithmetic across month and year ends", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-10-16", "2026-10-23")).toBe(7);
    expect(dateOnly(new Date("2026-10-20T00:00:00Z"))).toBe("2026-10-20");
    expect(dateOnly(null)).toBeNull();
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });

  it.each([
    ["2026-10-15", 0.9, "overdue"],
    ["2026-10-16", 0.9, "today"],
    ["2026-10-17", 0.9, "week"],
    ["2026-10-23", 0.9, "week"],
    ["2026-10-24", 0.9, "later"],
    [null, 0.9, "undated"],
    ["2026-10-16", 0.49, "needs_review"],
  ] as const)("bucketFor(%s, %s) = %s (same rules as the agent)", (due, conf, bucket) => {
    expect(bucketFor(due, conf, "2026-10-16")).toBe(bucket);
  });
});

describe("trace merging", () => {
  it("sums durations and counts, keeps the worst status and unique details", () => {
    const merged = mergeTraces([
      [
        {
          step: "triage",
          agent: "T",
          status: "ok",
          duration_ms: 2,
          detail: null,
          counts: { kept: 3 },
        },
        {
          step: "extract",
          agent: "E",
          status: "ok",
          duration_ms: 10,
          detail: "groq",
          counts: { items: 2 },
        },
      ],
      [
        {
          step: "triage",
          agent: "T",
          status: "skipped",
          duration_ms: 1,
          detail: null,
          counts: null,
        },
        {
          step: "extract",
          agent: "E",
          status: "degraded",
          duration_ms: 20,
          detail: "gemini rate-limited → groq",
          counts: { items: 1 },
        },
      ],
      [
        {
          step: "extract",
          agent: "E",
          status: "ok",
          duration_ms: 5,
          detail: "groq",
          counts: { items: 4 },
        },
      ],
    ]);
    expect(merged).toEqual([
      {
        step: "triage",
        agent: "T",
        status: "ok",
        duration_ms: 3,
        detail: null,
        counts: { kept: 3 },
      },
      {
        step: "extract",
        agent: "E",
        status: "degraded",
        duration_ms: 35,
        detail: "groq; gemini rate-limited → groq",
        counts: { items: 7 },
      },
    ]);
  });

  it("sums provider usage by provider", () => {
    expect(
      mergeUsage([
        [{ provider: "groq", model: "m", calls: 1, failures: 0, latency_ms: 10 }],
        [
          {
            provider: "groq",
            model: "m",
            calls: 2,
            failures: 1,
            latency_ms: 5,
            cache_hits: 1,
            last_error: "429",
          },
          { provider: "gemini", model: "g", calls: 1, failures: 1, latency_ms: 3 },
        ],
      ]),
    ).toEqual([
      {
        provider: "groq",
        model: "m",
        calls: 3,
        failures: 1,
        latency_ms: 15,
        cache_hits: 1,
        last_error: "429",
      },
      { provider: "gemini", model: "g", calls: 1, failures: 1, latency_ms: 3, cache_hits: 0 },
    ]);
  });
});

describe("config", () => {
  const base = {
    DATABASE_URL: "postgresql://x",
    INTERNAL_API_KEY: "12345678",
    JWT_SECRET: "x".repeat(32),
  };

  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      port: 4000,
      syncMaxEmails: 50,
      syncChunkSize: 12,
      cookieSecure: false,
      agentUrl: "http://localhost:8000",
    });
    expect(c.webOrigins).toEqual(["http://localhost:5173", "http://localhost:4000"]);
  });

  it("secure cookies by default in production, overridable", () => {
    expect(loadConfig({ ...base, NODE_ENV: "production" }).cookieSecure).toBe(true);
    expect(
      loadConfig({ ...base, NODE_ENV: "production", COOKIE_SECURE: "false" }).cookieSecure,
    ).toBe(false);
  });

  it("fails fast with every problem listed", () => {
    expect(() => loadConfig({ JWT_SECRET: "short" })).toThrow(
      /DATABASE_URL[\s\S]*INTERNAL_API_KEY[\s\S]*JWT_SECRET/,
    );
  });
});

describe("fixture inbox (test data used in place of Gmail)", () => {
  const now = new Date("2026-10-16T03:30:00Z");

  it("is realistic, unique and valid against the contract", () => {
    const emails = fixtureInbox(now, "Asia/Kolkata");
    expect(emails.length).toBeGreaterThanOrEqual(25);
    expect(new Set(emails.map((e) => e.id)).size).toBe(emails.length);
    const v = new ContractValidator();
    for (const e of emails)
      expect(
        v.errors("ExtractRequest", {
          user: { email: "a@b.co", timezone: "UTC", now: now.toISOString() },
          emails: [e],
        }),
      ).toEqual([]);
    expect(emails.some((e) => /Ignore all previous instructions/.test(e.body_text))).toBe(true);
    expect(emails.filter((e) => e.thread_id === "thread-contract")).toHaveLength(2);
  });

  it("generates explicit dates relative to today in the user's timezone", () => {
    const invoice = fixtureInbox(now, "Asia/Kolkata").find((e) => e.id === "msg-03");
    expect(invoice?.body_text).toContain("due on 20 October"); // today (IST) is 16 Oct, +4 days
    const invite = fixtureInbox(now, "Asia/Kolkata").find((e) => e.id === "msg-02");
    expect(invite?.body_text).toContain("Monday, 19 October");
  });

  it("the source filters by age and caps the count", async () => {
    const src = new FixtureMailSource();
    const user = { id: "u", email: "a@b.co", timezone: "UTC", authMode: "google" };
    expect((await src.listRecent(user, { days: 30, max: 5, now })).emails).toHaveLength(5);
    const lastDay = (await src.listRecent(user, { days: 1, max: 50, now })).emails;
    expect(lastDay.every((e) => now.getTime() - Date.parse(e.received_at) <= 86_400_000)).toBe(
      true,
    );
    expect(lastDay.length).toBeLessThan(fixtureInbox(now, "UTC").length);
  });
});

describe("read-time re-scoring (shared table with the Python agent)", () => {
  const table = JSON.parse(
    readFileSync(resolve(defaultContractsDir(), "fixtures", "priority_cases.json"), "utf-8"),
  ) as {
    today: string;
    cases: {
      name: string;
      base: number;
      confidence: number;
      due_date: string | null;
      urgency_label: string;
      score: number;
      priority: string;
    }[];
  };

  it.each(table.cases)("$name", (c) => {
    expect(combine(c.base, c.due_date, c.confidence, table.today)).toEqual({
      score: c.score,
      priority: c.priority,
      label: c.urgency_label,
    });
  });

  it("swaps only the urgency reason, and leaves rows without a base untouched", () => {
    const stored = {
      score: 21,
      priority: "P3" as const,
      reasons: ["Due in 4 days", "Send request"],
      base: 8,
    };
    expect(rescore(stored, "2026-10-17", 0.86, "2026-10-16")).toEqual({
      score: 47,
      priority: "P1",
      reasons: ["Due tomorrow", "Send request"],
    });
    expect(rescore({ ...stored, base: null }, "2026-10-17", 0.86, "2026-10-16")).toEqual({
      score: 21,
      priority: "P3",
      reasons: ["Due in 4 days", "Send request"],
    });
  });
});
