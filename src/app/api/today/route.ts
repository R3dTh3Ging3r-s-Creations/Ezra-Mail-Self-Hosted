import { authenticated } from "@/lib/email/api";
import { getTodayBrief } from "@/lib/email/today-brief";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticated(request, () => {
    const url = new URL(request.url);
    return getTodayBrief({ workspaceId: url.searchParams.get("workspaceId") || undefined });
  });
}
