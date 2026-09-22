import { claimNotificationDelivery } from "./helpers/notification-ledger";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, ensureEmailDatabase, execute } from "@/lib/email/database";
import { withNotificationStoreWrite, enrollNotificationDevice, revokeNotificationDevice, listNotificationDevices, createNotificationEvent, enqueueNotificationDeliveries } from "@/lib/email/notification-store";
import * as subscriptions from "@/lib/email/notification-subscriptions";
import { readPushConfiguration, sealPushSubscription } from "@/lib/email/notification-crypto";

const now = "2026-09-14T12:00:00.000Z", origin = "https://ezra.example.test";
let env: Record<string, string>;
function keypair() { const key = createECDH("prime256v1"); key.generateKeys(); return key; }
function subscription(endpoint = "https://fcm.googleapis.com/synthetic-endpoint", expirationTime: number | null = null) { return { endpoint, expirationTime, keys: { p256dh: keypair().getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } }; }
function configuration() {
  const vapid = keypair();
  return { EZRA_PUSH_KEY_ID: "synthetic-current", EZRA_PUSH_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), EZRA_VAPID_PUBLIC_KEY: vapid.getPublicKey().toString("base64url"), EZRA_VAPID_PRIVATE_KEY: Buffer.from(vapid.getPrivateKey().toString("hex").padStart(64, "0"), "hex").toString("base64url"), EZRA_VAPID_SUBJECT: "mailto:synthetic@example.test", EZRA_PUSH_OLD_KEYS_JSON: "" };
}
function setEnvironment(values: Record<string, string>) { for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value); }
beforeEach(async () => {
  vi.stubEnv("APP_BASE_URL", "https://ezra.example.test"); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", ""); vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "true"); env = configuration(); setEnvironment(env); configureEmailDatabaseForTests("file:./notification-subscriptions-" + randomUUID() + ".sqlite"); await ensureEmailDatabase(); });
afterEach(() => { closeEmailDatabaseForTests(); vi.unstubAllEnvs(); });
async function enroll(trustedDeviceId = "synthetic-trust", permission: "granted" | "denied" = "granted") {
  await execute("INSERT OR IGNORE INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES (?,'Synthetic',?,?,?)", [trustedDeviceId, trustedDeviceId, now, now]);
  return enrollNotificationDevice({ expectedSetupEpoch: 0, trustedDeviceId, origin, channel: "browser", platform: "windows", permission, capabilities: { foreground: true, push: false }, now });
}
function owned(device: { id: string; trustedDeviceId: string; generation: number }) { return { expectedSetupEpoch: 0, expectedVapidKeyFingerprint: readPushConfiguration()!.vapidKeyFingerprint, deviceId: device.id, trustedDeviceId: device.trustedDeviceId, origin, generation: device.generation, now }; }
async function row(deviceId: string) { return (await execute("SELECT * FROM notification_devices WHERE id=?", [deviceId])).rows[0]; }
async function attached() { const device = await enroll(), value = subscription(); await subscriptions.attachPushSubscription({ ...owned(device), subscription: value }); return { device, value }; }
async function pending(deviceId: string, channel: "push" | "foreground") {
  const event = await createNotificationEvent({ sourceKey: randomUUID(), kind: "interrupt", target: "/?view=today", replacementTag: "synthetic-tag", reasonCode: "attention", createdAt: now, expiresAt: "2026-09-14T13:00:00.000Z" });
  const delivery = (await enqueueNotificationDeliveries({ eventId: event.id, now })).find((item) => item.deviceId === deviceId)!;
  return (await claimNotificationDelivery({ deliveryId: delivery.id, channel, now }))!;
}

describe("encrypted subscription ownership", () => {
  it("stores ciphertext only, sets push only after attach, and safely reports expiration", async () => {
    const device = await enroll(), value = subscription();
    expect((await row(device.id)).push).toBe(0);
    const result = await subscriptions.attachPushSubscription({ ...owned(device), subscription: value });
    expect(result).toEqual({ subscribed: true, expiresAt: "2026-12-13T12:00:00.000Z", reenrollmentRequired: false, reason: "subscribed" });
    const stored = await row(device.id);
    expect(stored.push).toBe(1); expect(stored.generation).toBe(1); expect(stored.baseline_sequence).toBe(0);
    expect(JSON.stringify(stored)).not.toContain(value.endpoint); expect(JSON.stringify(stored)).not.toContain(value.keys.auth);
    expect(JSON.stringify(await listNotificationDevices())).not.toMatch(/ciphertext|fingerprint|endpoint/);
    expect((await subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now })).subscription).toEqual(value);
    await subscriptions.attachPushSubscription({ ...owned(device), subscription: value });
    expect((await row(device.id)).subscription_ciphertext).toBe(stored.subscription_ciphertext);
  });
  it("rejects a cached VAPID identity after configuration rotation without writing", async () => {
    const device = await enroll(), cachedRequest = owned(device), before = await row(device.id);
    setEnvironment(configuration());
    await expect(subscriptions.attachPushSubscription({ ...cachedRequest, subscription: subscription() })).rejects.toMatchObject({ code: "reenrollment_required" });
    expect(await row(device.id)).toEqual(before);
    await expect(subscriptions.attachPushSubscription({ ...owned(device), expectedVapidKeyFingerprint: undefined as unknown as string, subscription: subscription() })).rejects.toMatchObject({ code: "reenrollment_required" });
    expect(await row(device.id)).toEqual(before);
  });
  it("rejects wrong ownership, origin, generation, denied permission and revoked trust", async () => {
    const device = await enroll();
    for (const change of [{ trustedDeviceId: "other" }, { origin: "https://other.example.test" }, { generation: 2 }]) await expect(subscriptions.attachPushSubscription({ ...owned(device), ...change, subscription: subscription() })).rejects.toMatchObject({ code: "device_unavailable" });
    const denied = await enroll("denied-trust", "denied");
    await expect(subscriptions.attachPushSubscription({ ...owned(denied), subscription: subscription() })).rejects.toMatchObject({ code: "device_unavailable" });
    await execute("UPDATE trusted_devices SET revoked_at=? WHERE id=?", [now, device.trustedDeviceId]);
    await expect(subscriptions.attachPushSubscription({ ...owned(device), subscription: subscription() })).rejects.toMatchObject({ code: "device_unavailable" });
    expect((await row(device.id)).push).toBe(0);
  });
  it("rejects duplicate active endpoints even with different valid subscription keys and concurrent attach", async () => {
    const first = await enroll(), second = await enroll("second-trust");
    const results = await Promise.allSettled([subscriptions.attachPushSubscription({ ...owned(first), subscription: subscription() }), subscriptions.attachPushSubscription({ ...owned(second), subscription: subscription() })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "endpoint_in_use" } });
    const active = (await execute("SELECT * FROM notification_devices WHERE subscription_ciphertext IS NOT NULL")).rows;
    expect(active).toHaveLength(1);
    const other = active[0].id === first.id ? second : first;
    await expect(execute("UPDATE notification_devices SET subscription_fingerprint=?,subscription_ciphertext='synthetic-envelope' WHERE id=?", [active[0].subscription_fingerprint, other.id])).rejects.toThrow();
    await revokeNotificationDevice({ deviceId: String(active[0].id), now });
    await expect(subscriptions.attachPushSubscription({ ...owned(other), subscription: subscription() })).resolves.toMatchObject({ subscribed: true });
  });
  it("cannot resurrect a device when attach races revocation or generation rotation", async () => {
    const { device } = await attached();
    await Promise.all([subscriptions.attachPushSubscription({ ...owned(device), subscription: subscription() }), revokeNotificationDevice({ deviceId: device.id, now })]);
    expect((await row(device.id)).subscription_ciphertext).toBeNull();
    const rotated = await enroll();
    await expect(subscriptions.attachPushSubscription({ ...owned(device), subscription: subscription() })).rejects.toMatchObject({ code: "device_unavailable" });
    expect((await row(device.id)).generation).toBe(rotated.generation);
  });
});

// Real transaction barriers control queue order without mocking configuration or storage.
function blockedWrite() {
  let entered!: () => void, release!: () => void;
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const completed = withNotificationStoreWrite(async () => { entered(); await gate; });
  return { acquired, release, completed };
}

describe("queued push configuration rotation", () => {
  it("does not scrub a fresh rotated attach when cleanup queued under the old VAPID identity", async () => {
    const { device } = await attached(), replacement = subscription();
    const rotated = { ...configuration(), EZRA_PUSH_KEY_ID: env.EZRA_PUSH_KEY_ID, EZRA_PUSH_ENCRYPTION_KEY: env.EZRA_PUSH_ENCRYPTION_KEY };
    const first = blockedWrite(); await first.acquired;
    const cleanup = subscriptions.cleanupExpiredPushSubscriptions({ now });
    // Cleanup's trust purge runs between these barriers, before subscription cleanup queues.
    const second = blockedWrite();
    const registration = subscriptions.attachPushSubscription({ ...owned(device), subscription: replacement, expectedVapidKeyFingerprint: readPushConfiguration(rotated)!.vapidKeyFingerprint });
    first.release(); await first.completed; await second.acquired;
    try {
      // Drain continuations so cleanup has reached the queue behind registration.
      await nextTurn();
      setEnvironment(rotated);
    } finally { second.release(); }
    await second.completed; await registration;
    expect(await cleanup).toBe(0);
    expect((await row(device.id)).push).toBe(1);
    expect((await subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now })).subscription).toEqual(replacement);
  });
  it.each(["delivery", "status"] as const)("rechecks VAPID after acquiring a queued %s transaction", async (operation) => {
    const { device } = await attached();
    const blocker = blockedWrite(); await blocker.acquired;
    const pending = (operation === "delivery"
      ? subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now })
      : subscriptions.getPushSubscriptionStatus(owned(device)))
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await nextTurn();
      setEnvironment({ ...configuration(), EZRA_PUSH_KEY_ID: env.EZRA_PUSH_KEY_ID, EZRA_PUSH_ENCRYPTION_KEY: env.EZRA_PUSH_ENCRYPTION_KEY });
    } finally { blocker.release(); }
    await blocker.completed;
    expect(await pending).toMatchObject(operation === "delivery" ? { error: { code: "reenrollment_required" } } : { value: { subscribed: false, reason: "reenrollment_required" } });
  });
  it("does not rewrap a freshly rotated subscription back to a queued delivery's old current key", async () => {
    const nextKey = randomBytes(32).toString("base64url");
    setEnvironment({ ...env, EZRA_PUSH_OLD_KEYS_JSON: JSON.stringify([{ keyId: "synthetic-next", key: nextKey }]) });
    const { device } = await attached(), replacement = subscription();
    const blocker = blockedWrite(); await blocker.acquired;
    const registration = subscriptions.attachPushSubscription({ ...owned(device), subscription: replacement });
    const delivery = subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now });
    try {
      await nextTurn();
      setEnvironment({ ...env, EZRA_PUSH_KEY_ID: "synthetic-next", EZRA_PUSH_ENCRYPTION_KEY: nextKey, EZRA_PUSH_OLD_KEYS_JSON: JSON.stringify([{ keyId: env.EZRA_PUSH_KEY_ID, key: env.EZRA_PUSH_ENCRYPTION_KEY }]) });
    } finally { blocker.release(); }
    await blocker.completed; await registration;
    const result = await delivery;
    expect(result.subscription).toEqual(replacement);
    expect(JSON.parse(result.subscriptionCiphertext).kid).toBe("synthetic-next");
    expect(JSON.parse(String((await row(device.id)).subscription_ciphertext)).kid).toBe("synthetic-next");
  });
});

describe("subscription lifecycle", () => {
  it("removes push claims while preserving foreground and rejects stale-owner removal", async () => {
    const { device } = await attached(), push = await pending(device.id, "push"), foreground = await pending(device.id, "foreground");
    await expect(subscriptions.removePushSubscription({ ...owned(device), trustedDeviceId: "other" })).rejects.toMatchObject({ code: "device_unavailable" });
    await subscriptions.removePushSubscription(owned(device));
    expect(await row(device.id)).toMatchObject({ foreground: 1, push: 0, generation: 1, revoked_at: null, subscription_ciphertext: null, subscription_fingerprint: null });
    expect((await execute("SELECT state FROM notification_deliveries WHERE id=?", [push.delivery.id])).rows[0].state).toBe("cancelled");
    expect((await execute("SELECT outcome FROM notification_attempts WHERE id=?", [push.attempt.id])).rows[0].outcome).toBe("unknown");
    expect((await execute("SELECT state FROM notification_deliveries WHERE id=?", [foreground.delivery.id])).rows[0].state).toBe("claimed");
  });
  it("rewraps old keys without changing expiry, enrollment or delivery state", async () => {
    const { device, value } = await attached(), claim = await pending(device.id, "push"), before = await row(device.id);
    setEnvironment({ ...env, EZRA_PUSH_KEY_ID: "synthetic-next", EZRA_PUSH_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), EZRA_PUSH_OLD_KEYS_JSON: JSON.stringify([{ keyId: env.EZRA_PUSH_KEY_ID, key: env.EZRA_PUSH_ENCRYPTION_KEY }]) });
    const delivery = await subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now });
    expect(delivery.subscription).toEqual(value); expect(delivery.expiresAt).toBe("2026-12-13T12:00:00.000Z");
    expect((await row(device.id)).subscription_ciphertext).not.toBe(before.subscription_ciphertext);
    expect((await row(device.id)).generation).toBe(1);
    expect((await execute("SELECT state FROM notification_deliveries WHERE id=?", [claim.delivery.id])).rows[0].state).toBe("claimed");
  });
  it("rejects missing keys, corrupt envelopes, changed VAPID and partial configuration", async () => {
    const { device } = await attached();
    setEnvironment({ ...env, EZRA_PUSH_KEY_ID: "synthetic-next", EZRA_PUSH_ENCRYPTION_KEY: randomBytes(32).toString("base64url") });
    await expect(subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now })).rejects.toMatchObject({ code: "invalid_envelope" });
    setEnvironment({ ...configuration(), EZRA_PUSH_KEY_ID: env.EZRA_PUSH_KEY_ID, EZRA_PUSH_ENCRYPTION_KEY: env.EZRA_PUSH_ENCRYPTION_KEY });
    await expect(subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now })).rejects.toMatchObject({ code: "reenrollment_required" });
    expect(await subscriptions.getPushSubscriptionStatus(owned(device))).toMatchObject({ subscribed: false, reenrollmentRequired: true, reason: "reenrollment_required" });
    setEnvironment(env); await execute("UPDATE notification_devices SET subscription_ciphertext='synthetic-corruption'");
    await expect(subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now })).rejects.toMatchObject({ code: "invalid_envelope" });
    vi.stubEnv("EZRA_VAPID_PRIVATE_KEY", "");
    await expect(subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now })).rejects.toMatchObject({ code: "configuration_unavailable" });
  });
  it("retains unreadable ciphertext for key repair but explicit removal still scrubs it", async () => {
    const { device } = await attached(), captured = (await row(device.id)).subscription_ciphertext;
    setEnvironment({ ...env, EZRA_PUSH_KEY_ID: "synthetic-next", EZRA_PUSH_ENCRYPTION_KEY: randomBytes(32).toString("base64url") });
    expect(await subscriptions.cleanupExpiredPushSubscriptions({ now: "2027-01-01T00:00:00.000Z" })).toBe(0);
    expect((await row(device.id)).subscription_ciphertext).toBe(captured);
    expect(await subscriptions.getPushSubscriptionStatus(owned(device))).toMatchObject({ subscribed: false, expiresAt: null, reenrollmentRequired: true });
    await subscriptions.removePushSubscription(owned(device));
    expect((await row(device.id)).subscription_ciphertext).toBeNull();
  });
  it("scrubs obsolete VAPID subscriptions during worker cleanup", async () => {
    const { device } = await attached();
    setEnvironment({ ...configuration(), EZRA_PUSH_KEY_ID: env.EZRA_PUSH_KEY_ID, EZRA_PUSH_ENCRYPTION_KEY: env.EZRA_PUSH_ENCRYPTION_KEY });
    await subscriptions.cleanupExpiredPushSubscriptions({ now });
    expect((await row(device.id)).subscription_ciphertext).toBeNull();
    expect((await row(device.id)).push).toBe(0);
  });
  it("uses exact ciphertext CAS so stale expiration or 404/410 cannot remove a replacement", async () => {
    const { device } = await attached(), captured = await subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now });
    const replacement = subscription(); await subscriptions.attachPushSubscription({ ...owned(device), subscription: replacement });
    expect(await subscriptions.clearPushSubscriptionIfCurrent({ deviceId: device.id, generation: 1, subscriptionCiphertext: captured.subscriptionCiphertext, subscriptionRevision: captured.subscriptionRevision, now })).toBe(false);
    expect((await subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now })).subscription).toEqual(replacement);
    const current = await subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now });
    expect(await subscriptions.clearPushSubscriptionIfCurrent({ deviceId: device.id, generation: 1, subscriptionCiphertext: current.subscriptionCiphertext, subscriptionRevision: captured.subscriptionRevision, now })).toBe(false);
    expect(await subscriptions.clearPushSubscriptionIfCurrent({ deviceId: device.id, generation: 1, subscriptionCiphertext: current.subscriptionCiphertext, subscriptionRevision: current.subscriptionRevision, now })).toBe(true);
  });
  it("serializes rewrap and replacement without overwriting the new subscription", async () => {
    const { device } = await attached();
    setEnvironment({ ...env, EZRA_PUSH_KEY_ID: "synthetic-next", EZRA_PUSH_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), EZRA_PUSH_OLD_KEYS_JSON: JSON.stringify([{ keyId: env.EZRA_PUSH_KEY_ID, key: env.EZRA_PUSH_ENCRYPTION_KEY }]) });
    const replacement = subscription();
    await Promise.all([subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now }), subscriptions.attachPushSubscription({ ...owned(device), subscription: replacement })]);
    expect((await subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now })).subscription).toEqual(replacement);
  });
  it("expires at browser or server deadline, scrubs secrets and purges revoked trust", async () => {
    const device = await enroll(), expires = Date.parse(now) + 1000;
    await subscriptions.attachPushSubscription({ ...owned(device), subscription: subscription(undefined, expires) });
    await expect(subscriptions.getPushSubscriptionForDelivery({ deviceId: device.id, generation: 1, now: "2026-09-14T12:00:01.000Z" })).rejects.toMatchObject({ code: "subscription_expired" });
    expect((await row(device.id)).subscription_ciphertext).toBeNull();
    const second = await enroll("second-trust");
    await subscriptions.attachPushSubscription({ ...owned(second), subscription: subscription() });
    const third = await enroll("third-trust");
    const config = readPushConfiguration(env)!;
    await execute("UPDATE notification_devices SET push=1,subscription_ciphertext=? WHERE id=?", [sealPushSubscription({ deviceId: third.id, origin, generation: 1, registeredAt: Date.parse(now) - 91 * 86400000, subscription: subscription() }, config), third.id]);
    await execute("UPDATE trusted_devices SET revoked_at=? WHERE id=?", [now, second.trustedDeviceId]);
    await subscriptions.cleanupExpiredPushSubscriptions({ now });
    expect((await row(second.id)).subscription_ciphertext).toBeNull(); expect((await row(third.id)).subscription_ciphertext).toBeNull();
    await expect(subscriptions.getPushSubscriptionForDelivery({ deviceId: second.id, generation: 1, now })).rejects.toMatchObject({ code: "device_unavailable" });
  });
});
