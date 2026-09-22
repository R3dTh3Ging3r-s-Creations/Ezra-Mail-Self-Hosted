import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureEmailDatabaseForTests,
  execute,
  setServiceState,
} from "@/lib/email/database";
import { getProviderPermissions } from "@/lib/email/permissions";

vi.mock("@/lib/email/gmail", () => ({
  getGmailAuthorizationCapabilities: vi.fn(async () => ({ modify: false })),
}));

describe("Provider Permissions Dashboard", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./permissions-${randomUUID()}.sqlite`);
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, last_sync_at, created_at, updated_at)
       VALUES
        ('acct-gmail', 'gmail', 'owner@gmail.test', 'Gmail', 'connected', '2026-07-02T10:00:00.000Z', '2026-07-02T09:00:00.000Z', '2026-07-02T10:00:00.000Z'),
        ('acct-hotmail', 'microsoft', 'owner@hotmail.test', 'Hotmail', 'connected', '2026-07-02T10:05:00.000Z', '2026-07-02T09:00:00.000Z', '2026-07-02T10:05:00.000Z')`,
    );
    await setServiceState("microsoft_access:owner@hotmail.test", "maintenance");
  });

  it("summarizes provider capabilities and keeps workspace scoping", async () => {
    await execute(
      `INSERT INTO account_integrations
        (account_id, feature, provider, access, status, last_connected_at, last_error, updated_at)
       VALUES
        ('acct-gmail', 'calendar', 'gmail', 'write', 'connected', '2026-07-02T10:10:00.000Z', NULL, '2026-07-02T10:10:00.000Z'),
        ('acct-hotmail', 'calendar', 'microsoft', 'none', 'error', NULL, 'Calendars.ReadWrite missing', '2026-07-02T10:11:00.000Z')`,
    );
    await execute(
      `INSERT INTO calendar_sync_state
        (account_id, calendar_id, status, last_sync_at, last_error, updated_at)
       VALUES
        ('acct-gmail', 'primary', 'connected', '2026-07-02T10:12:00.000Z', NULL, '2026-07-02T10:12:00.000Z'),
        ('acct-hotmail', 'primary', 'error', NULL, 'Calendar sync failed', '2026-07-02T10:13:00.000Z')`,
    );

    const all = await getProviderPermissions({ workspaceId: "workspace:all" });
    const gmail = all.accounts.find((account) => account.accountId === "acct-gmail");
    const hotmail = all.accounts.find((account) => account.accountId === "acct-hotmail");

    expect(all.summary).toMatchObject({ accounts: 2, connectedAccounts: 2, errors: 1, readOnly: 1 });
    expect(gmail?.features.find((feature) => feature.id === "mail_read")).toMatchObject({ status: "connected", access: "read" });
    expect(gmail?.features.find((feature) => feature.id === "mail_actions")).toMatchObject({ status: "read_only", access: "read" });
    expect(gmail?.features.find((feature) => feature.id === "calendar_write")).toMatchObject({ status: "connected", access: "write" });
    expect(gmail?.features.find((feature) => feature.id === "send")).toMatchObject({ status: "connected", access: "write" });
    expect(hotmail?.features.find((feature) => feature.id === "mail_actions")).toMatchObject({ status: "connected", access: "write" });
    expect(hotmail?.features.find((feature) => feature.id === "send")).toMatchObject({ status: "needs_setup", access: "none" });
    expect(hotmail?.features.find((feature) => feature.id === "calendar_read")).toMatchObject({ status: "error", access: "none" });
    expect(hotmail?.reconnectRecommended).toBe(true);

    const gmailOnly = await getProviderPermissions({ workspaceId: "workspace:gmail" });
    expect(gmailOnly.accounts.map((account) => account.accountId)).toEqual(["acct-gmail"]);

    const gmailAccount = await getProviderPermissions({ workspaceId: "workspace:account:gmail:acct-gmail" });
    expect(gmailAccount.accounts.map((account) => account.accountId)).toEqual(["acct-gmail"]);
  });

  it("shows Hotmail send as connected after Microsoft Mail.Send upgrade", async () => {
    await setServiceState("microsoft_access:owner@hotmail.test", "full");
    await setServiceState("microsoft_scopes:owner@hotmail.test", JSON.stringify(["Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"]));

    const hotmailOnly = await getProviderPermissions({ workspaceId: "workspace:microsoft" });
    const send = hotmailOnly.accounts[0]?.features.find((feature) => feature.id === "send");
    const actions = hotmailOnly.accounts[0]?.features.find((feature) => feature.id === "mail_actions");

    expect(send).toMatchObject({
      status: "connected",
      access: "write",
      detail: expect.stringContaining("Microsoft Mail.Send access"),
    });
    expect(actions).toMatchObject({ status: "connected", access: "write" });
  });
});
