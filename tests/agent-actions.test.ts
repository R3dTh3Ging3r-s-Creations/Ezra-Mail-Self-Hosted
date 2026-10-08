import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests } from "@/lib/email/database";
import { agentOperationStore } from "@/lib/email/agent-operation-store";
import { calendarCreateSchema, type CalendarCreate } from "@/lib/email/agent-operation-schema";
import { prepareCalendarCreate, executeCalendarCreate, reconcileCalendarCreate } from "@/lib/email/agent-actions";
import type { CalendarEvent } from "@/lib/email/types";
const service = vi.hoisted(() => ({ capabilities: vi.fn(), account: vi.fn(), read: vi.fn(), event: vi.fn(), msCreate: vi.fn(), ggCreate: vi.fn(), googleReminderSupport: vi.fn() }));
vi.mock("@/lib/email/agent-accounts", () => ({ getAgentCapabilities: service.capabilities, assertPersonalAccount: service.account, assertConnectedAccount: service.account }));
vi.mock("@/lib/email/agent-calendar", () => ({ readAgentCalendar: service.read, readAgentEvent: service.event }));
vi.mock("@/lib/email/microsoft", () => ({ createMicrosoftCalendarEvent: service.msCreate }));
vi.mock("@/lib/email/gmail", () => ({ createGoogleCalendarEvent: service.ggCreate, assertGoogleCalendarReminderSupport: service.googleReminderSupport }));
const payload = calendarCreateSchema.parse({ account: { accountId: "ms", provider: "microsoft", expectedEmail: "owner@hotmail.test" }, calendarId: "cal", title: "Reminder", description: "", location: "", startsAt: "2026-10-09T12:00:00.000Z", endsAt: "2026-10-09T12:10:00.000Z", timezone: "America/Chicago", isAllDay: false, reminder: { mode: "minutes", minutes: 0 }, isBusy: false, privacy: "default", attendees: [], sendUpdates: false });
function event(input: CalendarCreate = payload, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: "event", accountId: input.account.accountId, accountLabel: "Personal", accountProvider: input.account.provider, externalEventId: "event", calendarId: input.calendarId, calendarName: "Calendar", title: input.title, description: input.description || null, location: input.location || null, startsAt: input.startsAt, endsAt: input.endsAt, timezone: input.timezone, isAllDay: false, dateRange: null, status: "confirmed", visibility: "default", isBusy: input.isBusy, reminder: input.reminder, attendees: [], organizerEmail: input.account.expectedEmail, organizerName: "Owner", webLink: null, updatedAt: new Date().toISOString(), syncedAt: new Date().toISOString(), ...overrides };
}
describe("duplicate-safe calendar operations", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  beforeEach(() => {
    configureEmailDatabaseForTests(`file:./actions-${randomUUID()}.sqlite`);
    for (const mock of Object.values(service)) mock.mockReset();
    service.account.mockImplementation(async ref => ({ id: ref.accountId, provider: ref.provider, email: ref.expectedEmail, label: "Personal" }));
    service.capabilities.mockImplementation(async ref => ({ account: ref, scopes: ["Calendars.ReadWrite"], identityVerifiedAt: new Date().toISOString(), calendarRead: "available", calendarWrite: "available" }));
    service.read.mockImplementation(async (ref, calendarId, range) => ({ account: ref, calendarId, range, fetchedAt: new Date().toISOString(), complete: true, events: [] }));
    service.event.mockResolvedValue({ status: "found", event: event() });
    service.msCreate.mockResolvedValue({ externalEventId: "event", calendarId: "cal" });
    service.ggCreate.mockResolvedValue({ externalEventId: "event", calendarId: "cal" });
  });
  async function approve(input: CalendarCreate = payload) {
    const op = await prepareCalendarCreate(input);
    await agentOperationStore.approveOperationFromTrustedTransport(op.id, op.payloadHash, { source: "owner_ui", principal: "owner", requestId: randomUUID(), account: input.account });
    return op;
  }
  it("prepares without writing and requires trusted approval before dispatch", async () => {
    const op = await prepareCalendarCreate(payload);
    expect((await executeCalendarCreate(op.id)).status).toBe("prepared");
    expect(service.msCreate).not.toHaveBeenCalled();
  });
  it("rejects unsupported Microsoft public privacy before preparation or provider dispatch", async () => {
    await expect(prepareCalendarCreate({ ...payload, privacy: "public" })).rejects.toThrow(/public/i);
    expect(service.msCreate).not.toHaveBeenCalled();
  });
  it("rejects unsupported Google no-reminder mode before saving a prepared operation", async () => {
    const input = { ...payload, account: { accountId: "gg", provider: "gmail", expectedEmail: "owner@gmail.test" }, reminder: { mode: "none" } };
    service.googleReminderSupport.mockRejectedValue(new Error("Installed Google calendar tool does not support disabling reminders."));
    await expect(prepareCalendarCreate(input, "unsupported-reminders")).rejects.toThrow(/does not support disabling reminders/);
    expect(await agentOperationStore.getOperation("unsupported-reminders")).toBeNull();
    expect(service.ggCreate).not.toHaveBeenCalled();
  });
  it("fails before dispatch if Google reminder support disappears after review", async () => {
    const input = calendarCreateSchema.parse({ ...payload, account: { accountId: "gg", provider: "gmail", expectedEmail: "owner@gmail.test" }, reminder: { mode: "none" } });
    const op = await approve(input);
    service.googleReminderSupport.mockRejectedValue(new Error("Installed Google calendar tool does not support disabling reminders."));
    const result = await executeCalendarCreate(op.id);
    expect(result.status).toBe("failed");
    expect(service.ggCreate).not.toHaveBeenCalled();
  });
  it("creates once with stable transaction identity and verified readback, then resumes from receipt", async () => {
    const op = await approve(); const result = await executeCalendarCreate(op.id);
    expect(result).toMatchObject({ status: "succeeded", receipt: { outcome: "created", providerEventId: "event", payloadHash: op.payloadHash } });
    expect(service.msCreate).toHaveBeenCalledOnce();
    expect(service.msCreate.mock.calls[0][1]).toMatchObject({ calendarId: "cal", transactionId: op.id, reminderMode: "minutes", reminderMinutes: 0, isBusy: false, attendees: [] });
    expect((await executeCalendarCreate(op.id)).receipt).toEqual(result.receipt); expect(service.msCreate).toHaveBeenCalledOnce();
  });
  it("reuses an exact match without writing", async () => {
    const op = await approve();
    service.read.mockImplementation(async (ref, calendarId, range) => ({ account: ref, calendarId, range, fetchedAt: new Date().toISOString(), complete: true, events: [event()] }));
    expect(await executeCalendarCreate(op.id)).toMatchObject({ status: "succeeded", receipt: { outcome: "existing_match" } });
    expect(service.msCreate).not.toHaveBeenCalled();
  });
  it.each([{ events: [event(payload, { reminder: { mode: "none" } })] }, { events: [event(), event(payload, { externalEventId: "second" })] }])("stops on conflicting fields or multiple matches", async ({ events }) => {
    const op = await approve();
    service.read.mockImplementation(async (ref, calendarId, range) => ({ account: ref, calendarId, range, fetchedAt: new Date().toISOString(), complete: true, events }));
    expect((await executeCalendarCreate(op.id)).status).toBe("failed"); expect(service.msCreate).not.toHaveBeenCalled();
  });
  it("stops if identity changes or coverage becomes incomplete after preparation", async () => {
    const op = await approve(); service.capabilities.mockRejectedValue(new Error("identity changed"));
    expect((await executeCalendarCreate(op.id)).status).toBe("failed"); expect(service.msCreate).not.toHaveBeenCalled();
    service.capabilities.mockImplementation(async ref => ({ account: ref, identityVerifiedAt: new Date().toISOString(), calendarWrite: "available" }));
    const second = await approve(); service.read.mockRejectedValue(new Error("incomplete"));
    expect((await executeCalendarCreate(second.id)).status).toBe("failed"); expect(service.msCreate).not.toHaveBeenCalled();
  });
  it("serializes racing operations and checks duplicates again inside the claim", async () => {
    const first = await approve(); const second = await approve();
    let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
    service.msCreate.mockImplementation(async () => { await pause; return { externalEventId: "event", calendarId: "cal" }; });
    const executing = executeCalendarCreate(first.id);
    await vi.waitFor(() => expect(service.msCreate).toHaveBeenCalledOnce());
    expect((await executeCalendarCreate(second.id)).status).toBe("approved"); release(); await executing;
    service.read.mockImplementation(async (ref, calendarId, range) => ({ account: ref, calendarId, range, fetchedAt: new Date().toISOString(), complete: true, events: [event()] }));
    expect((await executeCalendarCreate(second.id)).receipt?.outcome).toBe("existing_match"); expect(service.msCreate).toHaveBeenCalledOnce();
  });
  it("leaves an accepted-but-timed-out write unknown and reconciles only correlated evidence", async () => {
    const op = await approve(); service.msCreate.mockRejectedValue(new Error("timeout after accept"));
    expect((await executeCalendarCreate(op.id)).status).toBe("unknown");
    expect((await executeCalendarCreate(op.id)).status).toBe("unknown"); expect(service.msCreate).toHaveBeenCalledOnce();
    service.read.mockImplementation(async (ref, calendarId, range) => ({ account: ref, calendarId, range, fetchedAt: new Date().toISOString(), complete: true, events: [event(payload, { correlationId: op.id })] }));
    service.event.mockResolvedValue({ status: "found", event: event(payload, { correlationId: op.id }) });
    expect((await reconcileCalendarCreate(op.id)).status).toBe("succeeded"); expect(service.msCreate).toHaveBeenCalledOnce();
  });
  it("keeps wrong or absent readback unknown and saves the returned id for restart reconciliation", async () => {
    const op = await approve(); service.event.mockResolvedValue({ status: "found", event: event(payload, { isBusy: true }) });
    expect(await executeCalendarCreate(op.id)).toMatchObject({ status: "unknown", providerEventId: "event" });
    service.event.mockResolvedValue({ status: "absent" }); expect((await reconcileCalendarCreate(op.id)).status).toBe("unknown");
    service.event.mockResolvedValue({ status: "found", event: event() }); expect((await reconcileCalendarCreate(op.id)).status).toBe("succeeded");
    expect(service.msCreate).toHaveBeenCalledOnce();
  });
  it("does not infer Google timeout success from a title/field match without correlation", async () => {
    const google = { ...payload, account: { accountId: "gg", provider: "gmail" as const, expectedEmail: "owner@gmail.test" } };
    const op = await approve(google); service.ggCreate.mockRejectedValue(new Error("timeout"));
    expect((await executeCalendarCreate(op.id)).status).toBe("unknown");
    service.read.mockImplementation(async (ref, calendarId, range) => ({ account: ref, calendarId, range, fetchedAt: new Date().toISOString(), complete: true, events: [event(google)] }));
    expect((await reconcileCalendarCreate(op.id)).status).toBe("unknown"); expect(service.ggCreate).toHaveBeenCalledOnce();
  });
  it("resumes a partial batch without redispatching either a receipt or an unknown outcome", async () => {
    const first = await approve(); const second = await approve({ ...payload, startsAt: "2026-10-23T12:00:00.000Z", endsAt: "2026-10-23T12:10:00.000Z" });
    expect((await executeCalendarCreate(first.id)).status).toBe("succeeded");
    service.msCreate.mockRejectedValue(new Error("timeout"));
    expect((await executeCalendarCreate(second.id)).status).toBe("unknown");
    expect((await executeCalendarCreate(first.id)).status).toBe("succeeded");
    expect((await executeCalendarCreate(second.id)).status).toBe("unknown");
    expect(service.msCreate).toHaveBeenCalledTimes(2);
  });
  it("reconciles a restart after dispatch and provider-id persistence without another create", async () => {
    const op = await approve(); const claim = (await agentOperationStore.claimOperation(op.id, op.payloadHash))!;
    await agentOperationStore.markDispatched(op.id, claim); await agentOperationStore.recordProviderEventId(op.id, claim, "event");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 180_001);
    expect((await agentOperationStore.getOperation(op.id))?.status).toBe("unknown");
    expect((await reconcileCalendarCreate(op.id)).status).toBe("succeeded"); expect(service.msCreate).not.toHaveBeenCalled();
  });
  it("aborts the provider call at its deadline and keeps its outcome unknown", async () => {
    const op = await approve(); vi.useFakeTimers();
    service.msCreate.mockImplementation(async (_email, _input, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const pending = executeCalendarCreate(op.id);
    await vi.waitFor(() => expect(service.msCreate).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(120_001);
    expect((await pending).status).toBe("unknown"); expect(service.msCreate).toHaveBeenCalledOnce();
  });
  it("stops before dispatch if the heartbeat loses ownership during identity verification", async () => {
    const op = await approve(); vi.useFakeTimers();
    vi.spyOn(agentOperationStore, "heartbeat").mockResolvedValue(false);
    let resume!: () => void;
    service.capabilities.mockImplementation(() => new Promise(resolve => { resume = () => resolve(op.evidence); }));
    const pending = executeCalendarCreate(op.id);
    await vi.waitFor(() => expect(resume).toBeDefined());
    await vi.advanceTimersByTimeAsync(30_001); resume();
    expect((await pending).status).toBe("failed"); expect(service.msCreate).not.toHaveBeenCalled();
  });
});
