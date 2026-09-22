import { describe, expect, it } from "vitest";
import {
  calendarPeriod,
  calendarEventOverlapsDay,
  parseCalendarDate,
  serializeCalendarDate,
  shiftCalendarAnchor,
  calendarDrilldownFromParams,
} from "@/components/ezra/calendarViewState";

describe("calendar view state", () => {
  it("builds exact day, week, and month ranges", () => {
    const anchor = new Date(2026, 6, 15, 14, 30);
    const day = calendarPeriod(anchor, "day");
    const week = calendarPeriod(anchor, "week");
    const month = calendarPeriod(anchor, "month");

    expect(day.days).toHaveLength(1);
    expect(day.from.getHours()).toBe(0);
    expect(day.to.getDate()).toBe(16);
    expect(week.days).toHaveLength(7);
    expect(week.from.getDay()).toBe(0);
    expect(week.to.getTime() - week.from.getTime()).toBeGreaterThanOrEqual(6 * 24 * 60 * 60_000);
    expect(month.days).toHaveLength(31);
    expect(month.from.getDate()).toBe(1);
    expect(month.to.getMonth()).toBe(7);
    expect(month.label).toBe("July 2026");
  });

  it("moves by the active period without overflowing short months", () => {
    const january31 = new Date(2026, 0, 31, 12);
    expect(serializeCalendarDate(shiftCalendarAnchor(january31, "day", 1))).toBe("2026-02-01");
    expect(serializeCalendarDate(shiftCalendarAnchor(january31, "week", 1))).toBe("2026-02-07");
    expect(serializeCalendarDate(shiftCalendarAnchor(january31, "month", 1))).toBe("2026-02-28");
  });

  it("round-trips persisted local dates and rejects impossible dates", () => {
    expect(serializeCalendarDate(parseCalendarDate("2026-11-03"))).toBe("2026-11-03");
    expect(serializeCalendarDate(parseCalendarDate("2026-02-31", new Date(2026, 4, 9)))).toBe("2026-05-09");
  });

  it("restores only an exact Calendar local ID and valid day from history parameters", () => {
    expect(calendarDrilldownFromParams(new URLSearchParams("view=calendar&event=opaque%3A1&date=2026-08-30"))).toEqual({ view: "calendar", eventId: "opaque:1", date: "2026-08-30" });
    for (const params of ["view=mail&event=e&date=2026-08-30", "view=calendar&event=e&date=2026-02-31", "view=calendar&event=%20&date=2026-08-30", "view=calendar&event=e", "view=calendar&date=2026-08-30"]) {
      expect(calendarDrilldownFromParams(new URLSearchParams(params))).toBeNull();
    }
  });

  it("keeps multi-day events visible on every overlapping day", () => {
    const event = {
      startsAt: new Date(2026, 6, 14, 22).toISOString(),
      endsAt: new Date(2026, 6, 16, 2).toISOString(),
    };
    expect(calendarEventOverlapsDay(event, new Date(2026, 6, 14))).toBe(true);
    expect(calendarEventOverlapsDay(event, new Date(2026, 6, 15))).toBe(true);
    expect(calendarEventOverlapsDay(event, new Date(2026, 6, 16))).toBe(true);
    expect(calendarEventOverlapsDay(event, new Date(2026, 6, 17))).toBe(false);
  });

  it("uses explicit all-day dates even when UTC placeholders have another local start day", () => {
    const event = { startsAt: "2026-08-29T00:00:00.000Z", endsAt: "2026-08-30T00:00:00.000Z", isAllDay: true, dateRange: { startDate: "2026-08-30", endDate: "2026-09-02" } };
    expect(calendarEventOverlapsDay(event, new Date(2026, 7, 30))).toBe(true);
    expect(calendarEventOverlapsDay(event, new Date(2026, 8, 1))).toBe(true);
    expect(calendarEventOverlapsDay(event, new Date(2026, 8, 2))).toBe(false);
  });
});
