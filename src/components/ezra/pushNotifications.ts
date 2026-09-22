import { NotificationClientError, notificationRequest } from "./notificationClient";
import type { NotificationPushSubscriptionStatus } from "@/lib/email/notification-types";

export type CleanupKind = "background_disable" | "device_disable" | "worker_repair";
export type NotificationSetupStatus = {
  origin: string; setupEpoch: number; featureEnabled: boolean;
  currentDevice: { id: string; generation: number } | null;
  pending: { operationId: string; pendingEpoch: number; kind: CleanupKind; startedAt: string; recoveryInstructions: string } | null;
  completion: { operationId: string; pendingEpoch: number; completedAt: string; evidence: "client_settled" | "owner_confirmation" } | null;
};
export type PushConfiguration = { configured: false; reason: string } | { configured: true; reason: string; publicKey: string; vapidKeyFingerprint: string };
export type PushSetup = {
  reason: string; setup: NotificationSetupStatus; configuration: PushConfiguration;
  registration?: ServiceWorkerRegistration; worker?: ServiceWorker; applicationServerKey?: Uint8Array<ArrayBuffer>;
  nativeSubscribed?: boolean;
};
const fail = (code: string): never => { throw new NotificationClientError(code, 409); };
export function ownsNotificationWorker(registration: ServiceWorkerRegistration, origin = window.location.origin) {
  const workers = [registration.active, registration.waiting, registration.installing].filter(Boolean);
  return registration.scope === `${origin}/` && workers.length > 0 && workers.every(worker => worker!.scriptURL === `${origin}/ezra-sw.js`);
}
export async function ownedNotificationRegistration() {
  if (!navigator.serviceWorker) return undefined;
  const registrations = await navigator.serviceWorker.getRegistrations();
  const root = registrations.find(registration => registration.scope === `${window.location.origin}/`);
  if (root && !ownsNotificationWorker(root)) fail("worker_conflict");
  return root;
}
export function getNotificationSetup() { return notificationRequest<NotificationSetupStatus>("setup"); }
function keyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey)) return fail("configuration_unavailable");
  const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) return fail("configuration_unavailable");
  return bytes;
}
function matchesKey(subscription: PushSubscription, expected: Uint8Array) {
  const key = subscription.options?.applicationServerKey;
  if (!key) return false;
  const bytes = new Uint8Array(key);
  return bytes.length === expected.length && bytes.every((value, index) => value === expected[index]);
}
export function notificationWorkerCapability(worker: ServiceWorker): Promise<boolean> {
  if (typeof MessageChannel === "undefined") return Promise.resolve(false);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = (ready: boolean) => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(ready); };
    const timer = setTimeout(() => finish(false), 2000);
    channel.port1.onmessage = event => finish(event.data?.notificationProtocol === 1);
    try { worker.postMessage({ type: "EZRA_NOTIFICATION_CAPABILITIES" }, [channel.port2]); }
    catch { finish(false); }
  });
}
export async function preparePushSetup(configuration: PushConfiguration, setup: NotificationSetupStatus): Promise<PushSetup> {
  const result: PushSetup = { reason: "ready", configuration, setup };
  const unavailable = (reason: string) => ({ ...result, reason });
  if (setup.pending) return unavailable("setup_pending");
  if (!setup.featureEnabled) return unavailable("feature_disabled");
  if (!window.isSecureContext) return unavailable("insecure");
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return unavailable("denied");
  if (typeof PushManager === "undefined" || !navigator.serviceWorker || !PushManager.supportedContentEncodings?.includes("aes128gcm")) return unavailable("unsupported");
  if (!setup.currentDevice) return unavailable("trusted_device_required");
  if (!configuration.configured) return unavailable("configuration_unavailable");
  try {
    result.applicationServerKey = keyBytes(configuration.publicKey);
    const registration = await ownedNotificationRegistration();
    if (!registration?.active || registration.active.state !== "activated") return unavailable("finish_update");
    result.registration = registration; result.worker = registration.active;
    if (!registration.pushManager || typeof registration.showNotification !== "function") return unavailable("unsupported");
    if (!await notificationWorkerCapability(registration.active)) return unavailable(registration.waiting ? "finish_update" : "worker_unavailable");
    if (registration.active !== result.worker) return unavailable("finish_update");
    const subscription = await registration.pushManager.getSubscription();
    result.nativeSubscribed = !!subscription;
    if (subscription && !matchesKey(subscription, result.applicationServerKey)) return unavailable("reenrollment_required");
    return result;
  } catch (error) { return unavailable(error instanceof NotificationClientError ? error.code : "worker_unavailable"); }
}
export async function enableBackgroundDelivery(ready: PushSetup) {
  const { setup, registration, configuration, applicationServerKey } = ready;
  if (ready.reason !== "ready" || !setup.currentDevice || !registration || !applicationServerKey || !configuration.configured) return fail(ready.reason);
  if (setup.origin !== window.location.origin || registration.active !== ready.worker || !ownsNotificationWorker(registration)
    || Notification.permission !== "granted") return fail("setup_stale");
  // This invocation precedes every await: browser user activation is still live.
  const native = registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  const subscription = await native;
  if (!matchesKey(subscription, applicationServerKey)) return fail("reenrollment_required");
  // Never compensate a failed/ambiguous attach with unsubscribe: other tabs share it.
  return notificationRequest<{ subscription: NotificationPushSubscriptionStatus }>(`devices/${encodeURIComponent(setup.currentDevice.id)}/subscription`, {
    method: "POST", signal: AbortSignal.timeout(15000), body: JSON.stringify({
      expectedGeneration: setup.currentDevice.generation, expectedSetupEpoch: setup.setupEpoch,
      expectedVapidKeyFingerprint: configuration.vapidKeyFingerprint, subscription: subscription.toJSON(),
    }),
  });
}

type CleanupOperation = {
  body: { operationId: string; expectedSetupEpoch: number; kind: CleanupKind; current?: { deviceId: string; expectedGeneration: number } };
  begun?: NotificationSetupStatus; settled: boolean; running?: Promise<NotificationSetupStatus>;
};
// Retained across unmounts; no timeout or inferred status releases native work.
const cleanups = new Map<string, CleanupOperation>();
// Replay only retained native settlement; never start fresh cleanup through this path.
export function resumeSettledBrowserPushCleanup(kind: CleanupKind): {
  completion: Promise<NotificationSetupStatus>; current: CleanupOperation["body"]["current"];
} | null {
  const retained = cleanups.get(window.location.origin);
  if (!retained?.settled || retained.body.kind !== kind) return null;
  return { completion: cleanupBrowserPush(kind), current: retained.body.current };
}
export async function cleanupBrowserPush(kind: CleanupKind, onBegin?: (status: NotificationSetupStatus) => void): Promise<NotificationSetupStatus> {
  const origin = window.location.origin;
  let operation = cleanups.get(origin);
  if (operation && operation.body.kind !== kind) return fail("setup_pending");
  if (operation?.running) return operation.running;
  if (!operation) {
    const setup = await getNotificationSetup();
    if (setup.origin !== origin || setup.pending) return fail("setup_pending");
    if (cleanups.has(origin)) return cleanupBrowserPush(kind, onBegin);
    operation = { body: { operationId: crypto.randomUUID(), expectedSetupEpoch: setup.setupEpoch, kind,
      ...(setup.currentDevice ? { current: { deviceId: setup.currentDevice.id, expectedGeneration: setup.currentDevice.generation } } : {}) }, settled: false };
    cleanups.set(origin, operation);
  }
  const captured = operation;
  captured.running = (async () => {
    if (!captured.begun) captured.begun = await notificationRequest<NotificationSetupStatus>("setup/begin", { method: "POST", body: JSON.stringify(captured.body) });
    const pending = captured.begun.pending;
    if (!pending || pending.operationId !== captured.body.operationId || pending.pendingEpoch !== captured.body.expectedSetupEpoch + 1) return fail("setup_operation_mismatch");
    onBegin?.(captured.begun);
    if (!captured.settled) {
      if (!navigator.serviceWorker?.getRegistrations) return fail("native_cleanup_unconfirmed");
      const registration = await ownedNotificationRegistration();
      if (registration && !registration.pushManager?.getSubscription) return fail("native_cleanup_unconfirmed");
      const subscription = await registration?.pushManager?.getSubscription();
      if (registration && !ownsNotificationWorker(registration)) return fail("worker_conflict");
      if (subscription && !await subscription.unsubscribe()) return fail("native_cleanup_unconfirmed");
      if (kind === "worker_repair" && registration) {
        if (!ownsNotificationWorker(registration) || !await registration.unregister()) return fail("native_cleanup_unconfirmed");
      }
      captured.settled = true;
    }
    const completed = await notificationRequest<NotificationSetupStatus>("setup/complete", { method: "POST", body: JSON.stringify({ operationId: pending.operationId, pendingEpoch: pending.pendingEpoch, nativeCleanupSettled: true }) });
    if (cleanups.get(origin) === captured) cleanups.delete(origin);
    return completed;
  })();
  try { return await captured.running; }
  catch (error) {
    // A definite rejected begin performed no native mutation. A fresh action must
    // recapture authority; ambiguous network errors instead retain exact replay.
    if (!captured.begun && error instanceof NotificationClientError && error.status < 500 && cleanups.get(origin) === captured) cleanups.delete(origin);
    throw error;
  }
  finally { captured.running = undefined; }
}
export async function confirmInterruptedCleanup(pending: NonNullable<NotificationSetupStatus["pending"]>) {
  const retained = cleanups.get(window.location.origin);
  if (retained?.running) return fail("setup_pending");
  const result = await notificationRequest<NotificationSetupStatus>("setup/recover", { method: "POST", body: JSON.stringify({ operationId: pending.operationId, pendingEpoch: pending.pendingEpoch, ownerConfirmedNativeCleanup: true }) });
  if (retained?.body.operationId === pending.operationId) cleanups.delete(window.location.origin);
  return result;
}
export function pushSetupMessage(reason: string) {
  if (reason === "checking") return "Checking background setup prerequisites.";
  if (reason === "ready") return "Ready for explicit background setup.";
  if (reason === "feature_disabled") return "Browser notifications are disabled for this installation.";
  if (reason === "configuration_unavailable") return "Background delivery is not configured. Removal remains available.";
  if (reason === "finish_update") return "Finish the app update first: save drafts and close all Ezra tabs and installed windows, then reopen.";
  if (reason === "worker_unavailable") return "The active app connection could not confirm background support. Check for an update and retry.";
  if (reason === "worker_conflict") return "Another worker owns this address. Review this exact origin in browser settings.";
  if (reason === "reenrollment_required") return "Background setup needs renewal. Disable background delivery, then explicitly enable it again with the current origin and key.";
  if (reason === "setup_pending") return "Background setup is paused while an origin cleanup operation is pending.";
  if (reason === "trusted_device_required") return "Enable notifications on this trusted browser first.";
  if (reason === "denied") return "Grant this site's notification permission before enabling background delivery.";
  if (reason === "insecure") return "Open your configured private HTTPS address for background delivery.";
  if (reason === "unsupported") return "Background delivery is unavailable here. On iPhone or iPad, add Ezra to the Home Screen and open it there; browser support is checked when opened.";
  return "Background setup could not be confirmed. Its browser subscription is retained. Refresh settings and explicitly retry; setup may have changed in another window.";
}
