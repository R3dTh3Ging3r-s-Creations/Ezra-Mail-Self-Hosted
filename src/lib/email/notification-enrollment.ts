import { readTelegramConfiguration, telegramEnrollmentStatus, telegramPrivacyDisclosure } from "./notification-telegram";
import { notificationSetupEpoch } from "./notification-setup-schema";
import { z } from "zod";
import { audit } from "./database";
import { foregroundBrowserNotificationsEnabled } from "./foreground-notifications";
import { getPushConfigurationStatus } from "./notification-crypto";
import { NotificationApiError, notificationGeneration, notificationId, type NotificationOwner } from "./notification-api";
import { cancelNotificationDeviceWork, enrollNotificationDevice, listNotificationDevices, revokeNotificationDevice, withNotificationStoreWrite } from "./notification-store";
import type { NotificationDevice } from "./notification-types";

export const notificationPermission = z.enum(["default", "granted", "denied"]);
const enrollmentFields = { platform: z.enum(["windows", "macos", "linux", "android", "ios", "other"]), permission: notificationPermission, capabilities: z.object({ foreground: z.boolean(), push: z.boolean() }).strict() };
export const enrollmentSchema = z.discriminatedUnion("channel", [
  z.object({ ...enrollmentFields, expectedSetupEpoch: notificationSetupEpoch, channel: z.literal("browser") }).strict(),
  z.object({ ...enrollmentFields, channel: z.literal("telegram") }).strict(),
]);
export const devicePatchSchema = z.object({ expectedGeneration: notificationGeneration, detailedCopy: z.boolean().optional(), permission: notificationPermission.optional() }).strict().refine((value) => value.detailedCopy !== undefined || value.permission !== undefined);
/** Explicit allowlist. Store/internal identity and transport errors never cross the API. */
export function publicNotificationDevice(device: NotificationDevice) {
  return { id: device.id, origin: device.origin, channel: device.channel, platform: device.platform, permission: device.permission, capabilities: { foreground: device.capabilities.foreground, push: device.capabilities.push }, detailedCopy: device.privacy === "detailed", generation: device.generation, createdAt: device.createdAt, updatedAt: device.updatedAt, revokedAt: device.revokedAt, lastSuccessAt: device.lastSuccessAt, lastDisplayedAt: device.lastDisplayedAt, lastClickedAt: device.lastClickedAt, lastFailureAt: device.lastFailureAt };
}
export function requireBrowserNotifications() {
  if (!foregroundBrowserNotificationsEnabled()) throw new NotificationApiError("feature_disabled", 503);
}
export async function notificationInventory(owner: NotificationOwner) {
  const devices = await listNotificationDevices();
  const current = devices.find((device) => device.channel === "browser" && device.trustedDeviceId === owner.trustedDeviceId && device.origin === owner.origin && !device.revokedAt);
  return { telegramConfiguration: await telegramEnrollmentStatus(owner), devices: devices.map(publicNotificationDevice), currentDeviceId: current?.id ?? null, pushConfiguration: foregroundBrowserNotificationsEnabled() ? getPushConfigurationStatus() : { configured: false, reason: "feature_disabled" } };
}
export async function currentNotificationDevice(owner: NotificationOwner, deviceId?: string, generation?: number, options: { readOnly?: boolean } = {}) {
  if (deviceId !== undefined) notificationId.parse(deviceId);
  const device = (await listNotificationDevices(options)).find((item) => item.channel === "browser" && item.trustedDeviceId === owner.trustedDeviceId && item.origin === owner.origin && (!deviceId || item.id === deviceId));
  if (!device) throw new NotificationApiError("device_forbidden", 403);
  if (device.revokedAt || (generation !== undefined && device.generation !== generation)) throw new NotificationApiError("device_unavailable", 409);
  return device;
}
export async function auditNotificationMutation(deviceId: string, generation: number, action: "enrolled" | "rotated" | "revoked") {
  await audit(`notification.device.${action}`, "owner", "notification_device", deviceId, { deviceId, generation, action, status: "completed" });
}
export async function enrollBrowserNotification(owner: NotificationOwner, input: z.infer<typeof enrollmentSchema>) {
  if (input.channel === "telegram") {
    const configuration = readTelegramConfiguration();
    if (!configuration) throw new NotificationApiError("channel_unavailable", 503);
    if (input.permission !== "granted" || input.capabilities.foreground || input.capabilities.push) throw new NotificationApiError("invalid_request", 400);
    const device = await enrollNotificationDevice({ ...input, ...owner, telegramBindingFingerprint: configuration.fingerprint });
    await auditNotificationMutation(device.id, device.generation, device.generation === 1 ? "enrolled" : "rotated");
    return { device: publicNotificationDevice(device), disclosure: telegramPrivacyDisclosure };
  }
  requireBrowserNotifications();
  const device = await enrollNotificationDevice({ ...input, ...owner, capabilities: { foreground: input.permission === "granted" && input.capabilities.foreground, push: false } });
  await auditNotificationMutation(device.id, device.generation, device.generation === 1 ? "enrolled" : "rotated");
  return { device: publicNotificationDevice(device) };
}
export async function patchNotificationDevice(owner: NotificationOwner, deviceId: string, input: z.infer<typeof devicePatchSchema>) {
  notificationId.parse(deviceId);
  await withNotificationStoreWrite(async (tx) => {
    const result = await tx.execute({ sql: "SELECT d.* FROM notification_devices d JOIN trusted_devices t ON t.id=d.trusted_device_id WHERE d.id=? AND d.trusted_device_id=? AND d.origin=? AND t.revoked_at IS NULL", args: [deviceId, owner.trustedDeviceId, owner.origin] });
    const device = result.rows[0];
    if (!device) throw new NotificationApiError("device_forbidden", 403);
    if (device.revoked_at || Number(device.generation) !== input.expectedGeneration || (input.permission === "granted" && device.permission !== "granted")) throw new NotificationApiError("device_unavailable", 409);
    const now = new Date().toISOString(), disable = input.permission !== undefined && input.permission !== "granted";
    await tx.execute({ sql: "UPDATE notification_devices SET privacy=?,permission=?,foreground=CASE WHEN ? THEN 0 ELSE foreground END,push=CASE WHEN ? THEN 0 ELSE push END,subscription_ciphertext=CASE WHEN ? THEN NULL ELSE subscription_ciphertext END,subscription_fingerprint=CASE WHEN ? THEN NULL ELSE subscription_fingerprint END,telegram_binding_fingerprint=CASE WHEN ? THEN NULL ELSE telegram_binding_fingerprint END,updated_at=? WHERE id=? AND generation=? AND revoked_at IS NULL", args: [input.detailedCopy === undefined ? device.privacy : input.detailedCopy ? "detailed" : "generic", input.permission ?? device.permission, +disable, +disable, +disable, +disable, +disable, now, deviceId, input.expectedGeneration] });
    if (disable) await cancelNotificationDeviceWork(tx, deviceId, now);
  });
  if (input.permission && input.permission !== "granted" && !await (await import("./notification-telegram")).getActiveTelegramBinding()) (await import("./telegram")).stopTelegramPolling();
  const device = (await listNotificationDevices()).find(item => item.id === deviceId && item.trustedDeviceId === owner.trustedDeviceId && item.origin === owner.origin);
  if (!device || device.revokedAt || device.generation !== input.expectedGeneration) throw new NotificationApiError("device_unavailable", 409);
  return { device: publicNotificationDevice(device) };
}
export async function removeNotificationDevice(deviceId: string, conditional?: { owner: NotificationOwner; expectedGeneration: number }, inventoryOwner?: NotificationOwner) {
  notificationId.parse(deviceId);
  const device = (await listNotificationDevices()).find((item) => item.id === deviceId);
  if (device?.channel === "telegram" && !conditional) {
    if (!inventoryOwner) throw new NotificationApiError("device_forbidden", 403);
    conditional = { owner: inventoryOwner, expectedGeneration: device.generation };
  }
  const result = await revokeNotificationDevice({ deviceId, ...(conditional ? { expectedOwner: { ...conditional.owner, generation: conditional.expectedGeneration } } : {}) });
  if (result !== "removed") throw new NotificationApiError(result, result === "stale_generation" ? 409 : 403);
  if (device?.channel === "telegram" && !await (await import("./notification-telegram")).getActiveTelegramBinding()) (await import("./telegram")).stopTelegramPolling();
  if (device) await auditNotificationMutation(device.id, device.generation, "revoked");
  return { removed: true };
}
