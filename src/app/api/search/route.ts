import { authenticated } from "@/lib/email/api";
import { getNaturalLanguageSearchPage } from "@/lib/email/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticated(request, async () => {
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
    if (query.length < 2) throw new Error("Provide a search query with at least 2 characters.");
    return getNaturalLanguageSearchPage({
      query,
      workspaceId: url.searchParams.get("workspaceId"),
      cursor: url.searchParams.get("cursor"),
      limit: Number(url.searchParams.get("limit") || 20),
    });
  });
}
