import { isCurrentNotificationOrigin } from "./notification-origin";
import { disableTelegramBindingIfCurrent, getActiveTelegramBinding, readTelegramConfiguration, sendTelegramMessage, telegramNotificationMessage, type TelegramBinding, type TelegramNetwork } from "./notification-telegram";
import type { Transaction } from "@libsql/client";
import { execute } from "./database";
import { foregroundBrowserNotificationsEnabled } from "./foreground-notifications";
import { claimGovernedNotification } from "./notification-claims";
import { resolveNotificationEventForClaim } from "./notification-governor";
import { openPushSubscription, pushSubscriptionRevision, readPushConfiguration, type PushConfiguration } from "./notification-crypto";
import { cleanupExpiredPushSubscriptions, clearPushSubscriptionIfCurrent, getPushSubscriptionForDelivery, type PushSubscriptionForDelivery } from "./notification-subscriptions";
import { finishNotificationAttempt, recoverNotificationAttempts, withNotificationStoreWrite } from "./notification-store";
import { createPushRequest, sendPushRequest, type PushNetwork, type PushPayload } from "./notification-web-push";
import { parseNotificationTarget } from "./notification-target";
import type { NotificationClaim, NotificationReasonCode } from "./notification-types";

export type DispatchOptions = { now?: string; network?: PushNetwork; telegramNetwork?: TelegramNetwork };
function time(options: DispatchOptions) { return options.now ?? new Date().toISOString(); }
function text(value: unknown, length: number) { return String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, length); }
async function payloadFor(claim: NotificationClaim): Promise<PushPayload> {
  const target = claim.attempt.resolvedTarget;
  if (!target || claim.event.kind === "in_app") throw new Error("Notification unavailable");
  const parsed = parseNotificationTarget(target);
  if (!parsed) throw new Error("Notification unavailable");
  let title = "Ezra Mail", body = claim.event.kind === "checkin" ? "Open Ezra Mail for your daily check-in." : claim.event.kind === "brief" ? "Your brief is ready in Ezra Mail." : "Open Ezra Mail to review new attention.";
  if (claim.device.privacy === "detailed" && parsed.view === "mail") {
    const row = (await execute("SELECT m.sender_name,m.subject FROM email_messages m JOIN email_accounts a ON a.id=m.account_id WHERE m.id=? AND a.id=? AND a.provider=? AND a.status='connected'", [parsed.messageId, parsed.accountId, parsed.provider])).rows[0];
    if (row) { title = text(row.sender_name, 80) || title; body = text(row.subject, 140) || body; }
  }
  return { version: 1, eventId: claim.event.id, attemptId: claim.attempt.id, deviceId: claim.device.id, generation: claim.attempt.generation, kind: claim.event.kind, title, body, target, tag: claim.event.replacementTag, expiresAt: claim.event.expiresAt };
}
async function cancelUnsent(tx: Transaction, claim: NotificationClaim, now: string, reason: NotificationReasonCode) {
  const changed = await tx.execute({ sql: "UPDATE notification_deliveries SET state='cancelled',cancellation_reason=?,updated_at=? WHERE id=? AND generation=? AND state='claimed' AND EXISTS (SELECT 1 FROM notification_attempts WHERE id=? AND delivery_id=notification_deliveries.id AND completed_at IS NULL) RETURNING id", args: [reason, now, claim.delivery.id, claim.attempt.generation, claim.attempt.id] });
  if (changed.rows.length) await tx.execute({ sql: "UPDATE notification_attempts SET outcome='failed',error_code='rejected',completed_at=? WHERE id=? AND completed_at IS NULL", args: [now, claim.attempt.id] });
}
/** The committed final check is the authorization boundary. No network work in
 * this transaction. A later revocation cannot retract bytes already released. */
async function authorizePush(claim: NotificationClaim, captured: PushSubscriptionForDelivery, configuration: PushConfiguration, clock: () => string): Promise<boolean> {
  return withNotificationStoreWrite(async tx => {
    const now = clock();
    const row = (await tx.execute({ sql: `SELECT d.* FROM notification_attempts a JOIN notification_deliveries r ON r.id=a.delivery_id
      JOIN notification_devices d ON d.id=r.device_id JOIN trusted_devices t ON t.id=d.trusted_device_id JOIN notification_events e ON e.id=r.event_id
      WHERE a.id=? AND a.delivery_id=? AND a.channel='push' AND a.completed_at IS NULL AND a.resolved_target=? AND r.state='claimed'
      AND a.generation=? AND r.generation=a.generation AND d.generation=a.generation AND d.id=? AND d.channel='browser'
      AND d.revoked_at IS NULL AND t.revoked_at IS NULL AND d.permission='granted' AND d.push=1
      AND e.sequence>d.baseline_sequence AND e.not_before<=? AND e.expires_at>? AND (e.origin IS NULL OR e.origin=d.origin)`, args: [claim.attempt.id, claim.delivery.id, claim.attempt.resolvedTarget!, claim.attempt.generation, claim.device.id, now, now] })).rows[0];
    let current = false;
    try {
      const config = readPushConfiguration();
      current = !!row && isCurrentNotificationOrigin(claim.device.origin) && foregroundBrowserNotificationsEnabled() && !!config && config.vapidKeyFingerprint === configuration.vapidKeyFingerprint
        && row.subscription_ciphertext === captured.subscriptionCiphertext && pushSubscriptionRevision(captured.subscriptionCiphertext) === captured.subscriptionRevision
        && row.privacy === claim.device.privacy && row.trusted_device_id === claim.device.trustedDeviceId && row.origin === claim.device.origin;
      if (current) {
        const opened = openPushSubscription(captured.subscriptionCiphertext, { deviceId: claim.device.id, generation: claim.attempt.generation, origin: claim.device.origin }, config!);
        current = opened.expiresAt > Date.parse(now);
      }
    } catch { current = false; }
    if (!current) { await cancelUnsent(tx, claim, now, "stale"); return false; }
    const resolved = await resolveNotificationEventForClaim(tx, { event: claim.event, now });
    // The claimed target is immutable. A newly selected member must not inherit
    // this attempt's copy/routing authorization, even if the group survives.
    if (!resolved.target || resolved.target !== claim.attempt.resolvedTarget) {
      await cancelUnsent(tx, claim, now, resolved.reasonCode || "stale"); return false;
    }
    return true;
  });
}
async function dispatchPushDelivery(deliveryId: string, options: DispatchOptions = {}): Promise<void> {
  if (!foregroundBrowserNotificationsEnabled() || !/^[A-Za-z0-9_-]{1,200}$/.test(deliveryId)) return;
  const configuration = readPushConfiguration(); if (!configuration) return;
  const row = (await execute("SELECT device_id,generation FROM notification_deliveries WHERE id=? AND state='pending'", [deliveryId])).rows[0];
  if (!row) return;
  const claim = await claimGovernedNotification({ deliveryId, deviceId: String(row.device_id), generation: Number(row.generation), channel: "push", now: time(options) });
  if (!claim) return;
  let captured: PushSubscriptionForDelivery;
  let payload: PushPayload;
  try {
    captured = await getPushSubscriptionForDelivery({ deviceId: claim.device.id, generation: claim.attempt.generation, now: time(options) });
    payload = await payloadFor(claim);
  } catch {
    await withNotificationStoreWrite(tx => cancelUnsent(tx, claim, time(options), "stale")); return;
  }
  if (!await authorizePush(claim, captured, configuration, () => time(options))) return;
  let request: ReturnType<typeof createPushRequest>;
  try { request = createPushRequest({ subscription: captured.subscription, configuration, payload, now: time(options) }); }
  catch { await withNotificationStoreWrite(tx => cancelUnsent(tx, claim, time(options), "stale")); return; }
  const result = await sendPushRequest(request, options.network, options.now);
  const now = time(options);
  // Bound backoff relative to completion too, after a slow known refusal.
  if (result.retryAt) result.retryAt = new Date(Math.max(Date.parse(now) + 30_000, Math.min(Date.parse(now) + 900_000, Date.parse(result.retryAt)))).toISOString();
  const finished = await finishNotificationAttempt({ attemptId: claim.attempt.id, ...result, expectedPushSubscriptionCiphertext: captured.subscriptionCiphertext, now });
  if (finished?.state === "expired" && result.outcome === "expired") await clearPushSubscriptionIfCurrent({ deviceId: claim.device.id, generation: claim.attempt.generation, subscriptionCiphertext: captured.subscriptionCiphertext, subscriptionRevision: captured.subscriptionRevision, now });
}
async function authorizeTelegram(claim: NotificationClaim, binding: TelegramBinding, clock: () => string) {
  return withNotificationStoreWrite(async tx => {
    const now = clock();
    const row = (await tx.execute({ sql: `SELECT d.id FROM notification_attempts a JOIN notification_deliveries r ON r.id=a.delivery_id
      JOIN notification_devices d ON d.id=r.device_id JOIN trusted_devices t ON t.id=d.trusted_device_id JOIN notification_events e ON e.id=r.event_id
      WHERE a.id=? AND a.delivery_id=? AND a.channel='telegram' AND a.completed_at IS NULL AND a.resolved_target=? AND r.state='claimed'
      AND a.generation=? AND r.generation=a.generation AND d.generation=a.generation AND d.id=? AND d.channel='telegram'
      AND d.revoked_at IS NULL AND t.revoked_at IS NULL AND d.permission='granted' AND d.telegram_binding_fingerprint=?
      AND d.trusted_device_id=? AND d.origin=? AND d.privacy=?
      AND e.sequence>d.baseline_sequence AND e.not_before<=? AND e.expires_at>? AND (e.origin IS NULL OR e.origin=d.origin)`,
      args:[claim.attempt.id,claim.delivery.id,claim.attempt.resolvedTarget!,binding.generation,binding.deviceId,binding.fingerprint,binding.trustedDeviceId,binding.origin,claim.device.privacy,now,now] })).rows[0];
    if (!row || !isCurrentNotificationOrigin(binding.origin) || readTelegramConfiguration()?.fingerprint !== binding.fingerprint) { await cancelUnsent(tx,claim,now,"stale"); return false; }
    const resolved = await resolveNotificationEventForClaim(tx,{event:claim.event,now});
    if (!resolved.target || resolved.target !== claim.attempt.resolvedTarget) { await cancelUnsent(tx,claim,now,resolved.reasonCode||"stale"); return false; }
    return true;
  });
}
async function dispatchTelegramDelivery(deliveryId: string, options: DispatchOptions) {
  const row=(await execute("SELECT device_id,generation FROM notification_deliveries WHERE id=? AND state='pending'",[deliveryId])).rows[0];
  if(!row)return;
  const binding=await getActiveTelegramBinding(String(row.device_id)), configuration=readTelegramConfiguration();
  if(!binding||!configuration||binding.fingerprint!==configuration.fingerprint||binding.generation!==Number(row.generation))return;
  const claim=await claimGovernedNotification({deliveryId,deviceId:binding.deviceId,generation:binding.generation,channel:"telegram",now:time(options)});
  if(!claim)return;
  let message: ReturnType<typeof telegramNotificationMessage>, existingId: string|undefined;
  try {
    message=telegramNotificationMessage(await payloadFor(claim),binding.origin);
    const previous=(await execute(`SELECT a.external_id FROM notification_attempts a JOIN notification_deliveries r ON r.id=a.delivery_id
      JOIN notification_events e ON e.id=r.event_id WHERE r.device_id=? AND a.generation=? AND a.channel='telegram'
      AND a.outcome='accepted' AND a.external_id IS NOT NULL AND e.replacement_tag=? AND a.completed_at>=? AND a.completed_at<=?
      ORDER BY a.completed_at DESC,a.id DESC LIMIT 1`,[binding.deviceId,binding.generation,claim.event.replacementTag,new Date(Date.parse(time(options))-3600000).toISOString(),time(options)])).rows[0];
    if(previous && /^[1-9]\d{0,15}$/.test(String(previous.external_id)))existingId=String(previous.external_id);
  }catch{await withNotificationStoreWrite(tx=>cancelUnsent(tx,claim,time(options),"stale"));return;}
  if(!await authorizeTelegram(claim,binding,()=>time(options)))return;
  let result=await sendTelegramMessage(configuration,message,options.telegramNetwork,{existingId,now:options.now});
  if(result.editRefused && await authorizeTelegram(claim,binding,()=>time(options))) result=await sendTelegramMessage(configuration,message,options.telegramNetwork,{now:options.now});
  const now=time(options);
  // A changed configuration cannot inherit a delayed retry; re-enrollment owns rotation.
  const current=readTelegramConfiguration()?.fingerprint===binding.fingerprint;
  if(result.retryAt)result.retryAt=current?new Date(Math.max(Date.parse(now)+30000,Math.min(Date.parse(now)+900000,Date.parse(result.retryAt)))).toISOString():undefined;
  await finishNotificationAttempt({attemptId:claim.attempt.id,outcome:result.outcome,errorCode:result.errorCode,externalId:result.externalId,retryAt:result.retryAt,now});
  if(result.blocked)await disableTelegramBindingIfCurrent(binding,now);
}
export async function dispatchNotificationDelivery(deliveryId: string, options: DispatchOptions = {}): Promise<void> {
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(deliveryId))return;
  const row=(await execute("SELECT d.channel FROM notification_deliveries r JOIN notification_devices d ON d.id=r.device_id WHERE r.id=?",[deliveryId])).rows[0];
  if(row?.channel==="telegram")await dispatchTelegramDelivery(deliveryId,options);
  else if(row?.channel==="browser")await dispatchPushDelivery(deliveryId,options);
}
let activeDrain: Promise<void> | undefined;
/** Process-local single flight plus durable per-reservation claims. Foreground-only
 * reservations are not consumed; browser and Telegram share this bounded lane. */
export function drainPushNotifications(options: DispatchOptions = {}): Promise<void> {
  if (activeDrain) return activeDrain;
  activeDrain = (async () => {
    const now = time(options);
    await recoverNotificationAttempts({ now });
    await cleanupExpiredPushSubscriptions({ now });
    const pushEnabled=foregroundBrowserNotificationsEnabled() && !!readPushConfiguration();
    const telegramBinding=await getActiveTelegramBinding();
    if (!pushEnabled && !telegramBinding) return;
    const candidates = (await execute(`SELECT r.id FROM notification_deliveries r JOIN notification_devices d ON d.id=r.device_id
      JOIN trusted_devices t ON t.id=d.trusted_device_id JOIN notification_events e ON e.id=r.event_id
      WHERE r.state='pending' AND r.attempt_count<3 AND r.next_attempt_at<=? AND e.not_before<=? AND e.expires_at>?
      AND ((?=1 AND d.channel='browser' AND d.push=1) OR (d.channel='telegram' AND d.id=? AND d.telegram_binding_fingerprint=?)) AND d.permission='granted' AND d.revoked_at IS NULL AND t.revoked_at IS NULL
      AND d.generation=r.generation ORDER BY e.sequence,r.id LIMIT 10`, [now, now, now, +pushEnabled, telegramBinding?.deviceId ?? "", telegramBinding?.fingerprint ?? ""])).rows;
    let cursor = 0;
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (cursor < candidates.length) {
        const row = candidates[cursor++];
        // A failed completion may be ambiguous; leave recovery to mark it unknown.
        try { await dispatchNotificationDelivery(String(row.id), options); } catch { /* No upstream error is logged or replayed. */ }
      }
    }));
  })().finally(() => { activeDrain = undefined; });
  return activeDrain;
}
