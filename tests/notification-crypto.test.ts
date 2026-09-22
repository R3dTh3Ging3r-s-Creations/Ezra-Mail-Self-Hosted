import { createECDH, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as crypto from "@/lib/email/notification-crypto";

const registeredAt = Date.parse("2026-09-14T12:00:00.000Z");
const binding = { deviceId: "synthetic-device", origin: "https://ezra.example.test", generation: 1 };
function pair() { const key = createECDH("prime256v1"); key.generateKeys(); return key; }
function subscription(endpoint = "https://fcm.googleapis.com/synthetic-endpoint") {
  return { endpoint, expirationTime: null, keys: { p256dh: pair().getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}
function environment(vapid = pair()) {
  return { EZRA_PUSH_KEY_ID: "synthetic-current", EZRA_PUSH_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), EZRA_VAPID_PUBLIC_KEY: vapid.getPublicKey().toString("base64url"), EZRA_VAPID_PRIVATE_KEY: Buffer.from(vapid.getPrivateKey().toString("hex").padStart(64, "0"), "hex").toString("base64url"), EZRA_VAPID_SUBJECT: "mailto:synthetic@example.test" };
}
function configured(env: Record<string, string | undefined> = environment()) { const result = crypto.readPushConfiguration(env); if (!result) throw new Error("Synthetic configuration unavailable"); return result; }
function seal(config = configured()) { return { config, envelope: crypto.sealPushSubscription({ ...binding, registeredAt, subscription: subscription() }, config) }; }

describe("subscription validation", () => {
  it("normalizes approved relays and strips unknown properties", () => {
    for (const host of ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "wns.notify.windows.com"]) {
      const value = subscription("https://" + host + "/synthetic");
      expect(crypto.validatePushSubscription({ ...value, ignored: true, keys: { ...value.keys, ignored: true } }, registeredAt)).toEqual(value);
    }
  });
  it.each(["http://fcm.googleapis.com/x", "https://fcm.googleapis.com:444/x", "https://user@fcm.googleapis.com/x", "https://fcm.googleapis.com/x#fragment", "https://fcm.googleapis.com.evil.test/x", "https://evilpush.apple.com/x", "https://push.apple.com/x", "https://fcm.googleapis.com./x", "https://%66cm.googleapis.com/x", "https://127.0.0.1/x", "https://[::1]/x", "https://fcm.googleapis.com", "https://fcm.googleapis.com/", "https://a..push.apple.com/x", "https://-a.push.apple.com/x", "https://fcm.googleapis.com\\evil.test/x"])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => crypto.validatePushSubscription(subscription(endpoint), registeredAt)).toThrow(crypto.PushSubscriptionError);
  });
  it("bounds the normalized endpoint as well as the incoming URL", () => {
    expect(() => crypto.validatePushSubscription(subscription("https://fcm.googleapis.com/" + "é".repeat(700)), registeredAt)).toThrow(crypto.PushSubscriptionError);
    const value = subscription("https://FCM.GOOGLEAPIS.COM:443/synthetic");
    expect(crypto.validatePushSubscription(value, registeredAt).endpoint).toBe("https://fcm.googleapis.com/synthetic");
  });
  it("rejects oversized JSON, noncanonical keys, invalid curves, and expired browser records without echo", () => {
    const value = subscription();
    for (const input of [null, { ...value, extra: "x".repeat(8192) }, { ...value, endpoint: value.endpoint + "x".repeat(2048) }, { ...value, expirationTime: registeredAt }, { ...value, expirationTime: Infinity }, { ...value, keys: { ...value.keys, auth: value.keys.auth + "=" } }, { ...value, keys: { ...value.keys, auth: randomBytes(15).toString("base64url") } }, { ...value, keys: { ...value.keys, p256dh: Buffer.alloc(65, 4).toString("base64url") } }]) {
      try { crypto.validatePushSubscription(input, registeredAt); expect.fail("must reject"); } catch (error) { expect(error).toBeInstanceOf(crypto.PushSubscriptionError); expect(String(error)).toBe("PushSubscriptionError: Push subscription unavailable"); }
    }
  });
});

describe("push configuration", () => {
  it("exposes only safe public information for complete valid pairs", () => {
    const env = environment();
    expect(crypto.getPushConfigurationStatus(env)).toEqual({ configured: true, reason: "configured", publicKey: env.EZRA_VAPID_PUBLIC_KEY, vapidKeyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(crypto.getPushConfigurationStatus({})).toEqual({ configured: false, reason: "not_configured" });
    expect(crypto.getPushConfigurationStatus({ EZRA_PUSH_KEY_ID: "synthetic" })).toEqual({ configured: false, reason: "invalid_configuration" });
  });
  it("rejects mismatched VAPID, key sizes, duplicate IDs, unbounded old keys and unsafe subjects", () => {
    const env = environment();
    for (const change of [
      { EZRA_VAPID_PUBLIC_KEY: pair().getPublicKey().toString("base64url") }, { EZRA_PUSH_KEY_ID: "bad.id" }, { EZRA_PUSH_ENCRYPTION_KEY: randomBytes(31).toString("base64url") },
      { EZRA_PUSH_OLD_KEYS_JSON: JSON.stringify([{ keyId: env.EZRA_PUSH_KEY_ID, key: randomBytes(32).toString("base64url") }]) },
      { EZRA_PUSH_OLD_KEYS_JSON: JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ keyId: "old" + i, key: randomBytes(32).toString("base64url") }))) },
      { EZRA_PUSH_OLD_KEYS_JSON: JSON.stringify([{ keyId: "old", key: env.EZRA_PUSH_ENCRYPTION_KEY }, { keyId: "old", key: env.EZRA_PUSH_ENCRYPTION_KEY }]) },
      { EZRA_PUSH_OLD_KEYS_JSON: " ".repeat(4097) },
      ...["https://localhost", "https://user@example.test", "https://example.test/?q=x", "https://example.test/path", "mailto:not-an-address", "mailto:synthetic%0A@example.test", "mailto:a@b..test", "mailto:a@-b.test", "mailto:a..b@example.test", "mailto:a#b@example.test", "mailto:a@example.test\n"].map((EZRA_VAPID_SUBJECT) => ({ EZRA_VAPID_SUBJECT })),
    ]) expect(crypto.getPushConfigurationStatus({ ...env, ...change })).toEqual({ configured: false, reason: "invalid_configuration" });
  });
});

describe("authenticated subscription encryption", () => {
  it("round-trips only encrypted metadata, caps expiry and uses fresh nonces", () => {
    const config = configured(), value = subscription();
    const one = crypto.sealPushSubscription({ ...binding, registeredAt, subscription: value }, config);
    const two = crypto.sealPushSubscription({ ...binding, registeredAt, subscription: value }, config);
    expect(one).not.toBe(two);
    expect(JSON.parse(one).iv).not.toBe(JSON.parse(two).iv);
    expect(one).not.toContain(value.endpoint);
    expect(one).not.toContain(value.keys.auth);
    expect(crypto.openPushSubscription(one, binding, config)).toMatchObject({ subscription: value, registeredAt, expiresAt: Date.parse("2026-12-13T12:00:00.000Z"), vapidKeyFingerprint: config.vapidKeyFingerprint });
    const early = { ...value, expirationTime: registeredAt + 1000 };
    expect(crypto.openPushSubscription(crypto.sealPushSubscription({ ...binding, registeredAt, subscription: early }, config), binding, config).expiresAt).toBe(registeredAt + 1000);
  });
  it("rejects each wrong binding and tampering without crypto or input details", () => {
    const { envelope, config } = seal();
    for (const change of [{ deviceId: "other" }, { origin: "https://other.example.test" }, { generation: 2 }]) expect(() => crypto.openPushSubscription(envelope, { ...binding, ...change }, config)).toThrow(crypto.PushSubscriptionError);
    const parsed = JSON.parse(envelope);
    for (const change of [{ v: 2 }, { kid: "missing" }, { iv: randomBytes(12).toString("base64url") }, { tag: randomBytes(16).toString("base64url") }, { ciphertext: randomBytes(60).toString("base64url") }, { extra: true }, { iv: parsed.iv + "=" }]) expect(() => crypto.openPushSubscription(JSON.stringify({ ...parsed, ...change }), binding, config)).toThrow("Push subscription unavailable");
    expect(() => crypto.openPushSubscription(envelope, binding, configured())).toThrow(crypto.PushSubscriptionError);
    expect(() => crypto.openPushSubscription("x".repeat(16385), binding, config)).toThrow(crypto.PushSubscriptionError);
  });
  it("opens explicit old keys and requires VAPID re-enrollment on identity change", () => {
    const shortScalar = createECDH("prime256v1");
    shortScalar.setPrivateKey(Buffer.alloc(31, 1));
    expect(shortScalar.getPrivateKey()).toHaveLength(31);
    const env = environment(shortScalar), oldConfig = configured(env), { envelope } = seal(oldConfig);
    expect(Buffer.from(env.EZRA_VAPID_PRIVATE_KEY, "base64url")).toHaveLength(32);
    const rotated = configured({ ...env, EZRA_PUSH_KEY_ID: "synthetic-next", EZRA_PUSH_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), EZRA_PUSH_OLD_KEYS_JSON: JSON.stringify([{ keyId: env.EZRA_PUSH_KEY_ID, key: env.EZRA_PUSH_ENCRYPTION_KEY }]) });
    expect(crypto.openPushSubscription(envelope, binding, rotated).keyId).toBe(env.EZRA_PUSH_KEY_ID);
    const changedVapid = configured({ ...environment(), EZRA_PUSH_KEY_ID: env.EZRA_PUSH_KEY_ID, EZRA_PUSH_ENCRYPTION_KEY: env.EZRA_PUSH_ENCRYPTION_KEY });
    expect(() => crypto.openPushSubscription(envelope, binding, changedVapid)).toThrowError(expect.objectContaining({ code: "reenrollment_required" }));
  });
  it("fingerprints endpoint ownership independently from subscription keys", () => {
    const one = subscription(), two = subscription();
    expect(crypto.pushEndpointFingerprint(one)).toBe(crypto.pushEndpointFingerprint(two));
    expect(crypto.pushSubscriptionFingerprint(one)).not.toBe(crypto.pushSubscriptionFingerprint(two));
  });
});
