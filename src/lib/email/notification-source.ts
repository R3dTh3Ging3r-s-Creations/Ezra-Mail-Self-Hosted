import { createHash } from "node:crypto";
import type { InValue, Transaction } from "@libsql/client";
import type { AttentionCandidateContext } from "./notification-attention";
import { notificationPolicySettingKeys, parseNotificationPolicySettings } from "./notification-center";
import { isCurrentNotificationEnrollment } from "./notification-eligibility";
import { currentNotificationOrigins } from "./notification-origin";
import { readTelegramConfiguration } from "./notification-telegram-config";
import { foregroundBrowserNotificationsEnabled } from "./foreground-notifications";
import { notificationHandledEvidence } from "./notification-handled";
import type { InboxItem } from "./types";
const senderHash = (value: string) => createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
async function query(tx: Transaction, sql: string, args: InValue[] = []) { return (await tx.execute({ sql, args })).rows; }
function strings(value: unknown): string[] | null {
  try { const parsed: unknown = JSON.parse(String(value)); return Array.isArray(parsed) && parsed.every(v => typeof v === "string") ? parsed : null; } catch { return null; }
}
/** Minimal local policy projection. No dashboard, body, attachment or provider access. */
export async function loadNotificationCandidateInTransaction(tx: Transaction, messageId: string): Promise<{ item: InboxItem; connected: boolean } | null> {
  const row = (await query(tx, `SELECT m.id,m.account_id,m.thread_id,m.sender_email,m.received_at,m.is_unread,m.status,m.gmail_labels,
      a.provider,a.status AS account_status,t.urgency,t.confidence,t.category,t.deadline,t.injection_flags,t.needs_reply,
      COALESCE(t.user_corrected_attention,t.attention) AS attention
    FROM email_messages m JOIN email_accounts a ON a.id=m.account_id
    LEFT JOIN triage_decisions t ON t.id=(SELECT id FROM triage_decisions WHERE message_id=m.id ORDER BY created_at DESC,id DESC LIMIT 1)
    WHERE m.id=?`, [messageId]))[0];
  if (!row) return null;
  const labels = strings(row.gmail_labels), flags = strings(row.injection_flags);
  const item: InboxItem = {
    id: String(row.id), accountId: String(row.account_id), threadId: String(row.thread_id), senderEmail: String(row.sender_email),
    receivedAt: String(row.received_at), isUnread: row.is_unread === 1, status: String(row.status), mailboxLabels: labels || [],
    attention: row.attention as InboxItem["attention"], urgency: row.urgency == null ? null : Number(row.urgency), confidence: row.confidence == null ? null : Number(row.confidence),
    category: row.category == null ? null : String(row.category), deadline: row.deadline == null ? null : String(row.deadline),
    injectionFlags: labels && flags ? flags : ["invalid_metadata"], accountProvider: row.provider as InboxItem["accountProvider"],
    accountLabel: "", externalMessageId: "", senderName: "", subject: "", snippet: "", gmailUrl: "", hasAttachments: false,
    summary: null, reason: null, recommendation: null, needsReply: row.needs_reply === 1, model: null, notifiedAt: null,
  };
  return { item, connected: row.account_status === "connected" && ["gmail", "microsoft"].includes(String(row.provider)) };
}
export async function notificationCandidateContextInTransaction(tx: Transaction, item: InboxItem, now: Date): Promise<AttentionCandidateContext & { invalidEvidence: boolean }> {
  const settings = await query(tx, `SELECT key,value FROM settings WHERE key IN (${notificationPolicySettingKeys.map(() => "?").join(",")})`, notificationPolicySettingKeys);
  const feedback = await query(tx, `SELECT DISTINCT f.kind,f.created_at FROM notification_feedback f JOIN notification_policy_evidence p ON p.event_id=f.event_id WHERE p.account_id=? AND p.sender_hash=?
    UNION SELECT DISTINCT f.kind,f.created_at FROM notification_feedback f JOIN notification_schedule_members s ON s.event_id=f.event_id
    JOIN email_messages m ON m.id=s.message_id AND m.account_id=s.account_id WHERE s.account_id=? AND lower(trim(m.sender_email))=?`, [item.accountId, senderHash(item.senderEmail), item.accountId, item.senderEmail.trim().toLowerCase()]);
  const origins = currentNotificationOrigins();
  const enrolled = origins.length ? await query(tx, `SELECT d.origin,d.channel,d.foreground,d.push,d.telegram_binding_fingerprint
    FROM notification_devices d JOIN trusted_devices t ON t.id=d.trusted_device_id
    WHERE t.revoked_at IS NULL AND d.revoked_at IS NULL AND d.permission='granted'
    AND d.origin IN (${origins.map(() => "?").join(",")})
    AND ((d.channel='telegram' AND d.telegram_binding_fingerprint=?) OR (d.channel='browser' AND ?=1 AND (d.foreground=1 OR d.push=1)))
    LIMIT 1`, [...origins, readTelegramConfiguration()?.fingerprint ?? "", +foregroundBrowserNotificationsEnabled()]) : [];
  const evidence = await notificationHandledEvidence(tx, { accountId: item.accountId, provider: item.accountProvider || "", threadId: item.threadId, receivedAt: item.receivedAt });
  return { item, now, policy: parseNotificationPolicySettings(Object.fromEntries(settings.map(row => [String(row.key), row.value])), now),
    feedback: feedback.map(row => ({ accountId: item.accountId, senderEmail: item.senderEmail, kind: row.kind as "useful" | "too_noisy", createdAt: String(row.created_at) })),
    handled: evidence.handled, invalidEvidence: evidence.invalid, hasEnrolledDevice: enrolled.some(row => isCurrentNotificationEnrollment(row)) };
}
