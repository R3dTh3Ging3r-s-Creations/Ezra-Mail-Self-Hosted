import type { Client, Transaction } from "@libsql/client";
import { ensureEmailDatabase, getEmailClient } from "./database";
import { withEmailDatabaseAccess } from "./database-access";
import { AuthError } from "./auth";
import { assertGrantTarget, requireActiveGrantRow } from "./agent-grants";
import { accountKey, type GrantPrincipal, type GrantScope, type ResourceRef } from "./agent-resource-types";

export async function withAgentTransaction<T>(connection: Client | undefined, work: (tx: Transaction) => Promise<T>): Promise<T> {
  await ensureEmailDatabase();
  return withEmailDatabaseAccess(async () => {
    const tx = await (connection || getEmailClient()).transaction("write");
    try { const value = await work(tx); await tx.commit(); return value; }
    finally { tx.close(); }
  });
}
/** Same transaction as dispatch/revocation; never re-enter the outer database queue. */
export async function assertTransactionGrant(tx: Transaction, principal: GrantPrincipal, scope: GrantScope, target: ResourceRef) {
  const grant = requireActiveGrantRow((await tx.execute({ sql: "SELECT * FROM agent_grants WHERE key_id=?", args: [principal.keyId] })).rows[0], principal);
  assertGrantTarget(grant, scope, target);
  await assertTransactionPersonalAccount(tx, target);
  return grant;
}
export async function assertTransactionPersonalAccount(tx: Transaction, target: ResourceRef) {
  const account = (await tx.execute({ sql: "SELECT provider,email,status FROM email_accounts WHERE id=?", args: [target.account.accountId] })).rows[0];
  const raw = (await tx.execute("SELECT value FROM settings WHERE key='agent_personal_accounts'")).rows[0];
  let profile: unknown;
  try { profile = JSON.parse(String(raw?.value)); } catch { throw new AuthError("Account unavailable.", 403); }
  if (!account || account.status !== "connected" || account.provider !== target.account.provider || String(account.email).toLowerCase() !== target.account.expectedEmail.toLowerCase() || !Array.isArray(profile) || profile.length !== 2 || !profile.some(selected => selected && accountKey(selected) === accountKey(target.account))) throw new AuthError("Account unavailable.", 403);
}
export function createAgentDispatcher(connection?: Client) {
  async function authorizeAgentDispatch(principal: GrantPrincipal, id: string, hash: string, claimId: string): Promise<boolean> {
    try {
      return await withAgentTransaction(connection, async tx => {
        const binding = (await tx.execute({ sql: "SELECT * FROM agent_key_bindings WHERE grant_id=? AND grant_revision=? AND operation_id=? AND payload_hash=?", args: [principal.keyId, principal.revision, id, hash] })).rows[0];
        if (!binding) return false;
        const legacy = binding.operation_table === "legacy";
        if (!legacy && binding.operation_table !== "resource") return false;
        const table = legacy ? "agent_operations" : "agent_resource_operations";
        const op = (await tx.execute({ sql: `SELECT * FROM ${table} WHERE id=? AND payload_hash=? AND claim_id=? AND status='executing' AND expires_at>? AND lease_expires_at>?`, args: [id, hash, claimId, new Date(Date.now()).toISOString(), new Date(Date.now()).toISOString()] })).rows[0];
        if (!op) return false;
        const target: ResourceRef = { account: { accountId: String(op.account_id), provider: op.provider as "microsoft" | "gmail", expectedEmail: String(op.expected_email) }, kind: legacy ? "calendar" : op.resource_kind as ResourceRef["kind"], id: String(legacy ? op.calendar_id : op.resource_id) };
        await assertTransactionGrant(tx, principal, op.kind as GrantScope, target);
        const lock = (await tx.execute({ sql: "SELECT operation_id FROM agent_resource_locks WHERE account_id=? AND provider=? AND resource_kind=? AND resource_id=? AND operation_table=? AND operation_id=?", args: [target.account.accountId, target.account.provider, target.kind, target.id, binding.operation_table, id] })).rows[0];
        if (!lock) return false;
        const attempts = legacy ? "agent_operation_attempts" : "agent_resource_operation_attempts";
        const stamp = new Date(Date.now()).toISOString();
        const result = await tx.execute({ sql: `UPDATE ${attempts} SET dispatched_at=?${legacy ? "" : ",authorized_at=?"} WHERE id=? AND operation_id=? AND dispatched_at IS NULL AND finished_at IS NULL`, args: legacy ? [stamp, claimId, id] : [stamp, stamp, claimId, id] });
        return result.rowsAffected === 1;
      });
    } catch (error) { if (error instanceof AuthError) return false; throw error; }
  }
  return { authorizeAgentDispatch };
}
export const authorizeAgentDispatch = createAgentDispatcher().authorizeAgentDispatch;
