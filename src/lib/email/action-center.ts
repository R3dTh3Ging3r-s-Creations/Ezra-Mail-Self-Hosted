import { execute, nowIso } from "./database";
import { getOutboxPage } from "./outbox";
import { getCleanupSuggestions } from "./professional";
import type {
  AccountProvider,
  ActionCenterItem,
  ActionCenterPage,
  ActionCenterSection,
  MailActionName,
} from "./types";
import { mailActionCopy } from "./vocabulary";
import { providerForWorkspace, workspaceSqlFilter } from "./workspaces";

type Row = Awaited<ReturnType<typeof execute>>["rows"][number];

export async function getActionCenter(input: {
  workspaceId?: string;
  includeCleanup?: boolean;
} = {}): Promise<ActionCenterPage> {
  const [replyDrafts, outgoingDrafts, calendarDrafts, cleanup, failedActions, permissionIssues] = await Promise.all([
    getReplyDraftItems(input.workspaceId),
    getOutgoingDraftItems(input.workspaceId),
    getCalendarDraftItems(input.workspaceId),
    input.includeCleanup === false ? Promise.resolve([]) : getCleanupItems(input.workspaceId),
    getFailedActionItems(input.workspaceId),
    getPermissionIssueItems(input.workspaceId),
  ]);
  const approvals = [
    ...replyDrafts,
    ...outgoingDrafts.filter((item) => item.priority !== "repair"),
    ...calendarDrafts,
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const repairs = [
    ...outgoingDrafts.filter((item) => item.priority === "repair"),
    ...failedActions,
    ...permissionIssues,
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const sections: ActionCenterSection[] = [
    {
      id: "approvals",
      title: "Needs approval",
      description: "Drafts and provider writes waiting for an explicit review.",
      count: approvals.length,
      items: approvals,
    },
    {
      id: "cleanup",
      title: "Cleanup review",
      description: "Low-risk cleanup suggestions that still require approval.",
      count: cleanup.length,
      items: cleanup,
    },
    {
      id: "repairs",
      title: "Needs repair",
      description: "Failed actions, partial provider changes, reconnects, or permission upgrades.",
      count: repairs.length,
      items: repairs,
    },
  ];
  const counts = {
    approvals: approvals.length,
    cleanup: cleanup.length,
    repairs: repairs.length,
    total: approvals.length + cleanup.length + repairs.length,
  };
  return { generatedAt: nowIso(), counts, sections };
}

async function getReplyDraftItems(workspaceId?: string): Promise<ActionCenterItem[]> {
  const workspace = workspaceSqlFilter(workspaceId, "m");
  const result = await execute(
    `SELECT d.*, m.account_id AS account_id, m.subject, m.sender_name, m.sender_email,
       a.label AS account_label, a.provider AS account_provider,
       sa.status AS approval_status, sa.expires_at AS approval_expires_at
     FROM reply_drafts d
     JOIN email_messages m ON m.id = d.message_id
     JOIN email_accounts a ON a.id = m.account_id
     LEFT JOIN send_approvals sa ON sa.id = (
       SELECT id FROM send_approvals latest WHERE latest.draft_id = d.id
       ORDER BY latest.created_at DESC LIMIT 1
     )
     WHERE d.id = (
       SELECT id FROM reply_drafts rd WHERE rd.message_id = d.message_id
       ORDER BY rd.version DESC LIMIT 1
     )
       AND d.status IN ('draft', 'awaiting_approval')
       AND NOT EXISTS (
         SELECT 1 FROM outgoing_drafts od WHERE od.legacy_reply_draft_id = d.id
       )
       AND ${workspace.sql}
     ORDER BY d.updated_at DESC
     LIMIT 20`,
    workspace.args,
  );
  return result.rows.map((row) => ({
    id: `reply:${String(row.id)}`,
    type: "reply_draft",
    priority: String(row.status) === "awaiting_approval" ? "approval" : "review",
    accountId: String(row.account_id),
    accountLabel: String(row.account_label),
    accountProvider: String(row.account_provider) as AccountProvider,
    title: String(row.subject),
    subtitle: `Reply to ${String(row.sender_name)} · ${String(row.account_label)}`,
    detail:
      String(row.status) === "awaiting_approval"
        ? "Reply is locked for exact send review."
        : "Reply draft is saved locally and can be revised or sent for approval.",
    updatedAt: String(row.updated_at),
    status: String(row.status),
    count: 1,
    target: { view: "drafts", draftId: String(row.id), messageId: String(row.message_id) },
  }));
}

async function getOutgoingDraftItems(workspaceId?: string): Promise<ActionCenterItem[]> {
  const outbox = await getOutboxPage({ workspaceId });
  return outbox.items
    .filter((item) => ["draft", "awaiting_approval", "approved", "failed", "send_unknown"].includes(item.status))
    .slice(0, 20)
    .map((item) => ({
      id: item.id,
      type: "outgoing_draft",
      priority: item.status === "failed" || item.status === "send_unknown" ? "repair" : item.status === "awaiting_approval" ? "approval" : "review",
      accountId: item.accountId,
      accountLabel: item.accountLabel,
      accountProvider: item.accountProvider,
      title: item.subject || "(no subject)",
      subtitle: `${sourceLabel(item.sourceType)} to ${recipientSummary(item)} · ${item.accountLabel}`,
      detail: outgoingDraftDetail(item),
      updatedAt: item.updatedAt,
      status: item.status,
      count: 1,
      target: { view: "outbox", draftId: item.draftId },
    }));
}

async function getCalendarDraftItems(workspaceId?: string): Promise<ActionCenterItem[]> {
  const workspace = workspaceSqlFilter(workspaceId, "d");
  const result = await execute(
    `SELECT d.*, a.label AS account_label, a.provider AS account_provider
     FROM calendar_drafts d
     JOIN email_accounts a ON a.id = d.account_id
     WHERE d.status = 'draft'
       AND ${workspace.sql}
     ORDER BY d.updated_at DESC, d.starts_at ASC
     LIMIT 20`,
    workspace.args,
  );
  return result.rows.map((row) => ({
    id: `calendar:${String(row.id)}`,
    type: "calendar_draft",
    priority: "approval",
    accountId: String(row.account_id),
    accountLabel: String(row.account_label),
    accountProvider: String(row.account_provider) as AccountProvider,
    title: String(row.title),
    subtitle: `${formatDateTime(row.starts_at)} · ${String(row.account_label)}`,
    detail: Number(row.send_updates) === 1
      ? "Calendar event draft includes attendee invitation updates and needs approval."
      : "Calendar event draft is saved locally and needs provider creation approval.",
    updatedAt: String(row.updated_at),
    status: String(row.status),
    count: 1,
    target: { view: "calendar", draftId: String(row.id) },
  }));
}

function sourceLabel(sourceType: string) {
  if (sourceType === "forward") return "Forward";
  if (sourceType === "reply") return "Reply";
  return "New email";
}

function recipientSummary(item: { to: Array<{ email: string }>; recipientCount: number }) {
  if (!item.to.length) return "no recipients yet";
  const first = item.to[0].email;
  const extra = item.recipientCount - 1;
  return extra > 0 ? `${first} +${extra}` : first;
}

function outgoingDraftDetail(item: Awaited<ReturnType<typeof getOutboxPage>>["items"][number]) {
  if (item.status === "failed") {
    return `Send failed: ${item.lastError || "provider error"}. Open Outbox to retry or review.`;
  }
  if (item.status === "approved") {
    return `Exact draft approved and ready to send from ${item.accountLabel}.`;
  }
  if (item.status === "awaiting_approval") {
    return "Exact review snapshot is waiting for approval.";
  }
  if (item.blockedReason) {
    return `${item.bodyPreview || "Draft saved locally."} ${item.blockedReason}`;
  }
  return item.bodyPreview || "Draft saved locally.";
}

async function getCleanupItems(workspaceId?: string): Promise<ActionCenterItem[]> {
  const suggestions = await getCleanupSuggestions(6, workspaceId);
  return suggestions.map((item) => ({
    id: `cleanup:${item.accountId}:${item.senderEmail}`,
    type: "cleanup_suggestion",
    priority: "review",
    accountId: item.accountId,
    accountLabel: item.accountLabel,
    title: item.senderName,
    subtitle: `${item.messageCount} message${item.messageCount === 1 ? "" : "s"} · ${item.accountLabel}`,
    detail: item.reason,
    updatedAt: item.latestReceivedAt,
    status: item.recommendation,
    count: item.messageCount,
    target: { view: "today", messageId: item.latestMessageId },
  }));
}

async function getFailedActionItems(workspaceId?: string): Promise<ActionCenterItem[]> {
  const result = await execute(
    `SELECT *
     FROM mail_actions
     WHERE failure_count > 0 OR status IN ('failed', 'partial')
     ORDER BY COALESCE(executed_at, created_at) DESC, created_at DESC
     LIMIT 80`,
  );
  const items: ActionCenterItem[] = [];
  for (const row of result.rows) {
    const messages = await actionWorkspaceMessages(parseStringArray(row.message_ids), workspaceId);
    if (!messages.length) continue;
    items.push(failedActionItem(row, messages));
    if (items.length >= 10) break;
  }
  return items;
}

async function actionWorkspaceMessages(messageIds: string[], workspaceId?: string) {
  const ids = Array.from(new Set(messageIds)).filter(Boolean);
  if (!ids.length) return [] as Row[];
  const workspace = workspaceSqlFilter(workspaceId, "m");
  const result = await execute(
    `SELECT m.id, m.account_id, m.subject, m.sender_name, m.sender_email,
       a.label AS account_label, a.provider AS account_provider
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id IN (${ids.map(() => "?").join(",")})
       AND ${workspace.sql}
     ORDER BY m.received_at DESC, m.id DESC`,
    [...ids, ...workspace.args],
  );
  return result.rows;
}

function failedActionItem(row: Row, messages: Row[]): ActionCenterItem {
  const details = parseRecord(row.details);
  const failures = Array.isArray(details.failures) ? details.failures.length : Number(row.failure_count || 0);
  const changed = Array.isArray(details.changedIds) ? details.changedIds.length : Number(row.success_count || 0);
  const unchanged = Array.isArray(details.unchangedIds) ? details.unchangedIds.length : 0;
  const sample = messages[0];
  const accountLabels = Array.from(new Set(messages.map((message) => String(message.account_label)))).join(", ");
  const action = String(row.action || "") as MailActionName;
  return {
    id: `failed:${String(row.id)}`,
    type: "failed_action",
    priority: "repair",
    accountId: sample ? String(sample.account_id) : null,
    accountLabel: accountLabels || null,
    accountProvider: sample?.account_provider ? (String(sample.account_provider) as AccountProvider) : undefined,
    title: actionTitle(action),
    subtitle: `${messages.length} message${messages.length === 1 ? "" : "s"} · ${accountLabels || "selected workspace"}`,
    detail: `${failures || Number(row.failure_count || 0)} failed, ${changed} changed, ${unchanged} unchanged. Review before retrying.`,
    updatedAt: String(row.executed_at || row.created_at),
    status: String(row.status || ""),
    count: failures || Number(row.failure_count || 0),
    target: sample ? { view: "mail", messageId: String(sample.id) } : { view: "today" },
  };
}

async function getPermissionIssueItems(workspaceId?: string): Promise<ActionCenterItem[]> {
  const provider = providerForWorkspace(workspaceId);
  const accountWorkspace = provider === "all"
    ? { sql: "1 = 1", args: [] as string[] }
    : { sql: "a.provider = ?", args: [provider] };
  const [accountRows, integrationRows, syncRows] = await Promise.all([
    execute(
      `SELECT a.id, a.label, a.provider, a.email, a.status, a.updated_at
       FROM email_accounts a
       WHERE a.status NOT IN ('connected', 'disabled')
         AND ${accountWorkspace.sql}
       ORDER BY a.updated_at DESC
       LIMIT 20`,
      accountWorkspace.args,
    ),
    execute(
      `SELECT i.*, a.label AS account_label, a.email, a.provider AS account_provider
       FROM account_integrations i
       JOIN email_accounts a ON a.id = i.account_id
       WHERE a.status <> 'disabled'
         AND (i.status <> 'connected' OR i.last_error IS NOT NULL OR i.access = 'none')
         AND ${accountWorkspace.sql}
       ORDER BY i.updated_at DESC
       LIMIT 20`,
      accountWorkspace.args,
    ),
    execute(
      `SELECT s.*, a.label AS account_label, a.email, a.provider AS account_provider
       FROM calendar_sync_state s
       JOIN email_accounts a ON a.id = s.account_id
       WHERE a.status <> 'disabled'
         AND (s.status = 'error' OR s.last_error IS NOT NULL)
         AND ${accountWorkspace.sql}
       ORDER BY s.updated_at DESC
       LIMIT 20`,
      accountWorkspace.args,
    ),
  ]);
  const seen = new Set<string>();
  const items: ActionCenterItem[] = [];
  for (const row of accountRows.rows) {
    const key = `account:${String(row.id)}`;
    seen.add(key);
    items.push({
      id: key,
      type: "permission_issue",
      priority: "repair",
      accountId: String(row.id),
      accountLabel: String(row.label),
      accountProvider: String(row.provider) as AccountProvider,
      title: `${String(row.label)} needs account attention`,
      subtitle: `${String(row.email)} · account ${String(row.status)}`,
      detail: "Reconnect or review this account in Settings.",
      updatedAt: String(row.updated_at || nowIso()),
      status: String(row.status),
      count: 1,
      target: { view: "settings", accountId: String(row.id) },
    });
  }
  for (const row of integrationRows.rows) {
    const key = `integration:${String(row.account_id)}:${String(row.feature)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: key,
      type: "permission_issue",
      priority: "repair",
      accountId: String(row.account_id),
      accountLabel: String(row.account_label),
      accountProvider: String(row.account_provider) as AccountProvider,
      title: `${featureLabel(row.feature)} needs attention`,
      subtitle: `${String(row.account_label)} · ${String(row.status)} · ${String(row.access)}`,
      detail: row.last_error ? String(row.last_error) : "Permission upgrade or reconnect is needed.",
      updatedAt: String(row.updated_at || nowIso()),
      status: String(row.status),
      count: 1,
      target: { view: "settings", accountId: String(row.account_id) },
    });
  }
  for (const row of syncRows.rows) {
    const key = `calendar-sync:${String(row.account_id)}:${String(row.calendar_id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: key,
      type: "permission_issue",
      priority: "repair",
      accountId: String(row.account_id),
      accountLabel: String(row.account_label),
      accountProvider: String(row.account_provider) as AccountProvider,
      title: "Calendar sync needs attention",
      subtitle: `${String(row.account_label)} · ${String(row.status)}`,
      detail: row.last_error ? String(row.last_error) : "Calendar sync reported an error.",
      updatedAt: String(row.updated_at || nowIso()),
      status: String(row.status),
      count: 1,
      target: { view: "settings", accountId: String(row.account_id) },
    });
  }
  return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 12);
}

function actionTitle(action: MailActionName) {
  return `${mailActionCopy(action).label} action needs review`;
}

function featureLabel(value: unknown) {
  const text = String(value || "integration");
  return text.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDateTime(value: unknown) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "Unscheduled";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function parseStringArray(value: unknown): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
