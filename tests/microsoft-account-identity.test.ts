import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, execute, getServiceState } from "@/lib/email/database";
import { completeMicrosoftAccountConnection, startMicrosoftAccountConnection } from "@/lib/email/service";
import { getStoredMicrosoftRefreshToken, storeMicrosoftRefreshToken } from "@/lib/email/microsoft";
import { recordVerifiedProviderAccount } from "@/lib/email/provider-account-connection";

describe("Microsoft connection identity", () => {
  let credentialRoot: string;
  let profile: Record<string, string>;
  let pending: boolean;
  let providerRequests: string[];

  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./microsoft-identity-${randomUUID()}.sqlite`);
    credentialRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-ms-identity-"));
    vi.stubEnv("EZRA_MICROSOFT_TOKEN_BACKEND", "file");
    vi.stubEnv("EZRA_CREDENTIAL_DIR", credentialRoot);
    vi.stubEnv("MICROSOFT_CLIENT_ID", "synthetic-client");
    vi.stubEnv("MICROSOFT_TENANT", "common");
    profile = { mail: "work@example.test", userPrincipalName: "work@example.test", displayName: "Work" };
    pending = false;
    providerRequests = [];
    vi.stubGlobal("fetch", async (url: string) => {
      providerRequests.push(String(url));
      if (String(url).endsWith("/devicecode")) return Response.json({
        device_code: "synthetic-device-code", user_code: "SYNTHETIC", expires_in: 900, interval: 5,
        verification_uri: "https://microsoft.example.test/device",
      });
      if (String(url).endsWith("/token")) return Response.json(pending
        ? { error: "authorization_pending" }
        : { access_token: "test-access", refresh_token: "test-new-refresh", expires_in: 3600, scope: "Mail.ReadWrite" });
      if (String(url).startsWith("https://graph.microsoft.com/v1.0/me")) return Response.json(profile);
      throw new Error("Unexpected synthetic provider request");
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(credentialRoot, { recursive: true, force: true });
  });

  it("rejects a different mailbox before changing its credentials or account settings", async () => {
    profile = { mail: "personal@example.test", userPrincipalName: "personal@example.test" };
    await storeMicrosoftRefreshToken(profile.mail, "synthetic-existing-refresh");
    const existing = await recordVerifiedProviderAccount({ provider: "microsoft", email: profile.mail,
      label: "Personal", access: "readonly", credentialBackend: "file" });
    await execute("INSERT INTO service_state (key, value, updated_at) VALUES (?, ?, ?)", [`microsoft_access:${profile.mail}`, "readonly", new Date().toISOString()]);
    const before = await execute("SELECT * FROM email_accounts WHERE id = ?", [existing.accountId]);
    const challenge = await startMicrosoftAccountConnection({ email: "work@example.test", access: "maintenance" });

    await expect(completeMicrosoftAccountConnection(challenge.connectionId)).rejects.toThrow(/different Microsoft account/i);
    expect(await getStoredMicrosoftRefreshToken(profile.mail)).toBe("synthetic-existing-refresh");
    expect(await execute("SELECT * FROM email_accounts WHERE id = ?", [existing.accountId])).toEqual(before);
    expect(await getServiceState(`microsoft_access:${profile.mail}`)).toBe("readonly");
    expect((await execute("SELECT COUNT(*) AS count FROM email_accounts")).rows[0].count).toBe(1);
    expect(await getServiceState(`microsoft_auth:${challenge.connectionId}`)).not.toContain("synthetic-device-code");
    const requestsBeforeRetry = providerRequests.length;
    await expect(completeMicrosoftAccountConnection(challenge.connectionId)).rejects.toThrow(/Start again/i);
    expect(providerRequests).toHaveLength(requestsBeforeRetry);
  });

  it("rejects an unverifiable profile instead of trusting the typed address", async () => {
    profile = {};
    const challenge = await startMicrosoftAccountConnection({ email: "work@example.test", access: "maintenance" });
    await expect(completeMicrosoftAccountConnection(challenge.connectionId)).rejects.toThrow(/verify.*mailbox/i);
    expect((await execute("SELECT COUNT(*) AS count FROM email_accounts")).rows[0].count).toBe(0);
    expect(await fs.readdir(credentialRoot)).toEqual([]);
  });

  it("connects a verified address regardless of casing and surrounding whitespace", async () => {
    const challenge = await startMicrosoftAccountConnection({ email: " WORK@EXAMPLE.TEST ", access: "maintenance" });
    await expect(completeMicrosoftAccountConnection(challenge.connectionId))
      .resolves.toEqual({ status: "connected", email: "work@example.test" });
    expect(await getStoredMicrosoftRefreshToken("work@example.test")).toBe("test-new-refresh");
  });

  it("reconnects an existing mixed-case address without creating a second account", async () => {
    const existing = await recordVerifiedProviderAccount({ provider: "microsoft", email: "Work@Example.test",
      label: "Existing work", access: "readonly", credentialBackend: "file" });
    await execute("INSERT INTO account_profile_settings (account_id, purpose_label, updated_at) VALUES (?, ?, ?)",
      [existing.accountId, "Keep work purpose", new Date().toISOString()]);
    await execute("UPDATE email_accounts SET status = 'error' WHERE id = ?", [existing.accountId]);
    const challenge = await startMicrosoftAccountConnection({ email: "Work@Example.test", access: "maintenance" });
    await expect(completeMicrosoftAccountConnection(challenge.connectionId))
      .resolves.toEqual({ status: "connected", email: "Work@Example.test" });
    expect((await execute("SELECT id, email, status FROM email_accounts")).rows)
      .toEqual([{ id: existing.accountId, email: "Work@Example.test", status: "connected" }]);
    expect((await execute("SELECT purpose_label FROM account_profile_settings WHERE account_id = ?", [existing.accountId])).rows[0].purpose_label)
      .toBe("Keep work purpose");
  });

  it("keeps provider conflicts case-insensitive before saving Microsoft credentials", async () => {
    await recordVerifiedProviderAccount({ provider: "gmail", email: "Work@Example.test",
      label: "Existing Gmail", access: "readonly", credentialBackend: "gog-keyring" });
    const challenge = await startMicrosoftAccountConnection({ email: "work@example.test", access: "maintenance" });
    await expect(completeMicrosoftAccountConnection(challenge.connectionId)).rejects.toThrow(/different provider/i);
    expect((await execute("SELECT provider, email FROM email_accounts")).rows)
      .toEqual([{ provider: "gmail", email: "Work@Example.test" }]);
    expect(await fs.readdir(credentialRoot)).toEqual([]);
  });

  it("refuses ambiguous existing identities without changing either account", async () => {
    const now = new Date().toISOString();
    await execute("INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at) VALUES ('upper', 'microsoft', 'Work@Example.test', 'Upper', 'error', ?, ?), ('lower', 'microsoft', 'work@example.test', 'Lower', 'error', ?, ?)", [now, now, now, now]);
    const before = await execute("SELECT * FROM email_accounts ORDER BY id");
    const challenge = await startMicrosoftAccountConnection({ email: "work@example.test", access: "maintenance" });
    await expect(completeMicrosoftAccountConnection(challenge.connectionId)).rejects.toThrow(/More than one existing account/i);
    expect(await execute("SELECT * FROM email_accounts ORDER BY id")).toEqual(before);
    expect(await fs.readdir(credentialRoot)).toEqual([]);
  });

  it("accepts a provider-verified work sign-in name while persisting its primary mailbox", async () => {
    profile.userPrincipalName = "work-login@example.test";
    const challenge = await startMicrosoftAccountConnection({ email: profile.userPrincipalName, access: "maintenance" });
    await expect(completeMicrosoftAccountConnection(challenge.connectionId))
      .resolves.toEqual({ status: "connected", email: "work@example.test" });
    expect(await getStoredMicrosoftRefreshToken("work@example.test")).toBe("test-new-refresh");
  });

  it("keeps a pending authorization free of account and credential changes", async () => {
    pending = true;
    const challenge = await startMicrosoftAccountConnection({ email: "work@example.test", access: "maintenance" });
    await expect(completeMicrosoftAccountConnection(challenge.connectionId)).resolves.toMatchObject({ status: "pending" });
    expect((await execute("SELECT COUNT(*) AS count FROM email_accounts")).rows[0].count).toBe(0);
    expect(await fs.readdir(credentialRoot)).toEqual([]);
  });

  it("starts both personal and work sign-in at common by default", async () => {
    vi.stubEnv("MICROSOFT_TENANT", "");
    await startMicrosoftAccountConnection({ email: "work@example.test", access: "maintenance" });
    expect(providerRequests[0]).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/devicecode");
  });

  it("preserves an explicitly configured personal-only authority", async () => {
    vi.stubEnv("MICROSOFT_TENANT", "consumers");
    await startMicrosoftAccountConnection({ email: "personal@example.test", access: "maintenance" });
    expect(providerRequests[0]).toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode");
  });

  it("rejects an expired challenge before calling Microsoft", async () => {
    const challenge = await startMicrosoftAccountConnection({ email: "work@example.test", access: "maintenance" });
    const key = `microsoft_auth:${challenge.connectionId}`;
    const state = JSON.parse(String(await getServiceState(key)));
    state.expiresAt = "2000-01-01T00:00:00.000Z";
    await execute("UPDATE service_state SET value = ? WHERE key = ?", [JSON.stringify(state), key]);
    const requestsBefore = providerRequests.length;
    await expect(completeMicrosoftAccountConnection(challenge.connectionId)).rejects.toThrow(/expired/i);
    expect(providerRequests).toHaveLength(requestsBefore);
    expect(await fs.readdir(credentialRoot)).toEqual([]);
  });

  it("preserves an explicitly configured organizational authority", async () => {
    vi.stubEnv("MICROSOFT_TENANT", "organization.example.test");
    await startMicrosoftAccountConnection({ email: "work@example.test", access: "maintenance" });
    expect(providerRequests[0]).toBe("https://login.microsoftonline.com/organization.example.test/oauth2/v2.0/devicecode");
  });
});
