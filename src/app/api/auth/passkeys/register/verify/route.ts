import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { getAuthSession } from "@/lib/email/auth";
import { finishPasskeyRegistration } from "@/lib/email/passkeys";

export const runtime = "nodejs";

const schema = z.object({
  challengeId: z.string().min(1).max(200),
  name: z.string().min(1).max(80),
  response: z.record(z.unknown()),
});

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = schema.parse(await request.json());
    const session = await getAuthSession(request);
    return finishPasskeyRegistration(request, {
      ...body,
      deviceId: session.trustedDevice?.id,
      response: body.response as never,
    });
  });
}
