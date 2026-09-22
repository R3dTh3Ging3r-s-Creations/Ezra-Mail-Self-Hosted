import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { getSavedViews } from "@/lib/email/saved-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  workspaceId: z.string().optional(),
});

export async function GET(request: Request) {
  return authenticated(request, () => {
    const url = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams.entries()));
    return getSavedViews(query);
  });
}
