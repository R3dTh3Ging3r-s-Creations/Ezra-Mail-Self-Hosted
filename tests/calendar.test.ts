import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  calendarRangeCovered,
  createCalendarDraft,
  createEventFromDraft,
  getCalendarPage,
} from "@/lib/email/calendar";
import {
  configureEmailDatabaseForTests,
  execute,
  nowIso,
} from "@/lib/email/database";
import { normalizeGoogleCalendarEvent } from "@/lib/email/gmail";
import {
  MICROSOFT_CALENDAR_EVENT_SELECT_FIELDS,
  normalizeMicrosoftCalendarEvent,
} from "@/lib/email/microsoft";

describe("calendar workspaces", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./calendar-${randomUUID()}.sqlite`);
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail Test");
    await seedAccount("acct-ms", "microsoft", "owner@hotmail.test", "Hotmail Test");
  });

  it("normalizes Google and Microsoft events into one calendar shape", () => {
    const google = normalizeGoogleCalendarEvent("acct-gmail", {
      id: "google-event",
      summary: "Google interview",
      start: { dateTime: "2026-07-01T14:00:00-05:00", timeZone: "America/Chicago" },
      end: { dateTime: "2026-07-01T15:00:00-05:00", timeZone: "America/Chicago" },
      location: "Remote",
      attendees: [{ email: "recruiter@example.com", responseStatus: "accepted" }],
      htmlLink: "https://calendar.google.com/event",
    });
    const microsoft = normalizeMicrosoftCalendarEvent("acct-ms", {
      id: "ms-event",
      subject: "Outlook interview",
      start: { dateTime: "2026-07-02T16:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-07-02T16:30:00", timeZone: "UTC" },
      location: { displayName: "Teams" },
      attendees: [{ emailAddress: { address: "manager@example.com" }, status: { response: "none" } }],
      webLink: "https://outlook.live.com/calendar",
    });

    expect(google).toMatchObject({
      accountId: "acct-gmail",
      externalEventId: "google-event",
      title: "Google interview",
      location: "Remote",
      isAllDay: false,
      dateRange: null,
    });
    expect(google?.attendees[0]).toMatchObject({ email: "recruiter@example.com" });
    expect(microsoft).toMatchObject({
      accountId: "acct-ms",
      externalEventId: "ms-event",
      title: "Outlook interview",
      location: "Teams",
      calendarId: "primary",
      status: "confirmed",
    });
    expect(microsoft.attendees[0]).toMatchObject({ email: "manager@example.com" });
  });

  it("does not request invalid Microsoft Calendar event fields", () => {
    expect(MICROSOFT_CALENDAR_EVENT_SELECT_FIELDS).not.toContain("status");
    expect(MICROSOFT_CALENDAR_EVENT_SELECT_FIELDS).toContain("isCancelled");
  });

  it("preserves Google and Microsoft all-day lexical ranges before instant conversion", () => {
    const google = normalizeGoogleCalendarEvent("acct-gmail", { id: "all-day", start: { date: "2026-08-30" }, end: { date: "2026-09-02" } });
    const microsoft = normalizeMicrosoftCalendarEvent("acct-ms", { id: "all-day", isAllDay: true, start: { dateTime: "2026-08-30T00:00:00", timeZone: "Central Standard Time" }, end: { dateTime: "2026-09-02T00:00:00", timeZone: "Central Standard Time" } });
    expect(google).toMatchObject({ isAllDay: true, dateRange: { startDate: "2026-08-30", endDate: "2026-09-02" } });
    expect(microsoft).toMatchObject({ isAllDay: true, dateRange: { startDate: "2026-08-30", endDate: "2026-09-02" } });
    expect(normalizeGoogleCalendarEvent("acct-gmail", { id: "invalid", start: { date: "2026-02-31" }, end: { date: "2026-03-04" } })).toBeNull();
    expect(normalizeGoogleCalendarEvent("acct-gmail", { id: "reversed", start: { date: "2026-09-02" }, end: { date: "2026-08-30" } })).toBeNull();
    expect(normalizeGoogleCalendarEvent("acct-gmail", { id: "malformed", start: { date: "2026-08-30invalid" }, end: { date: "2026-09-02" } })).toBeNull();
    expect(() => normalizeMicrosoftCalendarEvent("acct-ms", { id: "invalid", isAllDay: true, start: { dateTime: "2026-08-30invalid" }, end: { dateTime: "2026-09-02T00:00:00" } })).toThrow("all-day calendar range is invalid");
  });

  it("derives local all-day dates in the draft timezone and persists the lossless range", async () => {
    const draft = await createCalendarDraft({ accountId: "acct-gmail", title: "Local day", startsAt: "2026-08-30T15:00:00.000Z", endsAt: "2026-08-31T15:00:00.000Z", isAllDay: true, timezone: "Asia/Tokyo" });
    const result = await createEventFromDraft({ draftId: draft.id });
    expect(result.event).toMatchObject({ dateRange: { startDate: "2026-08-31", endDate: "2026-09-01" } });
    expect((await execute("SELECT start_date, end_date FROM calendar_events")).rows).toEqual([{ start_date: "2026-08-31", end_date: "2026-09-01" }]);
  });

  it("decodes legacy cached all-day rows without sync, preserving placeholders and stored timezone dates", async () => {
    await seedEvent("placeholder", "acct-gmail", "Provider day", "2026-08-30T00:00:00.000Z");
    await seedEvent("zoned", "acct-gmail", "Zoned day", "2026-08-30T15:00:00.000Z");
    await execute("UPDATE calendar_events SET is_all_day = 1, ends_at = '2026-08-31T00:00:00.000Z', timezone = 'America/Chicago' WHERE id = 'placeholder'");
    await execute("UPDATE calendar_events SET is_all_day = 1, ends_at = '2026-08-31T15:00:00.000Z', timezone = 'Asia/Tokyo' WHERE id = 'zoned'");
    const page = await getCalendarPage({ workspaceId: "workspace:gmail", from: "2026-08-29T00:00:00.000Z", to: "2026-09-03T00:00:00.000Z", sync: false });
    expect(page.events).toEqual([
      expect.objectContaining({ id: "placeholder", dateRange: { startDate: "2026-08-30", endDate: "2026-08-31" } }),
      expect.objectContaining({ id: "zoned", dateRange: { startDate: "2026-08-31", endDate: "2026-09-01" } }),
    ]);
    await execute("UPDATE calendar_events SET start_date = '2026-09-01', end_date = '2026-09-03' WHERE id = 'placeholder'");
    expect((await getCalendarPage({ from: "2026-09-01T05:00:00.000Z", to: "2026-09-02T05:00:00.000Z", sync: false })).events[0]).toMatchObject({ id: "placeholder", dateRange: { startDate: "2026-09-01", endDate: "2026-09-03" } });
    await execute("UPDATE calendar_events SET start_date = '2026-09-03', end_date = '2026-09-01' WHERE id = 'placeholder'");
    expect((await getCalendarPage({ from: "2026-08-29T00:00:00.000Z", to: "2026-09-04T00:00:00.000Z", sync: false })).events.map((event) => event.id)).toEqual(["zoned"]);
    expect((await execute("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'calendar.synced'")).rows[0].n).toBe(0);
  });

  it("filters calendar events by Gmail, Hotmail, and All workspaces", async () => {
    await seedEvent("gmail-event", "acct-gmail", "Gmail planning", "2026-07-01T14:00:00.000Z");
    await seedEvent("ms-event", "acct-ms", "Hotmail planning", "2026-07-01T16:00:00.000Z");
    const range = { from: "2026-07-01T00:00:00.000Z", to: "2026-07-03T00:00:00.000Z", sync: false };

    const gmail = await getCalendarPage({ ...range, workspaceId: "workspace:gmail" });
    const hotmail = await getCalendarPage({ ...range, workspaceId: "workspace:microsoft" });
    const all = await getCalendarPage({ ...range, workspaceId: "workspace:all" });

    expect(gmail.events.map((event) => event.title)).toEqual(["Gmail planning"]);
    expect(hotmail.events.map((event) => event.title)).toEqual(["Hotmail planning"]);
    expect(all.events.map((event) => event.title)).toEqual(["Gmail planning", "Hotmail planning"]);

    const account = await getCalendarPage({ ...range, workspaceId: "workspace:account:gmail:acct-gmail" });
    expect(account.events.map((event) => event.title)).toEqual(["Gmail planning"]);
  });

  it("resolves an exact requested day in the configured timezone independently of browser range instants", async () => {
    await seedEvent("late", "acct-gmail", "Late local event", "2026-08-31T04:00:00.000Z");
    const page = await getCalendarPage({ date: "2026-08-30", from: "2026-08-30T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z", sync: false });
    expect(page.range).toEqual({ from: "2026-08-30T05:00:00.000Z", to: "2026-08-31T05:00:00.000Z", timezone: "America/Chicago" });
    expect(page.events.map((event) => event.id)).toEqual(["late"]);
    await expect(getCalendarPage({ date: "2026-02-31", sync: false })).rejects.toThrow("Calendar date is invalid");
  });

  it("migrates range-aware calendar sync coverage columns", async () => {
    const columns = await execute(`PRAGMA table_info(calendar_sync_state)`);
    const names = columns.rows.map((row) => String(row.name));
    expect(names).toContain("range_from");
    expect(names).toContain("range_to");
  });

  it("refreshes when the selected calendar period falls outside cached coverage", () => {
    const coverage = { from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" };
    expect(calendarRangeCovered(coverage, { from: "2026-07-05T00:00:00.000Z", to: "2026-07-12T00:00:00.000Z" })).toBe(true);
    expect(calendarRangeCovered(coverage, { from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" })).toBe(false);
    expect(calendarRangeCovered({ from: null, to: null }, { from: "2026-07-05T00:00:00.000Z", to: "2026-07-12T00:00:00.000Z" })).toBe(false);
  });

  it("rejects reversed or unbounded calendar ranges", async () => {
    await expect(getCalendarPage({ from: "2026-08-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z", sync: false })).rejects.toThrow("end must be after");
    await expect(getCalendarPage({ from: "2026-01-01T00:00:00.000Z", to: "2028-01-01T00:00:00.000Z", sync: false })).rejects.toThrow("cannot exceed 370 days");
  });

  it("stores manual event drafts without provider writes until approval", async () => {
    const draft = await createCalendarDraft({
      accountId: "acct-gmail",
      title: "Application follow-up",
      startsAt: "2026-07-01T14:00:00.000Z",
      endsAt: "2026-07-01T15:00:00.000Z",
      attendees: "recruiter@example.com",
    });
    const eventsBeforeApproval = await execute(`SELECT COUNT(*) AS count FROM calendar_events`);

    expect(draft).toMatchObject({
      status: "draft",
      sendUpdates: false,
      attendees: ["recruiter@example.com"],
    });
    expect(Number(eventsBeforeApproval.rows[0]?.count || 0)).toBe(0);

    const result = await createEventFromDraft({ draftId: draft.id });
    const saved = await execute(`SELECT status, provider_event_id FROM calendar_drafts WHERE id = ?`, [draft.id]);

    expect(result).toMatchObject({ ok: true, event: { title: "Application follow-up" } });
    expect(saved.rows[0]).toMatchObject({ status: "created", provider_event_id: `test-${draft.id}` });
  });

  it("blocks Microsoft attendee event creation until invite sending is explicitly confirmed", async () => {
    const draft = await createCalendarDraft({
      accountId: "acct-ms",
      title: "Hiring manager screen",
      startsAt: "2026-07-02T14:00:00.000Z",
      endsAt: "2026-07-02T14:30:00.000Z",
      attendees: ["manager@example.com"],
    });

    await expect(createEventFromDraft({ draftId: draft.id })).rejects.toThrow("Confirm invitation sending");

    const result = await createEventFromDraft({ draftId: draft.id, confirmInvites: true });
    expect(result).toMatchObject({ ok: true, event: { accountProvider: "microsoft" } });
  });
});

async function seedAccount(
  id: string,
  provider: "gmail" | "microsoft",
  email: string,
  label: string,
) {
  await execute(
    `INSERT INTO email_accounts
      (id, provider, email, label, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'connected', ?, ?)`,
    [id, provider, email, label, nowIso(), nowIso()],
  );
  await execute(
    `INSERT INTO account_integrations
      (account_id, feature, provider, access, status, last_connected_at, updated_at)
     VALUES (?, 'calendar', ?, 'write', 'connected', ?, ?)`,
    [id, provider, nowIso(), nowIso()],
  );
}

async function seedEvent(id: string, accountId: string, title: string, startsAt: string) {
  const endsAt = new Date(new Date(startsAt).getTime() + 60 * 60_000).toISOString();
  await execute(
    `INSERT INTO calendar_events
      (id, account_id, external_event_id, calendar_id, calendar_name, title, starts_at,
       ends_at, is_all_day, status, is_busy, attendees, synced_at, created_at, updated_at)
     VALUES (?, ?, ?, 'primary', 'Primary', ?, ?, ?, 0, 'confirmed', 1, '[]', ?, ?, ?)`,
    [id, accountId, id, title, startsAt, endsAt, nowIso(), nowIso(), nowIso()],
  );
}
