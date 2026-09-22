import { z } from "zod";
import { NotificationApiError, notificationApi, notificationId, notificationJson } from "@/lib/email/notification-api";
import { currentNotificationDevice } from "@/lib/email/notification-enrollment";
import { recordNotificationFeedback } from "@/lib/email/notification-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ eventId: notificationId, kind: z.enum(["useful", "too_noisy"]) }).strict();
export function POST(request: Request) {
  return notificationApi(request, async (owner) => {
    const input = await notificationJson(request, schema);
    const device = await currentNotificationDevice(owner);
    const feedback = await recordNotificationFeedback({ ...input, deviceId: device.id });
    if (!feedback) throw new NotificationApiError("feedback_forbidden", 403);
    return { recorded: true };
  });
}
