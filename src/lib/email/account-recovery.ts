import { audit, ensureEmailDatabase, execute, nowIso } from "./database";
import { providerAdapterFor } from "./provider-adapter";
import type { AccountProvider } from "./types";

export async function disconnectMailAccount(input: {
  accountId: string;
  confirmEmail: string;
}) {
  await ensureEmailDatabase();
  const result = await execute(
    `SELECT id, provider, email, status FROM email_accounts WHERE id = ?`,
    [input.accountId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Mail account was not found.");
  const email = String(row.email);
  const provider = String(row.provider) as AccountProvider;
  if (input.confirmEmail.trim().toLowerCase() !== email.toLowerCase()) {
    throw new Error("Disconnect confirmation did not match the account email.");
  }

  const credential = await providerAdapterFor(provider).disconnect(email);
  const disconnectedAt = nowIso();
  await execute(
    `UPDATE email_accounts SET status = 'disabled', updated_at = ? WHERE id = ?`,
    [disconnectedAt, input.accountId],
  );
  await execute(
    `UPDATE account_integrations
     SET access = 'none', status = 'disabled', last_error = NULL, updated_at = ?
     WHERE account_id = ?`,
    [disconnectedAt, input.accountId],
  );
  await execute(`DELETE FROM provider_account_credentials WHERE account_id = ?`, [input.accountId]);
  await execute(
    `UPDATE calendar_sync_state
     SET status = 'disabled', last_error = NULL, updated_at = ?
     WHERE account_id = ?`,
    [disconnectedAt, input.accountId],
  );
  await execute(
    `DELETE FROM service_state
     WHERE key IN (?, ?)`,
    [
      `manual_account_sync:${input.accountId}`,
      `microsoft_access:${email.toLowerCase()}`,
    ],
  );
  await audit("account.disconnected", "user", "account", input.accountId, {
    provider,
    credentialRemoved: credential.removed,
    retainedLocalData: true,
  });
  return {
    accountId: input.accountId,
    email,
    provider,
    status: "disabled" as const,
    credentialRemoved: credential.removed,
    retainedLocalData: true as const,
  };
}
