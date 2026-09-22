import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { generateRequestDetails, type RequestDetails } from "web-push";
import { z } from "zod";
import { validatePushSubscription, type PushConfiguration, type ValidatedPushSubscription } from "./notification-crypto";
import { parseNotificationTarget } from "./notification-target";
import type { NotificationAttemptOutcome, NotificationErrorCode } from "./notification-types";

export class PushTransportError extends Error {
  readonly code = "invalid_payload";
  constructor() { super("Push transport unavailable"); this.name = "PushTransportError"; }
}
const opaque = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const payloadSchema = z.object({
  version: z.literal(1), eventId: opaque, attemptId: opaque, deviceId: opaque,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), kind: z.enum(["interrupt", "brief", "checkin"]),
  title: z.string().min(1).max(80), body: z.string().min(1).max(140), target: z.string().max(2048),
  tag: z.string().min(1).max(200), expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type PushPayload = z.infer<typeof payloadSchema>;
export type PushTransportResult = { outcome: NotificationAttemptOutcome; errorCode?: NotificationErrorCode; retryAt?: string };
export interface PushNetwork { request?: typeof httpsRequest; lookup?: typeof dnsLookup }
// The transport accepts only our generated requests. Callers cannot replace headers,
// endpoint, agent, proxy or redirect handling between generation and I/O.
const generated = new WeakMap<RequestDetails, RequestDetails>();
function relay(endpoint: string) {
  const url = new URL(endpoint);
  const host = url.hostname;
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || url.pathname.length <= 1
    || !["fcm.googleapis.com", "updates.push.services.mozilla.com"].includes(host) && !host.endsWith(".push.apple.com") && !host.endsWith(".notify.windows.com")
    || !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new PushTransportError();
  return url;
}
export function createPushRequest(input: { subscription: ValidatedPushSubscription; configuration: PushConfiguration; payload: PushPayload; now: string }): RequestDetails {
  try {
    const now = Date.parse(input.now), payload = payloadSchema.parse(input.payload);
    if (!Number.isFinite(now) || !parseNotificationTarget(payload.target) || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(payload.title + payload.body + payload.tag)) throw new PushTransportError();
    const plaintext = JSON.stringify(payload), ttl = Math.min(3600, Math.floor((Date.parse(payload.expiresAt) - now) / 1000));
    if (Buffer.byteLength(plaintext, "utf8") > 3000 || ttl < 1) throw new PushTransportError();
    const subscription = validatePushSubscription(input.subscription, now), configuration = input.configuration;
    relay(subscription.endpoint);
    const details = generateRequestDetails(subscription, plaintext, { contentEncoding: "aes128gcm", TTL: ttl, urgency: "normal", topic: createHash("sha256").update(payload.tag).digest("base64url").slice(0, 32), vapidDetails: { publicKey: configuration.vapidPublicKey, privateKey: configuration.vapidPrivateKey, subject: configuration.vapidSubject } });
    generated.set(details, { ...details, headers: { ...details.headers }, body: Buffer.from(details.body) });
    return details;
  } catch { throw new PushTransportError(); }
}
/** Fail closed on special-use space, including translation/tunneling prefixes. */
export function isPublicPushAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (family !== 6 || address.includes("%")) return false;
  // URL canonicalization expands embedded IPv4 to hex; only native global unicast.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [first, second = "0"] = normalized.split(":").map(part => part || "0");
  const a = parseInt(first, 16), b = parseInt(second, 16);
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) && !(a === 0x3fff && b <= 0xfff);
}
export function createSafePushLookup(resolve: typeof dnsLookup = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    const denied = () => callback(Object.assign(new Error("Push network unavailable"), { code: "EACCES" }), "");
    try {
      relay(`https://${hostname}/push`);
      resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (error || !addresses.length || addresses.some(item => !isPublicPushAddress(item.address) || isIP(item.address) !== item.family)) return denied();
        const candidates = options.family ? addresses.filter(item => item.family === options.family) : addresses;
        if (!candidates.length) return denied();
        if (options.all) callback(null, candidates);
        else callback(null, candidates[0].address, candidates[0].family);
      });
    } catch { denied(); }
  };
}
function responseResult(status: number | undefined, retryAfter: string | string[] | undefined, now: string): PushTransportResult {
  if (!Number.isInteger(status)) return { outcome: "unknown", errorCode: "transport_unknown" };
  if (status && status >= 200 && status < 300) return { outcome: "accepted" };
  if (status === 404 || status === 410) return { outcome: "expired", errorCode: "subscription_expired" };
  if (status === 429 || status === 503) {
    const seconds = typeof retryAfter === "string" && /^\d+$/.test(retryAfter) ? Number(retryAfter) : typeof retryAfter === "string" ? (Date.parse(retryAfter) - Date.parse(now)) / 1000 : NaN;
    return { outcome: "failed", errorCode: status === 429 ? "rate_limited" : "unavailable", retryAt: new Date(Date.parse(now) + Math.max(30, Math.min(900, Number.isFinite(seconds) ? seconds : 30)) * 1000).toISOString() };
  }
  if (status && status >= 400 && status < 500) return { outcome: "failed", errorCode: "rejected" };
  return { outcome: "unknown", errorCode: "transport_unknown" };
}
/** Starts synchronously after the caller's final authorization commit. No redirects,
 * pooled/proxy agent, response contents or arbitrary upstream errors escape. */
export function sendPushRequest(details: RequestDetails, network: PushNetwork = {}, now?: string): Promise<PushTransportResult> {
  return new Promise(resolve => {
    let request: ReturnType<typeof httpsRequest> | undefined, response: { destroy(): void } | undefined, finished = false;
    const finish = (result: PushTransportResult, abort = false) => {
      if (finished) return; finished = true; clearTimeout(timer);
      resolve(result);
      if (abort) { response?.destroy(); request?.destroy(); }
    };
    const unknown = () => finish({ outcome: "unknown", errorCode: "transport_unknown" }, true);
    const timer = setTimeout(() => finish({ outcome: "unknown", errorCode: "timeout" }, true), 15_000);
    try {
      const captured = generated.get(details);
      if (!captured) throw new PushTransportError();
      generated.delete(details); // One prepared request can never be replayed.
      const url = relay(captured.endpoint);
      const options: RequestOptions = { protocol: "https:", hostname: url.hostname, port: 443, path: url.pathname + url.search, method: "POST", headers: captured.headers, agent: false, rejectUnauthorized: true, lookup: createSafePushLookup(network.lookup), maxHeaderSize: 16_384 };
      request = (network.request || httpsRequest)(options, incoming => {
        response = incoming;
        let bytes = 0;
        incoming.on("error", unknown); incoming.on("aborted", unknown);
        incoming.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16_384) unknown(); });
        incoming.on("end", () => { if (!incoming.complete) unknown(); else finish(responseResult(incoming.statusCode, incoming.headers["retry-after"], now ?? new Date().toISOString())); });
        incoming.on("close", () => { if (!finished) unknown(); });
      });
      request.on("error", unknown);
      request.end(captured.body);
    } catch { unknown(); }
  });
}
