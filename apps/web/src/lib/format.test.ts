import { describe, expect, it } from "vitest";

import { makeTask, TODAY } from "@/test/server";

import {
  addDays,
  dayLabel,
  dueLabel,
  greeting,
  groupByDay,
  relativeTime,
  snoozeOptions,
  tzOffsetMinutes,
  weekStrip,
  zonedTime,
} from "./format";

describe("labels in the user's timezone", () => {
  it("labels days relative to today", () => {
    expect(dayLabel(TODAY, TODAY)).toBe("Today");
    expect(dayLabel(addDays(TODAY, 1), TODAY)).toBe("Tomorrow");
    expect(dayLabel(addDays(TODAY, -1), TODAY)).toBe("Yesterday");
    expect(dayLabel("2026-10-20", TODAY)).toBe("Tue 20 Oct");
  });

  it("formats due labels with the time in the user's zone, not the browser's", () => {
    // 07:30Z is 1:00 PM in IST and 3:30 AM in New York
    const t = { due_date: TODAY, due_at: "2026-10-16T07:30:00Z", has_time: true };
    expect(dueLabel(t, TODAY, "Asia/Kolkata")).toBe("Today, 1:00 PM");
    expect(dueLabel(t, TODAY, "America/New_York")).toBe("Today, 3:30 AM");
    expect(dueLabel({ due_date: "2026-10-14", due_at: null, has_time: false }, TODAY, "UTC")).toBe(
      "Overdue · 2 days",
    );
    expect(dueLabel({ due_date: "2026-10-15", due_at: null, has_time: false }, TODAY, "UTC")).toBe(
      "Overdue · 1 day",
    );
    expect(dueLabel({ due_date: null, due_at: null, has_time: false }, TODAY, "UTC")).toBe(
      "No due date",
    );
  });

  it("relative times and greetings", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    expect(relativeTime("2026-10-16T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-10-16T11:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-10-16T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-10-14T12:00:00Z", now)).toBe("2 days ago");
    expect(greeting(new Date("2026-10-16T03:00:00Z"), "Asia/Kolkata")).toBe("Good morning"); // 08:30 IST
    expect(greeting(new Date("2026-10-16T09:00:00Z"), "Asia/Kolkata")).toBe("Good afternoon");
    expect(greeting(new Date("2026-10-16T14:00:00Z"), "Asia/Kolkata")).toBe("Good evening");
  });
});

describe("grouping", () => {
  it("groups dated tasks by day, highest priority first", () => {
    const a = makeTask({ due_date: "2026-10-18", priority: "P3" });
    const b = makeTask({ due_date: "2026-10-17", priority: "P2" });
    const c = makeTask({ due_date: "2026-10-18", priority: "P0" });
    const groups = groupByDay([a, b, c, makeTask({ due_date: null })], TODAY);
    expect(groups.map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ["Tomorrow", [b.id]],
      ["Sun 18 Oct", [c.id, a.id]],
    ]);
  });

  it("builds a 7-day strip with counts and urgent counts", () => {
    const strip = weekStrip(
      [
        makeTask({ due_date: TODAY, priority: "P0" }),
        makeTask({ due_date: TODAY }),
        makeTask({ due_date: addDays(TODAY, 3), priority: "P1" }),
        makeTask({ due_date: addDays(TODAY, 3), bucket: "needs_review" }),
        makeTask({ due_date: addDays(TODAY, 9) }),
      ],
      TODAY,
    );
    expect(strip).toHaveLength(7);
    expect(strip[0]).toMatchObject({ weekday: "Today", count: 2, urgent: 1 });
    expect(strip[3]).toMatchObject({ count: 1, urgent: 1 });
    expect(strip.reduce((n, d) => n + d.count, 0)).toBe(3);
  });
});

describe("zoned time + snooze", () => {
  it("computes timezone offsets, including DST", () => {
    expect(tzOffsetMinutes(new Date("2026-10-16T00:00:00Z"), "Asia/Kolkata")).toBe(330);
    expect(tzOffsetMinutes(new Date("2026-10-16T12:00:00Z"), "America/New_York")).toBe(-240); // EDT
    expect(tzOffsetMinutes(new Date("2026-11-03T12:00:00Z"), "America/New_York")).toBe(-300); // EST
  });

  it("finds the instant for a local wall-clock time", () => {
    expect(zonedTime("2026-10-17", 9, 0, "Asia/Kolkata").toISOString()).toBe(
      "2026-10-17T03:30:00.000Z",
    );
    expect(zonedTime("2026-11-02", 9, 0, "America/New_York").toISOString()).toBe(
      "2026-11-02T14:00:00.000Z",
    );
    expect(zonedTime("2026-10-31", 9, 0, "America/New_York").toISOString()).toBe(
      "2026-10-31T13:00:00.000Z",
    );
  });

  it("offers later today, tomorrow 9 AM and next Monday 9 AM in the user's zone", () => {
    const now = new Date("2026-10-16T06:00:00Z"); // Fri 11:30 IST
    const [later, tomorrow, nextWeek] = snoozeOptions(now, "Asia/Kolkata");
    expect(later?.until.toISOString()).toBe("2026-10-16T09:00:00.000Z");
    expect(tomorrow?.until.toISOString()).toBe("2026-10-17T03:30:00.000Z");
    expect(nextWeek?.until.toISOString()).toBe("2026-10-19T03:30:00.000Z"); // Monday
    // on a Monday, "next week" is the following Monday, not today
    const monday = snoozeOptions(new Date("2026-10-19T06:00:00Z"), "Asia/Kolkata")[2];
    expect(monday?.until.toISOString()).toBe("2026-10-26T03:30:00.000Z");
  });
});
