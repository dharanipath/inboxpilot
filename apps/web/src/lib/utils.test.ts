import { describe, expect, it } from "vitest";

import { normalizeTimeZone } from "./utils";

describe("normalizeTimeZone", () => {
  it("maps legacy CLDR names to current IANA names, and both stay valid", () => {
    expect(normalizeTimeZone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(normalizeTimeZone("Europe/Kiev")).toBe("Europe/Kyiv");
    expect(normalizeTimeZone("Europe/London")).toBe("Europe/London");
    for (const tz of ["Asia/Kolkata", "Europe/Kyiv", "Asia/Ho_Chi_Minh"]) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: tz })).not.toThrow();
    }
  });
});
