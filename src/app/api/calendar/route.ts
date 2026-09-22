import { authenticated } from "@/lib/email/api";
import { getCalendarPage } from "@/lib/email/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticated(request, () => {
    const url = new URL(request.url);
    return getCalendarPage({
      workspaceId: url.searchParams.get("workspaceId") || undefined,
      date: url.searchParams.get("date") || undefined,
      from: url.searchParams.get("from") || undefined,
      to: url.searchParams.get("to") || undefined,
      sync: url.searchParams.get("sync") === "false" ? false : undefined,
    });
  });
}
