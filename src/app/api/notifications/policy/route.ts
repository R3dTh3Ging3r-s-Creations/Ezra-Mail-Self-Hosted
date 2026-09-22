import { notificationApi, notificationJson } from "@/lib/email/notification-api";
import {
  getNotificationPolicyCenter,
  notificationPolicyUpdateSchema,
  updateNotificationPolicy,
} from "@/lib/email/notification-center";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return notificationApi(request, () => getNotificationPolicyCenter());
}

export async function PATCH(request: Request) {
  return notificationApi(request, async () => {
    const body = await notificationJson(request, notificationPolicyUpdateSchema());
    return updateNotificationPolicy(body);
  });
}
