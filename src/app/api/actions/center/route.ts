import { authenticated } from "@/lib/email/api";
import { getActionCenter } from "@/lib/email/action-center";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticated(request, () => {
    const url = new URL(request.url);
    return getActionCenter({ workspaceId: url.searchParams.get("workspaceId") || undefined });
  });
}
