import { afterEach, describe, expect, it, vi } from "vitest";
const gog = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: gog.spawn, default: { ...actual, spawn: gog.spawn } };
});
import { listMicrosoftCalendarEvents, getMicrosoftCalendarEvent, normalizeMicrosoftCalendarEvent, refreshMicrosoftAccessToken } from "@/lib/email/microsoft";
import { listGoogleCalendarEvents, getGoogleCalendarEvent, normalizeGoogleCalendarEvent } from "@/lib/email/gmail";
const range = { from: "2026-10-09T00:00:00Z", to: "2026-10-10T00:00:00Z", calendarId: "chosen" };
const msEvent = (id = "e1") => ({ id, subject: "Reminder", start: { dateTime: "2026-10-09T12:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-09T12:10:00", timeZone: "UTC" }, showAs: "free", isReminderOn: true, reminderMinutesBeforeStart: 0, attendees: [], changeKey: "rev", transactionId: "op", type: "occurrence", seriesMasterId: "series" });
const ggEvent = { id: "e1", summary: "Reminder", start: { dateTime: "2026-10-09T12:00:00Z" }, end: { dateTime: "2026-10-09T12:10:00Z" }, transparency: "transparent", reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] }, attendees: [], etag: "rev", recurringEventId: "series", extendedProperties: { private: { ezraOperationId: "op" } } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function fakeGog(value: unknown, code = 0) {
  return { stdout: { on: (event: string, cb: (chunk: Buffer) => void) => { if (event === "data") queueMicrotask(() => cb(Buffer.from(JSON.stringify(value)))); } }, stderr: { on: () => undefined }, on: (event: string, cb: (code: number) => void) => { if (event === "close") queueMicrotask(() => cb(code)); }, kill: vi.fn() };
}
describe("complete provider calendar reads", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); gog.spawn.mockReset(); });
  it("refreshes calendar-only grants without adding mail or write permission to a read grant", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "fixture-client");
    const fetcher=vi.fn(async()=>json({access_token:"test-access"}));vi.stubGlobal("fetch",fetcher);
    await refreshMicrosoftAccessToken("test-refresh","calendar-readonly" as any);
    expect(String((fetcher.mock.calls[0] as any[])[1].body.get("scope"))).toBe("offline_access User.Read Calendars.Read");
    await refreshMicrosoftAccessToken("test-refresh","calendar-write" as any);
    expect(String((fetcher.mock.calls[1] as any[])[1].body.get("scope"))).toBe("offline_access User.Read Calendars.ReadWrite");
  });
  it("preserves exact plain-text descriptions and requests text readback",async()=>{
    const description="First\nSecond  <literal>";
    const fetcher=vi.fn(async()=>json({...msEvent(),body:{contentType:"text",content:description}}));vi.stubGlobal("fetch",fetcher);
    expect(await getMicrosoftCalendarEvent("synthetic","ms","chosen","e1")).toMatchObject({description});
    expect((fetcher.mock.calls[0] as any[])[1].headers.prefer).toContain('outlook.body-content-type="text"');
    expect(normalizeMicrosoftCalendarEvent("ms",{...msEvent(),body:{contentType:"html",content:"<p>First</p>"}}).description).toBe("First");
  });
  it("uses the documented calendarView query without select and retains revision timestamps", async () => {
    vi.stubGlobal("fetch", vi.fn(async url => {
      if (new URL(String(url)).searchParams.has("$select")) return json({ error: { message: "calendarView timestamps do not support select" } }, 400);
      return json({ value: [{ ...msEvent(), lastModifiedDateTime: "2026-10-01T00:00:00Z" }] });
    }));
    expect(await listMicrosoftCalendarEvents("synthetic", "ms", range)).toMatchObject([{ updatedAt: "2026-10-01T00:00:00Z" }]);
  });
  it.each(["Asia/Tokyo","Tokyo Standard Time"])("re-reads UTC-projected all-day dates in Graph's original zone %s",async(zone)=>{
    const projected={...msEvent(),isAllDay:true,originalStartTimeZone:zone,originalEndTimeZone:zone,start:{dateTime:"2026-08-30T15:00:00",timeZone:"UTC"},end:{dateTime:"2026-08-31T15:00:00",timeZone:"UTC"}};
    const native={...projected,start:{dateTime:"2026-08-31T00:00:00",timeZone:zone},end:{dateTime:"2026-09-01T00:00:00",timeZone:zone}};
    const fetcher=vi.fn().mockResolvedValueOnce(json({value:[projected]})).mockResolvedValueOnce(json(native));vi.stubGlobal("fetch",fetcher);
    expect(await listMicrosoftCalendarEvents("synthetic","ms",range)).toMatchObject([{dateRange:{startDate:"2026-08-31",endDate:"2026-09-01"},timezone:zone}]);
    expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls[1][0]).toContain("/events/e1");expect(fetcher.mock.calls[1][1].headers.prefer).toContain(`outlook.timezone="${zone}"`);
    expect(fetcher.mock.calls[1][1].signal).toBe(fetcher.mock.calls[0][1].signal);
  });
  it.each(["missing-zone","changed-revision","wrong-id","nonmidnight","unsafe-zone"])("rejects unverified all-day reprojection: %s",async(kind)=>{
    const zone=kind==="unsafe-zone"?'UTC", injected="value':"Tokyo Standard Time";
    const projected={...msEvent(),isAllDay:true,originalStartTimeZone:kind==="missing-zone"?undefined:zone,originalEndTimeZone:zone,start:{dateTime:"2026-08-30T15:00:00",timeZone:"UTC"},end:{dateTime:"2026-08-31T15:00:00",timeZone:"UTC"}};
    const native={...projected,id:kind==="wrong-id"?"other":"e1",changeKey:kind==="changed-revision"?"new":"rev",start:{dateTime:kind==="nonmidnight"?"2026-08-31T01:00:00":"2026-08-31T00:00:00",timeZone:zone},end:{dateTime:"2026-09-01T00:00:00",timeZone:zone}};
    vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(json({value:[projected]})).mockResolvedValueOnce(json(native)));
    await expect(listMicrosoftCalendarEvents("synthetic","ms",range)).rejects.toThrow();
  });
  it("accepts already-native all-day dates without another provider request",async()=>{
    const native={...msEvent(),isAllDay:true,start:{dateTime:"2026-08-31T00:00:00",timeZone:"Tokyo Standard Time"},end:{dateTime:"2026-09-01T00:00:00",timeZone:"Tokyo Standard Time"}};
    const fetcher=vi.fn(async()=>json({value:[native]}));vi.stubGlobal("fetch",fetcher);
    expect(await listMicrosoftCalendarEvents("synthetic","ms",range)).toMatchObject([{dateRange:{startDate:"2026-08-31",endDate:"2026-09-01"}}]);expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not extend the complete-read deadline for all-day enrichment",async()=>{
    const start=Date.now();const zone="Tokyo Standard Time";
    const projected={...msEvent(),isAllDay:true,originalStartTimeZone:zone,originalEndTimeZone:zone,start:{dateTime:"2026-08-30T15:00:00",timeZone:"UTC"},end:{dateTime:"2026-08-31T15:00:00",timeZone:"UTC"}};
    const native={...projected,start:{dateTime:"2026-08-31T00:00:00",timeZone:zone},end:{dateTime:"2026-09-01T00:00:00",timeZone:zone}};
    vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(json({value:[projected]})).mockImplementationOnce(async()=>{vi.spyOn(Date,"now").mockReturnValue(start+120_001);return json(native);}));
    await expect(listMicrosoftCalendarEvents("synthetic","ms",range)).rejects.toThrow(/deadline/);
  });
  it("reads every Graph page including recurrence instances from the selected calendar", async () => {
    const next = "https://graph.microsoft.com/v1.0/me/calendars/chosen/calendarView?$skiptoken=next";
    const fetcher = vi.fn().mockResolvedValueOnce(json({ value: Array.from({ length: 100 }, (_, i) => msEvent(`e${i}`)), "@odata.nextLink": next })).mockResolvedValueOnce(json({ value: [msEvent("last")] }));
    vi.stubGlobal("fetch", fetcher);
    const events = await listMicrosoftCalendarEvents("synthetic", "ms", range);
    expect(events).toHaveLength(101);
    expect(fetcher.mock.calls[0][0]).toContain("/me/calendars/chosen/calendarView?");
    expect(events[100]).toMatchObject({ calendarId: "chosen", isBusy: false, reminder: { mode: "minutes", minutes: 0 }, revision: "rev", correlationId: "op", recurrenceId: "series" });
  });
  it.each(["https://evil.test/leak", "http://graph.microsoft.com/v1.0/me/calendarView", "https://graph.microsoft.com/v1.0/me/calendars/other/calendarView"]) ("rejects unsafe continuation %s", async next => {
    const fetcher = vi.fn().mockResolvedValue(json({ value: [msEvent()], "@odata.nextLink": next })); vi.stubGlobal("fetch", fetcher);
    await expect(listMicrosoftCalendarEvents("synthetic", "ms", range)).rejects.toThrow(/continuation/i); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([{}, { value: [{}] }, { value: [null] }, { value: "bad" }])("rejects malformed Graph success %j", async payload => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(payload)));
    await expect(listMicrosoftCalendarEvents("synthetic", "ms", range)).rejects.toThrow();
  });
  it("does not return first-page success when a later page fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ value: [msEvent()], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars/chosen/calendarView?$skiptoken=x" })).mockResolvedValueOnce(json({ error: { message: "denied" } }, 403)));
    await expect(listMicrosoftCalendarEvents("synthetic", "ms", range)).rejects.toThrow();
  });
  it("enforces the 100-page cap and total deadline", async () => {
    let page = 0;
    const fetcher = vi.fn(async () => json({ value: [], "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/calendars/chosen/calendarView?$skiptoken=${++page}` }));
    vi.stubGlobal("fetch", fetcher);
    await expect(listMicrosoftCalendarEvents("synthetic", "ms", range)).rejects.toThrow(/page limit/i);
    expect(fetcher).toHaveBeenCalledTimes(100);
    vi.useFakeTimers();
    fetcher.mockReset().mockImplementation(async () => { vi.setSystemTime(Date.now() + 120_001); return json({ value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars/chosen/calendarView?$skiptoken=late" }); });
    await expect(listMicrosoftCalendarEvents("synthetic", "ms", range)).rejects.toThrow(/deadline/i);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects malformed attendees rather than proving an empty guest list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ value: [{ ...msEvent(), attendees: [{}] }] })));
    await expect(listMicrosoftCalendarEvents("synthetic", "ms", range)).rejects.toThrow(/attendee/i);
    gog.spawn.mockImplementation(() => fakeGog({ events: [{ ...ggEvent, attendees: [{}] }] }));
    await expect(listGoogleCalendarEvents("owner@gmail.test", "gg", range)).rejects.toThrow(/attendee/i);
  });
  it("distinguishes Graph missing event from denied reads and rejects wrong returned id", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json({}, 403)).mockResolvedValueOnce(json(msEvent("other"))); vi.stubGlobal("fetch", fetcher);
    expect(await getMicrosoftCalendarEvent("synthetic", "ms", "chosen", "e1")).toBeNull();
    await expect(getMicrosoftCalendarEvent("synthetic", "ms", "chosen", "e1")).rejects.toThrow();
    await expect(getMicrosoftCalendarEvent("synthetic", "ms", "chosen", "e1")).rejects.toThrow(/id/i);
  });
  it.each(["list", "event"])("reads disabled reminders from complete typed gog %s output", async kind => {
    const event = { ...ggEvent, reminders: {} };
    gog.spawn.mockImplementation(() => fakeGog(kind === "list" ? { events: [event] } : { event }));
    const result = kind === "list" ? (await listGoogleCalendarEvents("owner@gmail.test", "gg", range))[0] : await getGoogleCalendarEvent("owner@gmail.test", "gg", "chosen", "e1");
    expect(result).toMatchObject({ externalEventId: "e1", calendarId: "chosen", reminder: { mode: "none" } });
    expect(gog.spawn).toHaveBeenCalledOnce();
  });
  it("keeps missing or malformed reminders unknown and does not infer empty raw evidence", async () => {
    expect(normalizeGoogleCalendarEvent("gg", { ...ggEvent, reminders: {} })?.reminder).toEqual({ mode: "unknown" });
    for (const reminders of [undefined, null, [], { unexpected: true }, { useDefault: null }]) {
      gog.spawn.mockImplementation(() => fakeGog({ event: { ...ggEvent, reminders } }));
      expect((await getGoogleCalendarEvent("owner@gmail.test", "gg", "chosen", "e1")).reminder).toEqual({ mode: "unknown" });
    }
  });
  it("preserves defaults and explicit zero-minute reminders at the typed gog boundary", async () => {
    for (const [reminders, expected] of [[{ useDefault: true }, { mode: "default" }], [{ overrides: [{ method: "popup", minutes: 0 }] }, { mode: "minutes", minutes: 0 }]] as const) {
      gog.spawn.mockImplementation(() => fakeGog({ event: { ...ggEvent, reminders } }));
      expect((await getGoogleCalendarEvent("owner@gmail.test", "gg", "chosen", "e1")).reminder).toEqual(expected);
    }
  });
  it("requires complete Google output and binds selected calendar and account", async () => {
    gog.spawn.mockImplementation(() => fakeGog({ events: [ggEvent], nextPageToken: "" }));
    expect(await listGoogleCalendarEvents("owner@gmail.test", "gg", range)).toMatchObject([{ calendarId: "chosen", reminder: { mode: "minutes", minutes: 0 }, isBusy: false, revision: "rev", correlationId: "op", recurrenceId: "series" }]);
    expect(gog.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["chosen", "--account", "owner@gmail.test", "--all-pages", "--no-input"]));
    gog.spawn.mockImplementation(() => fakeGog({ event: ggEvent }));
    expect(await getGoogleCalendarEvent("owner@gmail.test", "gg", "chosen", "e1")).toMatchObject({ externalEventId: "e1", calendarId: "chosen" });
  });
  it.each([{}, { events: [{}] }, { events: [ggEvent], nextPageToken: "more" }, { events: [{ ...ggEvent, calendarId: "other" }] }])("rejects incomplete Google response %j", async payload => {
    gog.spawn.mockImplementation(() => fakeGog(payload)); await expect(listGoogleCalendarEvents("owner@gmail.test", "gg", range)).rejects.toThrow();
  });
  it("kills timed-out Google reads without an empty success", async () => {
    vi.useFakeTimers(); const child = { stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() }; gog.spawn.mockReturnValue(child);
    const pending = listGoogleCalendarEvents("owner@gmail.test", "gg", range); const assertion = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(120_000); await assertion; expect(child.kill).toHaveBeenCalledOnce();
  });
});
