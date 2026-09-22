import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { revokeTrustedDevice } from "@/lib/email/auth";

export const runtime = "nodejs";

const paramsSchema = z.object({ deviceId: z.string().min(1).max(200) });

export async function DELETE(request: Request, context: { params: Promise<{ deviceId: string }> }) {
  return authenticated(request, async () => {
    const { deviceId } = paramsSchema.parse(await context.params);
    return revokeTrustedDevice(deviceId, "settings");
  });
}
