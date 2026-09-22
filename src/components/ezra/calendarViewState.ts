import { calendarEventOverlapsDate, validCalendarDate } from "@/lib/email/calendar-day";
import type { CalendarDateRange, CalendarDrilldownTarget } from "@/lib/email/types";

export type CalendarDrilldownRequest = CalendarDrilldownTarget & { requestKey: number };

export function isCalendarDrilldownTarget(value: { view?: unknown; eventId?: unknown; date?: unknown }): value is CalendarDrilldownTarget {
  return value.view === "calendar" && typeof value.eventId === "string" && !!value.eventId.trim() && validCalendarDate(value.date);
}

export function calendarDrilldownFromParams(params: URLSearchParams): CalendarDrilldownTarget | null {
  const target = { view: params.get("view"), eventId: params.get("event"), date: params.get("date") };
  return isCalendarDrilldownTarget(target) ? target : null;
}

export type CalendarViewMode = "day" | "week" | "month";

export type CalendarPeriod = {
  mode: CalendarViewMode;
  from: Date;
  to: Date;
  days: Date[];
  label: string;
  noun: "day" | "week" | "month";
};

export function calendarPeriod(anchor: Date, mode: CalendarViewMode): CalendarPeriod {
  const safeAnchor = validDate(anchor) ? new Date(anchor) : new Date();
  const from = mode === "week"
    ? startOfWeek(safeAnchor)
    : mode === "month"
      ? startOfMonth(safeAnchor)
      : startOfDay(safeAnchor);
  const to = mode === "day"
    ? addDays(from, 1)
    : mode === "week"
      ? addDays(from, 7)
      : startOfMonth(addMonths(from, 1));
  const days: Date[] = [];
  for (let cursor = new Date(from); cursor < to; cursor = addDays(cursor, 1)) days.push(cursor);
  return {
    mode,
    from,
    to,
    days,
    label: periodLabel(from, to, mode),
    noun: mode,
  };
}

export function shiftCalendarAnchor(anchor: Date, mode: CalendarViewMode, direction: -1 | 1) {
  if (mode === "day") return addDays(anchor, direction);
  if (mode === "week") return addDays(anchor, direction * 7);
  return addMonths(anchor, direction);
}

export function serializeCalendarDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseCalendarDate(value: string | null | undefined, fallback = new Date()) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return startOfDay(fallback);
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!validDate(parsed) || serializeCalendarDate(parsed) !== value) return startOfDay(fallback);
  return parsed;
}

export function isCalendarViewMode(value: string | null | undefined): value is CalendarViewMode {
  return value === "day" || value === "week" || value === "month";
}

export function calendarEventOverlapsDay(event: { startsAt: string; endsAt: string; isAllDay?: boolean; dateRange?: CalendarDateRange | null }, day: Date, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  return calendarEventOverlapsDate(event, serializeCalendarDate(day), timezone);
}

function periodLabel(from: Date, to: Date, mode: CalendarViewMode) {
  if (mode === "day") {
    return from.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }
  if (mode === "month") return from.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const inclusiveEnd = addDays(to, -1);
  return `${from.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${inclusiveEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

function startOfDay(value: Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfWeek(value: Date) {
  const date = startOfDay(value);
  date.setDate(date.getDate() - date.getDay());
  return date;
}

function startOfMonth(value: Date) {
  const date = startOfDay(value);
  date.setDate(1);
  return date;
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(value: Date, months: number) {
  const next = new Date(value);
  const targetDay = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(targetDay, lastDay));
  return next;
}

function validDate(value: Date) {
  return !Number.isNaN(value.getTime());
}
