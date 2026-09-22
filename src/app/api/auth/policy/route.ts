import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { AuthError, getAuthSession } from "@/lib/email/auth";
import { audit, setSetting } from "@/lib/email/database";
import { consumeStepUpReceipt } from "@/lib/email/passkeys";

export const runtime = "nodejs";

const schema = z.object({
  action: z.enum(["disable_bypass", "enable_bypass"]),
  receiptId: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = schema.parse(await request.json());
    const session = await getAuthSession(request);
    if (!session.trustedDevice) throw new AuthError("Use a trusted device for owner security changes.", 403);
    await consumeStepUpReceipt({
      receiptId: body.receiptId,
      action: "change_auth_policy",
      deviceId: session.trustedDevice.id,
    });
    const disabled = body.action === "disable_bypass";
    await setSetting("auth_bypass_disabled", disabled ? "true" : "false");
    await audit("auth.policy.changed", "owner", "auth_policy", "private_install_bypass", {
      bypassEnabled: !disabled,
      deviceId: session.trustedDevice.id,
    });
    return { bypassActive: !disabled };
  });
}
