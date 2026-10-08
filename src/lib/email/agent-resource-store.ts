import { prepareCalendarMutationEvidence } from "./calendar-mutation-actions";
import { prepareTaskEvidence } from "./agent-tasks";
import { createHash, randomUUID } from "node:crypto";
import type { Client, Row } from "@libsql/client";
import { z } from "zod";
import { AuthError } from "./auth";
import { execute } from "./database";
import { canonicalJson, hashCalendarCreate, type OperationStatus } from "./agent-operation-schema";
import { DISPATCH_LEASE_MS, PREPARATION_TTL_MS, agentOperationStore } from "./agent-operation-store";
import { assertTransactionGrant, withAgentTransaction } from "./agent-dispatch";
import { admitAgentRead } from "./agent-grants";
import { resourceKey, resourceMutationSchema, type GrantPrincipal, type ResourceMutation, type ResourceRef, type OperationView } from "./agent-resource-types";
import { prepareCalendarCreate } from "./agent-actions";

const stamp = (offset = 0) => new Date(Date.now() + offset).toISOString();
const idempotency = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
export type ResourceEvidence = { target: ResourceRef; complete: true; fetchedAt: string; identityVerifiedAt: string; providerRevision?: string; deletePolicyId?: string; before?: unknown };
export const mutationTarget = (mutation: ResourceMutation): ResourceRef => mutation.kind === "calendar.create" ? { account: mutation.payload.account, kind: "calendar", id: mutation.payload.calendarId } : mutation.target;
export function hashResourceMutation(input: ResourceMutation) {
  const mutation = resourceMutationSchema.parse(input);
  return mutation.kind === "calendar.create" ? hashCalendarCreate(mutation.payload) : createHash("sha256").update(canonicalJson({ version: 1, mutation })).digest("hex");
}
export type StoredResourceOperation = OperationView & { mutation: ResourceMutation; evidence: ResourceEvidence; claimId: string | null; providerId: string | null; authority: unknown };
function decode(row: Row): StoredResourceOperation {
  const mutation = resourceMutationSchema.parse(JSON.parse(String(row.payload_json)));
  const target = mutationTarget(mutation);
  if (row.version !== 1 || row.kind !== mutation.kind || row.payload_hash !== hashResourceMutation(mutation) || row.account_id !== target.account.accountId || row.provider !== target.account.provider || row.expected_email !== target.account.expectedEmail || row.resource_kind !== target.kind || row.resource_id !== target.id) throw new Error("Operation integrity failure.");
  return { id: String(row.id), kind: mutation.kind, mutation, evidence: JSON.parse(String(row.evidence_json)), payloadHash: String(row.payload_hash), status: row.status as OperationStatus, expiresAt: String(row.expires_at), claimId: row.claim_id ? String(row.claim_id) : null, providerId: row.provider_id ? String(row.provider_id) : null, authority: JSON.parse(String(row.authority_json)), ...(row.error_code ? { errorCode: String(row.error_code) } : {}), ...(row.receipt_json ? { receipt: JSON.parse(String(row.receipt_json)) } : {}) };
}
export const operationView = (op: OperationView): OperationView => ({ id: op.id, kind: op.kind, payloadHash: op.payloadHash, status: op.status, expiresAt: op.expiresAt, ...(op.errorCode ? { errorCode: op.errorCode } : {}), ...(op.receipt ? { receipt: op.receipt } : {}) });
export function createAgentResourceStore(connection?: Client) {
  async function getOperation(id: string): Promise<StoredResourceOperation | null> {
    return withAgentTransaction(connection, async tx => {
      await tx.execute({ sql: "UPDATE agent_resource_operations SET status='expired',updated_at=? WHERE id=? AND status IN ('prepared','approved') AND expires_at<=?", args: [stamp(), id, stamp()] });
      await tx.execute({ sql: "UPDATE agent_resource_operations SET status='unknown',error_code='lease_expired',updated_at=? WHERE id=? AND status='executing' AND lease_expires_at<=?", args: [stamp(), id, stamp()] });
      await tx.execute({ sql: "UPDATE agent_resource_operation_attempts SET finished_at=?,outcome='unknown',error_code='lease_expired' WHERE operation_id=? AND finished_at IS NULL AND EXISTS (SELECT 1 FROM agent_resource_operations WHERE id=? AND status='unknown' AND error_code='lease_expired')", args: [stamp(), id, id] });
      const row = (await tx.execute({ sql: "SELECT * FROM agent_resource_operations WHERE id=?", args: [id] })).rows[0];
      return row ? decode(row) : null;
    });
  }
  async function prepareKeyOperation(principal: GrantPrincipal, requestId: string, input: ResourceMutation, evidence: ResourceEvidence): Promise<StoredResourceOperation> {
    idempotency.parse(requestId);
    const mutation = resourceMutationSchema.parse(input);
    if (mutation.kind === "calendar.create") throw new Error("Use the qualified calendar create engine.");
    const target = mutationTarget(mutation); const hash = hashResourceMutation(mutation);
    const fresh = (value: string) => Number.isFinite(Date.parse(value)) && Date.now() - Date.parse(value) >= 0 && Date.now() - Date.parse(value) <= 600_000;
    if (evidence.complete !== true || resourceKey(evidence.target) !== resourceKey(target) || !fresh(evidence.fetchedAt) || !fresh(evidence.identityVerifiedAt) || ("expectedRevision" in mutation && mutation.expectedRevision !== evidence.providerRevision)) throw new Error("Fresh exact resource evidence required.");
    return withAgentTransaction(connection, async tx => {
      await assertTransactionGrant(tx, principal, mutation.kind, target);
      const prior = (await tx.execute({ sql: "SELECT * FROM agent_key_bindings WHERE grant_id=? AND idempotency_key=?", args: [principal.keyId, requestId] })).rows[0];
      if (prior) {
        if (prior.payload_hash !== hash || prior.grant_revision !== principal.revision || prior.operation_table !== "resource") throw new AuthError("Idempotency conflict.", 409);
        const row = (await tx.execute({ sql: "SELECT * FROM agent_resource_operations WHERE id=?", args: [prior.operation_id] })).rows[0];
        if (!row) throw new Error("Operation binding unavailable.");
        return decode(row);
      }
      const id = randomUUID(); const createdAt = stamp();
      await tx.execute({ sql: `INSERT INTO agent_resource_operations(id,kind,version,account_id,provider,expected_email,resource_kind,resource_id,payload_json,payload_hash,evidence_json,authority_json,created_at,expires_at,updated_at,status)
        VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,'approved')`, args: [id, mutation.kind, target.account.accountId, target.account.provider, target.account.expectedEmail, target.kind, target.id, canonicalJson(mutation), hash, canonicalJson(evidence), canonicalJson({ source: "agent_key", ...principal }), createdAt, stamp(PREPARATION_TTL_MS), createdAt] });
      await tx.execute({ sql: "INSERT INTO agent_key_bindings VALUES (?,?,?,?,?,?)", args: [principal.keyId, principal.revision, requestId, hash, "resource", id] });
      return decode((await tx.execute({ sql: "SELECT * FROM agent_resource_operations WHERE id=?", args: [id] })).rows[0]);
    });
  }
  async function claimOperation(id: string, hash: string): Promise<string | null> {
    await getOperation(id);
    return withAgentTransaction(connection, async tx => {
      const claim = randomUUID();
      const result = await tx.execute({ sql: `UPDATE agent_resource_operations SET status='executing',claim_id=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE id=? AND payload_hash=? AND status='approved' AND expires_at>?
        AND NOT EXISTS (SELECT 1 FROM agent_resource_locks l WHERE l.account_id=agent_resource_operations.account_id AND l.provider=agent_resource_operations.provider AND l.resource_kind=agent_resource_operations.resource_kind AND l.resource_id=agent_resource_operations.resource_id)`, args: [claim, stamp(DISPATCH_LEASE_MS), stamp(), id, hash, stamp()] });
      if (result.rowsAffected !== 1) return null;
      await tx.execute({ sql: "INSERT INTO agent_resource_operation_attempts(id,operation_id,started_at) VALUES (?,?,?)", args: [claim, id, stamp()] });
      return claim;
    });
  }
  async function heartbeat(id: string, claim: string) {
    return withAgentTransaction(connection, async tx => (await tx.execute({ sql: "UPDATE agent_resource_operations SET lease_expires_at=?,updated_at=? WHERE id=? AND claim_id=? AND status='executing' AND lease_expires_at>?", args: [stamp(DISPATCH_LEASE_MS), stamp(), id, claim, stamp()] })).rowsAffected === 1);
  }
  async function recordProviderId(id: string, claim: string, providerId: string) {
    if (!providerId || providerId.length > 1024) throw new Error("Provider ID required.");
    return withAgentTransaction(connection, async tx => (await tx.execute({ sql: "UPDATE agent_resource_operations SET provider_id=?,updated_at=? WHERE id=? AND claim_id=? AND status='executing' AND lease_expires_at>? AND provider_id IS NULL", args: [providerId, stamp(), id, claim, stamp()] })).rowsAffected === 1);
  }
  async function recordOutcome(id: string, claim: string, state: "succeeded" | "failed" | "unknown", receipt?: OperationView["receipt"], errorCode?: string) {
    if (state === "succeeded" && (!receipt?.providerId || !receipt.verifiedAt || !Number.isFinite(Date.parse(receipt.verifiedAt)))) throw new Error("Verified receipt required.");
    if (errorCode && !/^[a-z_]{1,80}$/.test(errorCode)) throw new Error("Invalid safe error code.");
    return withAgentTransaction(connection, async tx => {
      if (state === "succeeded") {
        const row = (await tx.execute({ sql: "SELECT * FROM agent_resource_operations WHERE id=?", args: [id] })).rows[0];
        if (!row) return false;
        const op = decode(row);
        const expectedId = op.mutation.kind === "tasks.create" ? op.providerId : "eventId" in op.mutation ? op.mutation.eventId : "taskId" in op.mutation ? op.mutation.taskId : null;
        const outcomes: Record<string,string> = { "tasks.create": "created", "tasks.update": "updated", "tasks.complete": "completed", "calendar.update": "updated", "calendar.delete": "deleted" };
        if (!expectedId || receipt!.providerId !== expectedId || receipt!.outcome !== outcomes[op.kind] || Date.parse(receipt!.verifiedAt) > Date.now() || Date.parse(receipt!.verifiedAt) < Date.parse(op.evidence.fetchedAt)) throw new Error("Operation receipt binding is invalid.");
        const attempt = (await tx.execute({ sql: "SELECT dispatched_at FROM agent_resource_operation_attempts WHERE id=? AND operation_id=?", args: [claim,id] })).rows[0];
        if (!attempt?.dispatched_at) throw new Error("Operation receipt requires authorized dispatch.");
      } else if (receipt) throw new Error("Receipt is only valid for a verified success.");
      const changed = await tx.execute({ sql: `UPDATE agent_resource_operations SET status=?,receipt_json=?,error_code=?,updated_at=? WHERE id=? AND claim_id=? AND status='executing' AND lease_expires_at>? AND (?<>'failed' OR EXISTS (SELECT 1 FROM agent_resource_operation_attempts WHERE id=? AND dispatched_at IS NULL))`, args: [state, receipt ? canonicalJson(receipt) : null, errorCode || null, stamp(), id, claim, stamp(), state, claim] });
      if (changed.rowsAffected !== 1) return false;
      await tx.execute({ sql: "UPDATE agent_resource_operation_attempts SET outcome=?,error_code=?,finished_at=? WHERE id=? AND finished_at IS NULL", args: [state, errorCode || null, stamp(), claim] });
      return true;
    });
  }
  async function recordReconciledOutcome(id: string,receipt: NonNullable<OperationView["receipt"]>) {
    return withAgentTransaction(connection,async tx=>{
      const row = (await tx.execute({sql:"SELECT * FROM agent_resource_operations WHERE id=? AND status='unknown'",args:[id]})).rows[0];
      if (!row) return false;
      const op = decode(row);
      if (!((op.mutation.kind === "tasks.create" && op.providerId && receipt.providerId === op.providerId && receipt.outcome === "created") || (op.mutation.kind === "calendar.delete" && receipt.providerId === op.mutation.eventId && receipt.outcome === "deleted")) || !Number.isFinite(Date.parse(receipt.verifiedAt)) || Date.parse(receipt.verifiedAt)>Date.now()) throw new Error("Reconciliation receipt binding is invalid.");
      const changed = await tx.execute({sql:"UPDATE agent_resource_operations SET status='succeeded',receipt_json=?,error_code=NULL,updated_at=? WHERE id=? AND status='unknown' AND EXISTS (SELECT 1 FROM agent_resource_operation_attempts WHERE operation_id=? AND dispatched_at IS NOT NULL)",args:[canonicalJson(receipt),stamp(),id,id]});
      return changed.rowsAffected===1;
    });
  }
  async function recordProviderRejection(id:string,claim:string,errorCode: "provider_precondition_failed" | "provider_not_dispatched" = "provider_precondition_failed") {
    return withAgentTransaction(connection,async tx=>{
      const changed=await tx.execute({sql:"UPDATE agent_resource_operations SET status='failed',error_code=?,updated_at=? WHERE id=? AND claim_id=? AND status='executing' AND lease_expires_at>? AND EXISTS (SELECT 1 FROM agent_resource_operation_attempts WHERE id=? AND operation_id=? AND dispatched_at IS NOT NULL AND finished_at IS NULL)",args:[errorCode,stamp(),id,claim,stamp(),claim,id]});
      if(changed.rowsAffected!==1)return false;
      await tx.execute({sql:"UPDATE agent_resource_operation_attempts SET finished_at=?,outcome='rejected',error_code=? WHERE id=? AND finished_at IS NULL",args:[stamp(),errorCode,claim]});
      return true;
    });
  }
  return { getOperation, prepareKeyOperation, claimOperation, heartbeat, recordProviderId, recordOutcome, recordReconciledOutcome, recordProviderRejection };
}
export const agentResourceStore = createAgentResourceStore();

export async function getAgentOperation(principal: GrantPrincipal, id: string): Promise<OperationView> {
  const binding = (await execute("SELECT * FROM agent_key_bindings WHERE grant_id=? AND grant_revision=? AND operation_id=?", [principal.keyId, principal.revision, id])).rows[0];
  if (!binding) throw new AuthError("Operation unavailable.", 403);
  if (binding.operation_table === "legacy") {
    const op = await agentOperationStore.getOperation(id);
    if (!op) throw new AuthError("Operation unavailable.", 404);
    await admitAgentRead(principal, "calendar.create", { account: op.payload.account, kind: "calendar", id: op.payload.calendarId });
    return { id: op.id, kind: op.kind, payloadHash: op.payloadHash, status: op.status, expiresAt: op.expiresAt, ...(op.errorCode ? { errorCode: op.errorCode } : {}), ...(op.receipt ? { receipt: { providerId: op.receipt.providerEventId, outcome: op.receipt.outcome, verifiedAt: op.receipt.verifiedAt } } : {}) };
  }
  const op = await agentResourceStore.getOperation(id);
  if (!op) throw new AuthError("Operation unavailable.", 404);
  await admitAgentRead(principal, op.kind, mutationTarget(op.mutation));
  return operationView(op);
}
export async function prepareAgentOperation(principal: GrantPrincipal, requestId: string, input: ResourceMutation): Promise<OperationView> {
  idempotency.parse(requestId);
  const mutation = resourceMutationSchema.parse(input); const target = mutationTarget(mutation); const hash = hashResourceMutation(mutation);
  await admitAgentRead(principal, mutation.kind, target);
  const prior = (await execute("SELECT * FROM agent_key_bindings WHERE grant_id=? AND idempotency_key=?", [principal.keyId, requestId])).rows[0];
  if (prior) {
    if (prior.payload_hash !== hash || prior.grant_revision !== principal.revision) throw new AuthError("Idempotency conflict.", 409);
    return getAgentOperation(principal, String(prior.operation_id));
  }
  if (mutation.kind !== "calendar.create") {
    const evidence = mutation.kind === "calendar.update" || mutation.kind === "calendar.delete" ? await prepareCalendarMutationEvidence(mutation) : await prepareTaskEvidence(mutation);
    return operationView(await agentResourceStore.prepareKeyOperation(principal,requestId,mutation,evidence));
  }
  const op = await prepareCalendarCreate(mutation.payload);
  if (op.payload.calendarId !== target.id) throw new AuthError("Select the resolved calendar ID.", 403);
  const id = await withAgentTransaction(undefined, async tx => {
    await assertTransactionGrant(tx, principal, "calendar.create", target);
    const existing = (await tx.execute({ sql: "SELECT * FROM agent_key_bindings WHERE grant_id=? AND idempotency_key=?", args: [principal.keyId, requestId] })).rows[0];
    if (existing) { if (existing.payload_hash !== hash || existing.grant_revision !== principal.revision) throw new AuthError("Idempotency conflict.", 409); return String(existing.operation_id); }
    const approval = { source: "agent_key", principal: principal.keyId, revision: principal.revision, requestId, account: target.account, operationId: op.id, payloadHash: hash, approvedAt: stamp() };
    const approved = await tx.execute({ sql: "UPDATE agent_operations SET status='approved',approval_json=?,updated_at=? WHERE id=? AND payload_hash=? AND status='prepared' AND expires_at>?", args: [canonicalJson(approval), stamp(), op.id, hash, stamp()] });
    if (approved.rowsAffected !== 1) throw new AuthError("Operation preparation expired.", 409);
    await tx.execute({ sql: "INSERT INTO agent_key_bindings VALUES (?,?,?,?,?,?)", args: [principal.keyId, principal.revision, requestId, hash, "legacy", op.id] });
    return op.id;
  });
  return getAgentOperation(principal, id);
}
