import { authenticated } from "@/lib/email/api";
import { AuthError, getAuthSession } from "@/lib/email/auth";
import { beginPasskeyRegistration } from "@/lib/email/passkeys";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const session = await getAuthSession(request);
    if (!session.trustedDevice) throw new AuthError("Trust this device before adding an owner passkey.", 409);
    return beginPasskeyRegistration(request, { deviceId: session.trustedDevice?.id });
  });
}
