import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, execute, setSetting, setServiceState } from "@/lib/email/database";
import { assertPersonalAccount, getAgentCapabilities } from "@/lib/email/agent-accounts";

const provider = vi.hoisted(() => ({ profile: vi.fn(), google: vi.fn() }));
vi.mock("@/lib/email/microsoft", () => ({ getMicrosoftAccessToken: vi.fn(async () => "fixture-only"), getMicrosoftProfile: provider.profile }));
vi.mock("@/lib/email/gmail", () => ({ getGoogleCalendarIdentity: provider.google, getGmailAuthorizationCapabilities: vi.fn(async () => ({ scopes: [], known: false })) }));
const personal = { accountId: "ms", provider: "microsoft" as const, expectedEmail: "owner@hotmail.test" };
const google = { accountId: "gg", provider: "gmail" as const, expectedEmail: "owner@gmail.test" };

describe("personal agent account boundary", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./agent-accounts-${randomUUID()}.sqlite`);
    await setSetting("agent_personal_accounts", JSON.stringify([personal, google]));
    for (const ref of [personal, google]) {
      await execute(`INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at)
        VALUES (?,?,?,?,'connected',?,?)`, [ref.accountId,ref.provider,ref.expectedEmail,ref.accountId,new Date().toISOString(),new Date().toISOString()]);
    }
    provider.profile.mockReset().mockResolvedValue({email: personal.expectedEmail});
    provider.google.mockReset().mockResolvedValue(google.expectedEmail);
  });
  it("admits the exact tuple with case-insensitive address matching", async () => {
    await expect(assertPersonalAccount({...personal, expectedEmail: "OWNER@HOTMAIL.TEST"})).resolves.toMatchObject({id:"ms"});
  });
  it.each([
    {...personal, accountId:"work"}, {...personal, provider:"gmail" as const},
    {...personal, expectedEmail:"work@company.test"}, {...personal, expectedEmail:"alias@hotmail.test"},
  ])("rejects tuple mismatch without provider access: %j", async ref => {
    await expect(getAgentCapabilities(ref, true)).rejects.toThrow(/account/i);
    expect(provider.profile).not.toHaveBeenCalled();
  });
  it("fails closed on absent configuration or a disabled account", async () => {
    await setSetting("agent_personal_accounts", "[]");
    await expect(assertPersonalAccount(personal)).rejects.toThrow(/profile/i);
    await setSetting("agent_personal_accounts", JSON.stringify([personal, google]));
    await execute("UPDATE email_accounts SET status='disabled' WHERE id='ms'");
    await expect(assertPersonalAccount(personal)).rejects.toThrow(/account/i);
  });
  it("requires provider identity and explicit scopes for write capability", async () => {
    await setServiceState("microsoft_scopes:owner@hotmail.test", JSON.stringify(["User.Read","Calendars.ReadWrite"]));
    const verified = await getAgentCapabilities(personal, true);
    expect(verified.calendarWrite).toBe("available");
    expect(JSON.stringify(verified)).not.toContain("fixture-only");
    provider.profile.mockResolvedValue({email:"work@company.test"});
    await expect(getAgentCapabilities(personal, true)).rejects.toThrow(/identity/i);
  });
  it("keeps unavailable evidence unknown without requesting consent", async () => {
    expect(await getAgentCapabilities(google, false)).toMatchObject({calendarWrite:"unknown", identityVerifiedAt:null});
  });
});
