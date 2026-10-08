import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, execute } from "@/lib/email/database";
import { createCalendarDraft, createEventFromDraft } from "@/lib/email/calendar";
import { agentOperationStore } from "@/lib/email/agent-operation-store";
const providers = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/email/agent-accounts", () => ({ assertConnectedAccount: vi.fn(async ref => ({ id: ref.accountId, email: ref.expectedEmail, provider: ref.provider, label: "Personal" })), assertPersonalAccount: vi.fn(async ref => ({ id: ref.accountId, email: ref.expectedEmail, provider: ref.provider, label: "Personal" })), getAgentCapabilities: vi.fn(async ref => ({ account: ref, scopes: ["Calendars.ReadWrite"], identityVerifiedAt: new Date().toISOString(), calendarWrite: "available" })) }));
vi.mock("@/lib/email/agent-calendar", () => ({ readAgentCalendar: providers.read, readAgentEvent: providers.event }));
vi.mock("@/lib/email/microsoft", async original => ({ ...await original<typeof import("@/lib/email/microsoft")>(), createMicrosoftCalendarEvent: providers.create }));
describe("calendar UI shares durable operations", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./calendar-operation-${randomUUID()}.sqlite`);
    await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES ('ms','microsoft','owner@hotmail.test','Personal','connected',?,?)", [new Date().toISOString(),new Date().toISOString()]);
    providers.create.mockReset(); providers.event.mockReset();
    providers.read.mockImplementation(async (account, _calendar, range) => ({ account, calendarId: "cal", range, fetchedAt: new Date().toISOString(), complete: true, events: [] }));
    providers.create.mockImplementation(async (_email, input) => {
      providers.event.mockResolvedValue({ status: "found", event: { id: "event", externalEventId: "event", accountId: "ms", accountProvider: "microsoft", accountLabel: "Personal", calendarId: "cal", calendarName: "Primary", title: input.title, description: null, location: null, startsAt: input.startsAt, endsAt: input.endsAt, timezone: input.timezone, isAllDay: false, dateRange: null, status: "confirmed", visibility: "default", isBusy: false, reminder: { mode: "minutes", minutes: 0 }, attendees: input.attendees.map((email: string) => ({ email })), organizerName: "Owner", organizerEmail: "owner@hotmail.test", webLink: null, updatedAt: new Date().toISOString(), syncedAt: new Date().toISOString() } });
      return { externalEventId: "event", calendarId: "cal" };
    });
  });
  async function draft(attendees: string[] = []) { return createCalendarDraft({ accountId: "ms", title: "Reminder", startsAt: "2026-10-09T12:00:00Z", endsAt: "2026-10-09T12:10:00Z", timezone: "America/Chicago", reminderMode: "minutes", reminderMinutes: 0, isBusy: false, attendees }); }
  const authority = { source: "owner_ui" as const, principal: "owner", requestId: "request" };
  it("never treats saving a draft or calling without trusted transport authority as approval", async () => {
    const saved = await draft(); expect(providers.create).not.toHaveBeenCalled();
    await expect(createEventFromDraft({ draftId: saved.id })).rejects.toThrow(/authority/i);
    expect(providers.create).not.toHaveBeenCalled();
  });
  it("stores one operation and receipt across repeated authenticated UI requests", async () => {
    const saved = await draft(); const result = await createEventFromDraft({ draftId: saved.id, authority });
    expect(result).toMatchObject({ ok: true, operationId: `calendar-draft:${saved.id}` });
    expect((await agentOperationStore.getOperation(`calendar-draft:${saved.id}`))?.status).toBe("succeeded");
    expect((await createEventFromDraft({ draftId: saved.id, authority })).ok).toBe(true);
    expect(providers.create).toHaveBeenCalledOnce();
  });
  it("preserves explicit Microsoft invitation confirmation", async () => {
    const saved = await draft(["guest@example.test"]);
    await expect(createEventFromDraft({ draftId: saved.id, authority })).rejects.toThrow(/Confirm invitation sending/);
    expect(providers.create).not.toHaveBeenCalled();
    expect((await createEventFromDraft({ draftId: saved.id, authority, confirmInvites: true })).ok).toBe(true);
  });
});
