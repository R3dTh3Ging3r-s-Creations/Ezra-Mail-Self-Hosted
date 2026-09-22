import { resolveScheduledNotification } from "./notification-schedule-eligibility";
import { createHash, randomUUID } from "node:crypto";
import type { InValue, Transaction } from "@libsql/client";
import { z } from "zod";
import { evaluateAttentionCandidate, evaluateAttentionAdmission, normalizeAttentionCategory, type AttentionCandidateContext, type AttentionDecision } from "./notification-attention";
import { loadNotificationCandidateInTransaction, notificationCandidateContextInTransaction } from "./notification-source";
export { loadNotificationCandidateInTransaction, notificationCandidateContextInTransaction } from "./notification-source";
import { foregroundBrowserNotificationsEnabled } from "./foreground-notifications";
import { createNotificationEventInTransaction, enqueueNotificationDeliveriesInTransaction, withNotificationStoreWrite } from "./notification-store";
import { buildNotificationTarget, parseNotificationTarget } from "./notification-target";
import type { NotificationEvent, NotificationKind, NotificationReasonCode } from "./notification-types";

const opaque = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const timestamp = z.string().datetime({ offset: true });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const senderHash = (value: string) => hash(value.trim().toLowerCase());
async function query(tx: Transaction, sql: string, args: InValue[] = []) { return (await tx.execute({ sql, args })).rows; }
function candidateDecision(context: AttentionCandidateContext & { invalidEvidence: boolean }, connected: boolean): AttentionDecision {
  const candidate = evaluateAttentionCandidate(context);
  if (!connected || context.invalidEvidence) return { ...candidate, level: "in_app", reasonCode: "source_unhealthy", ruleTrace: [context.invalidEvidence ? "completion-evidence-invalid" : "account_disconnected"] };
  return candidate;
}
export interface MessageNotificationDecision {
  ok: true; skipped: boolean; status: "queued" | "in_app"; eventId: string | null; level: NotificationKind; reasonCode: NotificationReasonCode;
}
function result(level: NotificationKind, reasonCode: NotificationReasonCode, eventId: string | null): MessageNotificationDecision {
  const queued = level === "interrupt" && eventId !== null;
  return { ok: true, skipped: !queued, status: queued ? "queued" : "in_app", eventId, level, reasonCode };
}
export async function decideMessageNotification(messageId: string, now = new Date().toISOString()): Promise<MessageNotificationDecision> {
  opaque.parse(messageId);
  // Invalid caller clocks do not cause durable source consumption.
  if (!timestamp.safeParse(now).success || !Number.isFinite(Date.parse(now))) return result("in_app", "stale", null);
  now = new Date(now).toISOString();
  return withNotificationStoreWrite(async tx => {
    const sourceKey = hash(`message:${messageId}`);
    const existing = (await query(tx, "SELECT level,reason_code,event_id FROM notification_policy_evidence WHERE source_key=?", [sourceKey]))[0];
    if (existing) return result(existing.level as NotificationKind, existing.reason_code as NotificationReasonCode, existing.event_id == null ? null : String(existing.event_id));
    const loaded = await loadNotificationCandidateInTransaction(tx, messageId);
    if (!loaded) return result("in_app", "source_unhealthy", null);
    const { item } = loaded;
    const context = await notificationCandidateContextInTransaction(tx, item, new Date(now));
    let decision = candidateDecision(context, loaded.connected);
    let eventId: string | null = null;
    const historical = (await query(tx, "SELECT id FROM notification_decisions WHERE message_id=?", [messageId]))[0];
    if (historical) decision = { ...decision, level: "in_app", reasonCode: "handled", ruleTrace: ["historical_no_replay"] };
    const expiryMillis = Math.min(Date.parse(item.receivedAt) + 86400000, Date.parse(now) + 3600000);
    // Group only unclaimed, still pending compatible admission; never charge a second event.
    if (decision.level === "interrupt") {
      const group = (await query(tx, `SELECT e.id,e.not_before FROM notification_events e JOIN notification_policy_evidence p ON p.event_id=e.id
        WHERE p.account_id=? AND p.grouping_key=? AND p.critical=? AND e.kind='interrupt' AND e.expires_at>? AND e.not_before>?
          AND e.created_at>=? AND EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.event_id=e.id AND d.state='pending')
          AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.event_id=e.id AND (d.state<>'pending' OR d.attempt_count>0))
        ORDER BY e.sequence LIMIT 1`, [item.accountId, decision.groupingKey, +decision.critical, now, now, new Date(Date.parse(now) - context.policy.burstWindowSeconds * 1000).toISOString()]))[0];
      if (group) { eventId = String(group.id); decision.notBefore = String(group.not_before); decision.ruleTrace = [...decision.ruleTrace, "pending_thread_group"].slice(0, 16); }
      else {
        const history = await query(tx, `SELECT e.id,e.created_at,p.account_id,p.critical,
          MAX(CASE WHEN p.account_id=? AND p.sender_hash=? THEN 1 ELSE 0 END) AS same_sender
          FROM notification_events e JOIN notification_policy_evidence p ON p.event_id=e.id
          WHERE e.kind='interrupt' AND e.created_at>=? GROUP BY e.id`, [item.accountId, senderHash(item.senderEmail), new Date(Date.parse(now) - 48 * 3600000).toISOString()]);
        decision = evaluateAttentionAdmission({ ...context, candidate: decision, history: history.map(row => ({ eventId: String(row.id), accountId: String(row.account_id), senderEmail: row.same_sender === 1 ? item.senderEmail : "", admittedAt: String(row.created_at), critical: row.critical === 1 })) });
      }
    }
    if (decision.level !== "in_app" && (!Number.isFinite(expiryMillis) || Date.parse(decision.notBefore) >= expiryMillis)) {
      decision = { ...decision, level: "in_app", reasonCode: "stale", ruleTrace: [...decision.ruleTrace, "deferral_expires"].slice(0, 16) }; eventId = null;
    }
    // Held decisions persist evidence; only shared Today schedules deliver briefs.
    if (decision.level === "interrupt" && !eventId) {
      const decisionId = randomUUID();
      await query(tx, "INSERT INTO notification_decisions (id,message_id,reason,decided_at) VALUES (?,?,?,?)", [decisionId, messageId, decision.reasonCode, now]);
      await query(tx, `INSERT INTO audit_logs (id,action,actor,target_type,target_id,metadata,created_at) VALUES (?,'notification.decision.created','worker','notification_decision',?,?,?)`, [randomUUID(), decisionId, JSON.stringify({ decisionId, messageId, reason: decision.reasonCode, decidedAt: now }), now]);
      const event = await createNotificationEventInTransaction(tx, { sourceKey, decisionId, kind: decision.level, target: buildNotificationTarget({ view: "mail", provider: item.accountProvider!, accountId: item.accountId, messageId }), replacementTag: decision.groupingKey, reasonCode: decision.reasonCode, createdAt: now, notBefore: decision.notBefore, expiresAt: new Date(expiryMillis).toISOString() });
      eventId = event.id;
      await enqueueNotificationDeliveriesInTransaction(tx, { eventId, now, browserEnabled: foregroundBrowserNotificationsEnabled() });
    }
    await query(tx, `INSERT INTO notification_policy_evidence (source_key,message_id,event_id,account_id,sender_hash,category,grouping_key,level,critical,reason_code,rule_trace,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [sourceKey, messageId, eventId, item.accountId, senderHash(item.senderEmail), normalizeAttentionCategory(item.category).slice(0, 100), decision.groupingKey, decision.level, +decision.critical, decision.reasonCode, JSON.stringify(decision.ruleTrace.slice(0, 16)), now]);
    return result(decision.level, decision.reasonCode, eventId);
  });
}
export type NotificationClaimResolution = { target: string; reasonCode?: never } | { target: null; reasonCode: NotificationReasonCode };
/** Read-only final policy check; admission history and canonical target stay immutable. */
export async function resolveNotificationEventForClaim(tx: Transaction, input: { event: NotificationEvent; now: string }): Promise<NotificationClaimResolution> {
  const { event, now } = input;
  if (Date.parse(event.expiresAt) <= Date.parse(now)) return { target: null, reasonCode: "stale" };
  const scheduled = await resolveScheduledNotification(tx, event, new Date(now));
  if (scheduled) return scheduled;
  const members = await query(tx, "SELECT message_id,account_id,grouping_key,source_key,critical FROM notification_policy_evidence WHERE event_id=? ORDER BY created_at,message_id", [event.id]);
  // Historical per-message briefs remain immutable but can no longer be claimed.
  if (!members.length || event.kind !== "interrupt") return { target: null, reasonCode: "source_unhealthy" };
  // All group members have the immutable canonical admission flag, not a recomputed label.
  const canonical = members.find(member => member.source_key === event.sourceKey);
  const originalTarget = parseNotificationTarget(event.target);
  if (!canonical || !originalTarget) return { target: null, reasonCode: "source_unhealthy" };
  const admittedCritical = canonical.critical === 1;
  let reasonCode: NotificationReasonCode = "handled";
  for (const member of members) {
    const loaded = await loadNotificationCandidateInTransaction(tx, String(member.message_id));
    if (!loaded || loaded.item.accountId !== member.account_id || member.account_id !== canonical.account_id
      || (originalTarget.view === "mail" && (loaded.item.accountProvider !== originalTarget.provider || loaded.item.accountId !== originalTarget.accountId))) {
      reasonCode = "source_unhealthy"; continue;
    }
    const context = await notificationCandidateContextInTransaction(tx, loaded.item, new Date(now));
    const decision = candidateDecision(context, loaded.connected);
    reasonCode = decision.reasonCode;
    if (decision.groupingKey !== member.grouping_key) { reasonCode = "source_unhealthy"; continue; }
    if (decision.level === "in_app" || decision.critical !== admittedCritical) continue;
    if (event.kind === "interrupt" && decision.level !== "interrupt") continue;
    // Do not recompute the admission burst timer at claim time.
    return { target: buildNotificationTarget({ view: "mail", provider: loaded.item.accountProvider!, accountId: loaded.item.accountId, messageId: loaded.item.id }) };
  }
  return { target: null, reasonCode };
}
