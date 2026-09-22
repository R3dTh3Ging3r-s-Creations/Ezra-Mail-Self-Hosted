import { notificationApi } from "@/lib/email/notification-api";
import { getNotificationHistory } from "@/lib/email/notification-history";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return notificationApi(request, getNotificationHistory); }
