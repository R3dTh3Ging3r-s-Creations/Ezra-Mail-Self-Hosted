import { createCipheriv, createDecipheriv, createECDH, createHash, ECDH, randomBytes } from "node:crypto";

export type PushSubscriptionErrorCode = "invalid_subscription" | "invalid_envelope" | "configuration_unavailable" | "reenrollment_required" | "subscription_expired" | "device_unavailable" | "endpoint_in_use" | "subscription_changed";
export class PushSubscriptionError extends Error {
  constructor(readonly code: PushSubscriptionErrorCode) { super("Push subscription unavailable"); this.name = "PushSubscriptionError"; }
}
export interface ValidatedPushSubscription { endpoint: string; expirationTime: number | null; keys: { p256dh: string; auth: string } }
/** Internal only: never serialize configuration or decrypted subscriptions. */
export interface PushConfiguration {
  keyId: string; encryptionKey: Buffer; oldKeys: ReadonlyMap<string, Buffer>;
  vapidPublicKey: string; vapidPrivateKey: string; vapidSubject: string; vapidKeyFingerprint: string;
}
export type PushConfigurationStatus = { configured: false; reason: "not_configured" | "invalid_configuration" } | { configured: true; reason: "configured"; publicKey: string; vapidKeyFingerprint: string };
export interface PushBinding { deviceId: string; origin: string; generation: number }
export interface OpenedPushSubscription { subscription: ValidatedPushSubscription; vapidKeyFingerprint: string; registeredAt: number; expiresAt: number; keyId: string }
const lifetime = 90 * 24 * 60 * 60 * 1000;
const keyIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
const configNames = ["EZRA_PUSH_KEY_ID", "EZRA_PUSH_ENCRYPTION_KEY", "EZRA_PUSH_OLD_KEYS_JSON", "EZRA_VAPID_PUBLIC_KEY", "EZRA_VAPID_PRIVATE_KEY", "EZRA_VAPID_SUBJECT"];
function fail(code: PushSubscriptionErrorCode = "invalid_subscription"): never { throw new PushSubscriptionError(code); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail(); return value as Record<string, unknown>; }
function closed(value: Record<string, unknown>, fields: string[]) { if (Object.keys(value).length !== fields.length || !fields.every((key) => Object.hasOwn(value, key))) fail(); }
function bytes(value: unknown, length?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  const result = Buffer.from(value, "base64url");
  if ((length !== undefined && result.length !== length) || result.toString("base64url") !== value) fail();
  return result;
}
function point(value: unknown) {
  const raw = bytes(value, 65);
  if (raw[0] !== 4 || !Buffer.from(ECDH.convertKey(raw, "prime256v1", undefined, undefined, "uncompressed")).equals(raw)) fail();
  return raw;
}
function finiteTime(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15; }
function digest(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
export function pushEndpointFingerprint(subscription: ValidatedPushSubscription) { return digest(subscription.endpoint); }
export function pushSubscriptionFingerprint(subscription: ValidatedPushSubscription) { return digest(JSON.stringify([subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth])); }
export function pushSubscriptionRevision(ciphertext: string) { return digest(ciphertext); }

export function validatePushSubscription(input: unknown, now = Date.now()): ValidatedPushSubscription {
  try {
    if (!finiteTime(now) || Buffer.byteLength(JSON.stringify(input), "utf8") > 8192) fail();
    const value = object(input), keys = object(value.keys), endpoint = value.endpoint;
    if (typeof endpoint !== "string" || endpoint.length > 2048 || /[\s\\]/.test(endpoint)) fail();
    const authority = /^https:\/\/([^/?#]+)\//.exec(endpoint)?.[1];
    if (!authority || !/^[A-Za-z0-9.-]+(?::443)?$/.test(authority)) fail();
    const url = new URL(endpoint), host = url.hostname;
    if (url.href.length > 2048 || url.protocol !== "https:" || url.port || url.username || url.password || url.hash || endpoint.includes("#") || url.pathname.length <= 1 || host.endsWith(".")) fail();
    const labels = host.split(".");
    if (host.length > 253 || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail();
    if (!["fcm.googleapis.com", "updates.push.services.mozilla.com"].includes(host) && !host.endsWith(".push.apple.com") && !host.endsWith(".notify.windows.com")) fail();
    point(keys.p256dh); bytes(keys.auth, 16);
    if (value.expirationTime !== null && (!finiteTime(value.expirationTime) || value.expirationTime <= now)) fail();
    return { endpoint: url.href, expirationTime: value.expirationTime as number | null, keys: { p256dh: keys.p256dh as string, auth: keys.auth as string } };
  } catch { return fail(); }
}
function subject(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) fail();
  const url = new URL(value);
  if (url.protocol === "mailto:") {
    const address = decodeURIComponent(url.pathname);
    const parts = address.split("@");
    if (url.search || url.hash || parts.length !== 2 || /[\s\x00-\x1f\x7f]/.test(address)) fail();
    const [local, domain] = parts;
    if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..") || local.length > 64 || domain.length > 253 || !domain.includes(".") || !domain.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) fail();
    return value;
  }
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.search || url.hash || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) fail();
  return value;
}
export function readPushConfiguration(env: Record<string, string | undefined> = process.env): PushConfiguration | null {
  try {
    const keyId = env.EZRA_PUSH_KEY_ID;
    if (!keyId || !keyIdPattern.test(keyId)) fail();
    const encryptionKey = bytes(env.EZRA_PUSH_ENCRYPTION_KEY, 32), publicBytes = point(env.EZRA_VAPID_PUBLIC_KEY), privateBytes = bytes(env.EZRA_VAPID_PRIVATE_KEY, 32);
    const vapid = createECDH("prime256v1"); vapid.setPrivateKey(privateBytes);
    if (!vapid.getPublicKey().equals(publicBytes)) fail();
    const oldKeys = new Map<string, Buffer>();
    if (env.EZRA_PUSH_OLD_KEYS_JSON) {
      if (Buffer.byteLength(env.EZRA_PUSH_OLD_KEYS_JSON, "utf8") > 4096) fail();
      const list: unknown = JSON.parse(env.EZRA_PUSH_OLD_KEYS_JSON);
      if (!Array.isArray(list) || list.length > 4) fail();
      for (const entry of list) {
        const item = object(entry); closed(item, ["keyId", "key"]);
        if (typeof item.keyId !== "string" || !keyIdPattern.test(item.keyId) || item.keyId === keyId || oldKeys.has(item.keyId)) fail();
        oldKeys.set(item.keyId, bytes(item.key, 32));
      }
    }
    return { keyId, encryptionKey, oldKeys, vapidPublicKey: publicBytes.toString("base64url"), vapidPrivateKey: privateBytes.toString("base64url"), vapidSubject: subject(env.EZRA_VAPID_SUBJECT), vapidKeyFingerprint: digest(publicBytes) };
  } catch { return null; }
}
export function getPushConfigurationStatus(env: Record<string, string | undefined> = process.env): PushConfigurationStatus {
  const config = readPushConfiguration(env);
  return config ? { configured: true, reason: "configured", publicKey: config.vapidPublicKey, vapidKeyFingerprint: config.vapidKeyFingerprint } : { configured: false, reason: configNames.some((name) => !!env[name]) ? "invalid_configuration" : "not_configured" };
}
function aad(binding: PushBinding) {
  if (typeof binding.deviceId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(binding.deviceId) || typeof binding.origin !== "string" || binding.origin.length > 300 || new URL(binding.origin).origin !== binding.origin || !Number.isSafeInteger(binding.generation) || binding.generation < 1) fail();
  return Buffer.from(JSON.stringify(["ezra-push-v1", binding.deviceId, binding.origin, binding.generation]));
}
export function sealPushSubscription(input: PushBinding & { subscription: unknown; registeredAt: number }, config: PushConfiguration): string {
  try {
    if (!finiteTime(input.registeredAt)) fail();
    const subscription = validatePushSubscription(input.subscription, input.registeredAt);
    const expiresAt = Math.min(subscription.expirationTime ?? Infinity, input.registeredAt + lifetime);
    if (!finiteTime(expiresAt)) fail();
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
    cipher.setAAD(aad(input));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ subscription, vapidKeyFingerprint: config.vapidKeyFingerprint, registeredAt: input.registeredAt, expiresAt }), "utf8"), cipher.final()]);
    const envelope = JSON.stringify({ v: 1, kid: config.keyId, iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") });
    if (Buffer.byteLength(envelope, "utf8") > 16384) fail();
    return envelope;
  } catch { return fail("invalid_envelope"); }
}
export function openPushSubscription(envelope: string, binding: PushBinding, config: PushConfiguration): OpenedPushSubscription {
  try {
    if (typeof envelope !== "string" || Buffer.byteLength(envelope, "utf8") > 16384) fail();
    const value = object(JSON.parse(envelope)); closed(value, ["v", "kid", "iv", "ciphertext", "tag"]);
    if (value.v !== 1 || typeof value.kid !== "string" || !keyIdPattern.test(value.kid)) fail();
    const key = value.kid === config.keyId ? config.encryptionKey : config.oldKeys.get(value.kid);
    if (!key) fail();
    const decipher = createDecipheriv("aes-256-gcm", key, bytes(value.iv, 12));
    decipher.setAAD(aad(binding)); decipher.setAuthTag(bytes(value.tag, 16));
    const plaintext = Buffer.concat([decipher.update(bytes(value.ciphertext)), decipher.final()]);
    const payload = object(JSON.parse(plaintext.toString("utf8"))); closed(payload, ["subscription", "vapidKeyFingerprint", "registeredAt", "expiresAt"]);
    if (!finiteTime(payload.registeredAt) || !finiteTime(payload.expiresAt) || payload.registeredAt >= payload.expiresAt) fail();
    const subscription = validatePushSubscription(payload.subscription, payload.registeredAt);
    if (payload.expiresAt !== Math.min(subscription.expirationTime ?? Infinity, payload.registeredAt + lifetime) || typeof payload.vapidKeyFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(payload.vapidKeyFingerprint)) fail();
    if (payload.vapidKeyFingerprint !== config.vapidKeyFingerprint) fail("reenrollment_required");
    return { subscription, vapidKeyFingerprint: payload.vapidKeyFingerprint, registeredAt: payload.registeredAt, expiresAt: payload.expiresAt, keyId: value.kid };
  } catch (error) {
    if (error instanceof PushSubscriptionError && error.code === "reenrollment_required") throw error;
    return fail("invalid_envelope");
  }
}
