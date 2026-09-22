import { notificationSetupApi, notificationJson } from "@/lib/email/notification-api";
import { beginNotificationCleanup, beginNotificationCleanupSchema } from "@/lib/email/notification-setup";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return notificationSetupApi(request, async owner => beginNotificationCleanup(owner, await notificationJson(request, beginNotificationCleanupSchema))); }
