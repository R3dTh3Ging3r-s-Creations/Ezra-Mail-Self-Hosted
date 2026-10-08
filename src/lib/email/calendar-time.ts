import { validCalendarDate } from "./calendar-day";

/** Convert a wall-clock choice, never the host/browser timezone. */
export function resolveCalendarTime(input: { date: string; time: string; timezone: string; offset?: string }): string {
  if (!validCalendarDate(input.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error("Calendar date or time is invalid.");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: input.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const wall = Date.parse(`${input.date}T${input.time}:00.000Z`);
  const local = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    const get = (type: string) => parts.find((part) => part.type === type)!.value;
    return Date.parse(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}.000Z`);
  };
  // Sample both sides of any transition, then require exact round trips.
  const offsets = new Set<number>();
  for (let hour = -48; hour <= 48; hour += 6) {
    const instant = wall + hour * 3_600_000;
    offsets.add(local(instant) - instant);
  }
  let candidates = [...offsets].map((offset) => wall - offset).filter((instant) => local(instant) === wall);
  if (!candidates.length) throw new Error("This calendar time does not exist in the selected timezone.");
  if (input.offset !== undefined) {
    if (!/^[+-](0\d|1\d|2[0-3]):[0-5]\d$/.test(input.offset)) throw new Error("Calendar offset is invalid.");
    const sign = input.offset[0] === "-" ? -1 : 1;
    const offset = sign * (Number(input.offset.slice(1, 3)) * 60 + Number(input.offset.slice(4))) * 60_000;
    candidates = candidates.filter((instant) => wall - instant === offset);
    if (!candidates.length) throw new Error("Calendar offset does not match the selected timezone.");
  }
  if (candidates.length !== 1) throw new Error("This calendar time is ambiguous; specify its UTC offset.");
  return new Date(candidates[0]).toISOString();
}
