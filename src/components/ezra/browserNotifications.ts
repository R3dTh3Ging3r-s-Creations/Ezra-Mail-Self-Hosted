import { cleanupBrowserPush, getNotificationSetup, type NotificationSetupStatus } from "./pushNotifications";
import type { NotificationPlatform } from "@/lib/email/notification-types";
import { notificationRequest, removeBrowserEnrollment, type NotificationDeviceInfo } from "./notificationClient";

export const BROWSER_NOTIFICATION_STORAGE_KEY = "ezra-mail-browser-notifications-enabled";
export const BROWSER_NOTIFICATION_ENROLLMENT_EVENT = "ezra-mail-browser-notification-enrollment-changed";
export type BrowserNotificationRuntime = {
  origin: string; isSecureContext: boolean;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  notification: { permission: NotificationPermission; requestPermission: () => Promise<NotificationPermission>; show: (title: string, options: NotificationOptions, onClick?: () => void) => void } | null;
};
export type BrowserNotificationEnrollment = { origin: string; enabled: boolean; deviceId: string; generation: number };
export type BrowserNotificationState = {
  kind: "unsupported" | "insecure" | "permission_unavailable" | "storage_unavailable" | "prompt" | "denied" | "disabled" | "enabled" | "legacy" | "removal_pending";
  origin: string; permission: NotificationPermission | null; enrollment: BrowserNotificationEnrollment | null;
};
export class BrowserNotificationOperationError extends Error {
  constructor(readonly code: "permission" | "storage" | "show" | "removal") { super(`Browser notification ${code} operation failed.`); }
}
// Immediately stop this tab even if persistent site storage becomes unavailable.
const paused = new Set<string>();
const enrollmentOperations = new Map<string, number>();
const identity = (value: BrowserNotificationEnrollment) => `${value.origin}/${value.deviceId}/${value.generation}`;
function stored(runtime: BrowserNotificationRuntime): Record<string, unknown> | null {
  if (!runtime.storage) throw new BrowserNotificationOperationError("storage");
  let value: string | null;
  try { value = runtime.storage.getItem(BROWSER_NOTIFICATION_STORAGE_KEY); } catch { throw new BrowserNotificationOperationError("storage"); }
  try { const parsed = JSON.parse(value || "null"); return parsed && typeof parsed === "object" ? parsed : null; } catch { return null; }
}
export function readBrowserNotificationEnrollment(runtime = browserNotificationRuntime()): BrowserNotificationEnrollment | null {
  const saved = stored(runtime);
  if (saved?.origin !== runtime.origin || typeof saved.enabled !== "boolean" || typeof saved.deviceId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(saved.deviceId) || !Number.isSafeInteger(saved.generation) || Number(saved.generation) < 1) return null;
  return { origin: runtime.origin, enabled: saved.enabled, deviceId: saved.deviceId, generation: Number(saved.generation) };
}
export function readBrowserNotificationState(runtime = browserNotificationRuntime()): BrowserNotificationState {
  const result: BrowserNotificationState = { kind: "disabled", origin: runtime.origin, permission: null, enrollment: null };
  if (!runtime.notification) return { ...result, kind: "unsupported" };
  if (!runtime.isSecureContext) return { ...result, kind: "insecure" };
  try { result.permission = runtime.notification.permission; } catch { return { ...result, kind: "permission_unavailable" }; }
  try {
    result.enrollment = readBrowserNotificationEnrollment(runtime);
    if (result.enrollment && (!result.enrollment.enabled || paused.has(identity(result.enrollment)))) return { ...result, kind: "removal_pending" };
    if (result.permission === "denied") return { ...result, kind: "denied" };
    if (result.permission !== "granted") return { ...result, kind: "prompt" };
    if (result.enrollment) return { ...result, kind: "enabled" };
    const legacy = stored(runtime);
    return { ...result, kind: legacy?.origin === runtime.origin && legacy.enabled === true ? "legacy" : "disabled" };
  } catch { return { ...result, kind: "storage_unavailable" }; }
}
function persist(value: BrowserNotificationEnrollment, runtime: BrowserNotificationRuntime) {
  try { if (!runtime.storage) throw new Error(); runtime.storage.setItem(BROWSER_NOTIFICATION_STORAGE_KEY, JSON.stringify(value)); }
  catch { throw new BrowserNotificationOperationError("storage"); }
}
export function clearMatchingBrowserEnrollment(expected: BrowserNotificationEnrollment, runtime = browserNotificationRuntime()) {
  const current = readBrowserNotificationEnrollment(runtime);
  if (!current || identity(current) !== identity(expected)) return;
  try { runtime.storage!.removeItem(BROWSER_NOTIFICATION_STORAGE_KEY); } catch { throw new BrowserNotificationOperationError("storage"); }
  dispatchBrowserNotificationEnrollmentChange();
}
export async function enableBrowserNotifications(runtime = browserNotificationRuntime(), isCurrent = () => true, capturedSetup?: NotificationSetupStatus) {
  const current = readBrowserNotificationState(runtime);
  if (!runtime.notification || !["prompt", "disabled", "legacy"].includes(current.kind)) return current;
  const operation = (enrollmentOperations.get(runtime.origin) || 0) + 1;
  enrollmentOperations.set(runtime.origin, operation);
  let externallyChanged = false;
  const onStorage = (event: StorageEvent) => { if (!event.key || event.key === BROWSER_NOTIFICATION_STORAGE_KEY) externallyChanged = true; };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  const active = () => isCurrent() && !externallyChanged && enrollmentOperations.get(runtime.origin) === operation;
  try {
    let permission: NotificationPermission;
    // Called synchronously from the Enable gesture, before any server await.
    try { permission = current.permission === "granted" ? "granted" : await runtime.notification.requestPermission(); }
    catch { throw new BrowserNotificationOperationError("permission"); }
    if (permission !== "granted" || !active()) return readBrowserNotificationState(runtime);
    const setup = capturedSetup ?? await getNotificationSetup();
    if (setup.pending || setup.origin !== runtime.origin || !active()) throw new DOMException("Enrollment superseded", "AbortError");
    const response = await notificationRequest<{ device: NotificationDeviceInfo }>("devices", { method: "POST", body: JSON.stringify({ expectedSetupEpoch: setup.setupEpoch, channel: "browser", platform: notificationPlatform(), permission, capabilities: { foreground: true, push: false } }) });
    const enrollment: BrowserNotificationEnrollment = { origin: runtime.origin, enabled: true, deviceId: response.device.id, generation: response.device.generation };
    try {
      const latest = readBrowserNotificationEnrollment(runtime);
      if (!active() || (latest && latest.generation > enrollment.generation && latest.deviceId === enrollment.deviceId)) throw new DOMException("Enrollment superseded", "AbortError");
      persist(enrollment, runtime);
      paused.delete(identity(enrollment));
      dispatchBrowserNotificationEnrollmentChange();
    } catch (error) {
      // Conditional rollback only: never revoke a newer tab's enrollment.
      try { await removeBrowserEnrollment(enrollment.deviceId, enrollment.generation); }
      catch { throw new BrowserNotificationOperationError("removal"); }
      clearMatchingBrowserEnrollment(enrollment, runtime);
      throw error;
    }
    return readBrowserNotificationState(runtime);
  } finally { if (typeof window !== "undefined") window.removeEventListener("storage", onStorage); }
}
export async function disableBrowserNotifications(runtime = browserNotificationRuntime()) {
  enrollmentOperations.set(runtime.origin, (enrollmentOperations.get(runtime.origin) || 0) + 1);
  const enrollment = readBrowserNotificationEnrollment(runtime);
  if (!enrollment) return readBrowserNotificationState(runtime);
  paused.add(identity(enrollment));
  let storageFailed = false;
  try { persist({ ...enrollment, enabled: false }, runtime); paused.delete(identity(enrollment)); } catch { storageFailed = true; }
  dispatchBrowserNotificationEnrollmentChange();
  await cleanupBrowserPush("device_disable");
  clearMatchingBrowserEnrollment(enrollment, runtime);
  if (storageFailed) throw new BrowserNotificationOperationError("storage");
  return readBrowserNotificationState(runtime);
}
export function sendBrowserNotificationTest(runtime = browserNotificationRuntime()) {
  if (readBrowserNotificationState(runtime).kind !== "enabled") throw new BrowserNotificationOperationError("show");
  showForegroundNotification({ title: "Ezra Mail", body: "Notifications are working on this browser.", tag: "ezra-mail-notification-test" }, undefined, runtime);
}
export function showForegroundNotification(event: { title: string; body: string; tag: string }, onOpen?: () => void, runtime = browserNotificationRuntime()) {
  if (!runtime.notification || readBrowserNotificationState(runtime).kind !== "enabled") throw new BrowserNotificationOperationError("show");
  try { runtime.notification.show(event.title, { body: event.body, tag: event.tag }, onOpen); }
  catch { throw new BrowserNotificationOperationError("show"); }
}
function notificationPlatform(): NotificationPlatform {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/android/i.test(agent)) return "android";
  if (/iphone|ipad|ipod/i.test(agent)) return "ios";
  if (/windows/i.test(agent)) return "windows";
  if (/macintosh/i.test(agent)) return "macos";
  if (/linux/i.test(agent) && !/jsdom/i.test(agent)) return "linux";
  return "other";
}
function browserNotificationRuntime(): BrowserNotificationRuntime {
  const NativeNotification = "Notification" in window ? window.Notification : null;
  let storage: BrowserNotificationRuntime["storage"] = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return {
    origin: window.location.origin,
    isSecureContext: window.isSecureContext,
    storage,
    notification: NativeNotification ? {
      get permission() { return NativeNotification.permission; },
      requestPermission: () => NativeNotification.requestPermission(),
      show: (title, options, onClick) => {
        const notification = new NativeNotification(title, options);
        if (!onClick) return;
        let opened = false;
        notification.onclick = () => {
          if (opened) return;
          opened = true;
          try { window.focus(); } catch {}
          try { onClick(); } catch {}
          try { notification.close(); } catch {}
        };
      },
    } : null,
  };
}

export function dispatchBrowserNotificationEnrollmentChange() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BROWSER_NOTIFICATION_ENROLLMENT_EVENT));
}

/** Merge only the generation captured by this action, never a later enrollment. */
export function reconcileBackgroundCleanup(expected: BrowserNotificationEnrollment | null, status: NotificationSetupStatus, runtime = browserNotificationRuntime()) {
  if (!expected || status.origin !== runtime.origin) return;
  const current = readBrowserNotificationEnrollment(runtime), device = status.currentDevice;
  if (!current || identity(current) !== identity(expected) || !device || device.id !== expected.deviceId || device.generation !== expected.generation + 1) return;
  persist({ ...current, generation: device.generation }, runtime);
  dispatchBrowserNotificationEnrollmentChange();
}
