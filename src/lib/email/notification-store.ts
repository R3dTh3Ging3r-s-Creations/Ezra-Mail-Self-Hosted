import { withEmailDatabaseAccess } from "./database-access";
import { isCurrentNotificationEnrollment } from "./notification-eligibility";
import { assertNotificationSetupReady, notificationSetupEpoch } from "./notification-setup-schema";
import { foregroundBrowserNotificationsEnabled } from "./foreground-notifications";
import { randomUUID } from "node:crypto";
import { buildNotificationTarget, parseNotificationTarget } from "./notification-target";
import type { InValue, Row, Transaction } from "@libsql/client";
import { z } from "zod";
import { ensureEmailDatabase, createEmailDatabaseConnection } from "./database";
import { notificationErrorCodes, notificationReasonCodes } from "./notification-types";
import type { NotificationAttempt, NotificationAttemptOutcome, NotificationCapabilities, NotificationClaim, NotificationDelivery, NotificationDevice, NotificationDeviceChannel, NotificationErrorCode, NotificationEvent, NotificationFeedback, NotificationKind, NotificationPermission, NotificationPlatform, NotificationReasonCode, NotificationReceipt, NotificationTransport } from "./notification-types";

const opaque = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const timestamp = z.string().datetime().refine((value) => Number.isFinite(Date.parse(value))).transform((value) => new Date(value).toISOString());
const originSchema = z.string().max(300).url().refine((value) => {
  const url = new URL(value);
  return url.origin === value && !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
});
function time(now?: string) { return timestamp.parse(now ?? new Date().toISOString()); }
function nullable(value: unknown) { return value == null ? null : String(value); }
function device(row: Row): NotificationDevice {
  return {
    id: String(row.id), trustedDeviceId: String(row.trusted_device_id), origin: String(row.origin),
    channel: row.channel as NotificationDeviceChannel, platform: row.platform as NotificationPlatform,
    permission: row.permission as NotificationPermission, capabilities: { foreground: row.foreground === 1, push: row.push === 1 },
    privacy: row.privacy as NotificationDevice["privacy"], generation: Number(row.generation), baselineSequence: Number(row.baseline_sequence),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), revokedAt: nullable(row.revoked_at),
    lastSuccessAt: nullable(row.last_success_at), lastDisplayedAt: nullable(row.last_displayed_at), lastClickedAt: nullable(row.last_clicked_at), lastFailureAt: nullable(row.last_failure_at), lastErrorCode: (row.last_error_code ?? null) as NotificationErrorCode | null,
  };
}
function event(row: Row): NotificationEvent {
  return { id: String(row.id), sequence: Number(row.sequence), sourceKey: String(row.source_key), decisionId: nullable(row.decision_id), kind: row.kind as NotificationKind,
    target: String(row.target), origin: nullable(row.origin), replacementTag: String(row.replacement_tag), reasonCode: row.reason_code as NotificationReasonCode,
    createdAt: String(row.created_at), notBefore: String(row.not_before), expiresAt: String(row.expires_at) };
}
function delivery(row: Row): NotificationDelivery {
  return { id: String(row.id), eventId: String(row.event_id), deviceId: String(row.device_id), generation: Number(row.generation), state: row.state as NotificationDelivery["state"],
    nextAttemptAt: String(row.next_attempt_at), attemptCount: Number(row.attempt_count), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function attempt(row: Row): NotificationAttempt {
  return { id: String(row.id), deliveryId: String(row.delivery_id), channel: row.channel as NotificationTransport, generation: Number(row.generation), startedAt: String(row.started_at), completedAt: nullable(row.completed_at), outcome: (row.outcome ?? null) as NotificationAttemptOutcome | null, errorCode: (row.error_code ?? null) as NotificationErrorCode | null, externalId: nullable(row.external_id), resolvedTarget: nullable(row.resolved_target) };
}
async function query(tx: Transaction, sql: string, args: InValue[] = []) { return (await tx.execute({ sql, args })).rows; }

// The native driver can retain a failed BEGIN statement. Discard that connection;
// retry only acquisition, never transaction work or an ambiguous COMMIT.
async function beginWrite() {
  for (let retry = 0; ; retry++) {
    const connection = createEmailDatabaseConnection();
    try {
      await connection.execute("PRAGMA foreign_keys = ON");
      return { tx: await connection.transaction("write"), connection };
    } catch (error) {
      connection.close();
      if (retry >= 7 || !error || typeof error !== "object" || !("code" in error) || error.code !== "SQLITE_BUSY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (retry + 1)));
    }
  }
}

/** Serialize this process's async transactions; SQLite write locks arbitrate other processes. */

async function write<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
  await ensureEmailDatabase();
  return withEmailDatabaseAccess(async () => {
    const { tx, connection } = await beginWrite();
    try {
      const result = await operation(tx);
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      try { tx.close(); } finally { connection.close(); }
    }
  });
}
/** Narrow shared transaction boundary; never call another store write from its callback. */
export { write as withNotificationStoreWrite };

const liveDevice = `d.revoked_at IS NULL AND t.revoked_at IS NULL`;
const liveDelivery = `${liveDevice} AND d.generation = r.generation`;
const deviceSelect = `SELECT d.*,
  (SELECT MAX(p.created_at) FROM notification_receipts p WHERE p.device_id=d.id AND p.generation=d.generation AND p.kind='displayed') AS last_displayed_at,
  (SELECT MAX(p.created_at) FROM notification_receipts p WHERE p.device_id=d.id AND p.generation=d.generation AND p.kind='clicked') AS last_clicked_at,
  (SELECT MAX(a.completed_at) FROM notification_attempts a JOIN notification_deliveries r ON r.id=a.delivery_id WHERE r.device_id=d.id AND a.generation=d.generation AND a.outcome='accepted') AS last_success_at,
  (SELECT MAX(a.completed_at) FROM notification_attempts a JOIN notification_deliveries r ON r.id=a.delivery_id WHERE r.device_id=d.id AND a.generation=d.generation AND a.outcome IN ('failed','unknown','expired')) AS last_failure_at,
  (SELECT a.error_code FROM notification_attempts a JOIN notification_deliveries r ON r.id=a.delivery_id WHERE r.device_id=d.id AND a.generation=d.generation AND a.outcome IN ('failed','unknown','expired') ORDER BY a.completed_at DESC,a.id DESC LIMIT 1) AS last_error_code
  FROM notification_devices d`;
/** Cancel device work inside the caller's existing write transaction. */
export async function cancelNotificationDeviceWork(tx: Transaction, deviceId: string, now: string) {
  // Claimed means transport may already be running. Close that attempt without replay.
  await query(tx, `UPDATE notification_attempts SET outcome='unknown',error_code='transport_unknown',completed_at=? WHERE completed_at IS NULL AND delivery_id IN (SELECT id FROM notification_deliveries WHERE device_id=? AND state='claimed')`, [now, deviceId]);
  await query(tx, `UPDATE notification_deliveries SET state='cancelled',updated_at=? WHERE device_id=? AND state IN ('pending','claimed')`, [now, deviceId]);
}
async function revoke(tx: Transaction, deviceId: string, now: string) {
  await query(tx, `UPDATE notification_devices SET revoked_at=COALESCE(revoked_at,?),updated_at=?,subscription_ciphertext=NULL,subscription_fingerprint=NULL,telegram_binding_fingerprint=NULL WHERE id=? AND (revoked_at IS NULL OR subscription_ciphertext IS NOT NULL OR subscription_fingerprint IS NOT NULL OR telegram_binding_fingerprint IS NOT NULL)`, [now, now, deviceId]);
  await cancelNotificationDeviceWork(tx, deviceId, now);
}

export async function enrollNotificationDevice(input: { telegramBindingFingerprint?: string; expectedSetupEpoch?: number; trustedDeviceId: string; origin: string; channel: NotificationDeviceChannel; platform: NotificationPlatform; permission: NotificationPermission; capabilities: NotificationCapabilities; now?: string }): Promise<NotificationDevice> {
  const value = z.object({ telegramBindingFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), expectedSetupEpoch: notificationSetupEpoch.optional(), trustedDeviceId: opaque, origin: originSchema, channel: z.enum(["browser", "telegram"]), platform: z.enum(["windows", "macos", "linux", "android", "ios", "other"]), permission: z.enum(["default", "granted", "denied"]), capabilities: z.object({ foreground: z.boolean(), push: z.boolean() }).strict(), now: timestamp.optional() }).strict().parse(input);
  if (value.channel === "telegram" && (value.capabilities.foreground || value.capabilities.push)) throw new Error("Invalid notification capabilities");
  const now = time(value.now);
  return write(async (tx) => {
    if (value.channel === "browser") await assertNotificationSetupReady(tx, value.origin, value.expectedSetupEpoch);
    if (!(await query(tx, "SELECT id FROM trusted_devices WHERE id=? AND revoked_at IS NULL", [value.trustedDeviceId])).length) throw new Error("Notification enrollment unavailable");
    if (value.telegramBindingFingerprint) {
      if (value.channel !== "telegram" || value.permission !== "granted") throw new Error("Invalid notification binding");
      const current = (await query(tx, `${deviceSelect} WHERE d.channel='telegram' AND d.trusted_device_id=? AND d.origin=? AND d.revoked_at IS NULL AND d.permission='granted' AND d.telegram_binding_fingerprint=?`, [value.trustedDeviceId, value.origin, value.telegramBindingFingerprint]))[0];
      if (current) return device(current);
      const old = await query(tx, "SELECT id FROM notification_devices WHERE channel='telegram' AND telegram_binding_fingerprint=? AND revoked_at IS NULL", [value.telegramBindingFingerprint]);
      for (const row of old) await revoke(tx, String(row.id), now);
    }
    const baseline = Number((await query(tx, "SELECT COALESCE(MAX(sequence),0) AS n FROM notification_events"))[0].n);
    const existing = (await query(tx, "SELECT id FROM notification_devices WHERE trusted_device_id=? AND origin=? AND channel=?", [value.trustedDeviceId, value.origin, value.channel]))[0];
    const id = existing ? String(existing.id) : randomUUID();
    if (existing) await cancelNotificationDeviceWork(tx, id, now);
    await query(tx, `INSERT INTO notification_devices (id,trusted_device_id,origin,channel,platform,permission,foreground,push,generation,baseline_sequence,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(trusted_device_id,origin,channel) DO UPDATE SET platform=excluded.platform,permission=excluded.permission,foreground=excluded.foreground,push=excluded.push,
      generation=notification_devices.generation+1,baseline_sequence=excluded.baseline_sequence,privacy='generic',revoked_at=NULL,subscription_ciphertext=NULL,subscription_fingerprint=NULL,updated_at=excluded.updated_at`,
    [id, value.trustedDeviceId, value.origin, value.channel, value.platform, value.permission, +value.capabilities.foreground, +value.capabilities.push, baseline, now, now]);
    await query(tx, "UPDATE notification_devices SET telegram_binding_fingerprint=? WHERE id=?", [value.telegramBindingFingerprint ?? null, id]);
    return device((await query(tx, `${deviceSelect} WHERE d.id=?`, [id]))[0]);
  });
}
export async function listNotificationDevices(options: { readOnly?: boolean } = {}): Promise<NotificationDevice[]> {
  if (!options.readOnly) await purgeRevokedNotificationDevices({});
  return write(async (tx) => (await query(tx, `${deviceSelect} ORDER BY d.created_at,d.id`)).map(device));
}
export async function revokeNotificationDevice(input: { deviceId: string; now?: string; expectedOwner?: { trustedDeviceId: string; origin: string; generation: number } }): Promise<"removed" | "device_forbidden" | "stale_generation"> {
  const id = opaque.parse(input.deviceId), now = time(input.now);
  return write(async (tx) => {
    if (input.expectedOwner) {
      const owner = input.expectedOwner;
      const row = (await query(tx, "SELECT d.generation FROM notification_devices d JOIN trusted_devices t ON t.id=d.trusted_device_id WHERE d.id=? AND d.trusted_device_id=? AND d.origin=? AND t.revoked_at IS NULL", [id, owner.trustedDeviceId, owner.origin]))[0];
      if (!row) return "device_forbidden";
      if (Number(row.generation) !== owner.generation) return "stale_generation";
    }
    await revoke(tx, id, now);
    return "removed";
  });
}
export async function purgeRevokedNotificationDevices(input: { now?: string }): Promise<number> {
  const now = time(input.now);
  return write(async (tx) => {
    const rows = await query(tx, `SELECT d.id FROM notification_devices d LEFT JOIN trusted_devices t ON t.id=d.trusted_device_id WHERE t.id IS NULL OR t.revoked_at IS NOT NULL OR d.revoked_at IS NOT NULL`);
    for (const row of rows) await revoke(tx, String(row.id), now);
    return rows.length;
  });
}
function target(value: string) {
  const parsed = parseNotificationTarget(value);
  if (!parsed) throw new Error("Invalid notification target");
  return buildNotificationTarget(parsed);
}
export async function createNotificationEvent(input: Parameters<typeof createNotificationEventInTransaction>[1]) {
  return write(tx => createNotificationEventInTransaction(tx, input));
}
export async function createNotificationEventInTransaction(tx: Transaction, input: { sourceKey: string; decisionId?: string; kind: NotificationKind; target: string; origin?: string; replacementTag: string; reasonCode: NotificationReasonCode; createdAt?: string; notBefore?: string; expiresAt: string }): Promise<NotificationEvent> {
  const value = z.object({ sourceKey: opaque, decisionId: opaque.optional(), kind: z.enum(["interrupt", "brief", "checkin", "in_app"]), target: z.string(), origin: originSchema.optional(), replacementTag: opaque, reasonCode: z.enum(notificationReasonCodes), createdAt: timestamp.optional(), notBefore: timestamp.optional(), expiresAt: timestamp }).strict().parse(input);
  const created = time(value.createdAt), due = time(value.notBefore ?? created);
  if (created > due || due >= value.expiresAt) throw new Error("Invalid notification times");
  const href = target(value.target);

  await query(tx, `INSERT INTO notification_events (id,source_key,decision_id,kind,target,origin,replacement_tag,reason_code,created_at,not_before,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO NOTHING`,
    [randomUUID(), value.sourceKey, value.decisionId ?? null, value.kind, href, value.origin ?? null, value.replacementTag, value.reasonCode, created, due, value.expiresAt]);
  return event((await query(tx, "SELECT * FROM notification_events WHERE source_key=?", [value.sourceKey]))[0]);
}
export async function enqueueNotificationDeliveries(input: Parameters<typeof enqueueNotificationDeliveriesInTransaction>[1]) {
  return write(tx => enqueueNotificationDeliveriesInTransaction(tx, input));
}
export async function enqueueNotificationDeliveriesInTransaction(tx: Transaction, input: { eventId: string; now?: string; browserEnabled?: boolean }): Promise<NotificationDelivery[]> {
  const eventId = opaque.parse(input.eventId), now = time(input.now);

  const rows = await query(tx, `SELECT e.*,d.id AS device_id,d.generation,d.origin AS device_origin,d.channel,d.foreground,d.push,d.telegram_binding_fingerprint FROM notification_events e JOIN notification_devices d ON e.sequence>d.baseline_sequence AND (e.origin IS NULL OR e.origin=d.origin) JOIN trusted_devices t ON t.id=d.trusted_device_id WHERE e.id=? AND e.kind<>'in_app' AND e.expires_at>? AND ${liveDevice} AND d.permission='granted' AND (d.channel='telegram' OR (?=1 AND (d.foreground=1 OR d.push=1)))`, [eventId, now, input.browserEnabled !== false && foregroundBrowserNotificationsEnabled() ? 1 : 0]);
  const result: NotificationDelivery[] = [];
  for (const row of rows) {
    if (!isCurrentNotificationEnrollment({ ...row, origin: row.device_origin }, input.browserEnabled !== false)) continue;
    await query(tx, `INSERT INTO notification_deliveries (id,event_id,device_id,generation,state,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?,?) ON CONFLICT(event_id,device_id) DO NOTHING`, [randomUUID(), eventId, row.device_id, row.generation, row.not_before, now, now]);
    result.push(delivery((await query(tx, "SELECT * FROM notification_deliveries WHERE event_id=? AND device_id=?", [eventId, row.device_id]))[0]));
  }
  return result;
}
export async function getNotificationClaimCandidateInTransaction(tx: Transaction, deliveryId: string): Promise<NotificationEvent | null> {
  const row = (await query(tx, `SELECT e.* FROM notification_events e JOIN notification_deliveries d ON d.event_id=e.id WHERE d.id=? AND d.state='pending'`, [opaque.parse(deliveryId)]))[0];
  return row ? event(row) : null;
}
export async function claimNotificationDeliveryInTransaction(tx: Transaction, input: { deliveryId: string; resolvedTarget: string; deviceId?: string; generation?: number; channel: NotificationTransport; foregroundOwner?: { deviceId: string; generation: number; trustedDeviceId: string; origin: string }; now?: string }): Promise<NotificationClaim | null> {
  const id = opaque.parse(input.deliveryId), now = time(input.now), channel = z.enum(["foreground", "push", "telegram"]).parse(input.channel);
  const owner = input.foregroundOwner === undefined ? undefined : z.object({ deviceId: opaque, generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), trustedDeviceId: opaque, origin: originSchema }).strict().parse(input.foregroundOwner);
  if (owner && channel !== "foreground") throw new Error("Invalid notification claim");
  const resolved = target(input.resolvedTarget);
  const current = (await query(tx, "SELECT d.* FROM notification_deliveries r JOIN notification_devices d ON d.id=r.device_id WHERE r.id=?", [id]))[0];
  if (!current || !isCurrentNotificationEnrollment(current)) return null;
  const rows = await query(tx, `UPDATE notification_deliveries SET state='claimed',attempt_count=attempt_count+1,updated_at=? WHERE id=? AND state='pending' AND attempt_count<3 AND next_attempt_at<=? AND EXISTS (
    SELECT 1 FROM notification_devices d JOIN trusted_devices t ON t.id=d.trusted_device_id JOIN notification_events e ON e.id=notification_deliveries.event_id
    WHERE (? IS NULL OR (d.id=? AND d.generation=?)) AND d.id=notification_deliveries.device_id AND d.generation=notification_deliveries.generation AND ${liveDevice} AND d.permission='granted' AND e.kind<>'in_app' AND e.sequence>d.baseline_sequence AND (e.origin IS NULL OR e.origin=d.origin) AND e.not_before<=? AND e.expires_at>?
    AND (?=0 OR (d.id=? AND d.generation=? AND d.trusted_device_id=? AND d.origin=? AND d.push=0))
    AND ((?='telegram' AND d.channel='telegram') OR (d.channel='browser' AND ((?='foreground' AND d.foreground=1) OR (?='push' AND d.push=1))))) RETURNING *`, [now, id, now, input.deviceId ?? null, input.deviceId ?? null, input.generation ?? null, now, now, owner ? 1 : 0, owner?.deviceId ?? "", owner?.generation ?? 0, owner?.trustedDeviceId ?? "", owner?.origin ?? "", channel, channel, channel]);
  if (!rows.length) return null;
  const reserved = delivery(rows[0]);
  const attemptId = randomUUID();
  const attempts = await query(tx, `INSERT INTO notification_attempts (id,delivery_id,channel,generation,started_at,resolved_target) VALUES (?,?,?,?,?,?) RETURNING *`, [attemptId, id, channel, reserved.generation, now, resolved]);
  const dev = (await query(tx, `${deviceSelect} WHERE d.id=?`, [reserved.deviceId]))[0];
  return { delivery: reserved, attempt: attempt(attempts[0]), device: { ...device(dev), subscriptionCiphertext: nullable(dev.subscription_ciphertext), subscriptionFingerprint: nullable(dev.subscription_fingerprint) }, event: event((await query(tx, "SELECT * FROM notification_events WHERE id=?", [reserved.eventId]))[0]) };
}
export async function finishNotificationAttempt(input: { attemptId: string; outcome: NotificationAttemptOutcome; errorCode?: NotificationErrorCode; externalId?: string; retryAt?: string; expectedPushSubscriptionCiphertext?: string; now?: string }): Promise<NotificationDelivery | null> {
  const value = z.object({ attemptId: opaque, outcome: z.enum(["accepted", "failed", "expired", "unknown"]), errorCode: z.enum(notificationErrorCodes).optional(), externalId: opaque.max(128).optional(), retryAt: timestamp.optional(), expectedPushSubscriptionCiphertext: z.string().min(1).max(16384).optional(), now: timestamp.optional() }).strict().parse(input);
  const now = time(value.now);
  if (value.retryAt && (value.outcome !== "failed" || !["rejected", "rate_limited", "unavailable"].includes(value.errorCode ?? "") || Date.parse(value.retryAt) - Date.parse(now) < 1000 || Date.parse(value.retryAt) - Date.parse(now) > 900_000)) throw new Error("Invalid notification retry");
  return write(async (tx) => {
    const row = (await query(tx, `SELECT r.*,e.expires_at,a.started_at,d.subscription_ciphertext FROM notification_attempts a JOIN notification_deliveries r ON r.id=a.delivery_id JOIN notification_devices d ON d.id=r.device_id JOIN trusted_devices t ON t.id=d.trusted_device_id JOIN notification_events e ON e.id=r.event_id WHERE a.id=? AND a.completed_at IS NULL AND r.state='claimed' AND a.generation=r.generation AND ${liveDelivery}`, [value.attemptId]))[0];
    if (!row || now < String(row.started_at)) return null;
    // Once a send may have been accepted, expiry cannot reclassify it as safe to retry.
    const retry = value.retryAt && (value.expectedPushSubscriptionCiphertext === undefined || row.subscription_ciphertext === value.expectedPushSubscriptionCiphertext) && Number(row.attempt_count) < 3 && value.retryAt < String(row.expires_at);
    const state = value.outcome === "failed" && value.retryAt ? (String(row.expires_at) <= now || value.retryAt >= String(row.expires_at) ? "expired" : retry ? "pending" : "failed") : value.outcome;
    await query(tx, `UPDATE notification_attempts SET outcome=?,error_code=?,external_id=?,completed_at=? WHERE id=?`, [value.outcome, value.errorCode ?? null, value.externalId ?? null, now, value.attemptId]);
    return delivery((await query(tx, `UPDATE notification_deliveries SET state=?,next_attempt_at=?,updated_at=? WHERE id=? RETURNING *`, [state, retry ? value.retryAt! : row.next_attempt_at, now, row.id]))[0]);
  });
}
export async function recoverNotificationAttempts(input: { now?: string }): Promise<void> {
  const now = time(input.now), cutoff = new Date(Date.parse(now) - 120_000).toISOString();
  await purgeRevokedNotificationDevices({ now });
  await write(async (tx) => {
    const stuck = await query(tx, `SELECT a.id,a.delivery_id FROM notification_attempts a JOIN notification_deliveries r ON r.id=a.delivery_id WHERE a.completed_at IS NULL AND r.state='claimed' AND a.started_at<?`, [cutoff]);
    for (const row of stuck) {
      await query(tx, "UPDATE notification_attempts SET outcome='unknown',error_code='timeout',completed_at=? WHERE id=?", [now, row.id]);
      await query(tx, "UPDATE notification_deliveries SET state='unknown',updated_at=? WHERE id=?", [now, row.delivery_id]);
    }
    await query(tx, `UPDATE notification_deliveries SET state='expired',updated_at=? WHERE state='pending' AND event_id IN (SELECT id FROM notification_events WHERE expires_at<=?)`, [now, now]);
  });
}
export async function recordNotificationReceipt(input: { deviceId: string; attemptId: string; generation: number; kind: NotificationReceipt["kind"]; now?: string }): Promise<NotificationReceipt | null> {
  const value = z.object({ deviceId: opaque, attemptId: opaque, generation: z.number().int().positive(), kind: z.enum(["displayed", "clicked"]), now: timestamp.optional() }).strict().parse(input);
  const now = time(value.now);
  return write(async (tx) => {
    const owner = (await query(tx, `SELECT r.id FROM notification_attempts a JOIN notification_deliveries r ON r.id=a.delivery_id JOIN notification_devices d ON d.id=r.device_id JOIN trusted_devices t ON t.id=d.trusted_device_id WHERE a.id=? AND d.id=? AND a.generation=? AND a.generation=r.generation AND a.outcome='accepted' AND a.completed_at<=? AND r.state IN ('accepted','displayed','clicked') AND ${liveDelivery}`, [value.attemptId, value.deviceId, value.generation, now]))[0];
    if (!owner) return null;
    return insertReceipt(tx, String(owner.id), value, now);
  });
}
async function insertReceipt(tx: Transaction, deliveryId: string, value: { deviceId: string; attemptId: string; generation: number; kind: NotificationReceipt["kind"] }, now: string): Promise<NotificationReceipt> {
  await query(tx, `INSERT INTO notification_receipts (id,attempt_id,device_id,generation,kind,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(attempt_id,device_id,generation,kind) DO NOTHING`, [randomUUID(), value.attemptId, value.deviceId, value.generation, value.kind, now]);
  await query(tx, `UPDATE notification_deliveries SET state=?,updated_at=? WHERE id=? AND (state='accepted' OR (state='displayed' AND ?='clicked'))`, [value.kind, now, deliveryId, value.kind]);
  const row = (await query(tx, "SELECT * FROM notification_receipts WHERE attempt_id=? AND device_id=? AND generation=? AND kind=?", [value.attemptId, value.deviceId, value.generation, value.kind]))[0];
  return { id: String(row.id), attemptId: String(row.attempt_id), deviceId: String(row.device_id), generation: Number(row.generation), kind: row.kind as NotificationReceipt["kind"], createdAt: String(row.created_at) };
}
/** Browser reports may beat the relay response; validate ownership before any transition. */
export async function recordBrowserNotificationReceipt(input: { deviceId: string; trustedDeviceId: string; origin: string; attemptId: string; generation: number; kind: "foreground_shown" | "foreground_failed" | "displayed" | "clicked"; now?: string }): Promise<boolean> {
  const value = z.object({ deviceId: opaque, trustedDeviceId: opaque, origin: originSchema, attemptId: opaque, generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), kind: z.enum(["foreground_shown", "foreground_failed", "displayed", "clicked"]), now: timestamp.optional() }).strict().parse(input);
  const now = time(value.now);
  return write(async (tx) => {
    const row = (await query(tx, `SELECT r.id,r.state,a.channel,a.outcome,a.completed_at,e.expires_at FROM notification_attempts a
      JOIN notification_deliveries r ON r.id=a.delivery_id JOIN notification_devices d ON d.id=r.device_id
      JOIN trusted_devices t ON t.id=d.trusted_device_id JOIN notification_events e ON e.id=r.event_id
      WHERE a.id=? AND d.id=? AND d.trusted_device_id=? AND d.origin=? AND d.channel='browser'
      AND a.generation=? AND a.generation=r.generation AND a.started_at<=? AND ${liveDelivery}`,
    [value.attemptId, value.deviceId, value.trustedDeviceId, value.origin, value.generation, now]))[0];
    if (!row) return false;
    const foreground = value.kind === "foreground_shown" || value.kind === "foreground_failed";
    if (foreground && row.channel !== "foreground") return false;
    const claimed = row.state === "claimed" && row.outcome === null && row.completed_at === null;
    const accepted = ["accepted", "displayed", "clicked"].includes(String(row.state)) && row.outcome === "accepted" && row.completed_at !== null && String(row.completed_at) <= now;
    if (value.kind === "foreground_failed") {
      if (!claimed || String(row.expires_at) <= now) return false;
      await query(tx, "UPDATE notification_attempts SET outcome='failed',error_code='unavailable',completed_at=? WHERE id=?", [now, value.attemptId]);
      await query(tx, "UPDATE notification_deliveries SET state='failed',updated_at=? WHERE id=?", [now, row.id]);
      return true;
    }
    if (claimed) {
      if (String(row.expires_at) <= now || (!foreground && row.channel !== "push")) return false;
      await query(tx, "UPDATE notification_attempts SET outcome='accepted',completed_at=? WHERE id=?", [now, value.attemptId]);
      await query(tx, "UPDATE notification_deliveries SET state='accepted',updated_at=? WHERE id=?", [now, row.id]);
    } else if (!accepted || !["foreground", "push"].includes(String(row.channel))) return false;
    await insertReceipt(tx, String(row.id), { ...value, kind: value.kind === "foreground_shown" ? "displayed" : value.kind }, now);
    return true;
  });
}
export async function recordNotificationFeedback(input: Parameters<typeof recordNotificationFeedbackInTransaction>[1]): Promise<NotificationFeedback | null> {
  return write(tx => recordNotificationFeedbackInTransaction(tx, input));
}
/** Reuses the caller's write transaction; never nest another store write. */
export async function recordNotificationFeedbackInTransaction(tx: Transaction, input: { deviceId: string; eventId: string; kind: NotificationFeedback["kind"]; now?: string }): Promise<NotificationFeedback | null> {
  const value = z.object({ deviceId: opaque, eventId: opaque, kind: z.enum(["useful", "too_noisy"]), now: timestamp.optional() }).strict().parse(input);
  const now = time(value.now);
  if (!(await query(tx, `SELECT r.id FROM notification_deliveries r JOIN notification_devices d ON d.id=r.device_id JOIN trusted_devices t ON t.id=d.trusted_device_id WHERE r.device_id=? AND r.event_id=? AND ${liveDelivery}`, [value.deviceId, value.eventId])).length) return null;
  await query(tx, `INSERT INTO notification_feedback (device_id,event_id,kind,created_at) VALUES (?,?,?,?) ON CONFLICT(device_id,event_id) DO UPDATE SET kind=excluded.kind,created_at=excluded.created_at`, [value.deviceId, value.eventId, value.kind, now]);
  return { deviceId: value.deviceId, eventId: value.eventId, kind: value.kind, createdAt: now };
}
