import { z } from "zod";
import { notificationApi, notificationGeneration, notificationId, notificationJson } from "@/lib/email/notification-api";
import { claimForegroundNotification } from "@/lib/email/notification-foreground";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ deliveryId: notificationId, expectedGeneration: notificationGeneration }).strict();
export function POST(request: Request) {
  return notificationApi(request, async (owner) => claimForegroundNotification(owner, await notificationJson(request, schema)));
}
