import { notificationSetupApi, notificationJson } from "@/lib/email/notification-api";
import { recoverNotificationCleanup, recoverNotificationCleanupSchema } from "@/lib/email/notification-setup";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return notificationSetupApi(request, async owner => recoverNotificationCleanup(owner, await notificationJson(request, recoverNotificationCleanupSchema))); }
