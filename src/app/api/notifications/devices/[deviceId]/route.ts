import { z } from "zod";
import { notificationApi, notificationJson, notificationGeneration } from "@/lib/email/notification-api";
import { devicePatchSchema, patchNotificationDevice, removeNotificationDevice } from "@/lib/email/notification-enrollment";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ deviceId: string }> };
export function PATCH(request: Request, context: Context) { return notificationApi(request, async (owner) => patchNotificationDevice(owner, (await context.params).deviceId, await notificationJson(request, devicePatchSchema))); }
export function DELETE(request: Request, context: Context) {
  return notificationApi(request, async (owner) => {
    const input = request.body ? await notificationJson(request, z.object({ expectedGeneration: notificationGeneration.optional() }).strict()) : {};
    return removeNotificationDevice((await context.params).deviceId, input.expectedGeneration === undefined ? undefined : { owner, expectedGeneration: input.expectedGeneration }, owner);
  });
}
