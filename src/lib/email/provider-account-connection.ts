import { audit, ensureEmailDatabase, execute, nowIso, upsertAccount } from "./database";
import type { AccountProvider, ProviderPreset } from "./types";

export type ProviderCredentialBackend =
  | "gog-keyring"
  | "windows-credential-manager"
  | "file"
  | "test";

export type VerifiedProviderAccount = {
  accountId: string;
  provider: AccountProvider;
  email: string;
  credentialBackend: ProviderCredentialBackend;
};

export async function assertProviderAccountIdentity(input: {
  provider: AccountProvider;
  email: string;
}) {
  await ensureEmailDatabase();
  const existing = await execute(`SELECT provider FROM email_accounts WHERE email = ?`, [input.email.trim()]);
  if (existing.rows[0] && String(existing.rows[0].provider) !== input.provider) {
    throw new Error("This email is already connected through a different provider.");
  }
}

export async function recordVerifiedProviderAccount(input: {
  provider: AccountProvider;
  email: string;
  label: string;
  access: string;
  credentialBackend: ProviderCredentialBackend;
}): Promise<VerifiedProviderAccount> {
  await ensureEmailDatabase();
  const email = input.email.trim();
  const label = input.label.trim();
  if (!email || !label) throw new Error("A verified provider account needs an email and label.");

  await assertProviderAccountIdentity({ provider: input.provider, email });

  const accountId = await upsertAccount({
    email,
    label,
    provider: input.provider,
    status: "connected",
  });
  const now = nowIso();
  await execute(
    `INSERT INTO provider_account_credentials
      (account_id, provider, credential_backend, credential_reference, access, verified_at, updated_at)
     VALUES (?, ?, ?, 'provider-managed', ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
      provider = excluded.provider,
      credential_backend = excluded.credential_backend,
      credential_reference = excluded.credential_reference,
      access = excluded.access,
      verified_at = excluded.verified_at,
      updated_at = excluded.updated_at`,
    [accountId, input.provider, input.credentialBackend, input.access, now, now],
  );
  await audit("provider.account.verified", "system", "account", accountId, {
    provider: input.provider,
    access: input.access,
    credentialBackend: input.credentialBackend,
  });
  return { accountId, provider: input.provider, email, credentialBackend: input.credentialBackend };
}

export async function recordProviderConnectionSettings(input: {
  accountId: string;
  preset: ProviderPreset;
  serverConfig: Record<string, string | number | boolean>;
}) {
  const config = validatedNonSecretServerConfig(input.serverConfig);
  await ensureEmailDatabase();
  const account = await execute(`SELECT id FROM email_accounts WHERE id = ?`, [input.accountId]);
  if (!account.rows[0]) throw new Error("Account was not found for provider connection settings.");
  await execute(
    `INSERT INTO provider_connection_settings (account_id, provider_preset, server_config_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       provider_preset = excluded.provider_preset,
       server_config_json = excluded.server_config_json,
       updated_at = excluded.updated_at`,
    [input.accountId, input.preset, JSON.stringify(config), nowIso()],
  );
  await audit("provider.connection.settings.updated", "system", "account", input.accountId, {
    preset: input.preset,
    serverConfigKeys: Object.keys(config).sort(),
  });
}

function validatedNonSecretServerConfig(input: Record<string, string | number | boolean>) {
  const entries = Object.entries(input);
  if (!entries.length || entries.length > 12) throw new Error("Non-secret server configuration must include between 1 and 12 settings.");
  const secretKey = /(password|secret|token|credential|auth|key)/i;
  if (entries.some(([key, value]) => !key.trim() || secretKey.test(key) || typeof value === "string" && value.length > 320)) {
    throw new Error("Only non-secret server configuration may be stored.");
  }
  return Object.fromEntries(entries.map(([key, value]) => [key.trim(), value]));
}
