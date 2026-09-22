import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { AuthError, getAuthSession } from "@/lib/email/auth";
import { finishStepUp } from "@/lib/email/passkeys";

export const runtime = "nodejs";

const schema = z.object({
  challengeId: z.string().min(1).max(200),
  action: z.string().min(1).max(100),
  response: z.record(z.unknown()),
});

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = schema.parse(await request.json());
    const session = await getAuthSession(request);
    if (!session.trustedDevice) throw new AuthError("Use a trusted device for owner security confirmation.", 403);
    return finishStepUp(request, {
      ...body,
      deviceId: session.trustedDevice?.id,
      response: body.response as never,
    });
  });
}
