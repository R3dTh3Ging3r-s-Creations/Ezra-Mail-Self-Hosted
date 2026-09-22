import type { Row } from "@libsql/client";
import { allDayRangeFromInstants, calendarDateInZone, calendarDateRange, calendarDayBounds, calendarEventOverlapsRange } from "./calendar-day";
import {
  createGoogleCalendarEvent,
  listGoogleCalendarEvents,
} from "./gmail";
import {
  createMicrosoftCalendarEvent,
  getMicrosoftAccessToken,
  listMicrosoftCalendarEvents,
} from "./microsoft";
import {
  audit,
  execute,
  getSetting,
  newId,
  nowIso,
} from "./database";
import type {
  AccountProvider,
  CalendarAccountStatus,
  CalendarActionResult,
  CalendarAttendee,
  CalendarDraft,
  CalendarEvent,
  CalendarPage,
  CalendarPrivacy,
} from "./types";
import { accountWorkspaceIdentity, providerForWorkspace } from "./workspaces";

const PRIMARY_CALENDAR_ID = "primary";
const DEFAULT_TIMEZONE = "America/Chicago";
const SYNC_STALE_MS = 10 * 60_000;

export type CalendarDraftInput = {
  accountId: string;
  calendarId?: string;
  title: string;
  description?: string;
  location?: string;
  startsAt: string;
  endsAt: string;
  isAllDay?: boolean;
  timezone?: string;
  attendees?: string[] | string;
  reminderMinutes?: number | null;
  isBusy?: boolean;
  privacy?: CalendarPrivacy;
  sendUpdates?: boolean;
};

export async function getCalendarPage(input: {
  workspaceId?: string;
  date?: string;
  from?: string;
  to?: string;
  sync?: boolean;
} = {}): Promise<CalendarPage> {
  const timezone = (await getSetting("timezone")) || DEFAULT_TIMEZONE;
  const day = input.date ? calendarDayBounds(input.date, timezone) : null;
  const range = day ? { from: day.startIso, to: day.endIso } : normalizeRange(input.from, input.to);
  if (input.sync !== false) {
    await syncCalendarAccounts({
      workspaceId: input.workspaceId,
      from: range.from,
      to: range.to,
      staleOnly: true,
    });
  }
  const accounts = await getCalendarAccounts(input.workspaceId);
  const events = await getCalendarEvents(accounts, range.from, range.to, timezone);
  const drafts = await getCalendarDrafts(accounts, range.from, range.to);
  return {
    events,
    drafts,
    accounts,
    range: { ...range, timezone },
  };
}

export async function syncCalendarAccounts(input: {
  workspaceId?: string;
  from?: string;
  to?: string;
  staleOnly?: boolean;
} = {}): Promise<CalendarActionResult> {
  const range = input.from && input.to ? { from: input.from, to: input.to } : syncWindow();
  const rows = await accountRows(input.workspaceId);
  let synced = 0;
  const failures: Array<{ accountId: string; error: string }> = [];
  for (const row of rows) {
    const accountId = String(row.id);
    const email = String(row.email);
    const provider = String(row.provider) as AccountProvider;
    if (input.staleOnly && !(await shouldSync(accountId, range))) continue;
    try {
      await setSyncState(accountId, "syncing", null);
      const events =
        provider === "microsoft"
          ? await syncMicrosoftCalendar(email, accountId, range)
          : await syncGoogleCalendar(email, accountId, range);
      for (const event of events.filter((event) => event.externalEventId)) {
        await upsertCalendarEvent({
          ...event,
          accountId,
          accountLabel: String(row.label),
          accountProvider: provider,
          syncedAt: nowIso(),
        });
        synced += 1;
      }
      await setCalendarIntegration(accountId, provider, "write", "connected", null);
      await setSyncState(accountId, "connected", null, range);
      await audit("calendar.synced", "worker", "account", accountId, { count: events.length });
    } catch (error) {
      const message = friendlyCalendarError(provider, error);
      failures.push({ accountId, error: message });
      await setCalendarIntegration(accountId, provider, "none", "error", message);
      await setSyncState(accountId, "error", message);
      await audit("calendar.sync.failed", "worker", "account", accountId, { error: message });
    }
  }
  return {
    ok: failures.length === 0,
    message: failures.length ? "Calendar sync completed with errors." : "Calendar sync complete.",
    synced,
    failures,
  };
}

export async function createCalendarDraft(input: CalendarDraftInput): Promise<CalendarDraft> {
  const account = await connectedAccount(input.accountId);
  const timezone = input.timezone?.trim() || (await getSetting("timezone")) || DEFAULT_TIMEZONE;
  const title = input.title.trim();
  if (!title) throw new Error("Calendar event title is required.");
  const startsAt = normalizeDateTime(input.startsAt, "start");
  const endsAt = normalizeDateTime(input.endsAt, "end");
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new Error("Calendar event end time must be after the start time.");
  }
  const attendees = normalizeAttendeeList(input.attendees || []);
  const now = nowIso();
  const id = newId("caldraft");
  await execute(
    `INSERT INTO calendar_drafts
      (id, account_id, calendar_id, title, description, location, starts_at, ends_at,
       is_all_day, timezone, attendees, reminder_minutes, is_busy, privacy, send_updates,
       status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [
      id,
      input.accountId,
      input.calendarId || PRIMARY_CALENDAR_ID,
      title,
      input.description?.trim() || "",
      input.location?.trim() || "",
      startsAt,
      endsAt,
      input.isAllDay ? 1 : 0,
      timezone,
      JSON.stringify(attendees),
      input.reminderMinutes ?? null,
      input.isBusy === false ? 0 : 1,
      input.privacy || "default",
      input.sendUpdates ? 1 : 0,
      now,
      now,
    ],
  );
  await audit("calendar.draft.created", "cockpit", "calendar_draft", id, {
    accountId: input.accountId,
    provider: account.provider,
    attendees: attendees.length,
  });
  const draft = await getCalendarDraft(id);
  if (!draft) throw new Error("Calendar draft could not be loaded after saving.");
  return draft;
}

export async function updateCalendarDraft(input: CalendarDraftInput & { draftId: string }): Promise<CalendarDraft> {
  const current = await getCalendarDraft(input.draftId);
  if (!current || current.status !== "draft") throw new Error("Calendar draft was not found or is no longer editable.");
  const next = await createCalendarDraft(input);
  await cancelCalendarDraft(input.draftId);
  return next;
}

export async function cancelCalendarDraft(draftId: string): Promise<CalendarActionResult> {
  const draft = await getCalendarDraft(draftId);
  if (!draft) throw new Error("Calendar draft was not found.");
  await execute(`UPDATE calendar_drafts SET status = 'cancelled', updated_at = ? WHERE id = ?`, [
    nowIso(),
    draftId,
  ]);
  await audit("calendar.draft.cancelled", "cockpit", "calendar_draft", draftId);
  return { ok: true, message: "Calendar draft cancelled." };
}

export async function createEventFromDraft(input: {
  draftId: string;
  confirmInvites?: boolean;
  sendUpdates?: boolean;
}): Promise<CalendarActionResult> {
  const draft = await getCalendarDraft(input.draftId);
  if (!draft) throw new Error("Calendar draft was not found.");
  if (draft.status !== "draft") throw new Error("Calendar draft is not ready to create.");
  const account = await connectedAccount(draft.accountId);
  const attendees = draft.attendees;
  if (account.provider === "microsoft" && attendees.length && !input.confirmInvites) {
    throw new Error("Microsoft calendar events with attendees send invitations. Confirm invitation sending before creating this event.");
  }

  const providerEvent = account.email.endsWith(".test")
    ? testCalendarEvent(account, draft)
    : account.provider === "microsoft"
      ? await createMicrosoftCalendarEvent(account.email, draft)
      : await createGoogleCalendarEvent({
        account: account.email,
        calendarId: draft.calendarId,
        title: draft.title,
        description: draft.description,
        location: draft.location,
        startsAt: draft.startsAt,
        endsAt: draft.endsAt,
        isAllDay: draft.isAllDay,
        timezone: draft.timezone,
        attendees,
        reminderMinutes: draft.reminderMinutes,
        isBusy: draft.isBusy,
        privacy: draft.privacy,
        sendUpdates: input.sendUpdates ?? draft.sendUpdates,
      });
  if (!providerEvent?.externalEventId) throw new Error("Calendar provider did not return a created event id.");
  const event = await upsertCalendarEvent({
    ...providerEvent,
    accountId: account.id,
    accountLabel: account.label,
    accountProvider: account.provider,
    syncedAt: nowIso(),
  });
  await execute(
    `UPDATE calendar_drafts
     SET status = 'created', provider_event_id = ?, updated_at = ?
     WHERE id = ?`,
    [event.externalEventId, nowIso(), draft.id],
  );
  await audit("calendar.event.created", "cockpit", "calendar_event", event.id, {
    draftId: draft.id,
    accountId: account.id,
    attendees: attendees.length,
  });
  return { ok: true, message: "Calendar event created.", draft: await getCalendarDraft(draft.id) || draft, event };
}

export async function markCalendarIntegrationConnected(accountId: string, provider: AccountProvider) {
  await setCalendarIntegration(accountId, provider, "write", "connected", null);
}

export function calendarSyncWindow(now = new Date()) {
  const from = new Date(now);
  from.setDate(from.getDate() - 7);
  const to = new Date(now);
  to.setDate(to.getDate() + 45);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function calendarRangeCovered(
  coverage: { from?: string | null; to?: string | null },
  requested: { from: string; to: string },
) {
  const coveredFrom = coverage.from ? new Date(coverage.from).getTime() : Number.NaN;
  const coveredTo = coverage.to ? new Date(coverage.to).getTime() : Number.NaN;
  const requestedFrom = new Date(requested.from).getTime();
  const requestedTo = new Date(requested.to).getTime();
  return Number.isFinite(coveredFrom)
    && Number.isFinite(coveredTo)
    && Number.isFinite(requestedFrom)
    && Number.isFinite(requestedTo)
    && requestedFrom >= coveredFrom
    && requestedTo <= coveredTo;
}

function syncWindow() {
  return calendarSyncWindow();
}

async function syncGoogleCalendar(email: string, accountId: string, range: { from: string; to: string }) {
  return listGoogleCalendarEvents(email, accountId, range);
}

async function syncMicrosoftCalendar(email: string, accountId: string, range: { from: string; to: string }) {
  const token = await getMicrosoftAccessToken(email, "calendar");
  return listMicrosoftCalendarEvents(token, accountId, range);
}

async function getCalendarEvents(accounts: CalendarAccountStatus[], from: string, to: string, timezone: string) {
  if (!accounts.length) return [];
  const ids = accounts.map((account) => account.accountId);
  const placeholders = ids.map(() => "?").join(",");
  const result = await execute(
    `SELECT e.*, a.label AS account_label, a.provider AS account_provider
     FROM calendar_events e
     JOIN email_accounts a ON a.id = e.account_id
     WHERE e.account_id IN (${placeholders})
       AND ((e.is_all_day = 0 AND e.starts_at < ? AND e.ends_at > ?)
         OR (e.is_all_day = 1 AND (
           (e.start_date IS NOT NULL AND e.end_date IS NOT NULL AND e.start_date <= ? AND e.end_date > ?)
           OR ((e.start_date IS NULL OR e.end_date IS NULL) AND e.starts_at < ? AND e.ends_at > ?)
         )))
       AND e.status <> 'cancelled'
     ORDER BY e.starts_at ASC, e.title ASC`,
    [...ids, to, from, calendarDateInZone(to, timezone), calendarDateInZone(from, timezone),
      new Date(Date.parse(to) + 2 * 86_400_000).toISOString(), new Date(Date.parse(from) - 2 * 86_400_000).toISOString()],
  );
  return result.rows.map((row) => calendarEventFromRow(row, timezone)).filter((event) => calendarEventOverlapsRange(event, from, to, timezone));
}

async function getCalendarDrafts(accounts: CalendarAccountStatus[], from: string, to: string) {
  if (!accounts.length) return [];
  const ids = accounts.map((account) => account.accountId);
  const placeholders = ids.map(() => "?").join(",");
  const result = await execute(
    `SELECT d.*, a.label AS account_label, a.provider AS account_provider
     FROM calendar_drafts d
     JOIN email_accounts a ON a.id = d.account_id
     WHERE d.account_id IN (${placeholders})
       AND d.status = 'draft'
       AND d.starts_at < ?
       AND d.ends_at > ?
     ORDER BY d.starts_at ASC, d.title ASC`,
    [...ids, to, from],
  );
  return result.rows.map(calendarDraftFromRow);
}

async function getCalendarDraft(draftId: string) {
  const result = await execute(
    `SELECT d.*, a.label AS account_label, a.provider AS account_provider
     FROM calendar_drafts d
     JOIN email_accounts a ON a.id = d.account_id
     WHERE d.id = ?`,
    [draftId],
  );
  return result.rows[0] ? calendarDraftFromRow(result.rows[0]) : null;
}

type CalendarEventUpsert = Omit<CalendarEvent, "id"> & { id?: string };

async function upsertCalendarEvent(event: CalendarEventUpsert): Promise<CalendarEvent> {
  const now = nowIso();
  const dateRange = event.isAllDay ? calendarDateRange(event.dateRange?.startDate, event.dateRange?.endDate) : null;
  if (event.isAllDay && !dateRange) throw new Error("All-day calendar range is invalid.");
  const existing = await execute(
    `SELECT id FROM calendar_events WHERE account_id = ? AND external_event_id = ?`,
    [event.accountId, event.externalEventId],
  );
  const id = existing.rows[0]?.id ? String(existing.rows[0].id) : newId("calevt");
  await execute(
    `INSERT INTO calendar_events
      (id, account_id, external_event_id, calendar_id, calendar_name, title, description,
       location, starts_at, ends_at, is_all_day, timezone, status, visibility, is_busy,
       organizer_name, organizer_email, attendees, web_link, provider_updated_at,
       synced_at, created_at, updated_at, start_date, end_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, external_event_id) DO UPDATE SET
       calendar_id = excluded.calendar_id,
       calendar_name = excluded.calendar_name,
       title = excluded.title,
       description = excluded.description,
       location = excluded.location,
       starts_at = excluded.starts_at,
       ends_at = excluded.ends_at,
       is_all_day = excluded.is_all_day,
       start_date = excluded.start_date,
       end_date = excluded.end_date,
       timezone = excluded.timezone,
       status = excluded.status,
       visibility = excluded.visibility,
       is_busy = excluded.is_busy,
       organizer_name = excluded.organizer_name,
       organizer_email = excluded.organizer_email,
       attendees = excluded.attendees,
       web_link = excluded.web_link,
       provider_updated_at = excluded.provider_updated_at,
       synced_at = excluded.synced_at,
       updated_at = excluded.updated_at`,
    [
      id,
      event.accountId,
      event.externalEventId,
      event.calendarId || PRIMARY_CALENDAR_ID,
      event.calendarName || "Primary",
      event.title,
      event.description,
      event.location,
      event.startsAt,
      event.endsAt,
      event.isAllDay ? 1 : 0,
      event.timezone,
      event.status,
      event.visibility,
      event.isBusy ? 1 : 0,
      event.organizerName,
      event.organizerEmail,
      JSON.stringify(event.attendees),
      event.webLink,
      event.updatedAt,
      event.syncedAt,
      now,
      now,
      dateRange?.startDate ?? null,
      dateRange?.endDate ?? null,
    ],
  );
  const result = await execute(
    `SELECT e.*, a.label AS account_label, a.provider AS account_provider
     FROM calendar_events e
     JOIN email_accounts a ON a.id = e.account_id
     WHERE e.account_id = ? AND e.external_event_id = ?`,
    [event.accountId, event.externalEventId],
  );
  return calendarEventFromRow(result.rows[0]);
}

async function getCalendarAccounts(workspaceId?: string): Promise<CalendarAccountStatus[]> {
  const rows = await accountRows(workspaceId);
  if (!rows.length) return [];
  const result = await execute(
    `SELECT a.id, a.provider, a.email, a.label, a.status,
       COALESCE(i.status, 'needs_setup') AS calendar_status,
       COALESCE(i.access, 'none') AS calendar_access,
       s.last_sync_at, COALESCE(s.last_error, i.last_error) AS last_error
     FROM email_accounts a
     LEFT JOIN account_integrations i ON i.account_id = a.id AND i.feature = 'calendar'
     LEFT JOIN calendar_sync_state s ON s.account_id = a.id AND s.calendar_id = 'primary'
     WHERE a.id IN (${rows.map(() => "?").join(",")})
     ORDER BY a.provider DESC, a.label ASC`,
    rows.map((row) => String(row.id)),
  );
  return result.rows.map((row) => ({
    accountId: String(row.id),
    accountLabel: String(row.label),
    accountEmail: String(row.email),
    provider: String(row.provider) as AccountProvider,
    status: String(row.status) as CalendarAccountStatus["status"],
    calendarStatus: String(row.calendar_status || "needs_setup") as CalendarAccountStatus["calendarStatus"],
    calendarAccess: String(row.calendar_access || "none") as CalendarAccountStatus["calendarAccess"],
    lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
  }));
}

async function accountRows(workspaceId?: string) {
  const account = accountWorkspaceIdentity(workspaceId);
  if (account) {
    const result = await execute(
      `SELECT id, provider, email, label, status
       FROM email_accounts WHERE id = ? AND provider = ? AND status <> 'disabled'`,
      [account.accountId, account.provider],
    );
    return result.rows;
  }
  const provider = providerForWorkspace(workspaceId);
  const where = provider === "all" ? "status <> 'disabled'" : "provider = ? AND status <> 'disabled'";
  const result = await execute(
    `SELECT id, provider, email, label, status
     FROM email_accounts
     WHERE ${where}
     ORDER BY provider DESC, label ASC`,
    provider === "all" ? [] : [provider],
  );
  return result.rows;
}

async function connectedAccount(accountId: string) {
  const result = await execute(
    `SELECT id, provider, email, label, status FROM email_accounts WHERE id = ? AND status <> 'disabled'`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Connected calendar account was not found.");
  return {
    id: String(row.id),
    provider: String(row.provider) as AccountProvider,
    email: String(row.email),
    label: String(row.label),
    status: String(row.status),
  };
}

async function shouldSync(accountId: string, range?: { from: string; to: string }) {
  const result = await execute(
    `SELECT last_sync_at, status, range_from, range_to
     FROM calendar_sync_state
     WHERE account_id = ? AND calendar_id = 'primary'`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row?.last_sync_at) return true;
  if (String(row.status) === "syncing") return false;
  if (range && !calendarRangeCovered({ from: row.range_from ? String(row.range_from) : null, to: row.range_to ? String(row.range_to) : null }, range)) return true;
  return Date.now() - new Date(String(row.last_sync_at)).getTime() > SYNC_STALE_MS;
}

async function setSyncState(accountId: string, status: string, error: string | null, range?: { from: string; to: string }) {
  await execute(
    `INSERT INTO calendar_sync_state
      (account_id, calendar_id, status, last_sync_at, last_error, range_from, range_to, updated_at)
     VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, calendar_id) DO UPDATE SET
       status = excluded.status,
       last_sync_at = excluded.last_sync_at,
       last_error = excluded.last_error,
       range_from = CASE WHEN excluded.status = 'connected' THEN excluded.range_from ELSE calendar_sync_state.range_from END,
       range_to = CASE WHEN excluded.status = 'connected' THEN excluded.range_to ELSE calendar_sync_state.range_to END,
       updated_at = excluded.updated_at`,
    [
      accountId,
      status,
      status === "connected" ? nowIso() : null,
      error,
      status === "connected" ? range?.from || null : null,
      status === "connected" ? range?.to || null : null,
      nowIso(),
    ],
  );
}

async function setCalendarIntegration(
  accountId: string,
  provider: AccountProvider,
  access: "none" | "read" | "write",
  status: "connected" | "needs_setup" | "error" | "syncing",
  error: string | null,
) {
  await execute(
    `INSERT INTO account_integrations
      (account_id, feature, provider, access, status, last_connected_at, last_error, updated_at)
     VALUES (?, 'calendar', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, feature) DO UPDATE SET
       provider = excluded.provider,
       access = excluded.access,
       status = excluded.status,
       last_connected_at = COALESCE(excluded.last_connected_at, account_integrations.last_connected_at),
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
    [
      accountId,
      provider,
      access,
      status,
      status === "connected" ? nowIso() : null,
      error,
      nowIso(),
    ],
  );
}

function calendarEventFromRow(row: Row, configuredTimezone = DEFAULT_TIMEZONE): CalendarEvent {
  const isAllDay = Number(row.is_all_day) === 1;
  const timezone = nullableString(row.timezone) || configuredTimezone;
  const hasDates = row.start_date != null || row.end_date != null;
  const dateRange = !isAllDay ? null : hasDates
    ? calendarDateRange(row.start_date, row.end_date)
    : allDayRangeFromInstants(String(row.starts_at), String(row.ends_at), timezone, true);
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    accountLabel: String(row.account_label),
    accountProvider: String(row.account_provider) as AccountProvider,
    externalEventId: String(row.external_event_id),
    calendarId: String(row.calendar_id),
    calendarName: String(row.calendar_name),
    title: String(row.title),
    description: nullableString(row.description),
    location: nullableString(row.location),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    isAllDay,
    dateRange,
    timezone: nullableString(row.timezone),
    status: String(row.status),
    visibility: nullableString(row.visibility),
    isBusy: Number(row.is_busy) === 1,
    organizerName: nullableString(row.organizer_name),
    organizerEmail: nullableString(row.organizer_email),
    attendees: parseAttendees(row.attendees),
    webLink: nullableString(row.web_link),
    updatedAt: nullableString(row.provider_updated_at),
    syncedAt: String(row.synced_at),
  };
}

function calendarDraftFromRow(row: Row): CalendarDraft {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    accountLabel: String(row.account_label),
    accountProvider: String(row.account_provider) as AccountProvider,
    calendarId: String(row.calendar_id),
    title: String(row.title),
    description: String(row.description || ""),
    location: String(row.location || ""),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    isAllDay: Number(row.is_all_day) === 1,
    timezone: String(row.timezone || DEFAULT_TIMEZONE),
    attendees: parseStringArray(row.attendees),
    reminderMinutes: row.reminder_minutes === null || row.reminder_minutes === undefined ? null : Number(row.reminder_minutes),
    isBusy: Number(row.is_busy) === 1,
    privacy: String(row.privacy || "default") as CalendarPrivacy,
    sendUpdates: Number(row.send_updates) === 1,
    status: String(row.status) as CalendarDraft["status"],
    providerEventId: nullableString(row.provider_event_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function testCalendarEvent(
  account: { id: string; label: string; provider: AccountProvider },
  draft: CalendarDraft,
): Omit<CalendarEvent, "id" | "accountLabel" | "accountProvider" | "syncedAt"> {
  return {
    accountId: account.id,
    externalEventId: `test-${draft.id}`,
    calendarId: draft.calendarId,
    calendarName: "Primary",
    title: draft.title,
    description: draft.description || null,
    location: draft.location || null,
    startsAt: draft.startsAt,
    endsAt: draft.endsAt,
    isAllDay: draft.isAllDay,
    dateRange: draft.isAllDay ? allDayRangeFromInstants(draft.startsAt, draft.endsAt, draft.timezone) : null,
    timezone: draft.timezone,
    status: "confirmed",
    visibility: draft.privacy,
    isBusy: draft.isBusy,
    organizerName: account.label,
    organizerEmail: null,
    attendees: draft.attendees.map((email) => ({ email })),
    webLink: null,
    updatedAt: nowIso(),
  };
}

function normalizeRange(from?: string, to?: string) {
  const start = from ? new Date(from) : startOfWeek(new Date());
  const end = to ? new Date(to) : addDays(start, 7);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Calendar range must use valid dates.");
  }
  const duration = end.getTime() - start.getTime();
  if (duration <= 0) throw new Error("Calendar range end must be after its start.");
  if (duration > 370 * 24 * 60 * 60_000) throw new Error("Calendar range cannot exceed 370 days.");
  return { from: start.toISOString(), to: end.toISOString() };
}

function startOfWeek(value: Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - date.getDay());
  return date;
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function normalizeDateTime(value: string, label: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Calendar ${label} time must be a valid date.`);
  return date.toISOString();
}

function normalizeAttendeeList(value: string[] | string) {
  const values = Array.isArray(value) ? value : value.split(/[,\n;]/g);
  return [...new Set(values.map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function parseAttendees(value: unknown): CalendarAttendee[] {
  if (Array.isArray(value)) return value.filter(Boolean) as CalendarAttendee[];
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.filter(Boolean) as CalendarAttendee[];
  } catch {
    return parseStringArray(value).map((email) => ({ email }));
  }
  return [];
}

function nullableString(value: unknown) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text ? text : null;
}

function friendlyCalendarError(provider: AccountProvider, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const projectMatch = message.match(/project\s+(\d+)/i);
  if (
    provider === "gmail" &&
    (/accessNotConfigured/i.test(message) ||
      /Calendar API has not been used/i.test(message) ||
      /calendar-json\.googleapis\.com/i.test(message))
  ) {
    return projectMatch?.[1]
      ? `Enable Google Calendar API in Google Cloud project ${projectMatch[1]}, then reconnect Gmail Calendar.`
      : "Enable Google Calendar API for the Google Cloud OAuth project, then reconnect Gmail Calendar.";
  }
  if (/calendar access|Calendars\.ReadWrite|calendar\.events|insufficient|unauthorized|invalid_grant/i.test(message)) {
    return provider === "microsoft"
      ? "Reconnect Hotmail from Settings to grant Microsoft calendar access."
      : "Reconnect Gmail from Settings to grant Google Calendar access.";
  }
  return message;
}
