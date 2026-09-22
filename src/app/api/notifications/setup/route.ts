import { notificationSetupApi } from "@/lib/email/notification-api";
import { notificationSetupStatus } from "@/lib/email/notification-setup";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return notificationSetupApi(request, notificationSetupStatus); }
