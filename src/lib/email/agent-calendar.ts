import { assertConnectedAccount, assertPersonalAccount, getAgentCapabilities, type AccountPolicy } from "./agent-accounts";
import { calendarIdSchema, calendarRangeSchema, type AccountRef, type CalendarRange, type CalendarSnapshot } from "./agent-types";
import { getMicrosoftAccessToken, resolveMicrosoftCalendarId, listMicrosoftCalendarEvents, getMicrosoftCalendarEvent } from "./microsoft";
import { getGoogleCalendarIdentity, listGoogleCalendarEvents, getGoogleCalendarEvent } from "./gmail";
import { nowIso } from "./database";
import type { CalendarEvent } from "./types";

type ProviderEvent = Omit<CalendarEvent, "id" | "accountLabel" | "accountProvider" | "syncedAt">;

async function calendarContext(ref: AccountRef, selectedId: string, policy: AccountPolicy) {
  const selected = calendarIdSchema.parse(selectedId);
  const guard = policy === "owner_ui" ? assertConnectedAccount : assertPersonalAccount;
  const account = await guard(ref);
  const capabilities = await getAgentCapabilities(ref, true, policy);
  if (capabilities.calendarRead !== "available") throw new Error("Calendar read permission has not been verified for this account.");
  const token = await (account.provider === "microsoft" ? getMicrosoftAccessToken(account.email, capabilities.scopes.some(scope => scope.toLowerCase() === "calendars.read") ? "calendar-readonly" : "calendar-write") : Promise.resolve(null));
  let calendarId: string;
  try {
    calendarId = account.provider === "microsoft" ? await resolveMicrosoftCalendarId(token!, selected)
      : selected === "primary" ? await getGoogleCalendarIdentity(account.email) : selected;
  } catch { throw new Error("Selected calendar could not be resolved for this account."); }
  calendarIdSchema.parse(calendarId);
  return { account, token, calendarId, guard };
}

function bindEvent(event: ProviderEvent, context: Awaited<ReturnType<typeof calendarContext>>, fetchedAt: string): CalendarEvent {
  if (event.accountId !== context.account.id || event.calendarId !== context.calendarId) throw new Error("Calendar event account or calendar binding changed.");
  return { ...event, id: event.externalEventId, accountLabel: context.account.label, accountProvider: context.account.provider, syncedAt: fetchedAt };
}

/** Provider reads only. A rejected/incomplete read never becomes an empty snapshot. */
export async function readAgentCalendar(ref: AccountRef, selectedId: string, inputRange: CalendarRange, policy: AccountPolicy = "personal"): Promise<CalendarSnapshot> {
  const range = calendarRangeSchema.parse(inputRange);
  const context = await calendarContext(ref, selectedId, policy);
  const { account, token, calendarId } = context;
  let records: ProviderEvent[];
  try {
    records = account.provider === "microsoft"
      ? await listMicrosoftCalendarEvents(token!, account.id, { ...range, calendarId })
      : await listGoogleCalendarEvents(account.email, account.id, { ...range, calendarId });
  } catch { throw new Error("Calendar read could not be completed for this account."); }
  await context.guard(ref);
  const fetchedAt = nowIso();
  const events = records.map(event => bindEvent(event, context, fetchedAt));
  return { account: { ...ref, expectedEmail: account.email }, calendarId, range, fetchedAt, complete: true, events };
}

export async function readAgentEvent(ref: AccountRef, selectedId: string, providerEventId: string, policy: AccountPolicy = "personal") {
  calendarIdSchema.parse(providerEventId);
  const context = await calendarContext(ref, selectedId, policy);
  const { account, token, calendarId } = context;
  let event: ProviderEvent | null;
  try {
    event = account.provider === "microsoft"
      ? await getMicrosoftCalendarEvent(token!, account.id, calendarId, providerEventId)
      : await getGoogleCalendarEvent(account.email, account.id, calendarId, providerEventId);
  } catch { throw new Error("Calendar event could not be read for this account."); }
  await context.guard(ref);
  const evidence = { account: { ...ref, expectedEmail: account.email }, calendarId, fetchedAt: nowIso() };
  if (!event) return { ...evidence, status: "absent" as const };
  if (event.externalEventId !== providerEventId) throw new Error("Calendar returned a different event id.");
  return { ...evidence, status: "found" as const, event: bindEvent(event, context, evidence.fetchedAt) };
}
