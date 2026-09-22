import { authority, matchesHost, configuredOrigins, NotificationOriginError } from "./notification-origin";
import { z } from "zod";
import { getAuthSession } from "./auth";
import { PushSubscriptionError } from "./notification-crypto";
import { NotificationSetupError } from "./notification-setup-schema";

export class NotificationApiError extends Error {
  constructor(public code: string, public status: number) { super("Notification request could not be completed."); }
}
export type NotificationSetupOwner = { trustedDeviceId: string | null; origin: string };
export type NotificationOwner = { trustedDeviceId: string; origin: string };
export const notificationId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
export const notificationGeneration = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
function rejectOrigin(): never { throw new NotificationApiError("origin_not_allowed", 403); }
export function resolveNotificationOrigin(request: Request): string {
  const configured = configuredOrigins();
  const incomingHost = request.headers.get("host");
  let candidates: URL[];
  if (incomingHost !== null) {
    const parsed = authority(incomingHost);
    candidates = configured.filter((url) => matchesHost(parsed, url));
  } else {
    const internal = new URL(request.url);
    candidates = configured.filter((url) => url.origin === internal.origin && !internal.username && !internal.password);
  }
  if (candidates.length !== 1) rejectOrigin();
  const resolved = candidates[0].origin, origin = request.headers.get("origin");
  const mutation = request.method !== "GET" && request.method !== "HEAD";
  if ((mutation && origin === null) || (origin !== null && origin !== resolved) || (mutation && request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site")) rejectOrigin();
  return resolved;
}

/** Bound raw stream bytes before UTF-8 decoding or JSON/schema parsing. */
export async function notificationJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new NotificationApiError("unsupported_media_type", 415);
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 8192)) throw new NotificationApiError("body_too_large", 413);
  if (!request.body) throw new NotificationApiError("invalid_request", 400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 8192) { void reader.cancel().catch(() => undefined); throw new NotificationApiError("body_too_large", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error instanceof NotificationApiError) throw error;
    throw new NotificationApiError("invalid_request", 400);
  } finally { reader.releaseLock(); }
}
export function notificationApi(request: Request, operation: (owner: NotificationOwner) => Promise<unknown>): Promise<Response> {
  return notificationOwnerApi(request, owner => operation(owner as NotificationOwner), true);
}
/** Cleanup/status also allow a configured password session; enrollment keeps its stricter wrapper. */
export function notificationSetupApi(request: Request, operation: (owner: NotificationSetupOwner) => Promise<unknown>): Promise<Response> {
  return notificationOwnerApi(request, operation, false);
}
async function notificationOwnerApi(request: Request, operation: (owner: NotificationSetupOwner) => Promise<unknown>, requireTrusted: boolean): Promise<Response> {
  try {
    const origin = resolveNotificationOrigin(request), session = await getAuthSession(request);
    if (!session.authenticated) throw new NotificationApiError("authentication_required", 401);
    if (!session.configured || session.developmentBypass || (requireTrusted && !session.trustedDevice)) throw new NotificationApiError("trusted_device_required", 403);
    const result = await operation({ trustedDeviceId: session.trustedDevice?.id ?? null, origin });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    let code = "notification_unavailable", status = 503;
    if (error instanceof NotificationApiError || error instanceof NotificationOriginError) { code = error.code; status = error.status; }
    else if (error instanceof NotificationSetupError) { code = error.code; status = 409; }
    else if (error instanceof z.ZodError) { code = "invalid_request"; status = 400; }
    else if (error instanceof PushSubscriptionError) { code = error.code; status = code === "configuration_unavailable" ? 503 : code === "invalid_subscription" ? 400 : 409; }
    return Response.json({ code, message: "Notification request could not be completed." }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
