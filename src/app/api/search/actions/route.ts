import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { runNaturalLanguageSearchAction } from "@/lib/email/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["interpret", "provider_search"]),
  query: z.string().trim().min(2).max(500),
  workspaceId: z.string().optional(),
  accountId: z.string().optional(),
  pageToken: z.string().optional(),
});

export async function POST(request: Request) {
  return authenticated(request, async () => runNaturalLanguageSearchAction(schema.parse(await request.json())));
}
