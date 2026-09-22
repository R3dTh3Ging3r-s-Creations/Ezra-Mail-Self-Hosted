// @vitest-environment node
import { createECDH, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { request as httpsRequest } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPushConfiguration } from "@/lib/email/notification-crypto";
import { createPushRequest, sendPushRequest, createSafePushLookup, isPublicPushAddress } from "@/lib/email/notification-web-push";

function keypair() { const key = createECDH("prime256v1"); key.generateKeys(); return key; }
function config() {
  const key = keypair();
  return readPushConfiguration({ EZRA_PUSH_KEY_ID: "test", EZRA_PUSH_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), EZRA_VAPID_PUBLIC_KEY: key.getPublicKey().toString("base64url"), EZRA_VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32), key.getPrivateKey()]).subarray(-32).toString("base64url"), EZRA_VAPID_SUBJECT: "mailto:synthetic@example.test" })!;
}
const now = "2026-09-14T15:01:00.000Z";
function input() {
  return { configuration: config(), subscription: { endpoint: "https://fcm.googleapis.com/synthetic", expirationTime: null, keys: { p256dh: keypair().getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } },
    payload: { version: 1 as const, eventId: "event", attemptId: "attempt", deviceId: "device", generation: 1, kind: "interrupt" as const, title: "Ezra Mail", body: "Open Ezra Mail to review new attention.", target: "/?view=today", tag: "replacement", expiresAt: "2026-09-14T17:00:00.000Z" }, now };
}
function network(status = 201, retryAfter?: string, body = "") {
  const calls: { options: Record<string, unknown>; body?: Buffer }[] = [];
  let response!: EventEmitter & { statusCode: number; headers: Record<string, string | undefined>; complete: boolean; destroy: () => void };
  const factory = ((options: Record<string, unknown>, receive: (value: unknown) => void) => {
    const call = { options, body: undefined as Buffer | undefined }; calls.push(call);
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: (value: Buffer) => { call.body = value; queueMicrotask(() => {
      response = Object.assign(new EventEmitter(), { statusCode: status, headers: retryAfter ? { "retry-after": retryAfter } : {}, complete: true, destroy: vi.fn() });
      receive(response); if (body) response.emit("data", Buffer.from(body)); response.emit("end");
    }); } });
    return req;
  }) as unknown as typeof httpsRequest;
  return { factory, calls, response: () => response };
}
afterEach(() => { vi.useRealTimers(); });
describe("encrypted push request", () => {
  it("encrypts payload with request-local VAPID identities, stable Topic, normal urgency and bounded TTL", () => {
    const a = input(), b = input(); const first = createPushRequest(a), second = createPushRequest(b);
    expect(first.body!.includes(Buffer.from(a.payload.body))).toBe(false);
    expect(first.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(first.headers.Authorization).toContain(a.configuration.vapidPublicKey);
    expect(second.headers.Authorization).toContain(b.configuration.vapidPublicKey);
    expect(second.headers.Authorization).not.toContain(a.configuration.vapidPublicKey);
    expect(first.headers.TTL).toBe(3600); expect(first.headers.Urgency).toBe("normal");
    expect(first.headers.Topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/); expect(first.headers.Topic).toBe(second.headers.Topic);
    a.payload.expiresAt = "2026-09-14T15:01:42.000Z"; expect(createPushRequest(a).headers.TTL).toBe(42);
  });
  it("rejects unsafe targets, oversized UTF8 payloads, expired events, secrets and invalid subscriptions with sanitized errors", () => {
    for (const change of [{ target: "//evil.test" }, { body: "秘密".repeat(1000) }, { expiresAt: now }, { account: "private@example.test" }]) {
      const value = input(); Object.assign(value.payload, change); expect(() => createPushRequest(value)).toThrow("Push transport unavailable");
    }
    const value = input(); value.subscription.endpoint = "https://fcm.googleapis.com.evil.test/private-secret";
    try { createPushRequest(value); throw new Error("expected rejection"); } catch (error) { expect(String(error)).not.toContain("private-secret"); }
  });
});
describe("relay connection boundary", () => {
  it.each(["127.0.0.1", [10, 0, 0, 1].join("."), [172, 16, 0, 1].join("."), [192, 168, 2, 1].join("."), "169.254.1.1", "100.64.0.1", "0.0.0.0", "192.0.0.8", "198.18.0.1", "224.0.0.1", "240.0.0.1", "::", "::1", "fe80::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:" + [192, 168, 0, 1].join("."), "2001:db8::1", "2002:0a00:1::", "64:ff9b::a00:1"])("rejects nonpublic address %s", address => expect(isPublicPushAddress(address)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("permits public address %s", address => expect(isPublicPushAddress(address)).toBe(true));
  it("rejects a mixed DNS answer instead of letting a second resolution select private addresses", async () => {
    const resolver = vi.fn((_host, _options, callback) => callback(null, [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]));
    const lookup = createSafePushLookup(resolver as never);
    const result = await new Promise(resolve => lookup("fcm.googleapis.com", { all: true }, (error, addresses) => resolve({ error, addresses })));
    expect(result).toMatchObject({ error: { code: "EACCES" } });
    expect(resolver).toHaveBeenCalledTimes(1);
  });
  it("uses direct verified HTTPS POST with safe lookup and ignores caller network overrides", async () => {
    const net = network(); const details = createPushRequest(input());
    Object.assign(details, { agent: {}, proxy: "https://evil.test", rejectUnauthorized: false, redirect: "follow" });
    expect(await sendPushRequest(details, { request: net.factory }, now)).toEqual({ outcome: "accepted" });
    expect(net.calls).toHaveLength(1); expect(net.calls[0].options).toMatchObject({ method: "POST", protocol: "https:", agent: false, rejectUnauthorized: true });
    expect(net.calls[0].options.lookup).toBeTypeOf("function"); expect(net.calls[0].options).not.toHaveProperty("proxy");
    expect(net.calls[0].body).toEqual(details.body);
  });
  it.each([[201, "accepted", undefined], [404, "expired", "subscription_expired"], [410, "expired", "subscription_expired"], [400, "failed", "rejected"], [302, "unknown", "transport_unknown"], [500, "unknown", "transport_unknown"]])("maps %s without treating acceptance as display or following redirects", async (status, outcome, errorCode) => {
    const net = network(status as number); expect(await sendPushRequest(createPushRequest(input()), { request: net.factory }, now)).toEqual({ outcome, ...(errorCode ? { errorCode } : {}) }); expect(net.calls).toHaveLength(1);
  });
  it.each([["0", 30], ["99999", 900], ["120", 120], ["garbage", 30]])("bounds known refusal Retry-After %s", async (header, seconds) => {
    expect(await sendPushRequest(createPushRequest(input()), { request: network(429, header).factory }, now)).toMatchObject({ outcome: "failed", errorCode: "rate_limited", retryAt: new Date(Date.parse(now) + seconds * 1000).toISOString() });
  });
  it("classifies explicit 503 as safe refusal and truncates all oversized response data", async () => {
    expect(await sendPushRequest(createPushRequest(input()), { request: network(503, "60").factory }, now)).toMatchObject({ outcome: "failed", errorCode: "unavailable" });
    const net = network(201, undefined, "private-response".repeat(2000));
    expect(await sendPushRequest(createPushRequest(input()), { request: net.factory }, now)).toEqual({ outcome: "unknown", errorCode: "transport_unknown" });
    expect(net.response().destroy).toHaveBeenCalled();
  });
  it("hard-aborts an indefinitely open request at fifteen seconds without replay or error echo", async () => {
    vi.useFakeTimers(); const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
    const result = sendPushRequest(createPushRequest(input()), { request: (() => req) as unknown as typeof httpsRequest }, now);
    await vi.advanceTimersByTimeAsync(14999); expect(req.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await result).toEqual({ outcome: "unknown", errorCode: "timeout" }); expect(req.destroy).toHaveBeenCalled();
  });
  it("sanitizes synchronous network errors", async () => {
    const request = (() => { throw new Error("https://private-endpoint.example/token secret"); }) as unknown as typeof httpsRequest;
    expect(await sendPushRequest(createPushRequest(input()), { request }, now)).toEqual({ outcome: "unknown", errorCode: "transport_unknown" });
  });
});

it("does not accept malformed fractional HTTP statuses", async () => {
  expect(await sendPushRequest(createPushRequest(input()), { request: network(201.5).factory }, now)).toEqual({ outcome: "unknown", errorCode: "transport_unknown" });
});

import { createRequire } from "node:module";
it("produces ciphertext the synthetic subscriber can actually decrypt", () => {
  const subscriber = keypair(), value = input(); value.subscription.keys.p256dh = subscriber.getPublicKey().toString("base64url");
  const request = createPushRequest(value);
  const ece = createRequire(import.meta.url)("http_ece") as { decrypt(body: Buffer, options: { version: string; privateKey: typeof subscriber; authSecret: string }): Buffer };
  const decoded = JSON.parse(ece.decrypt(request.body!, { version: "aes128gcm", privateKey: subscriber, authSecret: value.subscription.keys.auth }).toString("utf8"));
  expect(decoded).toMatchObject({ version: 1, eventId: "event", attemptId: "attempt", deviceId: "device", generation: 1, kind: "interrupt", target: "/?view=today", body: "Open Ezra Mail to review new attention." });
});
it("pins public DNS results for the connection in both Node lookup modes", async () => {
  const resolver = ((_host: string, _options: unknown, callback: (error: null, records: { address: string; family: number }[]) => void) => callback(null, [{ address: "8.8.8.8", family: 4 }])) as unknown as Parameters<typeof createSafePushLookup>[0];
  const lookup = createSafePushLookup(resolver);
  expect(await new Promise(resolve => lookup("fcm.googleapis.com", { all: true }, (error, addresses) => resolve({ error, addresses })))).toEqual({ error: null, addresses: [{ address: "8.8.8.8", family: 4 }] });
  expect(await new Promise(resolve => lookup("fcm.googleapis.com", {}, (error, address, family) => resolve({ error, address, family })))).toEqual({ error: null, address: "8.8.8.8", family: 4 });
});
it("does not let tampered request headers or repeat calls escape the generated request boundary", async () => {
  const request = createPushRequest(input()), net = network(); request.headers.Authorization = "malicious"; request.headers["X-Secret"] = "secret";
  expect(await sendPushRequest(request, { request: net.factory }, now)).toEqual({ outcome: "accepted" });
  expect((net.calls[0].options.headers as Record<string, unknown>).Authorization).not.toBe("malicious");
  expect(net.calls[0].options.headers).not.toHaveProperty("X-Secret");
  expect(await sendPushRequest(request, { request: net.factory }, now)).toMatchObject({ outcome: "unknown" }); expect(net.calls).toHaveLength(1);
});

it.each([
  ["0", "2026-09-14T15:01:40.000Z"],
  ["99999", "2026-09-14T15:16:10.000Z"],
  ["Mon, 14 Sep 2026 15:02:00 GMT", "2026-09-14T15:02:00.000Z"],
  ["Mon, 14 Sep 2026 15:01:20 GMT", "2026-09-14T15:01:40.000Z"],
])("bounds delayed Retry-After %s at receipt while preserving absolute dates", async (header, expected) => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
  const pending = sendPushRequest(createPushRequest(input()), { request: network(429, header).factory });
  vi.setSystemTime(new Date("2026-09-14T15:01:10.000Z"));
  expect(await pending).toMatchObject({ outcome: "failed", errorCode: "rate_limited", retryAt: expected });
});
