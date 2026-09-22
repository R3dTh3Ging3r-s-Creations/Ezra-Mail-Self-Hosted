import { NotificationApiError, notificationApi } from "@/lib/email/notification-api";
import { getSharedForegroundFeed } from "@/lib/email/notification-foreground";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return notificationApi(request, async (owner) => {
    if (new URL(request.url).search) throw new NotificationApiError("invalid_request", 400);
    return getSharedForegroundFeed(owner);
  });
}
