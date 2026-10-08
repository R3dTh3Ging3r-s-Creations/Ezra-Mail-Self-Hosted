import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, execute, setSetting, setServiceState } from "@/lib/email/database";
import { readAgentCalendar, readAgentEvent } from "@/lib/email/agent-calendar";
import { syncCalendarAccounts } from "@/lib/email/calendar";
import { getMicrosoftAccessToken } from "@/lib/email/microsoft";
const provider = vi.hoisted(() => ({ list: vi.fn(), event: vi.fn(), profile: vi.fn(), googleList: vi.fn(), googleEvent: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/email/microsoft", () => ({ getMicrosoftAccessToken: vi.fn(async () => "synthetic"), getMicrosoftProfile: provider.profile, resolveMicrosoftCalendarId: provider.resolve, listMicrosoftCalendarEvents: provider.list, getMicrosoftCalendarEvent: provider.event }));
vi.mock("@/lib/email/gmail", () => ({ getGoogleCalendarIdentity: vi.fn(async () => "owner@gmail.test"), getGmailAuthorizationCapabilities: vi.fn(async () => ({ scopes: ["https://www.googleapis.com/auth/calendar.readonly"] })), listGoogleCalendarEvents: provider.googleList, getGoogleCalendarEvent: provider.googleEvent }));
const ms = { accountId: "ms", provider: "microsoft" as const, expectedEmail: "owner@hotmail.test" };
const gg = { accountId: "gg", provider: "gmail" as const, expectedEmail: "owner@gmail.test" };
const range = { from: "2026-10-09T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z" };
describe("account-bound fresh calendar evidence", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./agent-calendar-${randomUUID()}.sqlite`);
    await setSetting("agent_personal_accounts", JSON.stringify([ms, gg]));
    await setServiceState("microsoft_scopes:owner@hotmail.test", JSON.stringify(["Calendars.Read"]));
    for (const ref of [ms, gg]) await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES (?,?,?,?,'connected',?,?)", [ref.accountId,ref.provider,ref.expectedEmail,ref.accountId,new Date().toISOString(),new Date().toISOString()]);
    for (const mock of Object.values(provider)) mock.mockReset();
    provider.profile.mockResolvedValue({ email: ms.expectedEmail }); provider.resolve.mockResolvedValue("resolved-primary");
    provider.list.mockResolvedValue([]); provider.googleList.mockResolvedValue([]);
  });
  it("returns fresh complete empty evidence only after an exact-account provider read", async () => {
    expect(await readAgentCalendar(ms, "primary", range)).toMatchObject({ account: ms, calendarId: "resolved-primary", range, complete: true, events: [] });
    expect(getMicrosoftAccessToken).toHaveBeenLastCalledWith(ms.expectedEmail, "calendar-readonly");
    expect(provider.list).toHaveBeenCalledWith("synthetic", "ms", { ...range, calendarId: "resolved-primary" });
    expect(await readAgentCalendar(gg, "primary", range)).toMatchObject({ account: gg, calendarId: gg.expectedEmail, complete: true });
    expect(provider.googleList).toHaveBeenCalledWith(gg.expectedEmail, "gg", { ...range, calendarId: gg.expectedEmail });
  });
  it("rejects a wrong account, provider identity, calendar or range before returning evidence", async () => {
    await expect(readAgentCalendar({ ...ms, expectedEmail: "work@company.test" }, "primary", range)).rejects.toThrow();
    await expect(readAgentCalendar(ms, "--all", range)).rejects.toThrow();
    await expect(readAgentCalendar(ms, "primary", { ...range, to: range.from })).rejects.toThrow();
    expect(provider.list).not.toHaveBeenCalled();
    provider.profile.mockResolvedValue({ email: "work@company.test" });
    await expect(readAgentCalendar(ms, "primary", range)).rejects.toThrow(/identity/i);
  });
  it("never converts an incomplete read into an empty snapshot or fresh coverage", async () => {
    provider.list.mockRejectedValue(new Error("partial response"));
    await expect(readAgentCalendar(ms, "primary", range)).rejects.toThrow(/could not be completed/i);
    await syncCalendarAccounts({ workspaceId: "workspace:account:microsoft:ms", ...range });
    const row = (await execute("SELECT status,range_from,range_to,last_sync_at FROM calendar_sync_state WHERE account_id='ms'")).rows[0];
    expect(row).toMatchObject({ status: "error", range_from: null, range_to: null, last_sync_at: null });
  });
  it("does not accept a provider result bound to another calendar or account", async () => {
    provider.list.mockResolvedValue([{ accountId: "other", calendarId: "other" }]);
    await expect(readAgentCalendar(ms, "primary", range)).rejects.toThrow(/binding/i);
  });
  it("rechecks account status after provider access", async () => {
    provider.list.mockImplementation(async () => { await execute("UPDATE email_accounts SET status='disabled' WHERE id='ms'"); return []; });
    await expect(readAgentCalendar(ms, "primary", range)).rejects.toThrow(/account/i);
  });
  it("distinguishes confirmed absence from unreadable events", async () => {
    provider.event.mockResolvedValue(null);
    expect(await readAgentEvent(ms, "primary", "e1")).toMatchObject({ status: "absent", calendarId: "resolved-primary" });
    provider.event.mockRejectedValue(new Error("403 private error"));
    await expect(readAgentEvent(ms, "primary", "e1")).rejects.toThrow("Calendar event could not be read for this account.");
    provider.googleEvent.mockRejectedValue(new Error("404 unstructured CLI text"));
    await expect(readAgentEvent(gg, "primary", "e1")).rejects.toThrow("Calendar event could not be read for this account.");
  });
});
