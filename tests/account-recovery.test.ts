import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectMailAccount } from "@/lib/email/account-recovery";
import {
  configureEmailDatabaseForTests,
  execute,
  nowIso,
  setServiceState,
} from "@/lib/email/database";
import { removeGmailAuthorization } from "@/lib/email/gmail";
import { removeStoredMicrosoftRefreshToken } from "@/lib/email/microsoft";

const adapterCalls = vi.hoisted(() => {
  const adapter = { disconnect: vi.fn(async () => ({ removed: true, backend: "gog-keyring" })) };
  return { adapter, providerAdapterFor: vi.fn(() => adapter) };
});

vi.mock("@/lib/email/gmail", () => ({
  removeGmailAuthorization: vi.fn(async () => ({ removed: true, backend: "gog-keyring" })),
}));

vi.mock("@/lib/email/microsoft", () => ({
  removeStoredMicrosoftRefreshToken: vi.fn(async () => ({ removed: true, backend: "file" })),
}));

vi.mock("@/lib/email/provider-adapter", () => adapterCalls);

describe("account disconnect and credential cleanup", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./account-recovery-${randomUUID()}.sqlite`);
    vi.clearAllMocks();
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, last_sync_at, created_at, updated_at)
       VALUES ('acct-gmail', 'gmail', 'owner@gmail.test', 'Gmail', 'connected', ?, ?, ?)`,
      [now, now, now],
    );
    await execute(
      `INSERT INTO account_profile_settings (account_id, purpose_label, updated_at)
       VALUES ('acct-gmail', 'Private daily mail', ?)`,
      [now],
    );
    await execute(
      `INSERT INTO provider_account_credentials
        (account_id, provider, credential_backend, credential_reference, access, verified_at, updated_at)
       VALUES ('acct-gmail', 'gmail', 'gog-keyring', 'provider-managed', 'readonly', ?, ?)`,
      [now, now],
    );
    await setServiceState("manual_account_sync:acct-gmail", now);
  });

  it("requires an exact account confirmation before removing credentials", async () => {
    await expect(disconnectMailAccount({
      accountId: "acct-gmail",
      confirmEmail: "someone-else@gmail.test",
    })).rejects.toThrow("did not match");

    expect(removeGmailAuthorization).not.toHaveBeenCalled();
    const account = await execute(`SELECT status FROM email_accounts WHERE id = 'acct-gmail'`);
    expect(account.rows[0].status).toBe("connected");
  });

  it("removes the Gmail credential, stops polling, and preserves local account data", async () => {
    await expect(disconnectMailAccount({
      accountId: "acct-gmail",
      confirmEmail: "OWNER@gmail.test",
    })).resolves.toMatchObject({
      status: "disabled",
      credentialRemoved: true,
      retainedLocalData: true,
    });

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("gmail");
    expect(adapterCalls.adapter.disconnect).toHaveBeenCalledWith("owner@gmail.test");
    expect(removeGmailAuthorization).not.toHaveBeenCalled();
    expect(removeStoredMicrosoftRefreshToken).not.toHaveBeenCalled();
    const account = await execute(`SELECT status FROM email_accounts WHERE id = 'acct-gmail'`);
    const profile = await execute(`SELECT purpose_label FROM account_profile_settings WHERE account_id = 'acct-gmail'`);
    const cooldown = await execute(`SELECT value FROM service_state WHERE key = 'manual_account_sync:acct-gmail'`);
    const credentialReference = await execute(`SELECT account_id FROM provider_account_credentials WHERE account_id = 'acct-gmail'`);
    const audit = await execute(`SELECT action, metadata FROM audit_logs WHERE target_id = 'acct-gmail' ORDER BY created_at DESC LIMIT 1`);
    expect(account.rows[0].status).toBe("disabled");
    expect(profile.rows[0].purpose_label).toBe("Private daily mail");
    expect(cooldown.rows).toHaveLength(0);
    expect(credentialReference.rows).toHaveLength(0);
    expect(audit.rows[0].action).toBe("account.disconnected");
    expect(JSON.parse(String(audit.rows[0].metadata))).toMatchObject({ retainedLocalData: true });
  });
});
