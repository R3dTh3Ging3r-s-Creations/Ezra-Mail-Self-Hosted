import { createHash, randomUUID } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { z } from "zod";
import { localAttentionDay } from "./notification-attention";
import { createNotificationEventInTransaction, enqueueNotificationDeliveriesInTransaction, withNotificationStoreWrite } from "./notification-store";
import { calmTimeDue, localSourcesProveCalm, scheduleBlocked, scheduleBriefItems, scheduleLocalTime, schedulePolicy } from "./notification-schedule-eligibility";
import { evaluateBriefDelivery } from "./notification-policy";
import type { InboxItem, NotificationPolicySettings } from "./types";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const timestamp = z.string().datetime({ offset: true });
export interface ScheduledBriefResult { digestId: string | null; eventId: string | null; count: number; status: "pending" | "skipped" }
async function createScheduledEvent(tx: Transaction, input: { kind: "brief" | "checkin"; sourceKey: string; slot: string; now: Date; policy: NotificationPolicySettings; items: InboxItem[]; manual: boolean }): Promise<ScheduledBriefResult> {
  const { kind, sourceKey, slot, now, policy, items, manual } = input;
  const createdAt = now.toISOString(), digestId = kind === "brief" ? randomUUID() : null;
  if (digestId) {
    await tx.execute({ sql: "INSERT INTO email_digests (id,label,channel,status,item_count,scheduled_for,created_at) VALUES (?,'Mail brief','shared','pending',?,?,?)", args: [digestId, items.length, createdAt, createdAt] });
    for (const [index, item] of items.entries()) await tx.execute({ sql: "INSERT INTO email_digest_items (digest_id,message_id,position,summary_snapshot,recommendation_snapshot) VALUES (?,?,?,'','')", args: [digestId, item.id, index + 1] });
  }
  // Class/count copy stays generic; no model or network request occurs in this transaction.
  const expiry = Math.min(now.getTime() + 3600000, ...items.map(item => Date.parse(item.receivedAt) + 86400000));
  const event = await createNotificationEventInTransaction(tx, { sourceKey, kind, target: "/?view=today", replacementTag: hash(`today:${kind}`), reasonCode: kind, createdAt, expiresAt: new Date(expiry).toISOString() });
  await tx.execute({ sql: `INSERT INTO notification_schedule_evidence (source_key,event_id,kind,local_day,slot_time,timezone,manual,item_count,digest_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, args: [sourceKey, event.id, kind, localAttentionDay(now, policy.timezone), slot, policy.timezone, +manual, items.length, digestId, createdAt] });
  for (const item of items) await tx.execute({ sql: "INSERT INTO notification_schedule_members (event_id,message_id,account_id,thread_id) VALUES (?,?,?,?)", args: [event.id, item.id, item.accountId, item.threadId] });
  const reservations = await enqueueNotificationDeliveriesInTransaction(tx, { eventId: event.id, now: createdAt });
  if (digestId && !reservations.length) await tx.execute({ sql: "UPDATE email_digests SET status='skipped' WHERE id=?", args: [digestId] });
  return { digestId, eventId: event.id, count: items.length, status: reservations.length ? "pending" : "skipped" };
}
export async function runNotificationSchedule(value = new Date().toISOString()): Promise<void> {
  const now = new Date(timestamp.parse(value));
  await withNotificationStoreWrite(async tx => {
    const policy = await schedulePolicy(tx, now);
    if (await scheduleBlocked(tx, policy, now)) return;
    const day = localAttentionDay(now, policy.timezone), local = scheduleLocalTime(now, policy.timezone);
    const slot = policy.digestTimes.filter(time => time <= local).at(-1);
    if (slot) {
      const sourceKey = hash(`schedule:brief:${policy.timezone}:${day}:${slot}`);
      if (!(await tx.execute({ sql: "SELECT 1 FROM notification_schedule_evidence WHERE source_key=?", args: [sourceKey] })).rows.length) {
        const items = (await scheduleBriefItems(tx, now)).filter(item => Date.parse(item.receivedAt) + 86400000 > now.getTime());
        if (evaluateBriefDelivery(items, slot === policy.digestTimes[0] ? "morning" : "afternoon", now).send) {
          await createScheduledEvent(tx, { kind: "brief", sourceKey, slot, now, policy, items, manual: false });
        }
      }
    }
    if (!calmTimeDue(policy, now)) return;
    const prior = await tx.execute({ sql: "SELECT 1 FROM notification_schedule_evidence WHERE kind='checkin' AND (local_day=? OR created_at>?) LIMIT 1", args: [day, new Date(now.getTime() - 86400000).toISOString()] });
    if (prior.rows.length || !await localSourcesProveCalm(tx, now)) return;
    await createScheduledEvent(tx, { kind: "checkin", sourceKey: hash(`schedule:checkin:${policy.timezone}:${day}`), slot: policy.calmCheckinTime, now, policy, items: [], manual: false });
  });
}
/** Explicit local request; no provider fetch, status mutation or transport send. */
export async function createManualNotificationBrief(value = new Date().toISOString()): Promise<ScheduledBriefResult> {
  const now = new Date(timestamp.parse(value));
  return withNotificationStoreWrite(async tx => {
    const policy = await schedulePolicy(tx, now);
    if (await scheduleBlocked(tx, policy, now)) return { digestId: null, eventId: null, count: 0, status: "skipped" };
    const items = (await scheduleBriefItems(tx, now, undefined, true)).filter(item => Date.parse(item.receivedAt) + 86400000 > now.getTime());
    if (!items.length) return { digestId: null, eventId: null, count: 0, status: "skipped" };
    return createScheduledEvent(tx, { kind: "brief", sourceKey: hash(`manual:${randomUUID()}`), slot: scheduleLocalTime(now, policy.timezone), now, policy, items, manual: true });
  });
}
