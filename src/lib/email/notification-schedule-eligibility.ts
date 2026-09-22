import { notificationCheckinHoldUntil } from "./notification-feedback";
import type { InValue, Transaction } from "@libsql/client";
import { evaluateAttentionCandidate, localAttentionDay } from "./notification-attention";
import { notificationPolicySettingKeys, parseNotificationPolicySettings } from "./notification-center";
import { loadNotificationCandidateInTransaction, notificationCandidateContextInTransaction } from "./notification-source";
import { evaluateBriefDelivery } from "./notification-policy";
import type { InboxItem, NotificationPolicySettings } from "./types";
import type { NotificationEvent, NotificationReasonCode } from "./notification-types";

async function rows(tx: Transaction, sql: string, args: InValue[] = []) { return (await tx.execute({ sql, args })).rows; }
export async function schedulePolicy(tx: Transaction, now: Date) {
  const settings = await rows(tx, `SELECT key,value FROM settings WHERE key IN (${notificationPolicySettingKeys.map(() => "?").join(",")})`, notificationPolicySettingKeys);
  return parseNotificationPolicySettings(Object.fromEntries(settings.map(row => [String(row.key), row.value])), now);
}
export function scheduleLocalTime(now: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
}
export async function scheduleBlocked(tx: Transaction, policy: NotificationPolicySettings, now: Date): Promise<NotificationReasonCode | null> {
  if ((await rows(tx, "SELECT value FROM service_state WHERE key='polling_paused_at'"))[0]?.value) return "source_unhealthy";
  if (policy.snoozedUntil && Date.parse(policy.snoozedUntil) > now.getTime()) return "snoozed";
  const time = scheduleLocalTime(now, policy.timezone);
  const quiet = policy.quietStart > policy.quietEnd ? time >= policy.quietStart || time < policy.quietEnd : time >= policy.quietStart && time < policy.quietEnd;
  return quiet ? "quiet_hours" : null;
}
/** Bounded local projection. Reuse the exact handled predicate and candidate safety rules. */
export async function scheduleBriefItems(tx: Transaction, now: Date, eventId?: string, manual = false): Promise<InboxItem[]> {
  if (eventId) manual = (await rows(tx, "SELECT manual FROM notification_schedule_evidence WHERE event_id=?", [eventId]))[0]?.manual === 1;
  const candidates = eventId
    ? await rows(tx, "SELECT message_id AS id,account_id,thread_id FROM notification_schedule_members WHERE event_id=? ORDER BY message_id LIMIT 12", [eventId])
    : await rows(tx, "SELECT m.id,m.account_id,m.thread_id FROM email_messages m JOIN email_accounts a ON a.id=m.account_id WHERE a.status='connected' AND m.is_unread=1 AND (?=1 OR NOT EXISTS (SELECT 1 FROM notification_schedule_members sm WHERE sm.message_id=m.id)) ORDER BY m.received_at DESC,m.id LIMIT 500", [+manual]);
  const threads = new Map<string, InboxItem>();
  for (const candidate of candidates) {
    const loaded = await loadNotificationCandidateInTransaction(tx, String(candidate.id));
    if (!loaded?.connected || loaded.item.accountId !== candidate.account_id || loaded.item.threadId !== candidate.thread_id) continue;
    const admission = (await rows(tx, `SELECT p.level,EXISTS (
      SELECT 1 FROM notification_events e JOIN notification_deliveries d ON d.event_id=e.id
      WHERE e.id=p.event_id AND e.kind IN ('interrupt','brief') AND
        (d.attempt_count>0 OR EXISTS (SELECT 1 FROM notification_attempts a WHERE a.delivery_id=d.id))
      ) AS attempted FROM notification_policy_evidence p WHERE p.message_id=? AND p.account_id=?`, [loaded.item.id, loaded.item.accountId]))[0];
    // Any attempted external source is consumed, even after a class change or unknown outcome.
    if (!manual && admission?.attempted === 1) continue;
    const context = await notificationCandidateContextInTransaction(tx, loaded.item, now);
    if (context.invalidEvidence) continue;
    // Enrollment is checked by reservations; useful local history still exists without a device.
    const decision = evaluateAttentionCandidate({ ...context, hasEnrolledDevice: true });
    const held = admission?.level === "brief";
    if (decision.level === "in_app" || (!held && (decision.level !== "brief" || loaded.item.attention !== "digest"))) continue;
    const key = JSON.stringify([loaded.item.accountId, loaded.item.threadId]);
    if (!threads.has(key)) threads.set(key, loaded.item);
    if (threads.size === 12) break;
  }
  return [...threads.values()];
}
function fresh(value: unknown, now: Date, maxAge: number) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms <= now.getTime() && now.getTime() - ms <= maxAge;
}
/** Positive local evidence only. Missing, stale, truncated or ambiguous data never proves calm. */
export async function localSourcesProveCalm(tx: Transaction, now: Date): Promise<boolean> {
  if (await notificationCheckinHoldUntil(tx, now)) return false;
  const poll = Number((await rows(tx, "SELECT value FROM settings WHERE key='poll_minutes'"))[0]?.value);
  if (!Number.isInteger(poll) || poll < 1 || poll > 1440) return false;
  const accounts = await rows(tx, "SELECT id,provider,status,last_sync_at FROM email_accounts WHERE status<>'disabled' LIMIT 101");
  if (!accounts.length || accounts.length > 100 || accounts.some(a => a.status !== "connected" || !["gmail", "microsoft"].includes(String(a.provider)) || !fresh(a.last_sync_at, now, poll * 60000))) return false;
  const integrations = await rows(tx, `SELECT i.*,a.provider AS account_provider,s.calendar_id,s.status AS sync_status,s.last_sync_at,s.last_error AS sync_error,s.range_from,s.range_to
    FROM account_integrations i JOIN email_accounts a ON a.id=i.account_id
    LEFT JOIN calendar_sync_state s ON s.account_id=i.account_id
    WHERE a.status<>'disabled' AND i.feature='calendar' AND (i.access<>'none' OR i.status NOT IN ('disabled','needs_setup')) LIMIT 101`);
  if (integrations.length > 100) return false;
  const horizon = now.getTime() + 86400000;
  const primaryAccounts = new Set(integrations.filter(i => i.calendar_id === "primary").map(i => i.account_id));
  for (const i of integrations) {
    if (!primaryAccounts.has(i.account_id)) return false;
    if (!["read", "write"].includes(String(i.access)) || i.provider !== i.account_provider || i.status !== "connected" || i.sync_status !== "connected" || i.last_error || i.sync_error
      || !fresh(i.last_sync_at, now, 600000) || !i.range_from || !i.range_to || Date.parse(String(i.range_from)) > now.getTime() || Date.parse(String(i.range_to)) < horizon
      || !Number.isFinite(Date.parse(String(i.range_from))) || !Number.isFinite(Date.parse(String(i.range_to)))) return false;
  }
  // Cache without a declared integration is ambiguous source state.
  if ((await rows(tx, `SELECT 1 FROM calendar_sync_state s JOIN email_accounts a ON a.id=s.account_id WHERE a.status<>'disabled'
    AND NOT EXISTS (SELECT 1 FROM account_integrations i WHERE i.account_id=s.account_id AND i.feature='calendar') LIMIT 1`)).length) return false;
  const unread = await rows(tx, "SELECT m.id FROM email_messages m JOIN email_accounts a ON a.id=m.account_id WHERE a.status<>'disabled' AND m.is_unread=1 LIMIT 501");
  if (unread.length > 500) return false;
  for (const row of unread) {
    const loaded = await loadNotificationCandidateInTransaction(tx, String(row.id));
    if (!loaded?.connected) return false;
    const context = await notificationCandidateContextInTransaction(tx, loaded.item, now);
    if (context.invalidEvidence) return false;
    const decision = evaluateAttentionCandidate({ ...context, hasEnrolledDevice: true });
    // Even routine unread mail can require an explicit cleanup review.
    if (decision.reasonCode !== "handled") return false;
  }
  // EXISTS queries are untruncated and do not materialize private content.
  const outstanding = await rows(tx, `SELECT 1 WHERE
    EXISTS (SELECT 1 FROM account_integrations i JOIN email_accounts a ON a.id=i.account_id WHERE a.status<>'disabled' AND i.status<>'disabled' AND (i.status<>'connected' OR i.access='none' OR i.last_error IS NOT NULL)) OR
    EXISTS (SELECT 1 FROM brief_item_memory WHERE state='open') OR
    EXISTS (SELECT 1 FROM reply_drafts WHERE status IN ('draft','awaiting_approval')) OR
    EXISTS (SELECT 1 FROM outgoing_drafts WHERE status IN ('draft','awaiting_approval','approved','failed','send_unknown')) OR
    EXISTS (SELECT 1 FROM calendar_drafts WHERE status='draft') OR
    EXISTS (SELECT 1 FROM mail_actions WHERE failure_count>0 OR status IN ('failed','partial')) OR
    EXISTS (SELECT 1 FROM calendar_events e JOIN email_accounts a ON a.id=e.account_id WHERE a.status<>'disabled' AND e.status<>'cancelled' AND (julianday(e.starts_at) IS NULL OR julianday(e.ends_at) IS NULL OR (julianday(e.ends_at)>julianday(?) AND julianday(e.starts_at)<julianday(?))))`, [now.toISOString(), new Date(horizon).toISOString()]);
  return outstanding.length === 0;
}
export function calmTimeDue(policy: NotificationPolicySettings, now: Date) {
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const delta = minutes(scheduleLocalTime(now, policy.timezone)) - minutes(policy.calmCheckinTime);
  return policy.calmCheckinEnabled && delta >= 0 && delta < 60;
}
export async function resolveScheduledNotification(tx: Transaction, event: NotificationEvent, now: Date): Promise<{ target: string } | { target: null; reasonCode: NotificationReasonCode } | null> {
  const record = (await rows(tx, "SELECT * FROM notification_schedule_evidence WHERE event_id=? AND source_key=?", [event.id, event.sourceKey]))[0];
  if (!record) return null;
  const policy = await schedulePolicy(tx, now), blocked = await scheduleBlocked(tx, policy, now);
  if (blocked) return { target: null, reasonCode: blocked };
  if (event.target !== "/?view=today" || record.kind !== event.kind || record.timezone !== policy.timezone || record.local_day !== localAttentionDay(now, policy.timezone)) return { target: null, reasonCode: "stale" };
  if (event.kind === "checkin") {
    if (record.slot_time !== policy.calmCheckinTime || !calmTimeDue(policy, now) || !await localSourcesProveCalm(tx, now)) return { target: null, reasonCode: "source_unhealthy" };
  } else {
    if (record.manual !== 1 && !policy.digestTimes.includes(String(record.slot_time))) return { target: null, reasonCode: "stale" };
    const items = await scheduleBriefItems(tx, now, event.id);
    const mode = record.manual === 1 ? "manual" : record.slot_time === policy.digestTimes[0] ? "morning" : "afternoon";
    if (!evaluateBriefDelivery(items, mode, now).send) return { target: null, reasonCode: "handled" };
  }
  return { target: "/?view=today" };
}
