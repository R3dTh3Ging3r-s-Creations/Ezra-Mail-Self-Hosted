import { authenticated } from "@/lib/email/api";
import { getMailPage } from "@/lib/email/professional";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticated(request, async () => {
    const url = new URL(request.url);
    const has = (name: string) => url.searchParams.has(name);
    const value = (name: string) => url.searchParams.get(name) || undefined;
    const booleanValue = (name: string) => url.searchParams.get(name) === "true";
    const viewId = value("viewId");
    const defaultUnlessView = (name: string, fallback: string) => has(name) ? value(name) : viewId ? undefined : fallback;
    return getMailPage({
      cursor: url.searchParams.get("cursor"),
      limit: Number(url.searchParams.get("limit") || 40),
      search: has("search") ? value("search") : undefined,
      workspaceId: value("workspaceId"),
      viewId,
      account: has("account") ? value("account") : undefined,
      folder: defaultUnlessView("folder", "inbox"),
      inboxCategory: defaultUnlessView("inboxCategory", "all"),
      category: has("category") ? value("category") : undefined,
      categories: value("categories")?.split(",").map((item) => item.trim()).filter(Boolean),
      priority: has("priority") ? value("priority") : undefined,
      unread: has("unread") ? booleanValue("unread") : undefined,
      attachments: has("attachments") ? booleanValue("attachments") : undefined,
      date: defaultUnlessView("date", "any"),
      needsReply: has("needsReply") ? booleanValue("needsReply") : undefined,
      hasDeadline: has("hasDeadline") ? booleanValue("hasDeadline") : undefined,
      handled: has("handled")
        ? (value("handled") as "active" | "handled" | "any" | undefined)
        : undefined,
      messageIds: Array.from(new Set(url.searchParams.getAll("messageId")
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && id.length <= 128)))
        .slice(0, 12),
    });
  });
}
