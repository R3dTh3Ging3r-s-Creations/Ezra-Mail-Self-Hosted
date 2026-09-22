import type { CalendarDateRange } from "./types";

export function validCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function calendarDateRange(startDate: unknown, endDate: unknown): CalendarDateRange | null {
  return validCalendarDate(startDate) && validCalendarDate(endDate) && startDate < endDate
    ? { startDate, endDate } : null;
}

export function calendarDateInZone(value: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function calendarDayBounds(date: string, timeZone: string) {
  if (!validCalendarDate(date)) throw new Error("Calendar date is invalid.");
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { date, startIso: localMidnight(date, timeZone), endIso: localMidnight(next.toISOString().slice(0, 10), timeZone) };
}

export function localDayRange(timeZone: string, now = new Date()) {
  return calendarDayBounds(calendarDateInZone(now, timeZone), timeZone);
}

function localMidnight(date: string, timeZone: string) {
  const target = Date.parse(`${date}T00:00:00.000Z`);
  let candidate = target;
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 4; i += 1) {
    const parts = formatter.formatToParts(new Date(candidate));
    const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
    const actual = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    if (actual === target) break;
    candidate += target - actual;
  }
  return new Date(candidate).toISOString();
}

export function allDayRangeFromInstants(startsAt: string, endsAt: string, timeZone: string, legacyPlaceholders = false): CalendarDateRange | null {
  if (!Number.isFinite(Date.parse(startsAt)) || !Number.isFinite(Date.parse(endsAt)) || Date.parse(startsAt) >= Date.parse(endsAt)) return null;
  if (legacyPlaceholders && [startsAt, endsAt].every((value) => /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(value))) {
    return calendarDateRange(startsAt.slice(0, 10), endsAt.slice(0, 10));
  }
  try { return calendarDateRange(calendarDateInZone(startsAt, timeZone), calendarDateInZone(endsAt, timeZone)); } catch { return null; }
}

type CalendarInterval = { startsAt: string; endsAt: string; isAllDay?: boolean; dateRange?: CalendarDateRange | null };

export function calendarEventOverlapsRange(event: CalendarInterval, from: string, to: string, timeZone: string): boolean {
  let start = Date.parse(event.startsAt);
  let end = Date.parse(event.endsAt);
  if (event.isAllDay) {
    const dates = calendarDateRange(event.dateRange?.startDate, event.dateRange?.endDate);
    if (!dates) return false;
    start = Date.parse(calendarDayBounds(dates.startDate, timeZone).startIso);
    end = Date.parse(calendarDayBounds(dates.endDate, timeZone).startIso);
  }
  return start < end && start < Date.parse(to) && end > Date.parse(from);
}

export function calendarEventOverlapsDate(event: CalendarInterval, date: string, timeZone: string): boolean {
  if (!validCalendarDate(date)) return false;
  if (event.isAllDay) {
    const dates = calendarDateRange(event.dateRange?.startDate, event.dateRange?.endDate);
    return !!dates && dates.startDate <= date && date < dates.endDate;
  }
  const bounds = calendarDayBounds(date, timeZone);
  return calendarEventOverlapsRange(event, bounds.startIso, bounds.endIso, timeZone);
}
