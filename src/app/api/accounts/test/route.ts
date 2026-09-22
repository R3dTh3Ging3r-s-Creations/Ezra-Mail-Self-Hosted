import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { testProviderSetup } from "@/lib/email/provider-setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  provider: z.enum(["gmail", "microsoft"]),
  capability: z.enum(["mail_read", "send"]),
});

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const input = schema.parse(await request.json());
    return { test: await testProviderSetup(input) };
  });
}
