import { z } from "zod";
import { NotificationApiError, notificationApi, notificationGeneration, notificationId, notificationJson } from "@/lib/email/notification-api";
import { currentNotificationDevice } from "@/lib/email/notification-enrollment";
import { recordBrowserNotificationReceipt } from "@/lib/email/notification-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ attemptId: notificationId, generation: notificationGeneration, kind: z.enum(["foreground_shown", "foreground_failed", "displayed", "clicked"]) }).strict();
export function POST(request: Request) {
  return notificationApi(request, async (owner) => {
    const input = await notificationJson(request, schema);
    const device = await currentNotificationDevice(owner, undefined, input.generation);
    const receipt = await recordBrowserNotificationReceipt({ ...input, ...owner, deviceId: device.id });
    if (!receipt) throw new NotificationApiError("receipt_forbidden", 403);
    return { recorded: true };
  });
}
