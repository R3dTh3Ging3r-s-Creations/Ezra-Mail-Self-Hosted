import { createAgentDispatcher } from "./agent-dispatch";
import type { GrantPrincipal } from "./agent-resource-types";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Client, Row } from "@libsql/client";
import { ensureEmailDatabase, getEmailClient } from "./database";
import { withEmailDatabaseAccess } from "./database-access";
import { accountRefSchema, type CapabilityEvidence, type CalendarSnapshot } from "./agent-types";
import { calendarCreateSchema, canonicalJson, hashCalendarCreate, type CalendarCreate, type OperationReceipt, type OperationStatus } from "./agent-operation-schema";

export const PREPARATION_TTL_MS = 30 * 60_000;
export const DISPATCH_LEASE_MS = 180_000;
export const DISPATCH_HEARTBEAT_MS = 30_000;
export const PROVIDER_DEADLINE_MS = 120_000;
const timestamp = (offset = 0) => new Date(Date.now() + offset).toISOString();
const idSchema = z.string().min(1).max(200);
const approvalSchema = z.object({ source: z.enum(["owner_ui", "mcp_host"]), principal: z.string().min(1).max(200), requestId: z.string().min(1).max(200), account: accountRefSchema }).strict();
export type TrustedApproval = z.infer<typeof approvalSchema>;
export type PreparedOperation = {
  id: string; kind: "calendar.create"; version: 1; payload: CalendarCreate; payloadHash: string;
  evidence: CapabilityEvidence; snapshot: CalendarSnapshot; status: OperationStatus;
  createdAt: string; expiresAt: string; claimId: string | null; leaseExpiresAt: string | null;
  attemptCount: number; providerEventId: string | null; receipt: OperationReceipt | null; errorCode: string | null;
  approvalSource: TrustedApproval["source"] | "agent_key" | null;
};
const sameAccount = (a: CalendarCreate["account"], b: CalendarCreate["account"]) => a.accountId === b.accountId && a.provider === b.provider && a.expectedEmail.toLowerCase() === b.expectedEmail.toLowerCase();

function decode(row: Row): PreparedOperation {
  const payload = calendarCreateSchema.parse(JSON.parse(String(row.payload_json)));
  if (row.version !== 1 || row.kind !== "calendar.create" || hashCalendarCreate(payload) !== row.payload_hash || payload.account.accountId !== row.account_id || payload.account.provider !== row.provider || payload.account.expectedEmail !== row.expected_email || payload.calendarId !== row.calendar_id) throw new Error("Operation integrity check failed.");
  const approval = row.approval_json ? JSON.parse(String(row.approval_json)) : null;
  if (approval && (approval.operationId !== row.id || approval.payloadHash !== row.payload_hash || !sameAccount(payload.account, approval.account) || !["owner_ui", "mcp_host", "agent_key"].includes(approval.source))) throw new Error("Operation approval integrity check failed.");
  return { id: String(row.id), kind: "calendar.create", version: 1, payload, payloadHash: String(row.payload_hash), approvalSource: approval?.source || null,
    evidence: JSON.parse(String(row.evidence_json)), snapshot: JSON.parse(String(row.snapshot_json)), status: row.status as OperationStatus,
    createdAt: String(row.created_at), expiresAt: String(row.expires_at), claimId: row.claim_id ? String(row.claim_id) : null,
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null, attemptCount: Number(row.attempt_count),
    providerEventId: row.provider_event_id ? String(row.provider_event_id) : null, receipt: row.receipt_json ? JSON.parse(String(row.receipt_json)) : null, errorCode: row.error_code ? String(row.error_code) : null };
}
function validateReceipt(op: PreparedOperation, receipt: OperationReceipt) {
  if (receipt.operationId !== op.id || receipt.payloadHash !== op.payloadHash || !sameAccount(receipt.account, op.payload.account) || receipt.calendarId !== op.payload.calendarId || !receipt.providerEventId || receipt.event.externalEventId !== receipt.providerEventId || receipt.event.accountId !== op.payload.account.accountId || receipt.event.calendarId !== op.payload.calendarId || !["created", "existing_match"].includes(receipt.outcome) || !Number.isFinite(Date.parse(receipt.verifiedAt))) throw new Error("Operation receipt binding is invalid.");
}

/** Internal persistence boundary. Never expose approval/claim methods as model tools. */
export function createAgentOperationStore(connection?: Client) {
  async function access<T>(fn: (client: Client) => Promise<T>) {
    await ensureEmailDatabase();
    return withEmailDatabaseAccess(() => fn(connection || getEmailClient()));
  }
  async function expire(client: Client) {
    const now = timestamp();
    await client.batch([
      { sql: "UPDATE agent_operations SET status='expired',updated_at=? WHERE status IN ('prepared','approved') AND expires_at<=?", args: [now, now] },
      { sql: "UPDATE agent_operations SET status='unknown',error_code='lease_expired',updated_at=? WHERE status='executing' AND lease_expires_at<=?", args: [now, now] },
      { sql: "UPDATE agent_operation_attempts SET finished_at=?,outcome='unknown',error_code='lease_expired' WHERE finished_at IS NULL AND id IN (SELECT claim_id FROM agent_operations WHERE status='unknown' AND error_code='lease_expired')", args: [now] },
    ], "write");
  }
  async function getOperation(id: string) {
    idSchema.parse(id);
    return access(async client => { await expire(client); const row = (await client.execute({ sql: "SELECT * FROM agent_operations WHERE id=?", args: [id] })).rows[0]; return row ? decode(row) : null; });
  }
  async function savePreparedOperation(input: unknown, evidence: CapabilityEvidence, snapshot: CalendarSnapshot, id: string = randomUUID()) {
    const payload = calendarCreateSchema.parse(input); idSchema.parse(id);
    const fresh = (value: string | null) => value !== null && Date.now() - Date.parse(value) >= 0 && Date.now() - Date.parse(value) <= 600_000;
    if (!sameAccount(payload.account, evidence.account) || evidence.calendarWrite !== "available" || !fresh(evidence.identityVerifiedAt) || !sameAccount(payload.account, snapshot.account) || snapshot.calendarId !== payload.calendarId || snapshot.complete !== true || !fresh(snapshot.fetchedAt) || Date.parse(snapshot.range.from) > Date.parse(payload.startsAt) || Date.parse(snapshot.range.to) < Date.parse(payload.endsAt)) throw new Error("Prepared operation evidence is incomplete or mismatched.");
    const hash = hashCalendarCreate(payload); const now = timestamp();
    await access(async client => {
      await client.execute({ sql: `INSERT INTO agent_operations (id,kind,version,account_id,provider,expected_email,calendar_id,payload_json,payload_hash,evidence_json,snapshot_json,created_at,expires_at,updated_at,status)
        VALUES (?,'calendar.create',1,?,?,?,?,?,?,?,?,?,?,?,'prepared') ON CONFLICT(id) DO NOTHING`, args: [id,payload.account.accountId,payload.account.provider,payload.account.expectedEmail,payload.calendarId,canonicalJson(payload),hash,canonicalJson(evidence),canonicalJson(snapshot),now,timestamp(PREPARATION_TTL_MS),now] });
    });
    const op = (await getOperation(id))!;
    if (op.payloadHash !== hash) throw new Error("Operation content is immutable; prepare a new operation.");
    return op;
  }
  async function approveOperationFromTrustedTransport(id: string, hash: string, input: TrustedApproval) {
    const approval = approvalSchema.parse(input); const op = await getOperation(id);
    if (!op || op.payloadHash !== hash || !sameAccount(op.payload.account, approval.account) || op.status !== "prepared") throw new Error("Operation approval is stale or mismatched.");
    const result = await access(client => client.execute({ sql: "UPDATE agent_operations SET status='approved',approval_json=?,updated_at=? WHERE id=? AND payload_hash=? AND status='prepared' AND expires_at>?", args: [canonicalJson({ ...approval, operationId: id, payloadHash: hash, approvedAt: timestamp() }), timestamp(), id, hash, timestamp()] }));
    if (result.rowsAffected !== 1) throw new Error("Operation approval is stale or mismatched.");
  }
  async function claimOperation(id: string, hash: string): Promise<string | null> {
    const op = await getOperation(id); if (!op || op.payloadHash !== hash || op.status !== "approved") return null;
    const claim = randomUUID(); const now = timestamp();
    return access(async client => {
      await expire(client);
      const results = await client.batch([
        { sql: `UPDATE agent_operations SET status='executing',claim_id=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE id=? AND payload_hash=? AND status='approved' AND approval_json IS NOT NULL AND expires_at>?
          AND NOT EXISTS (SELECT 1 FROM agent_resource_locks l WHERE l.account_id=agent_operations.account_id AND l.provider=agent_operations.provider AND l.resource_kind='calendar' AND l.resource_id=agent_operations.calendar_id)
          AND NOT EXISTS (SELECT 1 FROM agent_operations active WHERE active.account_id=agent_operations.account_id AND active.calendar_id=agent_operations.calendar_id AND active.status IN ('executing','unknown'))`, args: [claim,timestamp(DISPATCH_LEASE_MS),now,id,hash,now] },
        { sql: "INSERT INTO agent_operation_attempts(id,operation_id,started_at) SELECT claim_id,id,? FROM agent_operations WHERE id=? AND claim_id=? AND status='executing'", args: [now,id,claim] },
      ], "write");
      return results[0].rowsAffected === 1 ? claim : null;
    });
  }
  async function heartbeat(id: string, claim: string) {
    const result = await access(client => client.execute({ sql: "UPDATE agent_operations SET lease_expires_at=?,updated_at=? WHERE id=? AND claim_id=? AND status='executing' AND lease_expires_at>?", args: [timestamp(DISPATCH_LEASE_MS),timestamp(),id,claim,timestamp()] }));
    return result.rowsAffected === 1;
  }
  async function markDispatched(id: string, claim: string, principal?: GrantPrincipal) {
    const binding = await access(async client => (await client.execute({ sql: "SELECT grant_id FROM agent_key_bindings WHERE operation_table='legacy' AND operation_id=?", args: [id] })).rows[0]);
    if (binding) {
      if (!principal) return false;
      const op = await getOperation(id);
      return !!op && createAgentDispatcher(connection).authorizeAgentDispatch(principal, id, op.payloadHash, claim);
    }
    if (principal) return false;
    const result = await access(client => client.execute({ sql: `UPDATE agent_operation_attempts SET dispatched_at=? WHERE id=? AND operation_id=? AND dispatched_at IS NULL AND finished_at IS NULL AND EXISTS (SELECT 1 FROM agent_operations WHERE id=? AND claim_id=? AND status='executing' AND lease_expires_at>?)`, args: [timestamp(),claim,id,id,claim,timestamp()] }));
    return result.rowsAffected === 1;
  }
  async function recordProviderEventId(id: string, claim: string, providerEventId: string) {
    const result = await access(client => client.execute({ sql: "UPDATE agent_operations SET provider_event_id=?,updated_at=? WHERE id=? AND claim_id=? AND status='executing' AND lease_expires_at>? AND provider_event_id IS NULL", args: [providerEventId,timestamp(),id,claim,timestamp()] }));
    return result.rowsAffected === 1;
  }
  async function recordOperationOutcome(id: string, claim: string, state: "succeeded" | "failed" | "unknown", receipt?: OperationReceipt, errorCode?: string) {
    const op = await getOperation(id); if (!op || op.status !== "executing" || op.claimId !== claim) return false;
    if (state === "succeeded") { if (!receipt) throw new Error("Verified receipt is required."); validateReceipt(op, receipt); }
    if (errorCode && !/^[a-z_]{1,80}$/.test(errorCode)) throw new Error("Invalid operation error code.");
    const now = timestamp();
    return access(async client => {
      const results = await client.batch([
        { sql: `UPDATE agent_operations SET status=?,receipt_json=?,error_code=?,updated_at=? WHERE id=? AND claim_id=? AND status='executing' AND lease_expires_at>? AND (?<>'failed' OR EXISTS (SELECT 1 FROM agent_operation_attempts WHERE id=? AND dispatched_at IS NULL))`, args: [state,receipt ? canonicalJson(receipt) : null,errorCode || null,now,id,claim,now,state,claim] },
        { sql: "UPDATE agent_operation_attempts SET outcome=?,error_code=?,finished_at=? WHERE id=? AND finished_at IS NULL AND EXISTS (SELECT 1 FROM agent_operations WHERE id=? AND claim_id=? AND status=?)", args: [state,errorCode || null,now,claim,id,claim,state] },
      ], "write");
      return results[0].rowsAffected === 1;
    });
  }
  async function recordReconciledOutcome(id: string, receipt: OperationReceipt) {
    const op = await getOperation(id); if (!op || op.status !== "unknown") return false;
    validateReceipt(op, receipt);
    const result = await access(client => client.execute({ sql: "UPDATE agent_operations SET status='succeeded',receipt_json=?,error_code=NULL,updated_at=? WHERE id=? AND status='unknown' AND payload_hash=?", args: [canonicalJson(receipt),timestamp(),id,op.payloadHash] }));
    return result.rowsAffected === 1;
  }
  return { savePreparedOperation,getOperation,approveOperationFromTrustedTransport,claimOperation,heartbeat,markDispatched,recordProviderEventId,recordOperationOutcome,recordReconciledOutcome };
}
export const agentOperationStore = createAgentOperationStore();
