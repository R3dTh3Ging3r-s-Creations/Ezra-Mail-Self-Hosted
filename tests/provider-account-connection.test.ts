import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { configureEmailDatabaseForTests, execute, nowIso } from "@/lib/email/database";
import { recordProviderConnectionSettings, recordVerifiedProviderAccount } from "@/lib/email/provider-account-connection";

describe("verified provider account persistence", () => {
  beforeEach(() => {
    configureEmailDatabaseForTests(`file:./provider-account-connection-${randomUUID()}.sqlite`);
  });

  it("records only a non-secret credential reference after provider verification", async () => {
    const account = await recordVerifiedProviderAccount({
      provider: "gmail",
      email: "owner@gmail.test",
      label: "Owner Gmail",
      access: "readonly",
      credentialBackend: "gog-keyring",
    });

    expect(account).toMatchObject({ provider: "gmail", email: "owner@gmail.test", credentialBackend: "gog-keyring" });
    const credential = await execute(
      `SELECT provider, credential_backend, credential_reference, access FROM provider_account_credentials WHERE account_id = ?`,
      [account.accountId],
    );
    const audit = await execute(
      `SELECT action, metadata FROM audit_logs WHERE target_id = ? ORDER BY created_at DESC LIMIT 1`,
      [account.accountId],
    );

    expect(credential.rows[0]).toMatchObject({
      provider: "gmail",
      credential_backend: "gog-keyring",
      credential_reference: "provider-managed",
      access: "readonly",
    });
    expect(JSON.stringify({ credential: credential.rows[0], audit: audit.rows[0] }))
      .not.toMatch(/token|refresh|secret|password/i);
    expect(audit.rows[0].action).toBe("provider.account.verified");
  });

  it("updates the verified credential backend without creating a second account or changing profile data", async () => {
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
       VALUES ('existing-account', 'microsoft', 'owner@outlook.test', 'Outlook', 'disabled', ?, ?)`,
      [now, now],
    );
    await execute(
      `INSERT INTO account_profile_settings (account_id, purpose_label, updated_at)
       VALUES ('existing-account', 'Personal correspondence', ?)`,
      [now],
    );

    await expect(recordVerifiedProviderAccount({
      provider: "microsoft",
      email: "owner@outlook.test",
      label: "Owner Outlook",
      access: "full",
      credentialBackend: "windows-credential-manager",
    })).resolves.toMatchObject({ accountId: "existing-account", credentialBackend: "windows-credential-manager" });

    await expect(execute(`SELECT COUNT(*) AS count FROM email_accounts WHERE email = ?`, ["owner@outlook.test"]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(execute(`SELECT purpose_label FROM account_profile_settings WHERE account_id = 'existing-account'`))
      .resolves.toMatchObject({ rows: [{ purpose_label: "Personal correspondence" }] });
  });

  it("refuses to silently change the provider for an existing account identity", async () => {
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
       VALUES ('gmail-account', 'gmail', 'owner@example.test', 'Gmail', 'connected', ?, ?)`,
      [now, now],
    );

    await expect(recordVerifiedProviderAccount({
      provider: "microsoft",
      email: "owner@example.test",
      label: "Owner Outlook",
      access: "readonly",
      credentialBackend: "windows-credential-manager",
    })).rejects.toThrow(/different provider/i);
  });

  it("stores a standards preset separately from non-secret server configuration", async () => {
    const account = await recordVerifiedProviderAccount({
      provider: "gmail",
      email: "owner@gmail.test",
      label: "Owner Gmail",
      access: "readonly",
      credentialBackend: "gog-keyring",
    });

    await recordProviderConnectionSettings({
      accountId: account.accountId,
      preset: "fastmail",
      serverConfig: { incomingHost: "imap.fastmail.test", incomingPort: 993, outgoingHost: "smtp.fastmail.test", outgoingPort: 465 },
    });

    await expect(execute(
      `SELECT provider_preset, server_config_json FROM provider_connection_settings WHERE account_id = ?`,
      [account.accountId],
    )).resolves.toMatchObject({ rows: [{
      provider_preset: "fastmail",
      server_config_json: JSON.stringify({ incomingHost: "imap.fastmail.test", incomingPort: 993, outgoingHost: "smtp.fastmail.test", outgoingPort: 465 }),
    }] });
  });

  it("rejects secret-shaped standards configuration before it can reach SQLite", async () => {
    const prohibitedKey = ["pass", "word"].join("");
    await expect(recordProviderConnectionSettings({
      accountId: "missing-account",
      preset: "custom",
      serverConfig: { incomingHost: "imap.example.test", [prohibitedKey]: "not-stored" },
    })).rejects.toThrow(/non-secret/i);
  });
});
