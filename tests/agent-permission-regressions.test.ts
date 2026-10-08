import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, execute, setServiceState } from "@/lib/email/database";
import { getProviderPermissions } from "@/lib/email/permissions";
import { getAccountFreshness } from "@/lib/email/account-health";

vi.mock("@/lib/email/gmail", () => ({
  getGmailAuthorizationCapabilities: vi.fn(async (email?: string) => ({
    modify: email === "writer@gmail.test",
    send: email === "writer@gmail.test",
    calendarRead: false, calendarWrite: false, known: Boolean(email), scopes: [],
  })),
}));
vi.mock("@/lib/email/service", () => ({ pollMailAccount: vi.fn() }));

describe("personal capability regressions", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./agent-permissions-${randomUUID()}.sqlite`);
    for (const [id, email] of [["reader", "reader@gmail.test"], ["writer", "writer@gmail.test"]]) {
      await execute(`INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at)
        VALUES (?, 'gmail', ?, ?, 'connected', ?, ?)`, [id, email, id, new Date().toISOString(), new Date().toISOString()]);
    }
  });

  it("uses each account's grant evidence and never guesses Gmail send permission", async () => {
    const result = await getProviderPermissions();
    const reader = result.accounts.find(a => a.accountId === "reader")!;
    const writer = result.accounts.find(a => a.accountId === "writer")!;
    expect(reader.features.find(f => f.id === "send")?.access).toBe("none");
    expect(writer.features.find(f => f.id === "mail_actions")?.access).toBe("write");
  });

  it("does not infer calendar write scopes from a legacy connected integration", async () => {
    await execute(`INSERT INTO account_integrations
      (account_id,feature,provider,access,status,updated_at)
      VALUES ('reader','calendar','gmail','write','connected',?)`, [new Date().toISOString()]);
    const result = await getProviderPermissions();
    expect(result.accounts.find(a => a.accountId === "reader")!.features.find(f => f.id === "calendar_write")?.access).toBe("none");
  });

  it("reports an old successful calendar sync as stale without asking to reconnect", async () => {
    const old = new Date(Date.now() - 9 * 86400000).toISOString();
    await execute(`INSERT INTO calendar_sync_state
      (account_id,calendar_id,status,last_sync_at,updated_at)
      VALUES ('reader','primary','connected',?,?)`, [old, old]);
    const item = (await getAccountFreshness()).items.find(a => a.accountId === "reader")!;
    expect(item.issues!.find(i => i.feature === "calendar")).toMatchObject({ status: "stale", reconnectRecommended: false });
    expect(item.reconnectRecommended).toBe(false);
  });
  it("does not label a recent calendar read current without recorded coverage", async () => {
    const now = new Date().toISOString();
    await execute(`INSERT INTO calendar_sync_state (account_id,calendar_id,status,last_sync_at,updated_at)
      VALUES ('reader','primary','connected',?,?)`, [now, now]);
    const item = (await getAccountFreshness()).items.find(a => a.accountId === "reader")!;
    expect(item.issues!.find(i => i.feature === "calendar")?.status).toBe("incomplete");
  });
  it("does not treat requested Microsoft access mode as proof of granted mail scopes", async () => {
    await execute(`INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at)
      VALUES ('ms','microsoft','owner@hotmail.test','Personal','connected',?,?)`, [new Date().toISOString(),new Date().toISOString()]);
    await setServiceState("microsoft_access:owner@hotmail.test", "full");
    const ms = (await getProviderPermissions({workspaceId:"workspace:all"})).accounts.find(a => a.accountId === "ms")!;
    expect(ms.features.find(f => f.id === "mail_actions")?.status).toBe("unknown");
    expect(ms.features.find(f => f.id === "send")?.status).toBe("unknown");
  });
});
