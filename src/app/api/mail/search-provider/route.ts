import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { searchProviderMail } from "@/lib/email/professional";

export const runtime = "nodejs";

const schema = z.object({
  query: z.string().trim().min(1).max(500),
  accountId: z.string().optional(),
  workspaceId: z.string().optional(),
  pageToken: z.string().optional(),
});

export async function POST(request: Request) {
  return authenticated(request, async () => searchProviderMail(schema.parse(await request.json())));
}
