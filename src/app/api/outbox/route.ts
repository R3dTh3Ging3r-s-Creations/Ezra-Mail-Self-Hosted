import { authenticated } from "@/lib/email/api";
import { getOutboxPage } from "@/lib/email/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticated(request, async () => {
    const url = new URL(request.url);
    return getOutboxPage({ workspaceId: url.searchParams.get("workspaceId") || undefined });
  });
}
