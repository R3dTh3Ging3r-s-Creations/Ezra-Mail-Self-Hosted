import { notificationSetupApi, notificationJson } from "@/lib/email/notification-api";
import { completeNotificationCleanup, completeNotificationCleanupSchema } from "@/lib/email/notification-setup";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return notificationSetupApi(request, async owner => completeNotificationCleanup(owner, await notificationJson(request, completeNotificationCleanupSchema))); }
