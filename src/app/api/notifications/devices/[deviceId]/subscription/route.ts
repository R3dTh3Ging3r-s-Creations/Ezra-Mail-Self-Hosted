import { foregroundBrowserNotificationsEnabled } from "@/lib/email/foreground-notifications";
import { notificationSetupEpoch } from "@/lib/email/notification-setup-schema";
import { z } from "zod";
import { notificationApi, notificationGeneration, notificationJson } from "@/lib/email/notification-api";
import { auditNotificationMutation, currentNotificationDevice, requireBrowserNotifications } from "@/lib/email/notification-enrollment";
import { attachPushSubscription, getPushSubscriptionStatus, removePushSubscription } from "@/lib/email/notification-subscriptions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ deviceId: string }> };
const removalSchema = z.object({ expectedGeneration: notificationGeneration }).strict();
const attachSchema = removalSchema.extend({ expectedSetupEpoch: notificationSetupEpoch, expectedVapidKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/), subscription: z.object({ endpoint: z.string().max(2048), expirationTime: z.number().finite().nullable(), keys: z.object({ p256dh: z.string().max(100), auth: z.string().max(32) }).strict() }).strict() }).strict();
export function POST(request: Request, context: Context) {
  return notificationApi(request, async (owner) => {
    requireBrowserNotifications();
    const input = await notificationJson(request, attachSchema);
    const device = await currentNotificationDevice(owner, (await context.params).deviceId, input.expectedGeneration);
    const subscription = await attachPushSubscription({ ...owner, expectedSetupEpoch: input.expectedSetupEpoch, deviceId: device.id, generation: input.expectedGeneration, subscription: input.subscription, expectedVapidKeyFingerprint: input.expectedVapidKeyFingerprint });
    await auditNotificationMutation(device.id, device.generation, "rotated");
    return { subscription };
  });
}
export function DELETE(request: Request, context: Context) {
  return notificationApi(request, async (owner) => {
    const input = await notificationJson(request, removalSchema);
    const device = await currentNotificationDevice(owner, (await context.params).deviceId, input.expectedGeneration);
    const subscription = await removePushSubscription({ ...owner, deviceId: device.id, generation: input.expectedGeneration });
    await auditNotificationMutation(device.id, device.generation, "revoked");
    return { subscription };
  });
}

export function GET(request: Request, context: Context) {
  return notificationApi(request, async (owner) => {
    const device = await currentNotificationDevice(owner, (await context.params).deviceId, undefined, { readOnly: true });
    const subscription = await getPushSubscriptionStatus({ ...owner, deviceId: device.id, generation: device.generation });
    return { generation: device.generation, subscription,
      deliveryEnabled: foregroundBrowserNotificationsEnabled() && device.permission === "granted" && device.capabilities.push && subscription.subscribed };
  });
}
