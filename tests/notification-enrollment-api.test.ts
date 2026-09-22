import { claimNotificationDelivery } from "./helpers/notification-ledger";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, execute } from "@/lib/email/database";
import * as auth from "@/lib/email/auth";
import { resolveNotificationOrigin } from "@/lib/email/notification-api";
import * as devices from "@/app/api/notifications/devices/route";
import * as deviceRoute from "@/app/api/notifications/devices/[deviceId]/route";
import * as subscriptionRoute from "@/app/api/notifications/devices/[deviceId]/subscription/route";
import { POST as receipt } from "@/app/api/notifications/receipts/route";
import { POST as feedback } from "@/app/api/notifications/feedback/route";
import { getPushConfigurationStatus } from "@/lib/email/notification-crypto";
import { createNotificationEvent, enqueueNotificationDeliveries, finishNotificationAttempt, enrollNotificationDevice, listNotificationDevices } from "@/lib/email/notification-store";

const origin = "https://ezra.example.test";
const enrollment = { expectedSetupEpoch: 0, channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push: true } };
let cookie: string;
function keypair() { const key = createECDH("prime256v1"); key.generateKeys(); return key; }
function request(method = "GET", body?: unknown, headers: Record<string, string> = {}, url = origin) {
  return new Request(url, { method, headers: { host: new URL(origin).host, origin, cookie, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function context(id: string) { return { params: Promise.resolve({ deviceId: id }) }; }
async function enroll() { const response = await devices.POST(request("POST", enrollment)); expect(response.status).toBe(200); return (await response.json()).device; }
async function row(id: string) { return (await execute("SELECT * FROM notification_devices WHERE id=?", [id])).rows[0]; }
async function subscribe(id: string, generation = 1) {
  const config = getPushConfigurationStatus(); if (!config.configured) throw new Error("Synthetic configuration missing");
  return subscriptionRoute.POST(request("POST", { expectedGeneration: generation, expectedSetupEpoch: 0, expectedVapidKeyFingerprint: config.vapidKeyFingerprint, subscription: { endpoint: "https://fcm.googleapis.com/synthetic", expirationTime: null, keys: { p256dh: keypair().getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } } }), context(id));
}
beforeEach(async () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", ""); vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID", "");
  const vapid = keypair();
  for (const [key, value] of Object.entries({ APP_BASE_URL: origin, EZRA_NOTIFICATION_ORIGINS: "", EZRA_BROWSER_NOTIFICATIONS_ENABLED: "true", EZRA_AUTH_SECRET: randomBytes(32).toString("base64url"), EZRA_AUTH_PASSWORD_HASH: "", EZRA_AUTH_PASSWORD_HASH_B64: Buffer.from(await auth.hashPassword("test-synthetic-owner-password")).toString("base64"), EZRA_AUTH_ALLOW_UNCONFIGURED: "false", EZRA_PUSH_KEY_ID: "synthetic", EZRA_PUSH_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), EZRA_PUSH_OLD_KEYS_JSON: "", EZRA_VAPID_PUBLIC_KEY: vapid.getPublicKey().toString("base64url"), EZRA_VAPID_PRIVATE_KEY: Buffer.from(vapid.getPrivateKey().toString("hex").padStart(64, "0"), "hex").toString("base64url"), EZRA_VAPID_SUBJECT: "mailto:synthetic@example.test" })) vi.stubEnv(key, value);
  configureEmailDatabaseForTests("file:./notification-api-" + randomUUID() + ".sqlite");
  const trusted = await auth.enrollTrustedDevice({ password: "test-synthetic-owner-password", label: "Synthetic", ipAddress: "192.0.2.1", userAgent: "Test" });
  cookie = trusted.cookie.split(";")[0];
});
afterEach(() => { vi.restoreAllMocks(); closeEmailDatabaseForTests(); vi.unstubAllEnvs(); });

describe("notification public origin boundary", () => {
  it("binds public Host despite internal Next URL and persists the public origin", async () => {
    const req = request("POST", enrollment, { host: "EZRA.example.test:443" }, "http://localhost:3000/api/notifications/devices");
    expect(resolveNotificationOrigin(req)).toBe(origin);
    const response = await devices.POST(req); expect(response.status).toBe(200);
    expect((await row((await response.json()).device.id)).origin).toBe(origin);
  });
  it.each(["localhost:3000", "ezra.example.test:444", "ezra.example.test,ezra.example.test", "ezra.example.test@evil.test", "ezra.example.test/", "ezra%2eexample.test", "ezra.example.test\\x", "ezra.example.test:", "ezra.example.test:0443", "[::1", "127.1", "ezra.example.test."])("rejects invalid/unrecognized Host %s despite forwarding headers", (host) => {
    expect(() => resolveNotificationOrigin(request("POST", enrollment, { host, "x-forwarded-host": "ezra.example.test", "x-forwarded-proto": "https", forwarded: "host=ezra.example.test;proto=https" }))).toThrow();
  });
  it.each(["null", "https://other.example.test", "https://ezra.example.test:444", "https://EZRA.example.test", origin + "/"])("rejects noncanonical or mismatched Origin %s", (value) => {
    expect(() => resolveNotificationOrigin(request("POST", enrollment, { origin: value }))).toThrow();
  });
  it("requires mutation Origin and rejects cross-site even on an allowed host", () => {
    const req = request("POST", enrollment); req.headers.delete("origin"); expect(() => resolveNotificationOrigin(req)).toThrow();
    expect(() => resolveNotificationOrigin(request("POST", enrollment, { "sec-fetch-site": "cross-site" }))).toThrow();
  });
  it("allows only exact configured URL origin when Host is missing", () => {
    const req = request("POST", enrollment); req.headers.delete("host"); expect(resolveNotificationOrigin(req)).toBe(origin);
    const internal = request("POST", enrollment, {}, "http://localhost:3000"); internal.headers.delete("host"); expect(() => resolveNotificationOrigin(internal)).toThrow();
  });
  it("handles deduplication, nondefault ports and bracketed loopback IPv6", () => {
    vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", origin + ",http://[::1]:3000,https://other.example.test:8443");
    expect(resolveNotificationOrigin(request("GET", undefined, { host: "[::1]:3000", origin: "http://[::1]:3000" }))).toBe("http://[::1]:3000");
    expect(resolveNotificationOrigin(request("POST", enrollment, { host: "OTHER.example.test:8443", origin: "https://other.example.test:8443" }))).toBe("https://other.example.test:8443");
  });
  it.each(["https://bad.example.test/path", "https://user@bad.example.test", "https://bad.example.test?x", "https://bad.example.test#x", "null", "http://bad.example.test", "http://localhost:3000,https://localhost:3000"])("rejects invalid/ambiguous configuration %s", (extra) => {
    vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", extra); expect(() => resolveNotificationOrigin(request())).toThrow();
  });
});

describe("protected notification enrollment", () => {
  it("GET never enrolls; explicit enrollment returns an allowlisted DTO with push off", async () => {
    expect(await (await devices.GET(request())).json()).toMatchObject({ devices: [], currentDeviceId: null });
    const device = await enroll(); expect(device).toMatchObject({ generation: 1, detailedCopy: false, capabilities: { foreground: true, push: false } });
    expect(JSON.stringify(device)).not.toMatch(/trustedDeviceId|ciphertext|fingerprint|endpoint|lastError/);
    const inventory = await devices.GET(request()); expect(inventory.headers.get("cache-control")).toBe("no-store");
    expect(await inventory.json()).toMatchObject({ currentDeviceId: device.id });
  });
  it.each(["password", "bypass", "unconfigured", "anonymous"])("rejects %s sessions without durable writes", async (mode) => {
    vi.spyOn(auth, "getAuthSession").mockResolvedValue({ authenticated: mode !== "anonymous", configured: mode !== "unconfigured", developmentBypass: mode === "bypass", expiresAt: null, authenticationMethod: "session", trustedDevice: mode === "unconfigured" ? { id: "spoof", label: "Spoof" } : null });
    const response = await devices.POST(request("POST", enrollment)); expect(response.status).toBe(mode === "anonymous" ? 401 : 403);
    expect(await response.json()).toMatchObject({ code: mode === "anonymous" ? "authentication_required" : "trusted_device_required" });
    expect((await execute("SELECT id FROM notification_devices")).rows).toHaveLength(0);
  });
  it("preserves disabled browser policy and refuses unconfigured Telegram", async () => {
    vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "false");
    expect(await (await devices.GET(request())).json()).toMatchObject({ pushConfiguration: { configured: false, reason: "feature_disabled" } });
    expect((await devices.POST(request("POST", enrollment))).status).toBe(503);
    expect(await (await devices.POST(request("POST", { channel: "telegram", platform: "other", permission: "granted", capabilities: { foreground: false, push: false } }))).json()).toMatchObject({ code: "channel_unavailable" });
    expect((await execute("SELECT id FROM notification_devices")).rows).toHaveLength(0);
  });
  it.each([{ ...enrollment, trustedDeviceId: "spoof" }, [], null, { ...enrollment, capabilities: { foreground: true, push: false, extra: true } }])("rejects unknown fields and non-object bodies", async (body) => {
    expect((await devices.POST(request("POST", body))).status).toBe(400);
  });
  it("bounds streamed bytes, malformed JSON and media types without leaking input", async () => {
    const chunks = [new Uint8Array(5000).fill(65), new Uint8Array(4000).fill(65)];
    const stream = new ReadableStream({ pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); } });
    const req = new Request(origin, { method: "POST", headers: { host: "ezra.example.test", origin, cookie, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect((await devices.POST(req)).status).toBe(413);
    const bad = new Request(origin, { method: "POST", headers: { host: "ezra.example.test", origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ secret: "test-sensitive" }).slice(0, -1) });
    const result = await devices.POST(bad); expect(result.status).toBe(400); expect(await result.text()).not.toContain("test-sensitive");
    expect((await devices.POST(request("POST", enrollment, { "content-type": "text/plain" }))).status).toBe(415);
  });
  it("attaches encrypted push; privacy changes preserve generation; denial scrubs and cannot reenable", async () => {
    const device = await enroll(); expect((await subscribe(device.id)).status).toBe(200);
    const ciphertext = (await row(device.id)).subscription_ciphertext; expect(ciphertext).toBeTruthy();
    expect((await deviceRoute.PATCH(request("PATCH", { expectedGeneration: 1, detailedCopy: true }), context(device.id))).status).toBe(200);
    expect(await row(device.id)).toMatchObject({ generation: 1, privacy: "detailed", subscription_ciphertext: ciphertext });
    expect((await deviceRoute.PATCH(request("PATCH", { expectedGeneration: 2, detailedCopy: false }), context(device.id))).status).toBe(409);
    expect((await deviceRoute.PATCH(request("PATCH", { expectedGeneration: 1, permission: "denied" }), context(device.id))).status).toBe(200);
    expect(await row(device.id)).toMatchObject({ foreground: 0, push: 0, subscription_ciphertext: null });
    expect((await deviceRoute.PATCH(request("PATCH", { expectedGeneration: 1, permission: "granted" }), context(device.id))).status).toBe(409);
    expect((await subscribe(device.id)).status).toBe(409);
  });
  it("permits owner inventory removal but forbids other-browser mutations, receipts and feedback", async () => {
    const first = await enroll();
    const event = await createNotificationEvent({ sourceKey: randomUUID(), kind: "interrupt", target: "/?view=today", replacementTag: "synthetic", reasonCode: "attention", expiresAt: new Date(Date.now() + 60000).toISOString() });
    const delivery = (await enqueueNotificationDeliveries({ eventId: event.id }))[0]; const claim = (await claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground" }))!;
    await finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "accepted" });
    expect((await receipt(request("POST", { attemptId: claim.attempt.id, generation: 1, kind: "displayed" }))).status).toBe(200);
    const trusted = await auth.enrollTrustedDevice({ password: "test-synthetic-owner-password", label: "Other", ipAddress: "192.0.2.2", userAgent: "Test" }); cookie = trusted.cookie.split(";")[0]; await enroll();
    expect((await subscribe(first.id)).status).toBe(403);
    expect((await deviceRoute.PATCH(request("PATCH", { expectedGeneration: 1, detailedCopy: true }), context(first.id))).status).toBe(403);
    expect((await receipt(request("POST", { attemptId: claim.attempt.id, generation: 1, kind: "clicked" }))).status).toBe(403);
    expect((await feedback(request("POST", { eventId: event.id, kind: "useful" }))).status).toBe(403);
    for (let n = 0; n < 2; n++) expect((await deviceRoute.DELETE(request("DELETE"), context(first.id))).status).toBe(200);
    expect((await row(first.id)).revoked_at).toBeTruthy();
  });
  it.each(["logout", "revoke"])("immediately scrubs subscription secrets on auth %s", async (action) => {
    const device = await enroll(); expect((await subscribe(device.id)).status).toBe(200);
    if (action === "logout") await auth.logout(request());
    else await auth.revokeTrustedDevice(String((await row(device.id)).trusted_device_id), "synthetic");
    expect(await row(device.id)).toMatchObject({ subscription_ciphertext: null, subscription_fingerprint: null });
    expect((await row(device.id)).revoked_at).toBeTruthy();
  });
});

describe("notification API regression boundaries", () => {
  it("deduplicates configuration before enforcing the eight additional origin limit", () => {
    vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", Array(10).fill(origin).join(","));
    expect(resolveNotificationOrigin(request())).toBe(origin);
    vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", Array.from({ length: 9 }, (_, index) => `https://extra${index}.example.test`).join(","));
    expect(() => resolveNotificationOrigin(request())).toThrow();
  });
  it("rejects Host ambiguity from explicit default ports across schemes", () => {
    vi.stubEnv("APP_BASE_URL", "http://localhost:443"); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "https://localhost");
    expect(() => resolveNotificationOrigin(request("GET", undefined, { host: "localhost:443", origin: "https://localhost" }))).toThrow();
  });
  it("GET checks a supplied Origin and resolves public Host without one", async () => {
    const req = request("GET", undefined, {}, "http://localhost:3000"); req.headers.delete("origin");
    expect((await devices.GET(req)).status).toBe(200);
    expect((await devices.GET(request("GET", undefined, { origin: "https://other.example.test" }))).status).toBe(403);
    const duplicate = request(); duplicate.headers.append("host", "ezra.example.test");
    expect((await devices.GET(duplicate)).status).toBe(403);
    expect((await devices.GET(request("GET", undefined, { host: "ezra. example.test" }))).status).toBe(403);
  });
  it("bounds raw multibyte bytes, accepts exactly 8192 bytes, rejects invalid UTF8 and declared oversize", async () => {
    const encoded = JSON.stringify(enrollment);
    const bounded = new Request(origin, { method: "POST", headers: { host: "ezra.example.test", origin, cookie, "content-type": "application/json" }, body: encoded + " ".repeat(8192 - encoded.length) });
    expect((await devices.POST(bounded)).status).toBe(200);
    const multibyte = new Request(origin, { method: "POST", headers: { host: "ezra.example.test", origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "é".repeat(5000) }) });
    expect((await devices.POST(multibyte)).status).toBe(413);
    const invalid = new Request(origin, { method: "POST", headers: { host: "ezra.example.test", origin, cookie, "content-type": "application/json" }, body: new Uint8Array([0xff]) });
    expect((await devices.POST(invalid)).status).toBe(400);
    expect((await devices.POST(request("POST", enrollment, { "content-length": "8193" }))).status).toBe(413);
  });
  it("returns generic errors without crypto/configuration/subscription input", async () => {
    const device = await enroll();
    const response = await subscriptionRoute.POST(request("POST", { expectedGeneration: 1, expectedSetupEpoch: 0, expectedVapidKeyFingerprint: "0".repeat(64), subscription: { endpoint: "https://evil.example.test/synthetic-private-endpoint", expirationTime: null, keys: { p256dh: "synthetic-private-key", auth: "synthetic-private-auth" } } }), context(device.id));
    expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "invalid_subscription", message: "Notification request could not be completed." });
    vi.spyOn(auth, "getAuthSession").mockRejectedValueOnce(new Error("synthetic-private-error"));
    const failed = await devices.GET(request()); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("synthetic-private-error");
  });
  it("removes only push, rejects stale attach, and never raises capability on privacy update", async () => {
    const device = await enroll(); expect((await subscribe(device.id)).status).toBe(200);
    expect((await subscriptionRoute.DELETE(request("DELETE", { expectedGeneration: 1 }), context(device.id))).status).toBe(200);
    expect(await row(device.id)).toMatchObject({ foreground: 1, push: 0, subscription_ciphertext: null });
    const next = await enroll(); expect(next.generation).toBe(2);
    expect((await subscribe(device.id, 1)).status).toBe(409);
    expect((await deviceRoute.PATCH(request("PATCH", { expectedGeneration: 2, detailedCopy: true }), context(device.id))).status).toBe(200);
    expect(await row(device.id)).toMatchObject({ generation: 2, push: 0, privacy: "detailed" });
    const audit = await execute("SELECT metadata FROM audit_logs WHERE action LIKE 'notification.device.%'");
    for (const entry of audit.rows) expect(Object.keys(JSON.parse(String(entry.metadata))).sort()).toEqual(["action", "deviceId", "generation", "status"]);
  });
  it("records only current-device feedback and rejects caller identity fields and stale receipts", async () => {
    await enroll();
    const event = await createNotificationEvent({ sourceKey: randomUUID(), kind: "interrupt", target: "/?view=today", replacementTag: "synthetic", reasonCode: "attention", expiresAt: new Date(Date.now() + 60000).toISOString() });
    const delivery = (await enqueueNotificationDeliveries({ eventId: event.id }))[0];
    const claim = (await claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground" }))!;
    await finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "accepted" });
    expect((await feedback(request("POST", { eventId: event.id, kind: "too_noisy" }))).status).toBe(200);
    expect((await feedback(request("POST", { eventId: event.id, kind: "useful", deviceId: delivery.deviceId }))).status).toBe(400);
    await enroll();
    expect((await receipt(request("POST", { attemptId: claim.attempt.id, generation: 1, kind: "displayed" }))).status).toBe(409);
    expect((await feedback(request("POST", { eventId: event.id, kind: "useful" }))).status).toBe(403);
  });
  it.each(["default", "denied"])("permission %s cancels pending delivery and closes claimed work", async (permission) => {
    const device = await enroll();
    for (let index = 0; index < 2; index++) {
      const event = await createNotificationEvent({ sourceKey: randomUUID(), kind: "interrupt", target: "/?view=today", replacementTag: "synthetic", reasonCode: "attention", expiresAt: new Date(Date.now() + 60000).toISOString() });
      const delivery = (await enqueueNotificationDeliveries({ eventId: event.id }))[0];
      if (index === 1) await claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground" });
    }
    expect((await deviceRoute.PATCH(request("PATCH", { expectedGeneration: 1, permission }), context(device.id))).status).toBe(200);
    expect((await execute("SELECT state FROM notification_deliveries WHERE device_id=?", [device.id])).rows.every((row) => row.state === "cancelled")).toBe(true);
    expect((await execute("SELECT outcome FROM notification_attempts")).rows[0].outcome).toBe("unknown");
  });
});

it("rejects unexpected and oversized bodies on owner removal without mutating", async () => {
  const device = await enroll();
  expect((await deviceRoute.DELETE(request("DELETE", { trustedDeviceId: "spoof" }), context(device.id))).status).toBe(400);
  expect((await deviceRoute.DELETE(request("DELETE", { padding: "x".repeat(8192) }), context(device.id))).status).toBe(413);
  expect((await row(device.id)).revoked_at).toBeNull();
  expect((await deviceRoute.DELETE(request("DELETE", {}), context(device.id))).status).toBe(200);
});


describe("generation-bound enrollment rollback", () => {
  it("does not let delayed generation-one rollback revoke generation two or its secrets and pending work", async () => {
    const first = await enroll();
    const second = await enroll();
    expect(second.generation).toBe(2);
    expect((await subscribe(second.id, 2)).status).toBe(200);
    const event = await createNotificationEvent({ sourceKey: "rollback-race", kind: "brief", target: "/?view=today", replacementTag: "rollback-race", reasonCode: "brief", expiresAt: new Date(Date.now() + 3600000).toISOString() });
    await enqueueNotificationDeliveries({ eventId: event.id });
    const before = await row(second.id);
    const response = await deviceRoute.DELETE(request("DELETE", { expectedGeneration: first.generation }), context(first.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_generation" });
    expect(await row(second.id)).toEqual(before);
    expect((await execute("SELECT state FROM notification_deliveries WHERE device_id=?", [second.id])).rows).toEqual([expect.objectContaining({ state: "pending" })]);
  });
  it("conditionally revokes and scrubs matching generation idempotently", async () => {
    const device = await enroll(); await subscribe(device.id);
    for (let attempt = 0; attempt < 2; attempt++) expect((await deviceRoute.DELETE(request("DELETE", { expectedGeneration: 1 }), context(device.id))).status).toBe(200);
    expect(await row(device.id)).toMatchObject({ subscription_ciphertext: null, subscription_fingerprint: null });
    expect((await row(device.id)).revoked_at).toBeTruthy();
  });
  it("rejects conditional removal from another trusted device or origin while retaining owner inventory removal", async () => {
    const device = await enroll();
    const trusted = await auth.enrollTrustedDevice({ password: "test-synthetic-owner-password", label: "Other", ipAddress: "192.0.2.2", userAgent: "Test" });
    const otherCookie = trusted.cookie.split(";")[0];
    expect((await deviceRoute.DELETE(request("DELETE", { expectedGeneration: 1 }, { cookie: otherCookie }), context(device.id))).status).toBe(403);
    vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "https://other.example.test");
    expect((await deviceRoute.DELETE(request("DELETE", { expectedGeneration: 1 }, { host: "other.example.test", origin: "https://other.example.test" }), context(device.id))).status).toBe(403);
    expect((await row(device.id)).revoked_at).toBeNull();
    expect((await deviceRoute.DELETE(request("DELETE", undefined, { cookie: otherCookie }), context(device.id))).status).toBe(200);
    expect((await row(device.id)).revoked_at).toBeTruthy();
  });
});


describe("inventory delivery outcome timestamps", () => {
  it("reports acceptance and receipts separately across events and resets projection on rotation", async () => {
    const device = await enroll();
    const claims = [];
    for (let n = 0; n < 2; n++) {
      const event = await createNotificationEvent({ sourceKey: `receipt-projection-${n}`, kind: "brief", target: "/?view=today", replacementTag: "receipt-projection", reasonCode: "brief", expiresAt: new Date(Date.now() + 60000).toISOString() });
      const delivery = (await enqueueNotificationDeliveries({ eventId: event.id }))[0];
      const claim = (await claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground" }))!;
      await finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "accepted" }); claims.push(claim);
    }
    await execute("UPDATE notification_attempts SET completed_at=? WHERE id=?", ["2026-09-14T12:00:00.000Z", claims[0].attempt.id]);
    await execute("UPDATE notification_attempts SET completed_at=? WHERE id=?", ["2026-09-14T13:00:00.000Z", claims[1].attempt.id]);
    expect((await receipt(request("POST", { attemptId: claims[0].attempt.id, generation: 1, kind: "displayed" }))).status).toBe(200);
    expect((await receipt(request("POST", { attemptId: claims[0].attempt.id, generation: 1, kind: "clicked" }))).status).toBe(200);
    const publicDevice = (await (await devices.GET(request())).json()).devices[0];
    expect(publicDevice.lastSuccessAt).toBe("2026-09-14T13:00:00.000Z");
    expect(publicDevice.lastDisplayedAt).toEqual(expect.any(String));
    expect(publicDevice.lastClickedAt).toEqual(expect.any(String));
    expect(JSON.stringify(publicDevice)).not.toMatch(/ciphertext|trustedDeviceId|endpoint|fingerprint|attemptId/);
    await enroll();
    const rotated = (await (await devices.GET(request())).json()).devices.find((entry: { id: string }) => entry.id === device.id);
    expect(rotated).toMatchObject({ generation: 2, lastSuccessAt: null, lastDisplayedAt: null, lastClickedAt: null });
  });
});

it("reads only the current device subscription status without secrets or mutation", async () => {
  const device = await enroll(); await subscribe(device.id);
  const before = await row(device.id);
  expect(typeof subscriptionRoute.GET).toBe("function");
  const response = await subscriptionRoute.GET(request(), context(device.id));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ generation: 1, deliveryEnabled: true, subscription: { subscribed: true, expiresAt: expect.any(String), reenrollmentRequired: false, reason: "subscribed" } });
  expect(await row(device.id)).toEqual(before);
  vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "false");
  const disabled = await subscriptionRoute.GET(request(), context(device.id));
  expect(await disabled.json()).toMatchObject({ generation: 1, deliveryEnabled: false, subscription: { subscribed: true } });
  vi.stubEnv("EZRA_VAPID_PRIVATE_KEY", "");
  expect(await (await subscriptionRoute.GET(request(), context(device.id))).json()).toMatchObject({ deliveryEnabled: false, subscription: { reason: "configuration_unavailable" } });
  expect(await row(device.id)).toEqual(before);
});
it("forbids subscription status across trusted identities and exact origins", async () => {
  const device = await enroll();
  expect(typeof subscriptionRoute.GET).toBe("function");
  const trusted = await auth.enrollTrustedDevice({ password: "test-synthetic-owner-password", label: "Other", ipAddress: "192.0.2.2", userAgent: "Test" });
  expect((await subscriptionRoute.GET(request("GET", undefined, { cookie: trusted.cookie.split(";")[0] }), context(device.id))).status).toBe(403);
  vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "https://other.example.test");
  expect((await subscriptionRoute.GET(request("GET", undefined, { host: "other.example.test", origin: "https://other.example.test" }), context(device.id))).status).toBe(403);
  expect((await subscriptionRoute.GET(request("GET", undefined, { cookie: "" }), context(device.id))).status).toBe(401);
});
it("reports subscription expiry without silently scrubbing or renewing", async () => {
  const device = await enroll(); await subscribe(device.id);
  const before = await row(device.id);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 91 * 86400000);
    const response = await subscriptionRoute.GET(request(), context(device.id));
    expect(await response.json()).toMatchObject({ generation: 1, deliveryEnabled: false, subscription: { subscribed: false, reenrollmentRequired: true, reason: "subscription_expired" } });
    expect(await row(device.id)).toEqual(before);
  } finally { vi.useRealTimers(); }
});
it("keeps subscription GET read-only even for unrelated revoked trust while default inventory still scrubs", async () => {
  const live = await enroll(); await subscribe(live.id);
  const now = new Date().toISOString();
  await execute("INSERT INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES ('revoked-trust','Synthetic other','synthetic-hash',?,?)", [now, now]);
  const other = await enrollNotificationDevice({ expectedSetupEpoch: 0, trustedDeviceId: "revoked-trust", origin, channel: "browser", platform: "other", permission: "granted", capabilities: { foreground: true, push: false } });
  await execute("UPDATE notification_devices SET push=1,subscription_ciphertext='synthetic-envelope',subscription_fingerprint='synthetic-fingerprint' WHERE id=?", [other.id]);
  await execute("UPDATE trusted_devices SET revoked_at=? WHERE id='revoked-trust'", [now]);
  const liveBefore = await row(live.id), otherBefore = await row(other.id);
  expect((await subscriptionRoute.GET(request(), context(live.id))).status).toBe(200);
  expect(await row(live.id)).toEqual(liveBefore);
  expect(await row(other.id)).toEqual(otherBefore);
  await listNotificationDevices();
  expect(await row(other.id)).toMatchObject({ subscription_ciphertext: null, subscription_fingerprint: null });
  expect((await row(other.id)).revoked_at).not.toBeNull();
});

it("Telegram DELETE without generation still checks the enrolling owner", async () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN","123456:synthetic");vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID","123456789");
  const body={channel:"telegram",platform:"other",permission:"granted",capabilities:{foreground:false,push:false}};
  const enrolled=await devices.POST(request("POST",body));expect(enrolled.status).toBe(200);const device=(await enrolled.json()).device;
  const other=await auth.enrollTrustedDevice({password:"test-synthetic-owner-password",label:"Other",ipAddress:"192.0.2.2",userAgent:"Test"});cookie=other.cookie.split(";")[0];
  expect((await deviceRoute.DELETE(request("DELETE"),context(device.id))).status).toBe(403);expect((await row(device.id)).revoked_at).toBeNull();
});
it("Telegram enrollment and GET are independent of pending browser cleanup and redact binding", async () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN","123456:synthetic");vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID","123456789");vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED","false");
  const response=await devices.POST(request("POST",{channel:"telegram",platform:"other",permission:"granted",capabilities:{foreground:false,push:false}}));expect(response.status).toBe(200);
  const status=await (await devices.GET(request())).json();expect(status).toMatchObject({currentDeviceId:null,telegramConfiguration:{configured:true,enrolled:true}});expect(JSON.stringify(status)).not.toMatch(/123456|fingerprint|token_hash/);
  expect((await devices.POST(request("POST",{channel:"browser",platform:"other",permission:"granted",capabilities:{foreground:true,push:false}}))).status).toBe(400);
});

import * as telegramRoute from "@/app/api/telegram/route";
it("Telegram status is read-only, origin protected and reports explicit enrollment",async()=>{
 vi.stubEnv("TELEGRAM_BOT_TOKEN","123456:synthetic");vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID","123456789");const fetch=vi.fn(()=>{throw new Error("No network allowed");});vi.stubGlobal("fetch",fetch);
 try{expect(await (await telegramRoute.GET(request())).json()).toMatchObject({telegram:{configured:true,enrolled:false,running:null,polling:"worker_managed"}});expect((await execute("SELECT id FROM notification_devices")).rows).toHaveLength(0);expect((await telegramRoute.POST(request("POST",{command:"test"},{origin:"https://other.example.test"}))).status).toBe(403);expect(fetch).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
});

it("Telegram compatibility start and stop cannot bypass explicit inventory enrollment",async()=>{for(const command of ["start","stop"])expect((await telegramRoute.POST(request("POST",{command}))).status).toBe(409);});
it("Telegram test requires an exact current enrolled generation",async()=>{vi.stubEnv("TELEGRAM_BOT_TOKEN","123456:synthetic");vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID","123456789");const response=await devices.POST(request("POST",{channel:"telegram",platform:"other",permission:"granted",capabilities:{foreground:false,push:false}}));const device=(await response.json()).device;expect((await telegramRoute.POST(request("POST",{command:"test"}))).status).toBe(400);expect((await telegramRoute.POST(request("POST",{command:"test",deviceId:device.id,expectedGeneration:device.generation+1}))).status).toBe(409);});
