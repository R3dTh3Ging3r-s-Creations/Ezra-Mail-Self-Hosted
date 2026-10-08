import { describe, expect, it } from "vitest";
import { resolveCalendarTime } from "@/lib/email/calendar-time";

describe("selected calendar timezone", () => {
  const timezone = "America/Chicago";
  it.each([["2026-10-09", "2026-10-09T12:00:00.000Z"], ["2026-11-06", "2026-11-06T13:00:00.000Z"]])("resolves %s at 7 AM", (date, expected) => {
    expect(resolveCalendarTime({ date, time: "07:00", timezone })).toBe(expected);
  });
  it("rejects a spring gap and requires an offset for a fall overlap", () => {
    expect(() => resolveCalendarTime({ date: "2026-03-08", time: "02:30", timezone })).toThrow(/does not exist/i);
    expect(() => resolveCalendarTime({ date: "2026-11-01", time: "01:30", timezone })).toThrow(/ambiguous/i);
    expect(resolveCalendarTime({ date: "2026-11-01", time: "01:30", timezone, offset: "-05:00" })).toBe("2026-11-01T06:30:00.000Z");
    expect(resolveCalendarTime({ date: "2026-11-01", time: "01:30", timezone, offset: "-06:00" })).toBe("2026-11-01T07:30:00.000Z");
    expect(() => resolveCalendarTime({ date: "2026-11-01", time: "01:30", timezone, offset: "+01:00" })).toThrow(/offset/i);
  });
  it.each([{ date: "2026-02-30", time: "07:00", timezone }, { date: "2026-10-09", time: "24:00", timezone }, { date: "2026-10-09", time: "07:00", timezone: "Invalid/Zone" }])("rejects malformed input %j", (input) => {
    expect(() => resolveCalendarTime(input)).toThrow();
  });
});
