import { assertNotificationSetupReady, NotificationSetupError } from "./notification-setup-schema";
import type { InValue, Row, Transaction } from "@libsql/client";
import { withNotificationStoreWrite, purgeRevokedNotificationDevices } from "./notification-store";
import { openPushSubscription, sealPushSubscription, validatePushSubscription, pushEndpointFingerprint, pushSubscriptionFingerprint, pushSubscriptionRevision, readPushConfiguration, PushSubscriptionError } from "./notification-crypto";
import type { PushBinding, PushConfiguration, OpenedPushSubscription } from "./notification-crypto";
import type { NotificationPushSubscriptionStatus } from "./notification-types";

type DeviceReference = { deviceId: string; generation: number; now?: string };
type OwnedDeviceReference = DeviceReference & { trustedDeviceId: string; origin: string };
export type PushSubscriptionIdentity = DeviceReference & { subscriptionCiphertext: string; subscriptionRevision: string };
/** Internal transport data; never return this object through an API. */
export interface PushSubscriptionForDelivery {
  subscription: OpenedPushSubscription["subscription"];
  subscriptionCiphertext: string;
  subscriptionRevision: string;
  expiresAt: string;
}
function fail(code: ConstructorParameters<typeof PushSubscriptionError>[0]): never { throw new PushSubscriptionError(code); }
function timestamp(now?: string) {
  const value = now ?? new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail("invalid_subscription");
  return new Date(value).toISOString();
}
function reference(input: DeviceReference, owned?: OwnedDeviceReference) {
  if (typeof input.deviceId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(input.deviceId) || !Number.isSafeInteger(input.generation) || input.generation < 1) fail("device_unavailable");
  if (owned && (typeof owned.trustedDeviceId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(owned.trustedDeviceId) || typeof owned.origin !== "string" || owned.origin.length > 300)) fail("device_unavailable");
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { if (error instanceof PushSubscriptionError || error instanceof NotificationSetupError) throw error; return fail("device_unavailable"); }
}
async function rows(tx: Transaction, sql: string, args: InValue[] = []) { return (await tx.execute({ sql, args })).rows; }
const live = "d.channel='browser' AND d.revoked_at IS NULL AND t.revoked_at IS NULL";
async function findDevice(tx: Transaction, input: DeviceReference, owner?: OwnedDeviceReference): Promise<Row> {
  const found = await rows(tx, "SELECT d.* FROM notification_devices d JOIN trusted_devices t ON t.id=d.trusted_device_id WHERE d.id=? AND d.generation=? AND " + live + (owner ? " AND d.trusted_device_id=? AND d.origin=?" : ""), [input.deviceId, input.generation, ...(owner ? [owner.trustedDeviceId, owner.origin] : [])]);
  if (!found.length) fail("device_unavailable");
  return found[0];
}
function binding(row: Row): PushBinding { return { deviceId: String(row.id), origin: String(row.origin), generation: Number(row.generation) }; }
function status(opened?: OpenedPushSubscription): NotificationPushSubscriptionStatus {
  return { subscribed: !!opened, expiresAt: opened ? new Date(opened.expiresAt).toISOString() : null, reenrollmentRequired: false, reason: opened ? "subscribed" : "not_subscribed" };
}
function configured() { const config = readPushConfiguration(); if (!config) fail("configuration_unavailable"); return config; }
async function cancelPush(tx: Transaction, deviceId: string, now: string) {
  // Preserve foreground work. An in-flight push is ambiguous and must never replay.
  await rows(tx, "UPDATE notification_deliveries SET state='cancelled',updated_at=? WHERE device_id=? AND state='claimed' AND id IN (SELECT delivery_id FROM notification_attempts WHERE channel='push' AND completed_at IS NULL)", [now, deviceId]);
  await rows(tx, "UPDATE notification_attempts SET outcome='unknown',error_code='transport_unknown',completed_at=? WHERE channel='push' AND completed_at IS NULL AND delivery_id IN (SELECT id FROM notification_deliveries WHERE device_id=? AND state='cancelled')", [now, deviceId]);
  await rows(tx, "UPDATE notification_deliveries SET state='cancelled',updated_at=? WHERE device_id=? AND state='pending' AND EXISTS (SELECT 1 FROM notification_devices WHERE id=? AND foreground=0)", [now, deviceId, deviceId]);
}
async function clearCurrent(tx: Transaction, input: PushSubscriptionIdentity, now: string) {
  if (pushSubscriptionRevision(input.subscriptionCiphertext) !== input.subscriptionRevision) return false;
  const changed = await rows(tx, "UPDATE notification_devices SET subscription_ciphertext=NULL,subscription_fingerprint=NULL,push=0,updated_at=? WHERE id=? AND generation=? AND subscription_ciphertext=? RETURNING id", [now, input.deviceId, input.generation, input.subscriptionCiphertext]);
  if (!changed.length) return false;
  await cancelPush(tx, input.deviceId, now);
  return true;
}
function identity(row: Row): PushSubscriptionIdentity { const ciphertext = String(row.subscription_ciphertext); return { deviceId: String(row.id), generation: Number(row.generation), subscriptionCiphertext: ciphertext, subscriptionRevision: pushSubscriptionRevision(ciphertext) }; }

export async function attachPushSubscription(input: OwnedDeviceReference & { expectedSetupEpoch: number; subscription: unknown; expectedVapidKeyFingerprint: string }): Promise<NotificationPushSubscriptionStatus> {
  return safe(async () => {
    reference(input, input);
    const now = timestamp(input.now), subscription = validatePushSubscription(input.subscription, Date.parse(now));
    return withNotificationStoreWrite(async (tx) => {
      // Browser JSON omits applicationServerKey. Bind explicit registration to the
      // public identity the browser used, rechecking after transaction acquisition.
      await assertNotificationSetupReady(tx, input.origin, input.expectedSetupEpoch);
      const config = configured();
      if (input.expectedVapidKeyFingerprint !== config.vapidKeyFingerprint) fail("reenrollment_required");
      const row = await findDevice(tx, input, input);
      if (row.permission !== "granted") fail("device_unavailable");
      const endpointFingerprint = pushEndpointFingerprint(subscription);
      if ((await rows(tx, "SELECT id FROM notification_devices WHERE channel='browser' AND revoked_at IS NULL AND subscription_fingerprint=? AND id<>?", [endpointFingerprint, input.deviceId])).length) fail("endpoint_in_use");
      if (row.subscription_ciphertext && row.push === 1) {
        try {
          const existing = openPushSubscription(String(row.subscription_ciphertext), binding(row), config);
          if (existing.expiresAt > Date.parse(now) && existing.subscription.expirationTime === subscription.expirationTime && pushSubscriptionFingerprint(existing.subscription) === pushSubscriptionFingerprint(subscription)) return status(existing);
        } catch { /* Explicit registration may replace an unreadable or obsolete subscription. */ }
      }
      const ciphertext = sealPushSubscription({ ...binding(row), subscription, registeredAt: Date.parse(now) }, config);
      const changed = await rows(tx, "UPDATE notification_devices SET subscription_ciphertext=?,subscription_fingerprint=?,push=1,updated_at=? WHERE id=? AND trusted_device_id=? AND origin=? AND generation=? AND channel='browser' AND permission='granted' AND revoked_at IS NULL AND subscription_ciphertext IS ? AND EXISTS (SELECT 1 FROM trusted_devices WHERE id=notification_devices.trusted_device_id AND revoked_at IS NULL) RETURNING id", [ciphertext, endpointFingerprint, now, input.deviceId, input.trustedDeviceId, input.origin, input.generation, row.subscription_ciphertext]);
      if (!changed.length) fail("device_unavailable");
      return status(openPushSubscription(ciphertext, binding(row), config));
    });
  });
}

export async function getPushSubscriptionForDelivery(input: DeviceReference): Promise<PushSubscriptionForDelivery> {
  return safe(async () => {
    reference(input);
    const now = timestamp(input.now);
    const result = await withNotificationStoreWrite(async (tx) => {
      const config = configured();
      const row = await findDevice(tx, input);
      if (row.permission !== "granted" || row.push !== 1 || !row.subscription_ciphertext) fail("device_unavailable");
      const captured = identity(row), opened = openPushSubscription(captured.subscriptionCiphertext, binding(row), config);
      if (opened.expiresAt <= Date.parse(now)) {
        await clearCurrent(tx, captured, now);
        // Return the error until COMMIT so the scrub is not rolled back.
        return new PushSubscriptionError("subscription_expired");
      }
      let ciphertext = captured.subscriptionCiphertext;
      if (opened.keyId !== config.keyId) {
        ciphertext = sealPushSubscription({ ...binding(row), subscription: opened.subscription, registeredAt: opened.registeredAt }, config);
        const changed = await rows(tx, "UPDATE notification_devices SET subscription_ciphertext=? WHERE id=? AND generation=? AND subscription_ciphertext=? AND revoked_at IS NULL AND permission='granted' AND push=1 AND EXISTS (SELECT 1 FROM trusted_devices WHERE id=notification_devices.trusted_device_id AND revoked_at IS NULL) RETURNING id", [ciphertext, input.deviceId, input.generation, captured.subscriptionCiphertext]);
        if (!changed.length) fail("subscription_changed");
      }
      return { subscription: opened.subscription, subscriptionCiphertext: ciphertext, subscriptionRevision: pushSubscriptionRevision(ciphertext), expiresAt: new Date(opened.expiresAt).toISOString() };
    });
    if (result instanceof PushSubscriptionError) throw result;
    return result;
  });
}

export async function getPushSubscriptionStatus(input: OwnedDeviceReference): Promise<NotificationPushSubscriptionStatus> {
  return safe(async () => {
    reference(input, input);
    const now = timestamp(input.now);
    return withNotificationStoreWrite(async (tx) => {
      const config = readPushConfiguration();
      const row = await findDevice(tx, input, input);
      if (!config) return { ...status(), reason: "configuration_unavailable" };
      if (!row.subscription_ciphertext) return status();
      if (row.permission !== "granted" || row.push !== 1) return { ...status(), reason: "device_unavailable" };
      try {
        const opened = openPushSubscription(String(row.subscription_ciphertext), binding(row), config);
        if (opened.expiresAt <= Date.parse(now)) return { ...status(), expiresAt: new Date(opened.expiresAt).toISOString(), reenrollmentRequired: true, reason: "subscription_expired" };
        return status(opened);
      } catch { return { ...status(), reenrollmentRequired: true, reason: "reenrollment_required" }; }
    });
  });
}

export async function removePushSubscription(input: OwnedDeviceReference): Promise<NotificationPushSubscriptionStatus> {
  return safe(async () => {
    reference(input, input); const now = timestamp(input.now);
    return withNotificationStoreWrite(async (tx) => {
      const row = await findDevice(tx, input, input);
      if (row.subscription_ciphertext) await clearCurrent(tx, identity(row), now);
      else {
        await rows(tx, "UPDATE notification_devices SET push=0,subscription_fingerprint=NULL,updated_at=? WHERE id=? AND generation=?", [now, input.deviceId, input.generation]);
        await cancelPush(tx, input.deviceId, now);
      }
      return status();
    });
  });
}
/** For captured expiry/404/410 results only; a stale result cannot delete a replacement. */
export async function clearPushSubscriptionIfCurrent(input: PushSubscriptionIdentity): Promise<boolean> {
  return safe(async () => {
    reference(input); const now = timestamp(input.now);
    if (typeof input.subscriptionCiphertext !== "string" || input.subscriptionCiphertext.length > 16384 || typeof input.subscriptionRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.subscriptionRevision)) return false;
    return withNotificationStoreWrite((tx) => clearCurrent(tx, input, now));
  });
}

export async function cleanupExpiredPushSubscriptions(input: { now?: string } = {}): Promise<number> {
  return safe(async () => {
    const now = timestamp(input.now);
    // Separate committed operations: never nest store writes within a transaction.
    await purgeRevokedNotificationDevices({ now });
    return withNotificationStoreWrite(async (tx) => {
      const config: PushConfiguration | null = readPushConfiguration();
      if (!config) return 0;
      const candidates = await rows(tx, "SELECT d.* FROM notification_devices d JOIN trusted_devices t ON t.id=d.trusted_device_id WHERE " + live + " AND d.subscription_ciphertext IS NOT NULL");
      let removed = 0;
      for (const row of candidates) {
        let opened: OpenedPushSubscription;
        try { opened = openPushSubscription(String(row.subscription_ciphertext), binding(row), config); }
        catch (error) {
          // Identity mismatch is reported only after successful authenticated decoding.
          // Missing keys/corruption remain unreadable; do not pretend their expiry is known.
          if (error instanceof PushSubscriptionError && error.code === "reenrollment_required" && await clearCurrent(tx, identity(row), now)) removed++;
          continue;
        }
        if (opened.expiresAt <= Date.parse(now) && await clearCurrent(tx, identity(row), now)) removed++;
      }
      return removed;
    });
  });
}
