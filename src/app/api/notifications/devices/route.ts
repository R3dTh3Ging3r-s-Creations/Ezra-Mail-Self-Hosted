import { notificationApi, notificationJson } from "@/lib/email/notification-api";
import { enrollmentSchema, enrollBrowserNotification, notificationInventory } from "@/lib/email/notification-enrollment";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return notificationApi(request, notificationInventory); }
export function POST(request: Request) { return notificationApi(request, async (owner) => enrollBrowserNotification(owner, await notificationJson(request, enrollmentSchema))); }
