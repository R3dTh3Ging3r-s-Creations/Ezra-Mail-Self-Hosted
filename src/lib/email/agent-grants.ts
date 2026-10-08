import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Row } from "@libsql/client";
import { audit, ensureEmailDatabase, execute, getEmailClient, nowIso } from "./database";
import { withEmailDatabaseAccess } from "./database-access";
import { AuthError } from "./auth";
import { consumeStepUpReceipt } from "./passkeys";
import { assertPersonalAccount } from "./agent-accounts";
import { canonicalJson } from "./agent-operation-schema";
import { accountKey, grantSpecSchema, resourceKey, type GrantPrincipal, type GrantScope, type GrantSpec, type GrantSummary, type ResourceRef } from "./agent-resource-types";
import type { AccountRef } from "./agent-types";

type Owner = { deviceId: string; stepUpReceiptId: string };
export const grantReviewHash = (action: unknown) => createHash("sha256").update(canonicalJson(action)).digest("hex");
async function consumeOwnerReview(owner: Owner, action: unknown) {
  if (!owner.deviceId || !owner.stepUpReceiptId) throw new AuthError("Owner confirmation required.", 403);
  await consumeStepUpReceipt({ receiptId: owner.stepUpReceiptId, action: "manage_agent_grants", deviceId: owner.deviceId, reviewHash: grantReviewHash(action) });
}
async function validateSpec(input: GrantSpec) {
  const spec = grantSpecSchema.parse(input);
  for (const account of spec.accounts) await assertPersonalAccount(account);
  return spec;
}
function newGrant(spec: GrantSpec) {
  const keyId = randomUUID();
  const rawSecret = randomBytes(32).toString("base64url");
  const secretDigest = createHash("sha256").update(rawSecret).digest("hex");
  const grant: GrantSummary = { ...spec, keyId, revision: 1, createdAt: nowIso(), expiresAt: new Date(Date.now() + spec.lifetimeDays * 86_400_000).toISOString(), revokedAt: null };
  return { grant, secret: `ezra_${keyId}.${rawSecret}`, statement: {
    sql: "INSERT INTO agent_grants(key_id,secret_digest,grant_json,revision,created_at,expires_at) VALUES (?,?,?,1,?,?)",
    args: [keyId, secretDigest, canonicalJson(spec), grant.createdAt, grant.expiresAt],
  } };
}
export function grantSummaryFromRow(row: Row): GrantSummary {
  const spec = grantSpecSchema.parse(JSON.parse(String(row.grant_json)));
  return { ...spec, keyId: String(row.key_id), revision: Number(row.revision), createdAt: String(row.created_at), expiresAt: String(row.expires_at), revokedAt: row.revoked_at === null ? null : String(row.revoked_at) };
}
export function requireActiveGrantRow(row: Row | undefined, principal?: GrantPrincipal): GrantSummary {
  if (!row || row.revoked_at !== null || !Number.isFinite(Date.parse(String(row.expires_at))) || Date.parse(String(row.expires_at)) <= Date.now() || (principal && (row.key_id !== principal.keyId || Number(row.revision) !== principal.revision))) throw new AuthError("Agent authentication required.");
  try { return grantSummaryFromRow(row); } catch { throw new AuthError("Agent authentication required."); }
}
export async function issueAgentGrant(input: GrantSpec, owner: Owner): Promise<{ grant: GrantSummary; secret: string }> {
  const spec = await validateSpec(input);
  await consumeOwnerReview(owner, { action: "issue", spec });
  const issued = newGrant(spec);
  await execute(issued.statement.sql, issued.statement.args);
  await audit("agent.grant.issued", "owner", "agent_grant", issued.grant.keyId);
  const { grant, secret } = issued; return { grant, secret };
}
export async function listAgentGrants(): Promise<GrantSummary[]> {
  return (await execute("SELECT key_id,grant_json,revision,created_at,expires_at,revoked_at FROM agent_grants ORDER BY created_at DESC")).rows.map(grantSummaryFromRow);
}
export async function revokeAgentGrant(keyId: string, owner: Owner): Promise<void> {
  await consumeOwnerReview(owner, { action: "revoke", keyId });
  const result = await execute("UPDATE agent_grants SET revoked_at=? WHERE key_id=? AND revoked_at IS NULL", [nowIso(), keyId]);
  if (result.rowsAffected !== 1) throw new AuthError("Grant is unavailable.", 409);
  await audit("agent.grant.revoked", "owner", "agent_grant", keyId);
}
export async function rotateAgentGrant(keyId: string, input: GrantSpec, owner: Owner): Promise<{ grant: GrantSummary; secret: string }> {
  const spec = await validateSpec(input);
  await consumeOwnerReview(owner, { action: "rotate", keyId, spec });
  const issued = newGrant(spec);
  await ensureEmailDatabase();
  await withEmailDatabaseAccess(async () => {
    const tx = await getEmailClient().transaction("write");
    try {
      const changed = await tx.execute({ sql: "UPDATE agent_grants SET revoked_at=? WHERE key_id=? AND revoked_at IS NULL", args: [nowIso(), keyId] });
      if (changed.rowsAffected !== 1) throw new AuthError("Grant is unavailable.", 409);
      await tx.execute(issued.statement);
      await tx.commit();
    } finally { tx.close(); }
  });
  await audit("agent.grant.rotated", "owner", "agent_grant", keyId, { replacementKeyId: issued.grant.keyId });
  const { grant, secret } = issued; return { grant, secret };
}
export function assertGrantTarget(grant: GrantSummary, scope: GrantScope, target: ResourceRef | AccountRef) {
  const account = "account" in target ? target.account : target;
  if (!grant.scopes.includes(scope) || !grant.accounts.some(selected => accountKey(selected) === accountKey(account)) || ("account" in target && !grant.resources.some(selected => resourceKey(selected) === resourceKey(target)))) throw new AuthError("Action is outside this grant.", 403);
  if ((scope.startsWith("calendar.") || scope.startsWith("tasks.")) && !("account" in target)) throw new AuthError("Exact resource required.", 403);
  if ("account" in target && ((scope.startsWith("calendar.") && target.kind !== "calendar") || (scope.startsWith("tasks.") && target.kind !== "task_list"))) throw new AuthError("Action is outside this grant.", 403);
}
export async function admitAgentRead(principal: GrantPrincipal, scope: GrantScope, target: ResourceRef | AccountRef): Promise<GrantSummary> {
  const row = (await execute("SELECT * FROM agent_grants WHERE key_id=?", [principal.keyId])).rows[0];
  const grant = requireActiveGrantRow(row, principal);
  assertGrantTarget(grant, scope, target);
  try { await assertPersonalAccount("account" in target ? target.account : target); } catch { throw new AuthError("Action is unavailable.", 403); }
  return grant;
}
