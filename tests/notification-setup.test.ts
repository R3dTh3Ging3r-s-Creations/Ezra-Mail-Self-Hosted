import { randomBytes, randomUUID, createECDH } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, execute } from "@/lib/email/database";
import * as auth from "@/lib/email/auth";
import * as devices from "@/app/api/notifications/devices/route";
import * as subscriptions from "@/app/api/notifications/devices/[deviceId]/subscription/route";
import { claimNotificationDelivery } from "./helpers/notification-ledger";
import { createNotificationEvent, enqueueNotificationDeliveries, finishNotificationAttempt } from "@/lib/email/notification-store";
import { getPushConfigurationStatus } from "@/lib/email/notification-crypto";

const origin = "https://ezra.example.test";
const enrollment = { expectedSetupEpoch: 0, channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push: true } };
let cookie: string;
let databaseUrl: string;
function request(method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(origin, { method, headers: { host: "ezra.example.test", origin, cookie, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function enroll(epoch = 0) { const response = await devices.POST(request("POST", { ...enrollment, expectedSetupEpoch: epoch })); expect(response.status).toBe(200); return (await response.json()).device; }
async function trust() { const result = await auth.enrollTrustedDevice({ password: "test-synthetic-owner-password", label: "Synthetic", ipAddress: "192.0.2.1", userAgent: "Test" }); cookie = result.cookie.split(";")[0]; }
function keypair() { const key = createECDH("prime256v1"); key.generateKeys(); return key; }
async function attach(id: string, generation = 1, epoch = 0) {
  const config = getPushConfigurationStatus(); if (!config.configured) throw new Error("Synthetic config missing");
  return subscriptions.POST(request("POST", { expectedGeneration: generation, expectedSetupEpoch: epoch, expectedVapidKeyFingerprint: config.vapidKeyFingerprint, subscription: { endpoint: "https://fcm.googleapis.com/synthetic", expirationTime: null, keys: { p256dh: keypair().getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } } }), { params: Promise.resolve({ deviceId: id }) });
}
beforeEach(async () => {
  const vapid = keypair();
  for (const [key, value] of Object.entries({ APP_BASE_URL: origin, EZRA_NOTIFICATION_ORIGINS: "", EZRA_BROWSER_NOTIFICATIONS_ENABLED: "true", EZRA_AUTH_SECRET: randomBytes(32).toString("base64url"), EZRA_AUTH_PASSWORD_HASH: "", EZRA_AUTH_PASSWORD_HASH_B64: Buffer.from(await auth.hashPassword("test-synthetic-owner-password")).toString("base64"), EZRA_AUTH_ALLOW_UNCONFIGURED: "false", EZRA_PUSH_KEY_ID: "synthetic", EZRA_PUSH_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), EZRA_PUSH_OLD_KEYS_JSON: "", EZRA_VAPID_PUBLIC_KEY: vapid.getPublicKey().toString("base64url"), EZRA_VAPID_PRIVATE_KEY: Buffer.from(vapid.getPrivateKey().toString("hex").padStart(64, "0"), "hex").toString("base64url"), EZRA_VAPID_SUBJECT: "mailto:synthetic@example.test" })) vi.stubEnv(key, value);
  databaseUrl = configureEmailDatabaseForTests("file:./notification-setup-" + randomUUID() + ".sqlite");
  await trust();
});
afterEach(() => { vi.restoreAllMocks(); closeEmailDatabaseForTests(); vi.unstubAllEnvs(); });

describe("captured setup epoch", () => {
  it("requires a captured epoch on enrollment", async () => {
    const { expectedSetupEpoch: _, ...oldClient } = enrollment;
    expect((await devices.POST(request("POST", oldClient))).status).toBe(400);
  });
  it("rejects a stale epoch even before the origin has a durable row", async () => {
    const response = await devices.POST(request("POST", { ...enrollment, expectedSetupEpoch: 1 }));
    expect(await response.json()).toMatchObject({ code: "setup_stale" });
    expect((await execute("SELECT id FROM notification_devices")).rows).toHaveLength(0);
  });
});

async function status() { const route = await import("@/app/api/notifications/setup/route"); return route.GET(request()); }
async function begin(body: unknown) { const route = await import("@/app/api/notifications/setup/begin/route"); return route.POST(request("POST", body)); }
async function complete(body: unknown) { const route = await import("@/app/api/notifications/setup/complete/route"); return route.POST(request("POST", body)); }
async function recover(body: unknown) { const route = await import("@/app/api/notifications/setup/recover/route"); return route.POST(request("POST", body)); }
function operation(device?: { id: string; generation: number }, kind = "background_disable", epoch = 0) { return { operationId: randomUUID(), expectedSetupEpoch: epoch, kind, ...(device ? { current: { deviceId: device.id, expectedGeneration: device.generation } } : {}) }; }
function settled(op: ReturnType<typeof operation>, pendingEpoch = op.expectedSetupEpoch + 1) { return { operationId: op.operationId, pendingEpoch, nativeCleanupSettled: true }; }
async function deviceRow(id: string) { return (await execute("SELECT * FROM notification_devices WHERE id=?", [id])).rows[0]; }

describe("durable native cleanup", () => {
  it("returns ready zero without creating setup or enrollment and shows feature disabled safely", async () => {
    expect(await (await status()).json()).toMatchObject({ setupEpoch: 0, pending: null, currentDevice: null, featureEnabled: true });
    expect((await execute("SELECT * FROM notification_origin_setup")).rows).toHaveLength(0);
    vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "false");
    expect(await (await status()).json()).toMatchObject({ featureEnabled: false });
  });
  it("advances twice, rejects pending/stale setup from replacement trust, and permits a fresh explicit enrollment", async () => {
    const device = await enroll(); expect((await attach(device.id)).status).toBe(200);
    const op = operation(device);
    expect(await (await begin(op)).json()).toMatchObject({ setupEpoch: 1, pending: { operationId: op.operationId, pendingEpoch: 1 }, currentDevice: { id: device.id, generation: 2 } });
    expect(await (await devices.POST(request("POST", enrollment))).json()).toMatchObject({ code: "setup_pending" });
    expect(await (await attach(device.id, 2, 1)).json()).toMatchObject({ code: "setup_pending" });
    await trust();
    expect(await (await devices.POST(request("POST", enrollment))).json()).toMatchObject({ code: "setup_pending" });
    expect(await (await complete(settled(op))).json()).toMatchObject({ setupEpoch: 2, pending: null });
    for (const epoch of [0, 1]) expect(await (await devices.POST(request("POST", { ...enrollment, expectedSetupEpoch: epoch }))).json()).toMatchObject({ code: "setup_stale" });
    expect((await enroll(2)).generation).toBe(1);
  });
  it("preserves foreground/privacy/baseline and cancels old work without affecting another browser", async () => {
    await createNotificationEvent({ sourceKey: randomUUID(), kind: "interrupt", target: "/?view=today", replacementTag: "synthetic", reasonCode: "attention", expiresAt: new Date(Date.now() + 60000).toISOString() });
    const device = await enroll(); expect((await attach(device.id)).status).toBe(200);
    await execute("UPDATE notification_devices SET privacy='detailed' WHERE id=?", [device.id]);
    const baseline = (await deviceRow(device.id)).baseline_sequence;
    const firstCookie = cookie; await trust(); const other = await enroll(); cookie = firstCookie;
    const event = await createNotificationEvent({ sourceKey: randomUUID(), kind: "interrupt", target: "/?view=today", replacementTag: "synthetic", reasonCode: "attention", expiresAt: new Date(Date.now() + 60000).toISOString() });
    const deliveries = await enqueueNotificationDeliveries({ eventId: event.id });
    const claimed = await claimNotificationDelivery({ deliveryId: deliveries.find(item => item.deviceId === device.id)!.id, channel: "push" });
    expect(claimed).toBeTruthy();
    const op = operation(device); expect((await begin(op)).status).toBe(200);
    expect(await deviceRow(device.id)).toMatchObject({ generation: 2, foreground: 1, privacy: "detailed", baseline_sequence: baseline, push: 0, subscription_ciphertext: null, subscription_fingerprint: null, revoked_at: null });
    expect((await execute("SELECT state FROM notification_deliveries WHERE device_id=?", [device.id])).rows).toEqual([{ state: "cancelled" }]);
    expect((await execute("SELECT state FROM notification_deliveries WHERE device_id=?", [other.id])).rows).toEqual([{ state: "pending" }]);
    expect(await claimNotificationDelivery({ deliveryId: deliveries.find(item => item.deviceId === other.id)!.id, channel: "foreground" })).toBeTruthy();
    expect(await finishNotificationAttempt({ attemptId: claimed!.attempt.id, outcome: "accepted" })).toBeNull();
    expect((await execute("SELECT outcome,error_code FROM notification_attempts WHERE id=?", [claimed!.attempt.id])).rows[0]).toMatchObject({ outcome: "unknown", error_code: "transport_unknown" });
    expect(await (await attach(device.id, 2, 0)).json()).toMatchObject({ code: "setup_pending" });
    await complete(settled(op));
    for (const epoch of [0, 1]) expect(await (await attach(device.id, 2, epoch)).json()).toMatchObject({ code: "setup_stale" });
    expect((await attach(device.id, 2, 2)).status).toBe(200);
  });
  it.each(["device_disable", "worker_repair"])("revokes only the matched current device for %s", async kind => {
    const device = await enroll(); const firstCookie = cookie; await trust(); const other = await enroll(); cookie = firstCookie;
    expect((await begin(operation(device, kind))).status).toBe(200);
    expect((await deviceRow(device.id)).revoked_at).toBeTruthy(); expect((await deviceRow(other.id)).revoked_at).toBeNull();
  });
  it("matches exact begin retries after lost response and rejects changed identity without repeating mutation", async () => {
    const device = await enroll(), op = operation(device);
    expect((await begin(op)).status).toBe(200); expect((await begin(op)).status).toBe(200);
    expect((await deviceRow(device.id)).generation).toBe(2);
    for (const change of [{ kind: "worker_repair" }, { expectedSetupEpoch: 1 }, { current: undefined }]) expect((await begin({ ...op, ...change })).status).toBe(409);
    await trust(); expect((await begin(op)).status).toBe(409);
    expect((await deviceRow(device.id)).generation).toBe(2);
  });
  it("keeps pending through reload/crash before or after native completion; duplicate complete cannot clear a newer operation", async () => {
    const op = operation(); await begin(op);
    configureEmailDatabaseForTests(databaseUrl);
    expect(await (await status()).json()).toMatchObject({ setupEpoch: 1, pending: { operationId: op.operationId } });
    expect((await complete({ ...settled(op), nativeCleanupSettled: false })).status).toBe(400);
    expect((await complete({ ...settled(op), pendingEpoch: 2 })).status).toBe(409);
    expect((await complete(settled(op))).status).toBe(200); expect((await complete(settled(op))).status).toBe(200);
    const next = operation(undefined, "worker_repair", 2); await begin(next);
    expect((await complete(settled(op))).status).toBe(409);
    expect(await (await status()).json()).toMatchObject({ setupEpoch: 3, pending: { operationId: next.operationId } });
  });
  it("requires explicit recovery acknowledgment for the identified interrupted operation", async () => {
    const op = operation(); await begin(op);
    const snapshot = await (await status()).json();
    expect(snapshot.pending).toMatchObject({ operationId: op.operationId });
    expect(snapshot.pending.recoveryInstructions).toMatch(/close/i);
    expect(snapshot.pending.recoveryInstructions).toMatch(/browser/i);
    const input = { operationId: op.operationId, pendingEpoch: 1, ownerConfirmedNativeCleanup: true };
    expect((await recover({ ...input, ownerConfirmedNativeCleanup: false })).status).toBe(400);
    expect((await recover({ ...input, operationId: randomUUID() })).status).toBe(409);
    expect(await (await recover(input)).json()).toMatchObject({ setupEpoch: 2, pending: null, completion: { evidence: "owner_confirmation" } });
    expect((await complete(settled(op))).status).toBe(409);
  });
  it("requires a matching captured current device and returns a safe current identity on status", async () => {
    const device = await enroll();
    expect(await (await status()).json()).toMatchObject({ currentDevice: { id: device.id, generation: 1 } });
    expect(await (await begin(operation())).json()).toMatchObject({ code: "current_device_required" });
    expect((await begin(operation({ ...device, generation: 2 }))).status).toBe(409);
    await trust(); expect((await begin(operation(device))).status).toBe(403);
    expect(await (await status()).json()).toMatchObject({ setupEpoch: 0, pending: null });
  });
  it("rolls back the origin barrier when target mutation fails", async () => {
    const device = await enroll();
    await execute("CREATE TRIGGER synthetic_cleanup_failure BEFORE UPDATE ON notification_devices BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    expect((await begin(operation(device))).status).toBe(503);
    expect(await (await status()).json()).toMatchObject({ setupEpoch: 0, pending: null });
    expect((await deviceRow(device.id)).generation).toBe(1);
  });
  it("allows configured password-only cleanup without creating target enrollment even with push config disabled", async () => {
    const login = await auth.login({ password: "test-synthetic-owner-password", ipAddress: "192.0.2.1", userAgent: "Test" }); cookie = login.cookie.split(";")[0];
    vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "false"); vi.stubEnv("EZRA_PUSH_ENCRYPTION_KEY", "");
    const op = operation(undefined, "worker_repair"); expect((await begin(op)).status).toBe(200); expect((await complete(settled(op))).status).toBe(200);
    expect((await execute("SELECT id FROM notification_devices")).rows).toHaveLength(0);
    expect((await devices.POST(request("POST", enrollment))).status).toBe(403);
  });
  it("shares exact origin, no-store, bounded body and non-bypass auth protections", async () => {
    const route = await import("@/app/api/notifications/setup/begin/route");
    for (const headers of [{ origin: "https://other.example.test" }, { host: "other.example.test" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) expect((await route.POST(request("POST", operation(), headers))).status).toBe(403);
    expect((await route.POST(request("POST", operation(), { "content-length": "8193" }))).status).toBe(413);
    const response = await route.POST(request("POST", operation(), { cookie: "" })); expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("no-store");
    vi.spyOn(auth, "getAuthSession").mockResolvedValue({ authenticated: true, configured: true, developmentBypass: true, trustedDevice: null, authenticationMethod: "bypass", expiresAt: null });
    expect((await status()).status).toBe(403);
  });
});

it("makes competing begin/attach outcomes safe and completion retries cannot mutate newer enrollment", async () => {
  const device = await enroll(), op = operation(device, "device_disable");
  const results = await Promise.all([begin(op), attach(device.id)]);
  expect(results[0].status).toBe(200);
  expect([200, 409]).toContain(results[1].status);
  expect(await deviceRow(device.id)).toMatchObject({ subscription_ciphertext: null, push: 0 });
  await complete(settled(op));
  const fresh = await enroll(2); expect(fresh.generation).toBe(3);
  expect((await complete(settled(op))).status).toBe(200);
  expect(await deviceRow(device.id)).toMatchObject({ generation: 3, revoked_at: null });
});

it("rejects absent attachment epochs and does not let stale setup cross another exact origin", async () => {
  const device = await enroll();
  const route = await import("@/app/api/notifications/devices/[deviceId]/subscription/route");
  expect((await route.POST(request("POST", { expectedGeneration: 1, expectedVapidKeyFingerprint: getPushConfigurationStatus().configured ? (getPushConfigurationStatus() as { vapidKeyFingerprint: string }).vapidKeyFingerprint : "", subscription: { endpoint: "https://fcm.googleapis.com/synthetic", expirationTime: null, keys: { p256dh: keypair().getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } } }), { params: Promise.resolve({ deviceId: device.id }) })).status).toBe(400);
  await begin(operation(device));
  vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "https://other.example.test");
  expect((await devices.POST(request("POST", enrollment, { host: "other.example.test", origin: "https://other.example.test" }))).status).toBe(200);
  const setup = await import("@/app/api/notifications/setup/complete/route");
  const pending = (await (await status()).json()).pending;
  expect((await setup.POST(request("POST", { operationId: pending.operationId, pendingEpoch: 1, nativeCleanupSettled: true }, { host: "other.example.test", origin: "https://other.example.test" }))).status).toBe(409);
});
