import { execute, nowIso } from "./database";
import type {
  AccountProvider,
  ActivityTimelineAccount,
  ActivityTimelineItem,
  ActivityTimelineKind,
  ActivityTimelinePage,
  ActivityTimelineSeverity,
  ActionCenterTarget,
  MailActionName,
  MailActionDetail,
  MailActionFailure,
} from "./types";
import { mailActionHistoryTitle, ruleActionLabel } from "./vocabulary";
import { providerForWorkspace, workspaceSqlFilter } from "./workspaces";

type Row = Awaited<ReturnType<typeof execute>>["rows"][number];

type ActivityInput = {
  workspaceId?: string;
  q?: string;
  kind?: ActivityTimelineKind | "all";
  accountId?: string;
  provider?: AccountProvider | "all";
  from?: string;
  to?: string;
  limit?: number;
};

type TimelineFilters = Required<Pick<ActivityInput, "q">> & {
  workspaceId?: string;
  kind: ActivityTimelineKind | "all";
  accountId: string;
  provider: AccountProvider | "all";
  from: string | null;
  to: string | null;
  limit: number;
};

const ALL_KINDS: ActivityTimelineKind[] = [
  "message_received",
  "classification",
  "mail_action",
  "outgoing_mail",
  "feedback",
  "learned_rule",
  "notification",
  "mail_sync",
  "calendar_sync",
  "integration",
];

export async function getActivityTimeline(input: ActivityInput = {}): Promise<ActivityTimelinePage> {
  const filters = normalizeFilters(input);
  const sourceLimit = Math.max(filters.limit, 50);
  const builders: Array<[ActivityTimelineKind, () => Promise<ActivityTimelineItem[]>]> = [
    ["message_received", () => getMessageEvents(filters, sourceLimit)],
    ["classification", () => getClassificationEvents(filters, sourceLimit)],
    ["mail_action", () => getMailActionEvents(filters, sourceLimit)],
    ["outgoing_mail", () => getOutgoingMailEvents(filters, sourceLimit)],
    ["feedback", () => getFeedbackEvents(filters, sourceLimit)],
    ["learned_rule", () => getLearnedRuleEvents(filters, sourceLimit)],
    ["notification", () => getNotificationEvents(filters, sourceLimit)],
    ["mail_sync", () => getMailSyncEvents(filters, sourceLimit)],
    ["calendar_sync", () => getCalendarSyncEvents(filters, sourceLimit)],
    ["integration", () => getIntegrationEvents(filters, sourceLimit)],
  ];
  const selectedBuilders = filters.kind === "all"
    ? builders
    : builders.filter(([kind]) => kind === filters.kind);
  const [accounts, ...eventGroups] = await Promise.all([
    getTimelineAccounts(filters),
    ...selectedBuilders.map(([, build]) => build()),
  ]);
  const query = normalizeSearch(filters.q);
  const filtered = eventGroups
    .flat()
    .filter((item) => (query ? activitySearchText(item).includes(query) : true))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  const items = filtered.slice(0, filters.limit);
  return {
    generatedAt: nowIso(),
    filters: {
      workspaceId: filters.workspaceId || null,
      q: filters.q,
      kind: filters.kind,
      accountId: filters.accountId,
      provider: filters.provider,
      from: filters.from,
      to: filters.to,
      limit: filters.limit,
    },
    counts: {
      total: filtered.length,
      shown: items.length,
      errors: filtered.filter((item) => item.severity === "error").length,
      warnings: filtered.filter((item) => item.severity === "warning").length,
      byKind: ALL_KINDS.map((kind) => ({
        kind,
        count: filtered.filter((item) => item.kind === kind).length,
      })).filter((item) => item.count > 0),
    },
    accounts,
    items,
  };
}

export async function getMailActionDetail(actionId: string): Promise<MailActionDetail> {
  const result = await execute(`SELECT * FROM mail_actions WHERE id = ?`, [actionId]);
  const row = result.rows[0];
  if (!row) throw new Error("The mail action was not found.");
  const details = parseRecord(row.details);
  const messageIds = parseStringArray(row.message_ids);
  const messages = messageIds.length ? await execute(
    `SELECT m.id, m.subject, m.sender_name, a.label AS account_label, a.provider AS account_provider
     FROM email_messages m JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id IN (${messageIds.map(() => "?").join(",")})`,
    messageIds,
  ) : { rows: [] as Row[] };
  const changedIds = new Set(Array.isArray(details.changedIds) ? details.changedIds.map(String) : []);
  const unchangedIds = new Set(Array.isArray(details.unchangedIds) ? details.unchangedIds.map(String) : []);
  const failures = (Array.isArray(details.failures) ? details.failures : [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => item as unknown as MailActionFailure);
  const failureById = new Map(failures.map((failure) => [String(failure.id), failure]));
  const outcomes = messages.rows.map((message) => {
    const id = String(message.id);
    const failure = failureById.get(id);
    const status = failure ? "failed" : unchangedIds.has(id) ? "unchanged" : "changed";
    return {
      id,
      subject: String(message.subject || "Message"),
      senderName: String(message.sender_name || "Unknown sender"),
      accountLabel: String(message.account_label || "Account"),
      provider: (message.account_provider === "microsoft" ? "microsoft" : "gmail") as AccountProvider,
      status,
      error: failure?.error || null,
      code: failure?.code || null,
      retryable: Boolean(failure?.retryable),
    } as const;
  });
  for (const failure of failures) {
    if (outcomes.some((outcome) => outcome.id === failure.id)) continue;
    outcomes.push({
      id: failure.id,
      subject: failure.id.includes("@") ? failure.id : "Action target",
      senderName: "Provider action",
      accountLabel: failure.accountLabel || "Account",
      provider: failure.provider === "microsoft" ? "microsoft" : "gmail",
      status: "failed",
      error: failure.error,
      code: failure.code || null,
      retryable: Boolean(failure.retryable),
    });
  }
  const changedCount = changedIds.size || Number(row.success_count || 0);
  return {
    actionId,
    action: String(row.action) as MailActionName,
    status: String(row.status || "unknown"),
    occurredAt: String(row.executed_at || row.created_at),
    reversible: String(row.undo_status || "") === "available",
    undoStatus: row.undo_status ? String(row.undo_status) : null,
    changedCount,
    unchangedCount: unchangedIds.size,
    failedCount: failures.length || Number(row.failure_count || 0),
    outcomes,
  };
}

function normalizeFilters(input: ActivityInput): TimelineFilters {
  const workspaceProvider = providerForWorkspace(input.workspaceId);
  const provider = input.provider === "gmail" || input.provider === "microsoft"
    ? input.provider
    : "all";
  const kind = ALL_KINDS.includes(input.kind as ActivityTimelineKind)
    ? input.kind as ActivityTimelineKind
    : "all";
  return {
    workspaceId: input.workspaceId,
    q: (input.q || "").trim(),
    kind,
    accountId: (input.accountId || "").trim(),
    provider: workspaceProvider === "all" ? provider : workspaceProvider,
    from: parseDateBoundary(input.from || null, "from"),
    to: parseDateBoundary(input.to || null, "to"),
    limit: clamp(Number(input.limit || 80), 20, 200),
  };
}

function parseDateBoundary(value: string | null, side: "from" | "to") {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? new Date(`${trimmed}T${side === "from" ? "00:00:00" : "23:59:59"}`)
    : new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function messageWhere(filters: TimelineFilters, messageAlias = "m", accountAlias = "a") {
  const workspace = workspaceSqlFilter(filters.workspaceId, messageAlias);
  const parts = [workspace.sql];
  const args = [...workspace.args];
  if (filters.accountId) {
    parts.push(`${messageAlias}.account_id = ?`);
    args.push(filters.accountId);
  }
  if (filters.provider !== "all") {
    parts.push(`${accountAlias}.provider = ?`);
    args.push(filters.provider);
  }
  return { sql: parts.join(" AND "), args };
}

function accountWhere(filters: TimelineFilters, accountAlias = "a") {
  const workspaceProvider = providerForWorkspace(filters.workspaceId);
  const parts = [`${accountAlias}.status <> 'disabled'`];
  const args: string[] = [];
  if (filters.accountId) {
    parts.push(`${accountAlias}.id = ?`);
    args.push(filters.accountId);
  }
  const provider = workspaceProvider === "all" ? filters.provider : workspaceProvider;
  if (provider !== "all") {
    parts.push(`${accountAlias}.provider = ?`);
    args.push(provider);
  }
  return { sql: parts.join(" AND "), args };
}

function dateWhere(column: string, filters: TimelineFilters) {
  const parts: string[] = [];
  const args: string[] = [];
  if (filters.from) {
    parts.push(`${column} >= ?`);
    args.push(filters.from);
  }
  if (filters.to) {
    parts.push(`${column} <= ?`);
    args.push(filters.to);
  }
  return { sql: parts.length ? parts.join(" AND ") : "1 = 1", args };
}

async function getTimelineAccounts(filters: TimelineFilters): Promise<ActivityTimelineAccount[]> {
  const account = accountWhere(filters, "a");
  const result = await execute(
    `SELECT a.id, a.label, a.email, a.provider
     FROM email_accounts a
     WHERE ${account.sql}
     ORDER BY a.provider, a.label`,
    account.args,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    email: String(row.email),
    provider: providerOrNull(row.provider) || "gmail",
  }));
}

async function getMessageEvents(filters: TimelineFilters, limit: number): Promise<ActivityTimelineItem[]> {
  const workspace = messageWhere(filters);
  const date = dateWhere("m.created_at", filters);
  const result = await execute(
    `SELECT m.id, m.account_id, m.sender_name, m.sender_email, m.subject, m.status,
       m.ingest_source, m.received_at, m.created_at,
       a.label AS account_label, a.email AS account_email, a.provider AS account_provider
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE ${workspace.sql}
       AND ${date.sql}
     ORDER BY m.created_at DESC
     LIMIT ?`,
    [...workspace.args, ...date.args, limit],
  );
  return result.rows.map((row) => {
    const source = String(row.ingest_source || "live");
    return baseItem({
      id: `message:${String(row.id)}:${String(row.created_at)}`,
      kind: "message_received",
      severity: "info",
      row,
      messageId: String(row.id),
      title: source === "backlog" ? "Backlog mail imported" : "Mail received by Ezra",
      subtitle: `${String(row.sender_name)} · ${String(row.account_label)}`,
      detail: String(row.subject),
      occurredAt: String(row.created_at),
      status: String(row.status || source),
      target: { view: "mail", messageId: String(row.id) },
      metadata: { senderEmail: String(row.sender_email), receivedAt: String(row.received_at), ingestSource: source },
    });
  });
}

async function getClassificationEvents(filters: TimelineFilters, limit: number): Promise<ActivityTimelineItem[]> {
  const workspace = messageWhere(filters);
  const date = dateWhere("t.created_at", filters);
  const result = await execute(
    `SELECT t.id, t.message_id, t.attention, t.category, t.summary, t.recommendation,
       t.user_corrected_attention, t.created_at,
       m.account_id, m.sender_name, m.sender_email, m.subject,
       a.label AS account_label, a.email AS account_email, a.provider AS account_provider
     FROM triage_decisions t
     JOIN email_messages m ON m.id = t.message_id
     JOIN email_accounts a ON a.id = m.account_id
     WHERE ${workspace.sql}
       AND ${date.sql}
     ORDER BY t.created_at DESC
     LIMIT ?`,
    [...workspace.args, ...date.args, limit],
  );
  return result.rows.map((row) => {
    const attention = String(row.user_corrected_attention || row.attention || "unknown");
    return baseItem({
      id: `classification:${String(row.id)}`,
      kind: "classification",
      severity: attention === "interrupt" ? "warning" : "info",
      row,
      messageId: String(row.message_id),
      title: `Classified as ${humanize(attention)}`,
      subtitle: `${String(row.sender_name)} · ${humanize(String(row.category || "uncategorized"))}`,
      detail: String(row.summary || row.recommendation || row.subject),
      occurredAt: String(row.created_at),
      status: attention,
      target: { view: "mail", messageId: String(row.message_id) },
      metadata: { senderEmail: String(row.sender_email), category: String(row.category || "") },
    });
  });
}

async function getMailActionEvents(filters: TimelineFilters, limit: number): Promise<ActivityTimelineItem[]> {
  const date = dateWhere("COALESCE(executed_at, created_at)", filters);
  const result = await execute(
    `SELECT *
     FROM mail_actions
     WHERE ${date.sql}
     ORDER BY COALESCE(executed_at, created_at) DESC, created_at DESC
     LIMIT ?`,
    [...date.args, limit * 2],
  );
  const items: ActivityTimelineItem[] = [];
  for (const row of result.rows) {
    const messages = await actionWorkspaceMessages(parseStringArray(row.message_ids), filters);
    if (!messages.length) continue;
    items.push(mailActionItem(row, messages));
    if (items.length >= limit) break;
  }
  return items;
}

async function actionWorkspaceMessages(messageIds: string[], filters: TimelineFilters) {
  const ids = Array.from(new Set(messageIds)).filter(Boolean);
  if (!ids.length) return [] as Row[];
  const workspace = messageWhere(filters);
  const result = await execute(
    `SELECT m.id, m.account_id, m.sender_name, m.sender_email, m.subject,
       a.label AS account_label, a.email AS account_email, a.provider AS account_provider
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id IN (${ids.map(() => "?").join(",")})
       AND ${workspace.sql}
     ORDER BY m.received_at DESC, m.id DESC`,
    [...ids, ...workspace.args],
  );
  return result.rows;
}

function mailActionItem(row: Row, messages: Row[]): ActivityTimelineItem {
  const action = String(row.action || "") as MailActionName;
  const details = parseRecord(row.details);
  const failures = Array.isArray(details.failures) ? details.failures.length : Number(row.failure_count || 0);
  const changed = Array.isArray(details.changedIds) ? details.changedIds.length : Number(row.success_count || 0);
  const unchanged = Array.isArray(details.unchangedIds) ? details.unchangedIds.length : 0;
  const sample = messages[0];
  const accounts = Array.from(new Set(messages.map((message) => String(message.account_label)))).join(", ");
  return baseItem({
    id: `action:${String(row.id)}`,
    kind: "mail_action",
    severity: failures > 0 || String(row.status) === "failed" ? "error" : String(row.status) === "partial" ? "warning" : "success",
    row: sample,
    messageId: sample ? String(sample.id) : null,
    actionId: String(row.id),
    title: actionTitle(action),
    subtitle: `${messages.length} message${messages.length === 1 ? "" : "s"} · ${accounts || "selected workspace"}`,
    detail: `${changed} changed, ${unchanged} unchanged, ${failures} failed.`,
    occurredAt: String(row.executed_at || row.created_at),
    status: String(row.status || ""),
    target: sample ? { view: "mail", messageId: String(sample.id) } : { view: "today" },
    metadata: {
      action,
      successCount: Number(row.success_count || 0),
      failureCount: Number(row.failure_count || 0),
    },
  });
}

async function getOutgoingMailEvents(filters: TimelineFilters, limit: number): Promise<ActivityTimelineItem[]> {
  const workspace = workspaceSqlFilter(filters.workspaceId, "d");
  const date = dateWhere("l.created_at", filters);
  const parts = [
    "l.target_type = 'outgoing_draft'",
    "l.action IN ('outgoing_draft.created', 'outgoing_draft.updated', 'outgoing_draft.approval_requested', 'outgoing_draft.approved', 'outgoing_draft.cancelled', 'outgoing_draft.send_started', 'outgoing_draft.sent', 'outgoing_draft.send_failed')",
    workspace.sql,
    date.sql,
  ];
  const args = [...workspace.args, ...date.args];
  if (filters.accountId) {
    parts.push("d.account_id = ?");
    args.push(filters.accountId);
  }
  if (filters.provider !== "all") {
    parts.push("a.provider = ?");
    args.push(filters.provider);
  }
  const result = await execute(
    `SELECT l.id AS log_id, l.action, l.actor, l.metadata, l.created_at AS event_at,
       d.id AS draft_id, d.source_type, d.source_message_id, d.reply_mode, d.account_id,
       d.from_email, d.to_recipients, d.cc_recipients, d.bcc_recipients,
       d.subject, d.body, d.status AS draft_status, d.provider_message_id,
       d.last_error, d.updated_at,
       a.label AS account_label, a.email AS account_email, a.provider AS account_provider
     FROM audit_logs l
     JOIN outgoing_drafts d ON d.id = l.target_id
     JOIN email_accounts a ON a.id = d.account_id
     WHERE ${parts.join(" AND ")}
     ORDER BY l.created_at DESC
     LIMIT ?`,
    [...args, limit],
  );
  return result.rows.map(outgoingMailItem);
}

function outgoingMailItem(row: Row): ActivityTimelineItem {
  const action = String(row.action || "");
  const metadata = parseRecord(row.metadata);
  const status = outgoingStatus(action, row);
  return baseItem({
    id: `outgoing:${String(row.log_id)}`,
    kind: "outgoing_mail",
    severity: outgoingSeverity(action),
    row,
    messageId: row.source_message_id ? String(row.source_message_id) : null,
    actionId: String(row.log_id),
    title: outgoingTitle(action, row),
    subtitle: `${sourceLabel(String(row.source_type || "new"), row.reply_mode ? String(row.reply_mode) : null)} to ${outgoingRecipientSummary(row)} · ${String(row.account_label)}`,
    detail: outgoingDetail(action, row, metadata),
    occurredAt: String(row.event_at),
    status,
    target: { view: "outbox", draftId: String(row.draft_id) },
    metadata: {
      draftId: String(row.draft_id),
      sourceType: String(row.source_type || "new"),
      replyMode: stringOrNull(row.reply_mode),
      provider: providerLabel(row.account_provider),
      attemptId: stringOrNull(metadata.attemptId),
      contentHash: stringOrNull(metadata.contentHash),
      providerMessageId: stringOrNull(metadata.providerMessageId || row.provider_message_id),
      retry: typeof metadata.retry === "boolean" ? metadata.retry : null,
    },
  });
}

function outgoingTitle(action: string, row: Row) {
  if (action === "outgoing_draft.created") return "Outgoing draft created";
  if (action === "outgoing_draft.updated") return "Outgoing draft edited";
  if (action === "outgoing_draft.approval_requested") return "Outgoing draft sent to exact review";
  if (action === "outgoing_draft.approved") return "Outgoing draft approved";
  if (action === "outgoing_draft.cancelled") return "Outgoing draft cancelled";
  if (action === "outgoing_draft.send_started") return `${providerLabel(row.account_provider)} send started`;
  if (action === "outgoing_draft.sent") return String(row.account_provider) === "microsoft"
    ? "Hotmail send accepted"
    : "Gmail draft sent";
  if (action === "outgoing_draft.send_failed") return `${providerLabel(row.account_provider)} send failed`;
  return "Outgoing mail updated";
}

function outgoingDetail(action: string, row: Row, metadata: Record<string, unknown>) {
  const recipients = outgoingRecipientSummary(row);
  if (action === "outgoing_draft.created") {
    return `${sourceLabel(String(row.source_type || "new"), row.reply_mode ? String(row.reply_mode) : null)} saved locally from ${String(row.from_email)} to ${recipients}.`;
  }
  if (action === "outgoing_draft.updated") return `Draft text or recipients changed for "${String(row.subject || "(no subject)")}".`;
  if (action === "outgoing_draft.approval_requested") return `Exact-review snapshot prepared for ${recipientCount(row)} recipient${recipientCount(row) === 1 ? "" : "s"}.`;
  if (action === "outgoing_draft.approved") return `Exact sender, recipients, subject, body, and hash were approved.`;
  if (action === "outgoing_draft.cancelled") return "Outgoing draft was cancelled before provider send.";
  if (action === "outgoing_draft.send_started") {
    return Boolean(metadata.retry) ? "Retry-safe provider send attempt started." : "Provider send attempt started.";
  }
  if (action === "outgoing_draft.sent") {
    const providerMessageId = stringOrNull(metadata.providerMessageId || row.provider_message_id);
    if (String(row.account_provider) === "microsoft") {
      return "Microsoft Graph accepted the message and saved it to Sent Items; final delivery is not proven by Graph's 202 response.";
    }
    return providerMessageId ? `Gmail returned provider message ID ${providerMessageId}.` : "Gmail accepted the outgoing draft.";
  }
  if (action === "outgoing_draft.send_failed") {
    return stringOrNull(metadata.error || row.last_error) || "Provider send failed before Ezra could mark the draft sent.";
  }
  return String(row.subject || "(no subject)");
}

function outgoingStatus(action: string, row: Row) {
  if (action === "outgoing_draft.send_started") return "sending";
  if (action === "outgoing_draft.send_failed") return "failed";
  if (action === "outgoing_draft.sent") return "sent";
  if (action === "outgoing_draft.cancelled") return "cancelled";
  if (action === "outgoing_draft.approved") return "approved";
  if (action === "outgoing_draft.approval_requested") return "awaiting_approval";
  return String(row.draft_status || "");
}

function outgoingSeverity(action: string): ActivityTimelineSeverity {
  if (action === "outgoing_draft.send_failed") return "error";
  if (action === "outgoing_draft.cancelled") return "warning";
  if (action === "outgoing_draft.sent" || action === "outgoing_draft.approved") return "success";
  return "info";
}

async function getFeedbackEvents(filters: TimelineFilters, limit: number): Promise<ActivityTimelineItem[]> {
  const workspace = messageWhere(filters);
  const date = dateWhere("f.created_at", filters);
  const result = await execute(
    `SELECT f.*, m.account_id, m.sender_name, m.sender_email, m.subject,
       a.label AS account_label, a.email AS account_email, a.provider AS account_provider
     FROM feedback_events f
     JOIN email_messages m ON m.id = f.message_id
     JOIN email_accounts a ON a.id = m.account_id
     WHERE ${workspace.sql}
       AND ${date.sql}
     ORDER BY f.created_at DESC
     LIMIT ?`,
    [...workspace.args, ...date.args, limit],
  );
  return result.rows.map((row) => {
    const value = String(row.value || "");
    return baseItem({
      id: `feedback:${String(row.id)}`,
      kind: "feedback",
      severity: "learning",
      row,
      messageId: String(row.message_id),
      title: `User correction: ${humanize(value)}`,
      subtitle: `${String(row.sender_name)} · ${String(row.source || "feedback")}`,
      detail: String(row.subject),
      occurredAt: String(row.created_at),
      status: value,
      target: { view: "mail", messageId: String(row.message_id) },
      metadata: { eventType: String(row.event_type), senderEmail: String(row.sender_email) },
    });
  });
}

async function getLearnedRuleEvents(filters: TimelineFilters, limit: number): Promise<ActivityTimelineItem[]> {
  const workspace = workspaceSqlFilter(filters.workspaceId, "p");
  const date = dateWhere("p.updated_at", filters);
  const parts = [workspace.sql, date.sql, "p.kind IN ('sender', 'topic')"];
  const args = [...workspace.args, ...date.args];
  if (filters.accountId) {
    parts.push("p.account_id = ?");
    args.push(filters.accountId);
  }
  if (filters.provider !== "all") {
    parts.push("a.provider = ?");
    args.push(filters.provider);
  }
  const result = await execute(
    `SELECT p.*, a.label AS account_label, a.email AS account_email, a.provider AS account_provider
     FROM learned_preferences p
     LEFT JOIN email_accounts a ON a.id = p.account_id
     WHERE ${parts.join(" AND ")}
     ORDER BY p.updated_at DESC
     LIMIT ?`,
    [...args, limit],
  );
  return result.rows.map((row) => {
    const action = String(row.action || "");
    return baseItem({
      id: `learned:${String(row.id)}`,
      kind: "learned_rule",
      severity: "learning",
      row,
      messageId: null,
      title: `${humanize(String(row.kind || "sender"))} preference learned`,
      subtitle: String(row.pattern),
      detail: `${ruleActionLabel(action)} · ${Number(row.evidence_count || 0)} approval${Number(row.evidence_count || 0) === 1 ? "" : "s"}.`,
      occurredAt: String(row.updated_at),
      status: Number(row.enabled) === 1 ? action : "disabled",
      target: { view: "settings", accountId: row.account_id ? String(row.account_id) : undefined },
      metadata: { kind: String(row.kind), pattern: String(row.pattern), action },
    });
  });
}

async function getNotificationEvents(filters: TimelineFilters, limit: number): Promise<ActivityTimelineItem[]> {
  const workspace = messageWhere(filters);
  const date = dateWhere("COALESCE(n.sent_at, n.created_at)", filters);
  const result = await execute(
    `SELECT n.*, m.account_id, m.sender_name, m.sender_email, m.subject,
       a.label AS account_label, a.email AS account_email, a.provider AS account_provider
     FROM notifications n
     JOIN email_messages m ON m.id = n.message_id
     JOIN email_accounts a ON a.id = m.account_id
     WHERE ${workspace.sql}
       AND ${date.sql}
     ORDER BY COALESCE(n.sent_at, n.created_at) DESC
     LIMIT ?`,
    [...workspace.args, ...date.args, limit],
  );
  return result.rows.map((row) => {
    const status = String(row.status || "");
    return baseItem({
      id: `notification:${String(row.id)}`,
      kind: "notification",
      severity: status === "failed" ? "error" : status === "skipped" ? "warning" : "success",
      row,
      messageId: String(row.message_id),
      title: `Notification ${status || "recorded"}`,
      subtitle: `${String(row.kind)} · ${String(row.sender_name)}`,
      detail: row.error ? String(row.error) : String(row.subject),
      occurredAt: String(row.sent_at || row.created_at),
      status,
      target: { view: "mail", messageId: String(row.message_id) },
      metadata: { channel: String(row.channel), notificationKind: String(row.kind) },
    });
  });
}

async function getMailSyncEvents(filters: TimelineFilters, limit: number): Promise<ActivityTimelineItem[]> {
  const account = accountWhere(filters, "a");
  const date = dateWhere("a.last_sync_at", filters);
  const result = await execute(
    `SELECT a.id AS account_id, a.label AS account_label, a.email AS account_email,
       a.provider AS account_provider, a.status, a.last_sync_at
     FROM email_accounts a
     WHERE ${account.sql}
       AND a.last_sync_at IS NOT NULL
       AND ${date.sql}
     ORDER BY a.last_sync_at DESC
     LIMIT ?`,
    [...account.args, ...date.args, limit],
  );
  return result.rows.map((row) => baseItem({
    id: `mail-sync:${String(row.account_id)}:${String(row.last_sync_at)}`,
    kind: "mail_sync",
    severity: String(row.status) === "error" ? "error" : "success",
    row,
    messageId: null,
    title: "Mailbox sync completed",
    subtitle: `${String(row.account_label)} · ${providerLabel(row.account_provider)}`,
    detail: `Latest mail sync for ${String(row.account_email)}.`,
    occurredAt: String(row.last_sync_at),
    status: String(row.status || "connected"),
    target: { view: "settings", accountId: String(row.account_id) },
  }));
}

async function getCalendarSyncEvents(filters: TimelineFilters, limit: number): Promise<ActivityTimelineItem[]> {
  const account = accountWhere(filters, "a");
  const date = dateWhere("s.updated_at", filters);
  const result = await execute(
    `SELECT s.*, a.id AS account_id, a.label AS account_label, a.email AS account_email,
       a.provider AS account_provider
     FROM calendar_sync_state s
     JOIN email_accounts a ON a.id = s.account_id
     WHERE ${account.sql}
       AND ${date.sql}
     ORDER BY s.updated_at DESC
     LIMIT ?`,
    [...account.args, ...date.args, limit],
  );
  return result.rows.map((row) => {
    const status = String(row.status || "");
    return baseItem({
      id: `calendar-sync:${String(row.account_id)}:${String(row.calendar_id)}:${String(row.updated_at)}`,
      kind: "calendar_sync",
      severity: status === "error" || row.last_error ? "error" : status === "syncing" ? "warning" : "success",
      row,
      messageId: null,
      title: "Calendar sync updated",
      subtitle: `${String(row.account_label)} · ${String(row.calendar_id)}`,
      detail: row.last_error ? String(row.last_error) : `Status ${status}${row.last_sync_at ? ` · last success ${formatDateTime(row.last_sync_at)}` : ""}.`,
      occurredAt: String(row.updated_at),
      status,
      target: { view: "calendar" },
    });
  });
}

async function getIntegrationEvents(filters: TimelineFilters, limit: number): Promise<ActivityTimelineItem[]> {
  const account = accountWhere(filters, "a");
  const date = dateWhere("i.updated_at", filters);
  const result = await execute(
    `SELECT i.*, a.id AS account_id, a.label AS account_label, a.email AS account_email,
       a.provider AS account_provider
     FROM account_integrations i
     JOIN email_accounts a ON a.id = i.account_id
     WHERE ${account.sql}
       AND ${date.sql}
     ORDER BY i.updated_at DESC
     LIMIT ?`,
    [...account.args, ...date.args, limit],
  );
  return result.rows.map((row) => {
    const status = String(row.status || "");
    return baseItem({
      id: `integration:${String(row.account_id)}:${String(row.feature)}:${String(row.updated_at)}`,
      kind: "integration",
      severity: status === "error" || row.last_error ? "error" : status === "connected" ? "success" : "warning",
      row,
      messageId: null,
      title: `${humanize(String(row.feature || "provider"))} permission ${humanize(status || "updated")}`,
      subtitle: `${String(row.account_label)} · ${String(row.access || "unknown access")}`,
      detail: row.last_error ? String(row.last_error) : `Provider integration is ${status || "updated"}.`,
      occurredAt: String(row.updated_at),
      status,
      target: { view: "settings", accountId: String(row.account_id) },
      metadata: { feature: String(row.feature), access: String(row.access) },
    });
  });
}

function baseItem(input: {
  id: string;
  kind: ActivityTimelineKind;
  severity: ActivityTimelineSeverity;
  row: Row;
  messageId: string | null;
  actionId?: string | null;
  title: string;
  subtitle: string;
  detail: string;
  occurredAt: string;
  status?: string | null;
  target?: ActionCenterTarget;
  metadata?: Record<string, string | number | boolean | null>;
}): ActivityTimelineItem {
  return {
    id: input.id,
    kind: input.kind,
    severity: input.severity,
    accountId: input.row.account_id ? String(input.row.account_id) : null,
    accountLabel: input.row.account_label ? String(input.row.account_label) : null,
    accountEmail: input.row.account_email ? String(input.row.account_email) : null,
    accountProvider: providerOrNull(input.row.account_provider),
    messageId: input.messageId,
    actionId: input.actionId || null,
    title: input.title,
    subtitle: input.subtitle,
    detail: input.detail,
    occurredAt: input.occurredAt,
    status: input.status || null,
    target: input.target,
    metadata: input.metadata,
  };
}

function providerOrNull(value: unknown): AccountProvider | null {
  return value === "gmail" || value === "microsoft" ? value : null;
}

function activitySearchText(item: ActivityTimelineItem) {
  return normalizeSearch([
    item.kind,
    item.title,
    item.subtitle,
    item.detail,
    item.status,
    item.accountLabel,
    item.accountEmail,
    item.accountProvider,
    item.metadata ? Object.values(item.metadata).join(" ") : "",
  ].filter(Boolean).join(" "));
}

function normalizeSearch(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
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

function actionTitle(action: MailActionName) {
  return mailActionHistoryTitle(action);
}

function sourceLabel(sourceType: string, replyMode: string | null = null) {
  if (sourceType === "forward") return "Forward";
  if (sourceType === "reply") return replyMode === "all" ? "Reply all" : "Reply";
  return "New email";
}

function outgoingRecipientSummary(row: Row) {
  const to = parseRecipientObjects(row.to_recipients);
  const count = recipientCount(row);
  if (!to.length) return "no recipients yet";
  const first = to[0].email;
  const extra = count - 1;
  return extra > 0 ? `${first} +${extra}` : first;
}

function recipientCount(row: Row) {
  return parseRecipientObjects(row.to_recipients).length +
    parseRecipientObjects(row.cc_recipients).length +
    parseRecipientObjects(row.bcc_recipients).length;
}

function parseRecipientObjects(value: unknown): Array<{ email: string }> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        email: typeof item === "object" && item !== null && "email" in item
          ? String((item as { email?: unknown }).email || "")
          : String(item || ""),
      }))
      .filter((item) => item.email);
  } catch {
    return [];
  }
}

function stringOrNull(value: unknown) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text ? text : null;
}

function providerLabel(value: unknown) {
  return value === "microsoft" ? "Hotmail" : value === "gmail" ? "Gmail" : "Provider";
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDateTime(value: unknown) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "not yet";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
