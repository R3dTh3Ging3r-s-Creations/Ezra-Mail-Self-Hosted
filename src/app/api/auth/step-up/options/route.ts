import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { AuthError, getAuthSession } from "@/lib/email/auth";
import { beginStepUp } from "@/lib/email/passkeys";

export const runtime = "nodejs";

const schema = z.object({ action: z.string().min(1).max(100) });

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = schema.parse(await request.json());
    const session = await getAuthSession(request);
    if (!session.trustedDevice) throw new AuthError("Use a trusted device for owner security confirmation.", 403);
    return beginStepUp(request, { action: body.action, deviceId: session.trustedDevice?.id });
  });
}
