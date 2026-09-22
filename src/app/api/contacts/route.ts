import { authenticated } from "@/lib/email/api";
import { getContactSuggestions } from "@/lib/email/contacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticated(request, async () => {
    const url = new URL(request.url);
    return getContactSuggestions({
      workspaceId: url.searchParams.get("workspaceId"),
      accountId: url.searchParams.get("accountId"),
      q: url.searchParams.get("q"),
      limit: Number(url.searchParams.get("limit") || 12),
    });
  });
}
