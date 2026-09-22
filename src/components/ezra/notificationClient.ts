import type { NotificationDeviceChannel, NotificationPlatform } from "@/lib/email/notification-types";

export type NotificationDeviceInfo = {
  id: string; origin: string; generation: number; channel: NotificationDeviceChannel;
  platform: NotificationPlatform; permission: NotificationPermission;
  capabilities: { foreground: boolean; push: boolean }; detailedCopy: boolean;
  createdAt: string; updatedAt: string; revokedAt: string | null;
  lastSuccessAt: string | null; lastFailureAt: string | null;
  lastDisplayedAt: string | null; lastClickedAt: string | null;
};
export type NotificationInventory = { telegramConfiguration?: { configured: boolean; enrolled: boolean; deviceId: string | null; reason: string; disclosure: string }; devices: NotificationDeviceInfo[]; currentDeviceId: string | null; pushConfiguration?: import("./pushNotifications").PushConfiguration };
export class NotificationClientError extends Error {
  constructor(readonly code: string, readonly status: number) { super("Notification setup could not be completed."); }
}
export async function notificationRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/notifications/${path}`, { ...init, cache: "no-store", headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const value = await response.json();
  if (!response.ok) throw new NotificationClientError(typeof value.code === "string" ? value.code : "unavailable", response.status);
  return value as T;
}
export function removeBrowserEnrollment(deviceId: string, generation: number) {
  return notificationRequest<{ removed: boolean }>(`devices/${encodeURIComponent(deviceId)}`, { method: "DELETE", body: JSON.stringify({ expectedGeneration: generation }) });
}
export function notificationSetupMessage(error: unknown) {
  if (error instanceof NotificationClientError) {
    if (error.status === 401) return "Sign in again to finish notification setup.";
    if (error.code === "trusted_device_required") return "Open Settings > System > Trusted devices and enroll this browser as a trusted device. Password-only sessions, bypass, and unconfigured owner protection cannot enroll notifications.";
    if (error.code === "feature_disabled") return "Browser notifications are disabled for this installation.";
    if (error.code.startsWith("origin_")) return "Notification setup needs a configured, allowed Ezra origin. Review this installation's public address.";
    if (error.code === "stale_generation" || error.code === "device_unavailable") return "Notification setup changed in another window. Refresh these settings before trying again.";
  }
  return "Notification setup could not be saved. Check the connection and site storage, then try again.";
}
