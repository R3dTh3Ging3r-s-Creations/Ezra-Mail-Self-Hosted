import { z } from "zod";
import { NotificationApiError, notificationApi, notificationGeneration, notificationId, notificationJson } from "@/lib/email/notification-api";
import { getActiveTelegramBinding, telegramEnrollmentStatus } from "@/lib/email/notification-telegram";
import { sendTelegramConnectionTest } from "@/lib/email/telegram";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("test"), deviceId: notificationId, expectedGeneration: notificationGeneration }).strict(),
  z.object({ command: z.enum(["start", "stop", "status"]) }).strict(),
]);
async function status(owner: {trustedDeviceId:string;origin:string}) {
  return { ...await telegramEnrollmentStatus(owner), running: null, polling: process.env.TELEGRAM_POLLING_ENABLED === "false" ? "disabled" : "worker_managed" };
}
export function GET(request: Request) { return notificationApi(request, async owner => ({ telegram: await status(owner) })); }
export function POST(request: Request) {
  return notificationApi(request, async owner => {
    const body = await notificationJson(request, schema);
    if (body.command === "start" || body.command === "stop") throw new NotificationApiError("use_notification_inventory_controls", 409);
    if (body.command === "test") {
      const binding = await getActiveTelegramBinding(body.deviceId);
      if (!binding || binding.generation !== body.expectedGeneration) throw new NotificationApiError("device_unavailable", 409);
      return { telegram: await status(owner), test: await sendTelegramConnectionTest(owner, { deviceId: body.deviceId, generation: body.expectedGeneration }) };
    }
    return { telegram: await status(owner) };
  });
}
