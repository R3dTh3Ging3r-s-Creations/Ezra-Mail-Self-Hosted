import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const gog = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: gog.spawn, default: { ...actual, spawn: gog.spawn } };
});
import { createMicrosoftCalendarEvent, storeMicrosoftRefreshToken } from "@/lib/email/microsoft";
import { createGoogleCalendarEvent } from "@/lib/email/gmail";

const base = { calendarId: "primary", title: "Fixture", description: "", location: "", startsAt: "2026-10-09T12:00:00Z", endsAt: "2026-10-09T12:10:00Z", isAllDay: false, timezone: "America/Chicago", attendees: [], reminderMinutes: null, isBusy: false, privacy: "default", sendUpdates: false };
describe("calendar provider reminder serialization", () => {
  let directory: string | undefined;
  afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); gog.spawn.mockReset(); if (directory) await fs.rm(directory, { recursive: true, force: true }); directory = undefined; });
  it("keeps Microsoft default, disabled and at-start distinct and transmits UTC instants", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-cal-"));
    vi.stubEnv("EZRA_MICROSOFT_TOKEN_BACKEND", "file"); vi.stubEnv("EZRA_CREDENTIAL_DIR", directory); vi.stubEnv("MICROSOFT_CLIENT_ID", "fixture");
    await storeMicrosoftRefreshToken("owner@hotmail.test", "synthetic-fixture");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).includes("/token")) return new Response(JSON.stringify({ access_token: "test-token" }));
      if (String(url).includes("/me/calendar?")) return new Response(JSON.stringify({ id: "resolved-primary" }));
      const body = JSON.parse(init.body); bodies.push(body);
      return new Response(JSON.stringify({ ...body, id: "fixture-event" }));
    }));
    for (const reminderMode of ["default", "none", "minutes"] as const) await createMicrosoftCalendarEvent("owner@hotmail.test", { ...base, reminderMode, reminderMinutes: reminderMode === "minutes" ? 0 : null });
    expect(bodies[0]).not.toHaveProperty("isReminderOn");
    expect(bodies[1]).toMatchObject({ isReminderOn: false });
    expect(bodies[2]).toMatchObject({ isReminderOn: true, reminderMinutesBeforeStart: 0, showAs: "free", attendees: [], start: { dateTime: "2026-10-09T12:00:00.000", timeZone: "UTC" } });
    const creates = vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).includes("/calendars/") && init?.method === "POST");
    expect(creates[0][0]).toContain("/me/calendars/resolved-primary/events");
    expect(creates[0][1]).toMatchObject({ headers: { prefer: 'IdType="ImmutableId"' } });
    await createMicrosoftCalendarEvent("owner@hotmail.test", { ...base, calendarId: "chosen", isAllDay: true, timezone: "Asia/Tokyo", startsAt: "2026-08-30T15:00:00Z", endsAt: "2026-08-31T15:00:00Z" });
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toContain("/me/calendars/chosen/events");
    expect(bodies[3]).toMatchObject({ start: { dateTime: "2026-08-31T00:00:00", timeZone: "Asia/Tokyo" }, end: { dateTime: "2026-09-01T00:00:00", timeZone: "Asia/Tokyo" } });
  });
  it("uses explicit Google flags without changing account or sending invitations", async () => {
    gog.spawn.mockImplementation((_executable, args: string[]) => ({ stdout: { on: (event: string, cb: (chunk: Buffer) => void) => { if (event === "data") queueMicrotask(() => cb(Buffer.from(args.includes("--help") ? "Usage: gog calendar create\n --no-reminders\n --reminder=REMINDER" : JSON.stringify({ id: "event", start: { dateTime: base.startsAt }, end: { dateTime: base.endsAt } })))); } }, stderr: { on: () => undefined }, on: (event: string, cb: (code: number) => void) => { if (event === "close") queueMicrotask(() => cb(0)); }, kill: () => undefined }));
    for (const reminderMode of ["default", "none", "minutes"] as const) await createGoogleCalendarEvent({ ...base, account: "owner@gmail.test", reminderMode, reminderMinutes: reminderMode === "minutes" ? 0 : null });
    const args = gog.spawn.mock.calls.filter(call => !call[1].includes("--help")).map(call => call[1] as string[]);
    expect(args[0]).not.toContain("--reminder"); expect(args[0]).not.toContain("--no-reminders");
    expect(args[1]).toContain("--no-reminders");
    expect(args[2]).toEqual(expect.arrayContaining(["--reminder", "popup:0m", "--account", "owner@gmail.test", "--send-updates", "none"]));
    await createGoogleCalendarEvent({ ...base, account: "owner@gmail.test", isAllDay: true, timezone: "Asia/Tokyo", startsAt: "2026-08-30T15:00:00Z", endsAt: "2026-08-31T15:00:00Z" });
    expect(gog.spawn.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(["--from", "2026-08-31", "--to", "2026-09-01", "--all-day"]));
  });
  it("does not dispatch a Google create when the installed CLI lacks no-reminders", async () => {
    gog.spawn.mockImplementation((_executable, args: string[]) => ({ stdout: { on: (event: string, cb: (chunk: Buffer) => void) => { if (event === "data") queueMicrotask(() => cb(Buffer.from(args.includes("--help") ? "Usage: gog calendar create\n --reminder=REMINDER" : JSON.stringify({ id: "event", start: { dateTime: base.startsAt }, end: { dateTime: base.endsAt } })))); } }, stderr: { on: () => undefined }, on: (event: string, cb: (code: number) => void) => { if (event === "close") queueMicrotask(() => cb(0)); }, kill: () => undefined }));
    await expect(createGoogleCalendarEvent({ ...base, account: "owner@gmail.test", reminderMode: "none" })).rejects.toThrow(/does not support disabling reminders/);
    expect(gog.spawn.mock.calls.every(call => call[1].includes("--help"))).toBe(true);
  });
});
