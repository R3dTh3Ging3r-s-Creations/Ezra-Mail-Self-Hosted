import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { completeGmailAccountConnection, completeMicrosoftAccountConnection } from "@/lib/email/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("gmail"),
    email: z.string().email(),
    access: z.enum(["readonly", "maintenance", "calendar"]),
    authUrl: z.string().url(),
  }),
  z.object({
    provider: z.literal("microsoft"),
    connectionId: z.string().min(1),
  }),
]);

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = schema.parse(await request.json());
    const connection = body.provider === "gmail"
      ? await completeGmailAccountConnection({ email: body.email, access: body.access, authUrl: body.authUrl })
      : await completeMicrosoftAccountConnection(body.connectionId);
    return { connection };
  });
}
