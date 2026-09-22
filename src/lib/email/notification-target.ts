import { accountWorkspaceId } from "./workspace-identity";
import type { AccountProvider } from "./types";

export type NotificationTarget = { view: "today" } | { view: "mail"; provider: AccountProvider; accountId: string; messageId: string; workspaceId: string };
type TargetInput = { view: "today" } | { view: "mail"; provider: AccountProvider; accountId: string; messageId: string };
const opaque = /^[A-Za-z0-9_-]{1,200}$/;

/** Exact relative root targets only; never let URL repair an unsafe path. */
export function parseNotificationTarget(value: string): NotificationTarget | null {
  if (typeof value !== "string" || value.length > 1000 || !value.startsWith("/?") || /[\\#\x00-\x20\x7f]/.test(value)) return null;
  const query = value.slice(2);
  if (query.split("&").some((part) => !part || !part.includes("="))) return null;
  // URLSearchParams tolerates bad escapes and replacement characters. Fail closed first.
  try { if (/[\\\x00-\x20\x7f]/.test(decodeURIComponent(query))) return null; } catch { return null; }
  const params = new URLSearchParams(query), keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return null;
  if (params.get("view") === "today" && keys.length === 1) return { view: "today" };
  if (params.get("view") !== "mail" || keys.length !== 3 || !keys.every((key) => ["view", "workspace", "message"].includes(key))) return null;
  const workspaceId = params.get("workspace")!, messageId = params.get("message")!;
  const match = /^workspace:account:(gmail|microsoft):([A-Za-z0-9_-]{1,200})$/.exec(workspaceId);
  if (!match || !opaque.test(messageId)) return null;
  return { view: "mail", provider: match[1] as AccountProvider, accountId: match[2], messageId, workspaceId };
}

export function buildNotificationTarget(value: TargetInput): string {
  if (value.view === "today") return "/?view=today";
  if (value.view !== "mail" || !["gmail", "microsoft"].includes(value.provider) || typeof value.accountId !== "string" || typeof value.messageId !== "string" || !opaque.test(value.accountId) || !opaque.test(value.messageId)) throw new Error("Invalid notification target");
  return `/?${new URLSearchParams({ view: "mail", workspace: accountWorkspaceId(value.provider, value.accountId), message: value.messageId })}`;
}
