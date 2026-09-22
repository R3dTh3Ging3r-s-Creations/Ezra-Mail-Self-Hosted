import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { discoverProvider } from "@/lib/email/provider-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  provider: z.enum(["gmail", "microsoft"]),
});

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const { provider } = schema.parse(await request.json());
    return { discovery: discoverProvider(provider) };
  });
}
