import { localDayRange } from "./calendar-day";
export { localDayRange } from "./calendar-day";
import {
  audit,
  execute,
  getSetting,
  getServiceState,
  newId,
  nowIso,
  syncMessageSearchIndex,
} from "./database";
import {
  getGmailAuthorizationCapabilities,
  getGmailUnsubscribeMetadata,
  searchGmailMessagePage,
} from "./gmail";
import { providerAdapterFor } from "./provider-adapter";
import {
  applyMaintenanceAction,
  getMessageDetail,
  providerOrganizationState,
  recordFeedback,
  undoMaintenanceAction,
} from "./service";
import { getSavedView, savedViewToMailFilters } from "./saved-views";
import { describeProviderError } from "./provider-errors";
import type {
  AccountProvider,
  AskEzraResult,
  AttentionLevel,
  BriefCandidate,
  CleanupSuggestion,
  DraftItem,
  EmailEnvelope,
  InboxItem,
  MailActionName,
  MailCareLevel,
  MailCarePreferenceSummary,
  MailCareScope,
  MailActionResult,
  MailPage,
  MailTodaySnapshot,
  MailThreadItem,
  ProviderOrganizationCapabilities,
  RuleItem,
  TodayBrief,
  TodayHistory,
  TodayHistoryItem,
  TodayHistoryKind,
  TodayReviewItem,
  TodayTopic,
  TodayTopicKind,
} from "./types";
import { mailActionHistoryTitle } from "./vocabulary";
import { accountPurpose, buildMailWorkspaces, providerForWorkspace, workspaceSqlFilter } from "./workspaces";

type Row = Awaited<ReturnType<typeof execute>>["rows"][number];

type MailPageInput = {
  cursor?: string | null;
  limit?: number;
  search?: string;
  workspaceId?: string;
  viewId?: string;
  account?: string;
  folder?: string;
  inboxCategory?: string;
  category?: string;
  categories?: string[];
  priority?: string;
  unread?: boolean;
  attachments?: boolean;
  date?: string;
  needsReply?: boolean;
  hasDeadline?: boolean;
  handled?: "active" | "handled" | "any";
  messageIds?: string[];
};

function accountProviderOrNull(value: unknown): AccountProvider | null {
  return value === "gmail" || value === "microsoft" ? value : null;
}

function ruleMutationWorkspaceFilter(workspaceId?: string) {
  if (!workspaceId) return { sql: "1 = 1", args: [] as string[] };
  const provider = providerForWorkspace(workspaceId);
  if (provider === "all") return { sql: "1 = 1", args: [] as string[] };
  return {
    sql: `account_id IN (
      SELECT id FROM email_accounts WHERE provider = ? AND status <> 'disabled'
    )`,
    args: [provider],
  };
}

const PROTECTED_CATEGORIES = new Set([
  "account-compromise",
  "account-security",
  "account-verification",
  "authentication",
  "career",
  "finance",
  "financial",
  "fraud",
  "health",
  "job",
  "legal",
  "medical",
  "personal",
  "receipt",
  "transaction",
  "transactional",
]);
const PROMOTIONAL_CATEGORY = /(bulk|marketing|newsletter|promotion|sale|shopping|social)/i;
const GMAIL_TAB_CATEGORY_LABELS: Record<string, string> = {
  promotions: "CATEGORY_PROMOTIONS",
  updates: "CATEGORY_UPDATES",
  social: "CATEGORY_SOCIAL",
  forums: "CATEGORY_FORUMS",
};
const GMAIL_TAB_LABELS = Object.values(GMAIL_TAB_CATEGORY_LABELS);

export async function getMailTodaySnapshot(input: {
  workspaceId?: string;
  timezone?: string;
  now?: string;
} = {}): Promise<MailTodaySnapshot> {
  const timezone = input.timezone?.trim() || (await getSetting("timezone")) || "America/Chicago";
  const generatedAt = input.now ? new Date(input.now).toISOString() : nowIso();
  const day = localDayRange(timezone, new Date(generatedAt));
  const workspace = workspaceSqlFilter(input.workspaceId);
  const candidates = await execute(
    `WITH ranked AS (
      SELECT m.*, a.label AS account_label, a.provider AS account_provider,
        COALESCE(t.user_corrected_attention, t.attention) AS attention,
        t.urgency, t.confidence, t.category, t.summary, t.reason,
        t.recommendation, t.needs_reply, t.deadline, t.injection_flags, t.model,
        ROW_NUMBER() OVER (
          PARTITION BY m.account_id, m.thread_id ORDER BY m.received_at DESC, m.id DESC
        ) AS thread_rank,
        COUNT(*) OVER (PARTITION BY m.account_id, m.thread_id) AS thread_count
      FROM email_messages m
      JOIN email_accounts a ON a.id = m.account_id
      LEFT JOIN triage_decisions t ON t.id = (
        SELECT id FROM triage_decisions td WHERE td.message_id = m.id
        ORDER BY td.created_at DESC LIMIT 1
      )
      WHERE m.status IN ('new', 'triaged', 'backlog_queued')
        AND m.is_unread = 1
        AND m.gmail_labels LIKE '%"INBOX"%'
        AND m.ingest_source <> 'provider_search'
        AND m.gmail_labels NOT LIKE '%"SPAM"%'
        AND m.gmail_labels NOT LIKE '%"TRASH"%'
        AND m.gmail_labels NOT LIKE '%"SENT"%'
        AND ${workspace.sql}
    )
    SELECT * FROM ranked WHERE thread_rank = 1
    ORDER BY received_at DESC LIMIT 180`,
    workspace.args,
  );

  const scored = candidates.rows
    .map((row) => scoreTodayCandidate(row))
    .filter((item): item is ScoredTopic => Boolean(item))
    .sort((left, right) => right.score - left.score);
  const topics = chooseBriefTopics(scored);
  const candidateByMessageId = new Map(scored.map((item) => [item.id, item.candidate]));
  const briefCandidates = topics.flatMap((topic) => {
    const candidate = candidateByMessageId.get(topic.id);
    return candidate ? [candidate] : [];
  });
  const replyIds = new Set(topics.filter((topic) => topic.kind === "reply").map((topic) => topic.id));
  const replyCandidates = briefCandidates.filter((candidate) => {
    const target = candidate.target;
    return target.view === "mail" && replyIds.has(target.messageId);
  });
  const cleanup = await getCleanupSuggestions(4, input.workspaceId);
  const oneMoreGlance = await getOneMoreGlance(day, input.workspaceId, [
    ...topics.map((topic) => topic.id),
    ...cleanup.map((item) => item.latestMessageId),
  ]);
  const quietCountResult = await execute(
    `SELECT COUNT(*) AS count
     FROM email_messages m
     JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE COALESCE(t.user_corrected_attention, t.attention) = 'suppress'
       AND t.created_at >= ?
       AND t.created_at < ?
       AND m.gmail_labels NOT LIKE '%"SPAM"%'
       AND m.gmail_labels NOT LIKE '%"TRASH"%'
       AND m.gmail_labels NOT LIKE '%"SENT"%'
       AND ${workspace.sql}`,
    [day.startIso, day.endIso, ...workspace.args],
  );
  const quietReviewed = Number(quietCountResult.rows[0]?.count || 0);
  const mailActivity = await getTodayMailActivity(day, input.workspaceId);
  const history = await getTodayHistory(day, input.workspaceId, generatedAt);
  const briefId = newId("brief");

  return {
    id: briefId,
    date: day.date,
    generatedAt,
    quietReviewed,
    mailActivity,
    topics,
    cleanup,
    oneMoreGlance,
    history,
    counts: {
      action: topics.filter((topic) => topic.kind === "action").length,
      reply: topics.filter((topic) => topic.kind === "reply").length,
      deadline: topics.filter((topic) => topic.kind === "deadline").length,
      fyi: topics.filter((topic) => topic.kind === "fyi").length,
    },
    briefCandidates,
    replyCandidates,
  };
}

export async function getTodayBrief(input: { workspaceId?: string } = {}): Promise<TodayBrief> {
  const livingBrief = await import("./today-brief");
  return livingBrief.getTodayBrief(input);
}

async function getOneMoreGlance(
  day: ReturnType<typeof localDayRange>,
  workspaceId: string | undefined,
  excludedIds: string[],
): Promise<TodayReviewItem[]> {
  const workspace = workspaceSqlFilter(workspaceId);
  const result = await execute(
    `WITH ranked AS (
      SELECT m.*, a.label AS account_label, a.provider AS account_provider,
        COALESCE(t.user_corrected_attention, t.attention) AS attention,
        t.category, t.summary,
        ROW_NUMBER() OVER (
          PARTITION BY m.account_id, m.thread_id ORDER BY m.received_at DESC, m.id DESC
        ) AS thread_rank
      FROM email_messages m
      JOIN email_accounts a ON a.id = m.account_id
      LEFT JOIN triage_decisions t ON t.id = (
        SELECT id FROM triage_decisions td WHERE td.message_id = m.id
        ORDER BY td.created_at DESC LIMIT 1
      )
      WHERE m.received_at >= ?
        AND m.received_at < ?
        AND m.ingest_source <> 'provider_search'
        AND m.gmail_labels LIKE '%"INBOX"%'
        AND m.gmail_labels NOT LIKE '%"SPAM"%'
        AND m.gmail_labels NOT LIKE '%"TRASH"%'
        AND m.gmail_labels NOT LIKE '%"SENT"%'
        AND m.status NOT IN ('deleted', 'spam')
        AND (
          m.is_unread = 0
          OR m.status IN ('read', 'cleared', 'maintained')
        )
        AND NOT (
          m.is_unread = 1
          AND m.status IN ('new', 'triaged', 'backlog_queued')
          AND COALESCE(t.user_corrected_attention, t.attention) = 'interrupt'
        )
        AND ${workspace.sql}
    )
    SELECT * FROM ranked
    WHERE thread_rank = 1
    ORDER BY received_at DESC, id DESC
    LIMIT 24`,
    [day.startIso, day.endIso, ...workspace.args],
  );
  const excluded = new Set(excludedIds);
  return result.rows
    .filter((row) => !excluded.has(String(row.id)))
    .slice(0, 5)
    .map(todayReviewItemFromRow);
}

function todayReviewItemFromRow(row: Row): TodayReviewItem {
  const attention = row.attention ? (String(row.attention) as AttentionLevel) : null;
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    accountLabel: String(row.account_label),
    accountProvider: row.account_provider
      ? (String(row.account_provider) as TodayReviewItem["accountProvider"])
      : undefined,
    senderName: String(row.sender_name),
    senderEmail: String(row.sender_email),
    subject: String(row.subject),
    summary: String(row.summary || row.snippet || row.subject),
    receivedAt: String(row.received_at),
    category: row.category ? String(row.category) : null,
    attention,
    reasonLabel: reviewReasonLabel(row, attention),
  };
}

function reviewReasonLabel(row: Row, attention: AttentionLevel | null) {
  const status = String(row.status || "");
  if (status === "cleared") return "Acknowledged earlier";
  if (status === "maintained") return "Handled by a quiet rule";
  if (status === "read") return "Marked read";
  if (attention === "suppress") return "Ezra kept it quiet";
  if (attention === "interrupt") return "Handled priority mail";
  return "Already handled";
}

async function getTodayHistory(
  day: ReturnType<typeof localDayRange>,
  workspaceId: string | undefined,
  generatedAt: string,
): Promise<TodayHistory> {
  const [received, quieted, stillNeedsAction, actionHistory] = await Promise.all([
    queryTodayHistoryMessages({
      day,
      workspaceId,
      kind: "received",
      detail: "Received in this workspace today.",
      where: `
        m.received_at >= ?
        AND m.received_at < ?
        AND m.ingest_source <> 'provider_search'
        AND m.gmail_labels NOT LIKE '%"SENT"%'
      `,
    }),
    queryTodayHistoryMessages({
      day,
      workspaceId,
      kind: "quieted",
      detail: "Ezra classified this as quiet or low-interruption mail.",
      where: `
        m.received_at >= ?
        AND m.received_at < ?
        AND m.ingest_source <> 'provider_search'
        AND m.gmail_labels LIKE '%"INBOX"%'
        AND m.gmail_labels NOT LIKE '%"SPAM"%'
        AND m.gmail_labels NOT LIKE '%"TRASH"%'
        AND m.gmail_labels NOT LIKE '%"SENT"%'
        AND m.status NOT IN ('deleted', 'spam')
        AND COALESCE(t.user_corrected_attention, t.attention) = 'suppress'
      `,
    }),
    queryTodayHistoryMessages({
      day,
      workspaceId,
      kind: "still_needs_action",
      detail: "Still unread, still in the inbox, and still classified as priority.",
      where: `
        m.received_at >= ?
        AND m.received_at < ?
        AND m.ingest_source <> 'provider_search'
        AND m.is_unread = 1
        AND m.status IN ('new', 'triaged', 'backlog_queued')
        AND m.gmail_labels LIKE '%"INBOX"%'
        AND m.gmail_labels NOT LIKE '%"SPAM"%'
        AND m.gmail_labels NOT LIKE '%"TRASH"%'
        AND m.gmail_labels NOT LIKE '%"SENT"%'
        AND COALESCE(t.user_corrected_attention, t.attention) = 'interrupt'
      `,
    }),
    queryTodayActionHistory(day, workspaceId),
  ]);

  return {
    generatedAt,
    sections: [
      {
        kind: "received",
        title: "What came in today",
        description: "Recent incoming mail Ezra saw in the selected workspace.",
        count: received.count,
        items: received.items,
      },
      {
        kind: "quieted",
        title: "What Ezra kept quiet",
        description: "Messages Ezra classified as low-interruption or quiet.",
        count: quieted.count,
        items: quieted.items,
      },
      {
        kind: "handled",
        title: "What you handled",
        description: "Acknowledged, read, deleted, taught, or corrected mail actions.",
        count: actionHistory.handled.count,
        items: actionHistory.handled.items,
      },
      {
        kind: "still_needs_action",
        title: "What still needs action",
        description: "Unread priority mail still active in this workspace.",
        count: stillNeedsAction.count,
        items: stillNeedsAction.items,
      },
      {
        kind: "failed",
        title: "Failed or partial actions",
        description: "Provider or local actions that need review before retrying.",
        count: actionHistory.failed.count,
        items: actionHistory.failed.items,
      },
    ],
  };
}

async function queryTodayHistoryMessages(input: {
  day: ReturnType<typeof localDayRange>;
  workspaceId?: string;
  kind: TodayHistoryKind;
  detail: string;
  where: string;
  limit?: number;
}): Promise<{ count: number; items: TodayHistoryItem[] }> {
  const workspace = workspaceSqlFilter(input.workspaceId);
  const limit = input.limit || 6;
  const result = await execute(
    `SELECT m.*, a.label AS account_label, a.provider AS account_provider,
       COALESCE(t.user_corrected_attention, t.attention) AS attention,
       t.category, t.summary,
       COUNT(*) OVER() AS total_count
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     LEFT JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE ${input.where}
       AND ${workspace.sql}
     ORDER BY m.received_at DESC, m.id DESC
     LIMIT ?`,
    [input.day.startIso, input.day.endIso, ...workspace.args, limit],
  );
  return {
    count: Number(result.rows[0]?.total_count || 0),
    items: result.rows.map((row) => todayHistoryMessageItem(row, input.kind, input.detail)),
  };
}

function todayHistoryMessageItem(row: Row, kind: TodayHistoryKind, detail: string): TodayHistoryItem {
  const category = row.category ? String(row.category) : "uncategorized";
  return {
    id: `${kind}:${String(row.id)}`,
    kind,
    itemType: "message",
    messageId: String(row.id),
    actionId: null,
    accountId: String(row.account_id),
    accountLabel: String(row.account_label),
    accountProvider: row.account_provider
      ? (String(row.account_provider) as TodayHistoryItem["accountProvider"])
      : undefined,
    title: String(row.subject),
    subtitle: `${String(row.sender_name)} · ${String(row.account_label)} · ${humanizeLabel(category)}`,
    detail: String(row.summary || detail),
    occurredAt: String(row.received_at),
    action: null,
    status: String(row.status || ""),
    successCount: null,
    failureCount: null,
  };
}

async function queryTodayActionHistory(
  day: ReturnType<typeof localDayRange>,
  workspaceId?: string,
): Promise<{
  handled: { count: number; items: TodayHistoryItem[] };
  failed: { count: number; items: TodayHistoryItem[] };
}> {
  const actionRowsResult = await execute(
    `SELECT * FROM mail_actions
     WHERE COALESCE(executed_at, created_at) >= ?
       AND COALESCE(executed_at, created_at) < ?
     ORDER BY COALESCE(executed_at, created_at) DESC, created_at DESC
     LIMIT 80`,
    [day.startIso, day.endIso],
  );
  const handledItems: TodayHistoryItem[] = [];
  const failedItems: TodayHistoryItem[] = [];
  let handledCount = 0;
  let failedCount = 0;
  for (const row of actionRowsResult.rows) {
    const messageIds = parseStringArray(row.message_ids);
    const messages = await actionWorkspaceMessages(messageIds, workspaceId);
    if (!messages.length) continue;
    const successCount = Number(row.success_count || 0);
    const failureCount = Number(row.failure_count || 0);
    const status = String(row.status || "");
    if (successCount > 0 || status === "executed" || status === "partial") {
      handledCount += 1;
      if (handledItems.length < 8) {
        handledItems.push(todayHistoryActionItem(row, messages, "handled"));
      }
    }
    if (failureCount > 0 || status === "failed") {
      failedCount += 1;
      if (failedItems.length < 6) {
        failedItems.push(todayHistoryActionItem(row, messages, "failed"));
      }
    }
  }
  return {
    handled: { count: handledCount, items: handledItems },
    failed: { count: failedCount, items: failedItems },
  };
}

async function actionWorkspaceMessages(messageIds: string[], workspaceId?: string) {
  const ids = Array.from(new Set(messageIds)).filter(Boolean);
  if (!ids.length) return [] as Row[];
  const workspace = workspaceSqlFilter(workspaceId);
  const placeholders = ids.map(() => "?").join(", ");
  const result = await execute(
    `SELECT m.id, m.account_id, m.sender_name, m.sender_email, m.subject, m.received_at,
       a.label AS account_label, a.provider AS account_provider
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id IN (${placeholders})
       AND ${workspace.sql}
     ORDER BY m.received_at DESC, m.id DESC`,
    [...ids, ...workspace.args],
  );
  return result.rows;
}

function todayHistoryActionItem(row: Row, messages: Row[], kind: "handled" | "failed"): TodayHistoryItem {
  const action = String(row.action || "") as TodayHistoryItem["action"];
  const details = parseRecord(row.details);
  const failures = Array.isArray(details.failures) ? details.failures.length : Number(row.failure_count || 0);
  const changed = Array.isArray(details.changedIds) ? details.changedIds.length : Number(row.success_count || 0);
  const unchanged = Array.isArray(details.unchangedIds) ? details.unchangedIds.length : 0;
  const accountLabels = Array.from(new Set(messages.map((message) => String(message.account_label)))).join(", ");
  const sample = messages[0];
  const successCount = Number(row.success_count || 0);
  const failureCount = Number(row.failure_count || 0);
  return {
    id: `${kind}:${String(row.id)}`,
    kind,
    itemType: "action",
    messageId: sample ? String(sample.id) : null,
    actionId: String(row.id),
    accountId: sample ? String(sample.account_id) : null,
    accountLabel: accountLabels || null,
    accountProvider: sample?.account_provider
      ? (String(sample.account_provider) as TodayHistoryItem["accountProvider"])
      : undefined,
    title: historyActionTitle(action, kind),
    subtitle: `${messages.length} message${messages.length === 1 ? "" : "s"} · ${accountLabels || "selected workspace"}`,
    detail:
      kind === "failed"
        ? `${failureCount || failures} failed, ${successCount || changed} changed, ${unchanged} unchanged. Review before retrying.`
        : `${successCount || changed} changed, ${unchanged} unchanged, ${failureCount || failures} failed.`,
    occurredAt: String(row.executed_at || row.created_at),
    action,
    status: String(row.status || ""),
    successCount,
    failureCount,
  };
}

function historyActionTitle(action: TodayHistoryItem["action"], kind: "handled" | "failed") {
  const prefix = kind === "failed" ? "Problem with " : "";
  return mailActionHistoryTitle(action, prefix);
}

function humanizeLabel(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function getTodayMailActivity(
  day: ReturnType<typeof localDayRange>,
  workspaceId?: string,
): Promise<MailTodaySnapshot["mailActivity"]> {
  const workspace = workspaceSqlFilter(workspaceId);
  const baseWhere = `
    m.received_at >= ?
    AND m.received_at < ?
    AND m.ingest_source <> 'provider_search'
    AND m.gmail_labels NOT LIKE '%"SENT"%'
    AND ${workspace.sql}
  `;
  const baseArgs = [day.startIso, day.endIso, ...workspace.args];
  const statsResult = await execute(
    `SELECT
       COUNT(*) AS received_today,
       SUM(CASE
         WHEN t.id IS NOT NULL OR m.status NOT IN ('new', 'backlog_queued') THEN 1
         ELSE 0
       END) AS handled_today
     FROM email_messages m
     LEFT JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE ${baseWhere}`,
    baseArgs,
  );
  const attentionResult = await execute(
    `SELECT COALESCE(COALESCE(t.user_corrected_attention, t.attention), 'unknown') AS attention,
       COUNT(*) AS count
     FROM email_messages m
     LEFT JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE ${baseWhere}
     GROUP BY COALESCE(COALESCE(t.user_corrected_attention, t.attention), 'unknown')`,
    baseArgs,
  );
  const categoryResult = await execute(
    `SELECT COALESCE(NULLIF(lower(t.category), ''), 'uncategorized') AS category,
       COUNT(*) AS count
     FROM email_messages m
     LEFT JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE ${baseWhere}
     GROUP BY COALESCE(NULLIF(lower(t.category), ''), 'uncategorized')
     ORDER BY count DESC, category
     LIMIT 6`,
    baseArgs,
  );
  const stillNeedsAttentionResult = await execute(
    `SELECT COUNT(*) AS count
     FROM email_messages m
     JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE ${baseWhere}
       AND m.is_unread = 1
       AND m.status IN ('new', 'triaged', 'backlog_queued')
       AND m.gmail_labels LIKE '%"INBOX"%'
       AND m.gmail_labels NOT LIKE '%"SPAM"%'
       AND m.gmail_labels NOT LIKE '%"TRASH"%'
       AND COALESCE(t.user_corrected_attention, t.attention) = 'interrupt'`,
    baseArgs,
  );
  const receivedToday = Number(statsResult.rows[0]?.received_today || 0);
  const handledToday = Number(statsResult.rows[0]?.handled_today || 0);
  const attentionCounts = {
    interrupt: 0,
    digest: 0,
    suppress: 0,
    unknown: 0,
  };
  for (const row of attentionResult.rows) {
    const key = String(row.attention);
    if (key === "interrupt" || key === "digest" || key === "suppress") {
      attentionCounts[key] = Number(row.count || 0);
    } else {
      attentionCounts.unknown += Number(row.count || 0);
    }
  }
  return {
    receivedToday,
    handledToday,
    unhandledToday: Math.max(0, receivedToday - handledToday),
    attentionCounts,
    stillNeedsAttention: Number(stillNeedsAttentionResult.rows[0]?.count || 0),
    categoryCounts: categoryResult.rows.map((row) => ({
      category: String(row.category),
      count: Number(row.count || 0),
    })),
    lastPollAt: await getServiceState("last_poll_at"),
    lastPollError: await getServiceState("last_poll_error"),
  };
}

export async function getMailPage(input: MailPageInput): Promise<MailPage> {
  const limit = Math.min(100, Math.max(10, input.limit || 40));
  const resolvedInput = await resolveMailPageInput(input);
  const filters = buildMailFilters(resolvedInput);
  const cursor = decodeCursor(input.cursor);
  const cursorClause = cursor
    ? `AND (received_at < ? OR (received_at = ? AND id < ?))`
    : "";
  const cursorArgs = cursor ? [cursor.receivedAt, cursor.receivedAt, cursor.id] : [];
  const result = await execute(
    `WITH ranked AS (
      SELECT m.*, a.label AS account_label, a.provider AS account_provider,
        a.email AS account_email, a.status AS account_status,
        credentials.access AS account_access,
        COALESCE(t.user_corrected_attention, t.attention) AS attention,
        t.urgency, t.confidence, t.category, t.summary, t.reason,
        t.recommendation, t.needs_reply, t.deadline, t.injection_flags, t.model,
        ROW_NUMBER() OVER (
          PARTITION BY m.account_id, m.thread_id ORDER BY m.received_at DESC, m.id DESC
        ) AS thread_rank,
        COUNT(*) OVER (PARTITION BY m.account_id, m.thread_id) AS thread_count,
        (SELECT sent_at FROM notifications n WHERE n.message_id = m.id AND n.status = 'sent'
          ORDER BY n.created_at DESC LIMIT 1) AS notified_at
      FROM email_messages m
      JOIN email_accounts a ON a.id = m.account_id
      LEFT JOIN provider_account_credentials credentials ON credentials.account_id = a.id
      LEFT JOIN triage_decisions t ON t.id = (
        SELECT id FROM triage_decisions td WHERE td.message_id = m.id
        ORDER BY td.created_at DESC LIMIT 1
      )
      WHERE ${filters.sql}
    )
    SELECT * FROM ranked
    WHERE thread_rank = 1 ${cursorClause}
    ORDER BY received_at DESC, id DESC LIMIT ?`,
    [...filters.args, ...cursorArgs, limit + 1],
  );
  const countResult = await execute(
    `SELECT COUNT(*) AS count FROM (
      SELECT m.account_id, m.thread_id
      FROM email_messages m
      LEFT JOIN triage_decisions t ON t.id = (
        SELECT id FROM triage_decisions td WHERE td.message_id = m.id
        ORDER BY td.created_at DESC LIMIT 1
      )
      WHERE ${filters.sql}
      GROUP BY m.account_id, m.thread_id
    )`,
    filters.args,
  );
  const hasMore = result.rows.length > limit;
  const visibleRows = result.rows.slice(0, limit);
  const items = visibleRows.map(mailThreadItemFromRow);
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last.receivedAt, last.id) : null,
    total: Number(countResult.rows[0]?.count || 0),
  };
}

export async function getMailMeta() {
  const [accounts, categories] = await Promise.all([
    execute(
      `SELECT a.id, a.provider, a.label, a.email, a.status, a.last_sync_at,
         p.purpose_label
       FROM email_accounts a
       LEFT JOIN account_profile_settings p ON p.account_id = a.id
       WHERE a.status <> 'disabled' ORDER BY a.label`,
    ),
    execute(
      `SELECT DISTINCT lower(t.category) AS category
       FROM triage_decisions t
       WHERE t.id = (SELECT id FROM triage_decisions td WHERE td.message_id = t.message_id
         ORDER BY td.created_at DESC LIMIT 1)
         AND t.category IS NOT NULL AND t.category <> ''
       ORDER BY category LIMIT 100`,
    ),
  ]);
  const accountStatuses = accounts.rows.map((row) => ({
    id: String(row.id),
    provider: String(row.provider || "gmail") as "gmail" | "microsoft",
    email: String(row.email),
    label: String(row.label),
    purpose: row.purpose_label ? String(row.purpose_label) : accountPurpose(String(row.provider || "gmail") as "gmail" | "microsoft"),
    status: String(row.status || "connected") as "connected" | "needs_setup" | "error" | "disabled",
    lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
    counts: { inbox: 0, unread: 0, interrupt: 0, digest: 0, maintenance: 0 },
  }));
  return {
    accounts: accountStatuses.map((row) => ({
      id: String(row.id),
      provider: row.provider,
      label: String(row.label),
      email: String(row.email),
      purpose: row.purpose,
    })),
    workspaces: buildMailWorkspaces(accountStatuses),
    categories: categories.rows.map((row) => String(row.category)),
  };
}

export async function getProfessionalMessageDetail(messageId: string) {
  const detail = await getMessageDetail(messageId);
  const careTrace = await getCareTrace(messageId);
  const capabilityRow = await execute(
    `SELECT m.*, a.email AS account_email, a.provider, a.status AS account_status,
       credentials.access AS account_access, t.category
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     LEFT JOIN provider_account_credentials credentials ON credentials.account_id = a.id
     LEFT JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE m.id = ?`,
    [messageId],
  );
  const protectedMessage = capabilityRow.rows[0]
    ? isProtectedCleanup(capabilityRow.rows[0])
    : false;
  const unsubscribeSupported = capabilityRow.rows[0] && !protectedMessage
    ? await unsubscribeCapability(capabilityRow.rows[0])
    : false;
  const organization = capabilityRow.rows[0]
    ? organizationCapabilitiesForRow(capabilityRow.rows[0])
    : {
      pin: { state: "unavailable" as const, reason: "Ezra cannot safely map Pin for this account yet." },
      flag: { state: "unavailable" as const, reason: "Ezra cannot safely map Flag for this account yet." },
    };
  const threadRows = await execute(
    `SELECT m.*, a.label AS account_label, a.provider AS account_provider,
      a.email AS account_email, a.status AS account_status,
      credentials.access AS account_access,
      COALESCE(t.user_corrected_attention, t.attention) AS attention,
      t.urgency, t.confidence, t.category, t.summary, t.reason,
      t.recommendation, t.needs_reply, t.deadline, t.injection_flags, t.model,
      1 AS thread_count, NULL AS notified_at
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     LEFT JOIN provider_account_credentials credentials ON credentials.account_id = a.id
     LEFT JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE m.account_id = ? AND m.thread_id = ?
     ORDER BY m.received_at ASC`,
    [detail.message.accountId, detail.message.threadId],
  );
  return {
    detail: { ...detail, careTrace },
    thread: threadRows.rows.map(mailThreadItemFromRow),
    capabilities: { unsubscribeSupported, protectedMessage, organization },
  };
}

async function getCareTrace(messageId: string) {
  const messageResult = await execute(
    `SELECT m.account_id, m.sender_email, m.subject, m.snippet,
      t.attention, t.user_corrected_attention, t.category
     FROM email_messages m
     LEFT JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE m.id = ?`,
    [messageId],
  );
  const row = messageResult.rows[0];
  if (!row) {
    return {
      originalAttention: null,
      correctedAttention: null,
      currentAttention: null,
      matchingPreferences: [],
      notificationStatus: null,
      notificationSentAt: null,
      notificationError: null,
    };
  }
  const preferences = await matchingCarePreferences({
    accountId: String(row.account_id),
    senderEmail: String(row.sender_email),
    subject: String(row.subject || ""),
    snippet: String(row.snippet || ""),
    category: row.category ? String(row.category) : null,
  });
  const notification = await execute(
    `SELECT status, sent_at, error
     FROM notifications
     WHERE message_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    [messageId],
  );
  const latest = notification.rows[0];
  const originalAttention = attentionOrNull(row.attention);
  const correctedAttention = attentionOrNull(row.user_corrected_attention);
  return {
    originalAttention,
    correctedAttention,
    currentAttention: correctedAttention || originalAttention,
    matchingPreferences: preferences.map((preference) => ({
      id: String(preference.id),
      kind: String(preference.kind) as "sender" | "topic",
      pattern: String(preference.pattern),
      action: attentionOrNull(preference.action) || "digest",
      evidenceCount: Number(preference.evidence_count || 0),
    })),
    notificationStatus: latest?.status ? String(latest.status) : "none",
    notificationSentAt: latest?.sent_at ? String(latest.sent_at) : null,
    notificationError: latest?.error ? String(latest.error) : null,
  };
}

export async function searchProviderMail(input: {
  query: string;
  accountId?: string;
  workspaceId?: string;
  pageToken?: string;
}) {
  if (providerForWorkspace(input.workspaceId) === "microsoft") {
    return { items: [], nextPageToken: null, accountCount: 0 };
  }
  const accounts = await execute(
    `SELECT id, email FROM email_accounts
     WHERE provider = 'gmail' AND status = 'connected'
       ${input.accountId ? "AND id = ?" : ""}
     ORDER BY label`,
    input.accountId ? [input.accountId] : [],
  );
  const storedIds: string[] = [];
  let nextPageToken: string | null = null;
  for (const account of accounts.rows) {
    const organizationObservedAt = nowIso();
    const page = await searchGmailMessagePage(String(account.email), {
      query: input.query,
      maxResults: 50,
      pageToken: accounts.rows.length === 1 ? input.pageToken : null,
    });
    nextPageToken = accounts.rows.length === 1 ? page.nextPageToken : null;
    for (const message of page.messages) {
      const messageId = await storeProviderResult(
        String(account.id),
        input.query,
        message,
        organizationObservedAt,
      );
      storedIds.push(messageId);
    }
  }
  const items = await mailItemsByIds(storedIds);
  await audit("mail.provider_search", "owner", "query", input.query, {
    accountId: input.accountId || null,
    results: items.length,
  });
  return { items, nextPageToken, accountCount: accounts.rows.length };
}

export async function askEzra(query: string): Promise<AskEzraResult> {
  const page = await getMailPage({ search: query, folder: "all", limit: 12 });
  const sources = page.items.map((item) => ({
    id: item.id,
    senderName: item.senderName,
    subject: item.subject,
    receivedAt: item.receivedAt,
    summary: item.summary || item.snippet,
  }));
  if (!sources.length) {
    return {
      answer: "I could not find matching mail in the local index. Try Search Gmail for older mail.",
      sources: [],
    };
  }
  const senders = Array.from(new Set(sources.map((source) => source.senderName))).slice(0, 4);
  const keyPoints = sources
    .slice(0, 4)
    .map((source) => `${source.subject}: ${source.summary}`)
    .join(" ");
  return {
    answer: `I found ${sources.length} relevant thread${sources.length === 1 ? "" : "s"} from ${senders.join(", ")}. ${keyPoints}`,
    sources,
  };
}

export async function applyProfessionalMailAction(input: {
  action: MailActionName;
  messageIds?: string[];
  actionId?: string;
  care?: MailCareLevel;
  scopes?: MailCareScope[];
  topicLabel?: string;
}): Promise<MailActionResult> {
  if (input.action === "undo") {
    if (!input.actionId) throw new Error("An action id is required to undo.");
    return undoMailAction(input.actionId);
  }
  const messageIds = Array.from(new Set(input.messageIds || [])).slice(0, 100);
  if (!messageIds.length) throw new Error("Select at least one message.");
  const requestedRows = await actionRows(messageIds);
  if (!requestedRows.length) throw new Error("The selected messages were not found.");
  const foundIds = new Set(requestedRows.map((row) => String(row.id)));
  const excludesProtected = ["quiet", "unsubscribe", "spam"].includes(input.action);
  const protectedRows = excludesProtected
    ? requestedRows.filter((row) => isProtectedCleanup(row))
    : [];
  const rows = excludesProtected
    ? requestedRows.filter((row) => !isProtectedCleanup(row))
    : requestedRows;
  const actionId = newId("action");
  const snapshots = rows.map(actionSnapshot);
  await execute(
    `INSERT INTO mail_actions
      (id, action, status, message_ids, undo_data, undo_status, created_at)
     VALUES (?, ?, 'executing', ?, ?, ?, ?)`,
    [
      actionId,
      input.action,
      JSON.stringify(messageIds),
      input.action === "unsubscribe" ? null : JSON.stringify(snapshots),
      input.action === "unsubscribe" ? null : "available",
      nowIso(),
    ],
  );

  const failures: Array<{ id: string; error: string }> = protectedRows.map((row) => ({
    id: String(row.id),
    error: "Protected mail was excluded from this cleanup action.",
  }));
  for (const messageId of messageIds) {
    if (!foundIds.has(messageId)) failures.push({ id: messageId, error: "The selected message was not found." });
  }
  let successCount = 0;
  const nestedActions: string[] = [];
  const changedIds: string[] = [];
  const unchangedIds: string[] = [];
  const savedPreferences: MailCarePreferenceSummary[] = [];
  try {
    if (input.action === "teach_care") {
      const care = normalizeCareAction(input.care);
      const scopes = normalizeCareScopes(input.scopes);
      const topicLabel = scopes.includes("topic") ? normalizeTopicLabel(input.topicLabel || "") : null;
      if (scopes.includes("topic") && !topicLabel) {
        throw new Error("A topic label is required to teach Ezra about subject matter.");
      }
      for (const row of rows) {
        try {
          const result = await applyCareTeaching(row, care, scopes, topicLabel);
          for (const id of result.changedIds) changedIds.push(id);
          for (const preference of result.preferences) savedPreferences.push(preference);
          successCount += 1;
        } catch (error) {
          failures.push({ id: String(row.id), error: errorMessage(error) });
        }
      }
    } else if (input.action === "lower_priority" || input.action === "keep" || input.action === "raise_priority") {
      const feedback =
        input.action === "raise_priority"
          ? "interrupt"
          : input.action === "keep"
            ? "digest"
            : "suppress";
      for (const row of rows) {
        try {
          await recordFeedback(String(row.id), feedback, "mail");
          changedIds.push(String(row.id));
          successCount += 1;
        } catch (error) {
          failures.push({ id: String(row.id), error: errorMessage(error) });
        }
      }
    } else if (input.action === "quiet" || input.action === "unsubscribe") {
      for (const row of rows) {
        await recordFeedback(String(row.id), "suppress", "mail");
      }
      const senders = uniqueSenderTargets(rows);
      for (const target of senders) {
        try {
          const result = await applyMaintenanceAction({
            accountId: target.accountId,
            senderEmail: target.senderEmail,
            action: input.action === "quiet" ? "mark_read" : "unsubscribe",
            remember: true,
            source: "mail",
          });
          nestedActions.push(result.actionId);
          for (const row of rows.filter((candidate) => String(candidate.account_id) === target.accountId && String(candidate.sender_email).toLowerCase() === target.senderEmail)) {
            changedIds.push(String(row.id));
          }
          successCount += result.messageCount;
        } catch (error) {
          failures.push({ id: target.senderEmail, error: errorMessage(error) });
        }
      }
    } else if (organizationAction(input.action)) {
      const organization = organizationAction(input.action)!;
      for (const group of groupByAccount(rows)) {
        const adapter = providerAdapterFor(group.accountProvider as AccountProvider);
        const capability = organizationCapabilitiesForRow(group.rows[0])[organization.kind];
        if (capability.state !== "supported") {
          for (const row of group.rows) failures.push({ id: String(row.id), error: capability.reason });
          continue;
        }
        const pending = group.rows.filter((row) => !isActionAlreadySatisfied(row, input.action));
        for (const row of group.rows.filter((row) => isActionAlreadySatisfied(row, input.action))) {
          unchangedIds.push(String(row.id));
        }
        for (const row of pending) {
          try {
            if (!group.accountEmail.endsWith(".test")) {
              await adapter.applyOrganizationState(
                group.accountEmail,
                organization.kind,
                organization.desired,
                [String(row.external_message_id)],
              );
            }
            await updateLocalOrganizationState(row, organization.kind, organization.desired);
            changedIds.push(String(row.id));
            successCount += 1;
          } catch (error) {
            failures.push({ id: String(row.id), error: errorMessage(error) });
          }
        }
      }
    } else {
      const providerAction =
        input.action === "spam"
          ? "spam"
          : input.action === "delete" || input.action === "delete_and_teach"
            ? "trash"
            : "read";
      const providerRows: Row[] = [];
      for (const row of rows) {
        if (isActionAlreadySatisfied(row, input.action)) {
          unchangedIds.push(String(row.id));
        } else if (providerAction === "read" && !rowNeedsProviderRead(row)) {
          try {
            await updateLocalAfterProviderAction(row, input.action);
            changedIds.push(String(row.id));
            successCount += 1;
          } catch (error) {
            failures.push({ id: String(row.id), error: errorMessage(error) });
          }
        } else {
          providerRows.push(row);
        }
      }
      for (const group of groupByAccount(providerRows)) {
        try {
          await applyProviderBatch(group.accountEmail, group.accountProvider, group.rows, providerAction);
          for (const row of group.rows) {
            if (input.action === "delete_and_teach") {
              await recordFeedback(String(row.id), "suppress", "mail");
            }
            await updateLocalAfterProviderAction(row, input.action);
            changedIds.push(String(row.id));
          }
          successCount += group.rows.length;
        } catch (error) {
          for (const row of group.rows) {
            failures.push({ id: String(row.id), error: errorMessage(error) });
          }
        }
      }
    }
  } catch (error) {
    failures.push({ id: "batch", error: errorMessage(error) });
  }
  const safeFailures = normalizeActionFailures(failures, requestedRows);
  const failureCount = safeFailures.length;
  const completedCount = successCount + unchangedIds.length;
  const status = completedCount ? (failureCount ? "partial" : "executed") : "failed";
  const reversible = input.action !== "unsubscribe" && input.action !== "teach_care" && successCount > 0;
  await execute(
    `UPDATE mail_actions SET status = ?, success_count = ?, failure_count = ?,
      details = ?, undo_status = ?, executed_at = ? WHERE id = ?`,
    [
      status,
      successCount,
      failureCount,
      JSON.stringify({ failures: safeFailures, nestedActions, changedIds, unchangedIds, savedPreferences }),
      reversible ? "available" : null,
      nowIso(),
      actionId,
    ],
  );
  await audit("mail.action", "owner", "mail_action", actionId, {
    action: input.action,
    successCount,
    failureCount,
  });
  return { actionId, action: input.action, successCount, failureCount, reversible, failures: safeFailures, changedIds, unchangedIds, savedPreferences };
}

function normalizeActionFailures(failures: Array<{ id: string; error: string }>, rows: Row[]) {
  return failures.map((failure) => {
    const row = rows.find((candidate) => String(candidate.id) === failure.id)
      || rows.find((candidate) => String(candidate.sender_email).toLowerCase() === failure.id.toLowerCase());
    if (/Protected mail was excluded/i.test(failure.error)) {
      return { id: failure.id, error: "Protected mail was excluded from this cleanup action.", code: "protected" as const, accountId: row ? String(row.account_id) : null, accountLabel: row?.account_label ? String(row.account_label) : null, provider: accountProviderOrNull(row?.account_provider), retryable: false };
    }
    if (/not found|missing|stale/i.test(failure.error)) {
      return { id: failure.id, error: "The selected message is no longer available. Refresh Mail before retrying.", code: "not_found" as const, accountId: row ? String(row.account_id) : null, accountLabel: row?.account_label ? String(row.account_label) : null, provider: accountProviderOrNull(row?.account_provider), retryable: false };
    }
    const provider = accountProviderOrNull(row?.account_provider);
    if (provider) {
      const described = describeProviderError(provider, failure.error);
      return { id: failure.id, error: described.message, code: described.code, accountId: String(row?.account_id || "") || null, accountLabel: row?.account_label ? String(row.account_label) : null, provider, retryable: described.code === "rate_limited" || described.code === "provider_unavailable" };
    }
    return { id: failure.id, error: "Ezra could not complete this local action. Refresh Mail and try again.", code: "local_error" as const, accountId: null, accountLabel: null, provider: null, retryable: true };
  });
}

function normalizeCareAction(value?: MailCareLevel): AttentionLevel {
  if (value === "more") return "interrupt";
  if (value === "less") return "suppress";
  if (value === "useful") return "digest";
  throw new Error("Choose whether Ezra should care more, care less, or keep this as useful.");
}

function normalizeCareScopes(value?: MailCareScope[]): MailCareScope[] {
  const scopes = Array.from(new Set(value || []));
  if (!scopes.length) throw new Error("Choose what Ezra should learn from: message, sender, subject matter, or both.");
  for (const scope of scopes) {
    if (scope !== "message" && scope !== "sender" && scope !== "topic") {
      throw new Error("Unsupported care teaching scope.");
    }
  }
  return scopes;
}

async function applyCareTeaching(
  row: Row,
  action: AttentionLevel,
  scopes: MailCareScope[],
  topicLabel: string | null,
) {
  const accountId = String(row.account_id);
  const threadId = String(row.thread_id);
  const now = nowIso();
  const changedResult = await execute(
    `SELECT id FROM email_messages WHERE account_id = ? AND thread_id = ?`,
    [accountId, threadId],
  );
  const changedIds = changedResult.rows.map((message) => String(message.id));
  await execute(
    `UPDATE triage_decisions SET user_corrected_attention = ?
     WHERE message_id IN (SELECT id FROM email_messages WHERE account_id = ? AND thread_id = ?)`,
    [action, accountId, threadId],
  );
  for (const messageId of changedIds) {
    await execute(
      `INSERT INTO feedback_events
        (id, message_id, draft_id, event_type, value, source, created_at)
       VALUES (?, ?, NULL, 'care_tuned', ?, 'mail', ?)`,
      [newId("feedback"), messageId, JSON.stringify({ action, scopes, topicLabel }), now],
    );
  }

  const preferences: MailCarePreferenceSummary[] = [];
  if (scopes.includes("sender")) {
    preferences.push(
      await saveCarePreference(accountId, "sender", String(row.sender_email).toLowerCase(), action),
    );
  }
  if (scopes.includes("topic") && topicLabel) {
    preferences.push(await saveCarePreference(accountId, "topic", topicLabel, action));
  }
  await audit("mail.care_tuned", "owner", "message", String(row.id), {
    action,
    scopes,
    topicLabel,
    changedIds,
    preferences,
  });
  return { changedIds, preferences };
}

async function saveCarePreference(
  accountId: string,
  kind: "sender" | "topic",
  pattern: string,
  action: AttentionLevel,
): Promise<MailCarePreferenceSummary> {
  const normalizedPattern = kind === "topic" ? normalizeTopicLabel(pattern) : pattern.toLowerCase();
  const now = nowIso();
  await execute(
    `UPDATE learned_preferences SET enabled = 0, updated_at = ?
     WHERE kind = ?
       AND account_id = ?
       AND lower(pattern) = lower(?)
       AND action <> ?`,
    [now, kind, accountId, normalizedPattern, action],
  );
  await execute(
    `INSERT INTO learned_preferences
      (id, account_id, kind, pattern, action, weight, evidence_count, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?, ?)
     ON CONFLICT(kind, account_id, pattern, action) DO UPDATE SET
       weight = MIN(5, learned_preferences.weight + 0.5),
       evidence_count = learned_preferences.evidence_count + 1,
       enabled = 1,
       updated_at = excluded.updated_at`,
    [newId("pref"), accountId, kind, normalizedPattern, action, now, now],
  );
  const saved = await execute(
    `SELECT id, kind, pattern, action, evidence_count
     FROM learned_preferences
     WHERE kind = ? AND account_id = ? AND lower(pattern) = lower(?) AND action = ?
     ORDER BY updated_at DESC LIMIT 1`,
    [kind, accountId, normalizedPattern, action],
  );
  const row = saved.rows[0];
  return {
    id: row?.id ? String(row.id) : undefined,
    kind,
    pattern: normalizedPattern,
    action,
    evidenceCount: Number(row?.evidence_count || 1),
  };
}

async function matchingCarePreferences(input: {
  accountId: string;
  senderEmail: string;
  subject: string;
  snippet: string;
  category: string | null;
}) {
  const result = await execute(
    `SELECT * FROM learned_preferences
     WHERE enabled = 1
       AND account_id = ?
       AND kind IN ('sender', 'topic')
     ORDER BY weight DESC, evidence_count DESC, updated_at DESC`,
    [input.accountId],
  );
  const text = `${input.subject} ${input.snippet}`;
  const category = input.category ? normalizeTopicLabel(input.category) : "";
  return result.rows.filter((row) => {
    const kind = String(row.kind);
    const pattern = String(row.pattern || "");
    if (kind === "sender") return String(input.senderEmail).toLowerCase() === pattern.toLowerCase();
    if (kind !== "topic") return false;
    return topicPreferenceMatches(pattern, category, text);
  });
}

function topicPreferenceMatches(pattern: string, normalizedCategory: string, text: string) {
  const normalizedPattern = normalizeTopicLabel(pattern);
  if (!normalizedPattern) return false;
  if (normalizedCategory && normalizedCategory === normalizedPattern) return true;
  const textTokens = new Set(topicTokens(text));
  const patternTokens = topicTokens(normalizedPattern);
  if (!patternTokens.length) return false;
  const matches = patternTokens.filter((token) => textTokens.has(token)).length;
  return matches >= Math.min(2, patternTokens.length);
}

function normalizeTopicLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|and|or|for|from|with|your|you|my|our|their|this|that|re|fw|fwd)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function topicTokens(value: string) {
  return normalizeTopicLabel(value)
    .split(" ")
    .filter((token) => token.length >= 3);
}

function attentionOrNull(value: unknown): AttentionLevel | null {
  return value === "interrupt" || value === "digest" || value === "suppress" ? value : null;
}

export async function getRules(input: { workspaceId?: string } = {}): Promise<RuleItem[]> {
  const cleanupWorkspace = workspaceSqlFilter(input.workspaceId, "r");
  const priorityWorkspace = workspaceSqlFilter(input.workspaceId, "p");
  const [cleanup, priority] = await Promise.all([
    execute(
      `SELECT r.*, a.label AS account_label, a.email AS account_email, a.provider AS account_provider
       FROM maintenance_rules r
       JOIN email_accounts a ON a.id = r.account_id
       WHERE ${cleanupWorkspace.sql}
       ORDER BY r.updated_at DESC`,
      cleanupWorkspace.args,
    ),
    execute(
      `SELECT p.*, a.label AS account_label, a.email AS account_email, a.provider AS account_provider
       FROM learned_preferences p
       LEFT JOIN email_accounts a ON a.id = p.account_id
       WHERE p.kind IN ('sender', 'topic') AND ${priorityWorkspace.sql}
       ORDER BY p.updated_at DESC`,
      priorityWorkspace.args,
    ),
  ]);
  return [
    ...cleanup.rows.map((row) => ({
      id: String(row.id),
      source: "cleanup" as const,
      kind: "sender" as const,
      accountId: String(row.account_id),
      accountLabel: row.account_label ? String(row.account_label) : null,
      accountEmail: row.account_email ? String(row.account_email) : null,
      accountProvider: accountProviderOrNull(row.account_provider),
      target: String(row.sender_email),
      senderEmail: String(row.sender_email),
      action: String(row.action),
      enabled: Number(row.enabled) === 1,
      evidenceCount: 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    })),
    ...priority.rows.map((row) => ({
      id: String(row.id),
      source: "priority" as const,
      kind: row.kind === "topic" ? "topic" as const : "sender" as const,
      accountId: row.account_id ? String(row.account_id) : null,
      accountLabel: row.account_label ? String(row.account_label) : null,
      accountEmail: row.account_email ? String(row.account_email) : null,
      accountProvider: accountProviderOrNull(row.account_provider),
      target: String(row.pattern),
      senderEmail: String(row.pattern),
      action: String(row.action),
      enabled: Number(row.enabled) === 1,
      evidenceCount: Number(row.evidence_count),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    })),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getDraftWorkspace(): Promise<DraftItem[]> {
  const result = await execute(
    `SELECT d.*, m.subject, m.sender_name, m.sender_email,
      a.status AS approval_status, a.expires_at AS approval_expires_at
     FROM reply_drafts d
     JOIN email_messages m ON m.id = d.message_id
     LEFT JOIN send_approvals a ON a.id = (
       SELECT id FROM send_approvals sa WHERE sa.draft_id = d.id
       ORDER BY sa.created_at DESC LIMIT 1
     )
     WHERE d.id = (
       SELECT id FROM reply_drafts rd WHERE rd.message_id = d.message_id
       ORDER BY rd.version DESC LIMIT 1
     )
       AND NOT EXISTS (
         SELECT 1 FROM outgoing_drafts od WHERE od.legacy_reply_draft_id = d.id
       )
     ORDER BY d.updated_at DESC LIMIT 100`,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    messageId: String(row.message_id),
    subject: String(row.subject),
    senderName: String(row.sender_name),
    senderEmail: String(row.sender_email),
    content: String(row.content),
    version: Number(row.version),
    status: String(row.status) as DraftItem["status"],
    approvalStatus: row.approval_status ? String(row.approval_status) : null,
    approvalExpiresAt: row.approval_expires_at ? String(row.approval_expires_at) : null,
    updatedAt: String(row.updated_at),
  }));
}

export async function createRule(input: {
  accountId: string;
  senderEmail: string;
  action: "mark_read" | "spam";
}) {
  const id = newId("rule");
  const now = nowIso();
  await execute(
    `INSERT INTO maintenance_rules
      (id, account_id, sender_email, action, enabled, approved_at, created_at, updated_at)
     VALUES (?, ?, lower(?), ?, 1, ?, ?, ?)
     ON CONFLICT(account_id, sender_email, action) DO UPDATE SET
       enabled = 1, approved_at = excluded.approved_at, updated_at = excluded.updated_at`,
    [id, input.accountId, input.senderEmail, input.action, now, now, now],
  );
  await audit("rule.created", "owner", "sender", input.senderEmail, input);
  return getRules();
}

export async function updateRule(input: {
  id: string;
  source: RuleItem["source"];
  enabled?: boolean;
  action?: string;
  workspaceId?: string;
}) {
  const table = input.source === "cleanup" ? "maintenance_rules" : "learned_preferences";
  const workspace = ruleMutationWorkspaceFilter(input.workspaceId);
  const currentResult = await execute(
    `SELECT action, enabled FROM ${table} WHERE id = ? AND ${workspace.sql}`,
    [input.id, ...workspace.args],
  );
  const current = currentResult.rows[0];
  if (!current) throw new Error("The learned rule was not found in this workspace.");
  const allowedActions = input.source === "cleanup"
    ? new Set(["mark_read", "spam"])
    : new Set(["interrupt", "digest", "suppress"]);
  if (input.action && !allowedActions.has(input.action)) {
    throw new Error(input.source === "cleanup"
      ? "Cleanup rules can be changed only to Mark read or Spam."
      : "Care rules can be changed only to Care more, Useful, or Care less.");
  }
  const nextEnabled = input.enabled === undefined ? Number(current.enabled) === 1 : input.enabled;
  const nextAction = input.action || String(current.action);
  await execute(`UPDATE ${table} SET enabled = ?, action = ?, updated_at = ? WHERE id = ? AND ${workspace.sql}`, [
    nextEnabled ? 1 : 0,
    nextAction,
    nowIso(),
    input.id,
    ...workspace.args,
  ]);
  await audit("rule.updated", "owner", "rule", input.id, {
    before: { enabled: Number(current.enabled) === 1, action: String(current.action) },
    after: { enabled: nextEnabled, action: nextAction },
  });
  return getRules({ workspaceId: input.workspaceId });
}

export async function deleteRule(input: {
  id: string;
  source: RuleItem["source"];
  workspaceId?: string;
}) {
  const table = input.source === "cleanup" ? "maintenance_rules" : "learned_preferences";
  const workspace = ruleMutationWorkspaceFilter(input.workspaceId);
  await execute(`DELETE FROM ${table} WHERE id = ? AND ${workspace.sql}`, [input.id, ...workspace.args]);
  await audit("rule.deleted", "owner", "rule", input.id, { source: input.source });
  return getRules({ workspaceId: input.workspaceId });
}

export async function getCleanupSuggestions(limit: number, workspaceId?: string): Promise<CleanupSuggestion[]> {
  const workspace = workspaceSqlFilter(workspaceId);
  const result = await execute(
    `SELECT m.*, a.label AS account_label, a.provider AS account_provider, a.email AS account_email, a.provider,
      COALESCE(t.user_corrected_attention, t.attention) AS attention,
      t.category, t.summary
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE m.is_unread = 1
       AND m.status IN ('new', 'triaged', 'backlog_queued')
       AND m.ingest_source <> 'provider_search'
       AND COALESCE(t.user_corrected_attention, t.attention) = 'suppress'
       AND m.gmail_labels NOT LIKE '%"SPAM"%'
       AND m.gmail_labels NOT LIKE '%"TRASH"%'
       AND m.gmail_labels NOT LIKE '%"SENT"%'
       AND ${workspace.sql}
     ORDER BY m.received_at DESC LIMIT 180`,
    workspace.args,
  );
  const groups = new Map<string, Row[]>();
  for (const row of result.rows) {
    if (isProtectedCleanup(row)) continue;
    const key = `${String(row.account_id)}:${String(row.sender_email).toLowerCase()}`;
    const current = groups.get(key) || [];
    current.push(row);
    groups.set(key, current);
  }
  const ranked = Array.from(groups.values())
    .sort((left, right) => right.length - left.length || String(right[0].received_at).localeCompare(String(left[0].received_at)))
    .slice(0, limit);
  const suggestions: CleanupSuggestion[] = [];
  for (const rows of ranked) {
    const latest = rows[0];
    const unsubscribeSupported = await unsubscribeCapability(latest);
    const recommendation = unsubscribeSupported
      ? "unsubscribe"
      : rows.length > 1
        ? "quiet"
        : "mark_read";
    suggestions.push({
      accountId: String(latest.account_id),
      accountLabel: String(latest.account_label),
      latestMessageId: String(latest.id),
      senderName: String(latest.sender_name),
      senderEmail: String(latest.sender_email),
      latestSubject: String(latest.subject),
      latestReceivedAt: String(latest.received_at),
      messageCount: rows.length,
      category: String(latest.category || "low priority"),
      recommendation,
      reason:
        recommendation === "unsubscribe"
          ? "This recurring low-priority sender supports one-click unsubscribe."
          : recommendation === "quiet"
            ? "This recurring sender can be marked read automatically after approval."
            : "This appears low priority, but Ezra has not seen enough to create a sender rule.",
      unsubscribeSupported,
    });
  }
  return suggestions;
}

type ScoredTopic = TodayTopic & { score: number; candidate: BriefCandidate };

function scoreTodayCandidate(row: Row): ScoredTopic | null {
  const receivedAt = String(row.received_at);
  const accountId = String(row.account_id || "").trim();
  const providerThreadId = String(row.thread_id || "").trim();
  const provider = accountProviderOrNull(row.account_provider);
  if (!accountId || !providerThreadId || !provider) return null;
  const ageDays = Math.max(0, (Date.now() - new Date(receivedAt).getTime()) / 86_400_000);
  const category = String(row.category || "general");
  const urgency = Number(row.urgency || 0);
  const deadline = row.deadline ? String(row.deadline) : null;
  const deadlineTime = deadline ? new Date(deadline).getTime() : Number.NaN;
  const activeDeadline = Number.isFinite(deadlineTime) && deadlineTime >= Date.now() - 86_400_000;
  const needsReply = Number(row.needs_reply || 0) === 1 && Number(row.is_unread || 0) === 1;
  if (ageDays > 30 && !activeDeadline && !needsReply) return null;
  if (PROMOTIONAL_CATEGORY.test(category) && !PROTECTED_CATEGORIES.has(category.toLowerCase())) {
    return null;
  }
  const decayedUrgency = Math.max(0, urgency - ageDays * 2.25);
  let kind: TodayTopicKind | null = null;
  let score = decayedUrgency;
  if (String(row.attention) === "interrupt" && (ageDays < 10 || activeDeadline)) {
    kind = "action";
    score += 15;
  } else if (needsReply && ageDays < 21) {
    kind = "reply";
    score += 12;
  } else if (activeDeadline) {
    kind = "deadline";
    const hours = Math.max(0, (deadlineTime - Date.now()) / 3_600_000);
    score += Math.max(5, 30 - hours / 12);
  } else if (String(row.attention) === "digest" && ageDays < 14) {
    kind = "fyi";
  }
  if (!kind) return null;
  const title = String(row.subject);
  const summary = String(row.summary || row.snippet || row.subject);
  return {
    id: String(row.id),
    kind,
    title,
    summary,
    senderName: String(row.sender_name),
    accountLabel: String(row.account_label),
    receivedAt,
    deadline,
    urgency: Math.round(decayedUrgency),
    threadCount: Number(row.thread_count || 1),
    score,
    candidate: {
      sourceType: "mail_thread",
      sourceKey: `mail:${accountId}:${providerThreadId}`,
      sourceAccountId: accountId,
      provider,
      providerThreadId,
      revisionAt: receivedAt,
      occurredAt: receivedAt,
      role: "attention",
      topicKind: kind,
      title,
      summary,
      target: { view: "mail", messageId: String(row.id) },
    },
  };
}

function chooseBriefTopics(scored: ScoredTopic[]): TodayTopic[] {
  const selected: ScoredTopic[] = [];
  const seen = new Set<string>();
  const take = (kind: TodayTopicKind, count: number) => {
    for (const item of scored.filter((candidate) => candidate.kind === kind)) {
      if (selected.filter((candidate) => candidate.kind === kind).length >= count) break;
      if (!seen.has(item.id)) {
        seen.add(item.id);
        selected.push(item);
      }
    }
  };
  take("action", 4);
  take("reply", 3);
  take("deadline", 2);
  take("fyi", 3);
  for (const item of scored) {
    if (selected.length >= 12) break;
    if (!seen.has(item.id)) {
      seen.add(item.id);
      selected.push(item);
    }
  }
  return selected.slice(0, 12).map(({ score: _score, candidate: _candidate, ...topic }) => topic);
}

async function resolveMailPageInput(input: MailPageInput): Promise<MailPageInput> {
  if (!input.viewId) return input;
  const view = await getSavedView(input.viewId, { workspaceId: input.workspaceId });
  const filters = savedViewToMailFilters(view);
  return {
    ...input,
    workspaceId: input.workspaceId || view.workspaceId,
    folder: explicitString(input.folder) ?? filters.folder,
    account: explicitString(input.account) ?? filters.account,
    inboxCategory: explicitString(input.inboxCategory) ?? filters.inboxCategory,
    category: explicitString(input.category) ?? filters.category,
    categories: explicitString(input.category) ? undefined : input.categories?.length ? input.categories : filters.categories,
    priority: explicitString(input.priority) ?? filters.priority,
    unread: input.unread ?? filters.unread,
    attachments: input.attachments ?? filters.attachments,
    date: explicitString(input.date) ?? filters.date,
    search: explicitString(input.search) ?? filters.search,
    needsReply: input.needsReply ?? filters.needsReply,
    hasDeadline: input.hasDeadline ?? filters.hasDeadline,
    handled: input.handled ?? filters.handled,
  };
}

function explicitString(value: string | null | undefined) {
  const text = String(value || "").trim();
  return text ? text : undefined;
}

function buildMailFilters(input: MailPageInput) {
  const clauses = ["1 = 1"];
  const args: Array<string | number> = [];
  const workspace = workspaceSqlFilter(input.workspaceId);
  clauses.push(workspace.sql);
  args.push(...workspace.args);
  const messageIds = Array.from(new Set((input.messageIds || []).map((id) => id.trim()).filter(Boolean))).slice(0, 12);
  if (messageIds.length) {
    clauses.push(`m.id IN (${messageIds.map(() => "?").join(",")})`);
    args.push(...messageIds);
  }
  const folder = input.folder || "inbox";
  if (folder === "inbox" || folder === "sent" || folder === "spam" || folder === "trash") {
    const mappedFolder = providerFolderClause(folder);
    clauses.push(mappedFolder.sql);
    args.push(...mappedFolder.args);
  }
  if (folder === "archive") {
    clauses.push(`m.gmail_labels NOT LIKE '%"INBOX"%'`);
    clauses.push(`m.gmail_labels NOT LIKE '%"SENT"%'`);
    clauses.push(`m.gmail_labels NOT LIKE '%"SPAM"%'`);
    clauses.push(`m.gmail_labels NOT LIKE '%"TRASH"%'`);
  }
  if (folder === "inbox" && input.inboxCategory && input.inboxCategory !== "all") {
    if (input.inboxCategory === "primary") {
      for (const label of GMAIL_TAB_LABELS) {
        clauses.push(`m.gmail_labels NOT LIKE ?`);
        args.push(`%"${label}"%`);
      }
    } else {
      const label = GMAIL_TAB_CATEGORY_LABELS[input.inboxCategory];
      if (label) {
        clauses.push(`m.gmail_labels LIKE ?`);
        args.push(`%"${label}"%`);
      }
    }
  }
  if (input.account) {
    clauses.push("m.account_id = ?");
    args.push(input.account);
  }
  if (input.category) {
    clauses.push("lower(COALESCE(t.category, '')) = lower(?)");
    args.push(input.category);
  }
  const categories = Array.from(new Set((input.categories || []).map((category) => category.trim().toLowerCase()).filter(Boolean)));
  const fts = input.search?.trim() ? ftsQuery(input.search) : "";
  if (categories.length && fts) {
    clauses.push(`(
      lower(COALESCE(t.category, '')) IN (${categories.map(() => "?").join(",")})
      OR m.id IN (SELECT message_id FROM email_message_fts WHERE email_message_fts MATCH ?)
    )`);
    args.push(...categories, fts);
  } else if (categories.length) {
    clauses.push(`lower(COALESCE(t.category, '')) IN (${categories.map(() => "?").join(",")})`);
    args.push(...categories);
  }
  if (input.priority) {
    clauses.push("COALESCE(t.user_corrected_attention, t.attention) = ?");
    args.push(input.priority);
  }
  if (input.unread) clauses.push("m.is_unread = 1");
  if (input.attachments) clauses.push("m.has_attachments = 1");
  if (input.date && input.date !== "any") {
    const days = input.date === "today" ? 1 : input.date === "week" || input.date === "last7" ? 7 : 30;
    clauses.push("m.received_at >= ?");
    args.push(new Date(Date.now() - days * 86_400_000).toISOString());
  }
  if (input.needsReply) clauses.push("COALESCE(t.needs_reply, 0) = 1");
  if (input.hasDeadline) clauses.push("t.deadline IS NOT NULL AND t.deadline <> ''");
  if (input.handled === "active") {
    clauses.push("m.is_unread = 1");
    clauses.push("m.status IN ('new', 'triaged', 'backlog_queued')");
    clauses.push(`m.gmail_labels NOT LIKE '%"SPAM"%'`);
    clauses.push(`m.gmail_labels NOT LIKE '%"TRASH"%'`);
    clauses.push(`m.gmail_labels NOT LIKE '%"SENT"%'`);
  } else if (input.handled === "handled") {
    clauses.push("(m.is_unread = 0 OR m.status IN ('read', 'cleared', 'maintained'))");
    clauses.push("m.status NOT IN ('deleted', 'spam')");
    clauses.push(`m.gmail_labels NOT LIKE '%"SPAM"%'`);
    clauses.push(`m.gmail_labels NOT LIKE '%"TRASH"%'`);
  }
  if (!categories.length && fts) {
    clauses.push(
      "m.id IN (SELECT message_id FROM email_message_fts WHERE email_message_fts MATCH ?)",
    );
    args.push(fts);
  }
  return { sql: clauses.join(" AND "), args };
}

function providerFolderClause(folder: "inbox" | "sent" | "spam" | "trash") {
  const providers: AccountProvider[] = ["gmail", "microsoft"];
  const clauses: string[] = [];
  const args: string[] = [];
  for (const provider of providers) {
    const label = providerAdapterFor(provider).folderMappings()[folder];
    clauses.push("(m.account_id IN (SELECT id FROM email_accounts WHERE provider = ?) AND m.gmail_labels LIKE ?)");
    args.push(provider, `%\"${label}\"%`);
  }
  return { sql: `(${clauses.join(" OR ")})`, args };
}

function ftsQuery(value: string) {
  const stopWords = new Set(["about", "from", "have", "that", "the", "this", "what", "when", "where", "with"]);
  return value
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !stopWords.has(token))
    .slice(0, 12)
    .map((token) => `"${token.replace(/"/g, "")}"*`)
    .join(" AND ");
}

function mailThreadItemFromRow(row: Row): MailThreadItem {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    accountLabel: String(row.account_label),
    accountProvider: row.account_provider
      ? (String(row.account_provider) as InboxItem["accountProvider"])
      : undefined,
    externalMessageId: String(row.external_message_id),
    threadId: String(row.thread_id),
    senderName: String(row.sender_name),
    senderEmail: String(row.sender_email),
    subject: String(row.subject),
    receivedAt: String(row.received_at),
    snippet: String(row.snippet),
    gmailUrl: String(row.gmail_url),
    hasAttachments: Number(row.has_attachments) === 1,
    isUnread: Number(row.is_unread) === 1,
    isPinned: Number(row.is_pinned) === 1,
    isFlagged: Number(row.is_flagged) === 1,
    organizationConfirmedAt: row.organization_confirmed_at ? String(row.organization_confirmed_at) : null,
    mailboxLabels: parseStringArray(row.gmail_labels),
    status: String(row.status),
    attention: row.attention ? (String(row.attention) as InboxItem["attention"]) : null,
    urgency: row.urgency === null || row.urgency === undefined ? null : Number(row.urgency),
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    category: row.category ? String(row.category) : null,
    summary: row.summary ? String(row.summary) : null,
    reason: row.reason ? String(row.reason) : null,
    recommendation: row.recommendation ? String(row.recommendation) : null,
    needsReply: Number(row.needs_reply) === 1,
    deadline: row.deadline ? String(row.deadline) : null,
    injectionFlags: parseStringArray(row.injection_flags),
    model: row.model ? String(row.model) : null,
    notifiedAt: row.notified_at ? String(row.notified_at) : null,
    threadCount: Number(row.thread_count || 1),
    organizationCapabilities: organizationCapabilitiesForRow(row),
  };
}

function organizationCapabilitiesForRow(row: Row): ProviderOrganizationCapabilities {
  const provider = String(row.account_provider || row.provider || "gmail") as AccountProvider;
  const base = providerAdapterFor(provider).organizationCapabilities();
  const connected = String(row.account_status || "") === "connected";
  const access = String(row.account_access || "");
  const writable = provider === "gmail"
    ? access === "maintenance" || access === "calendar"
    : access === "maintenance" || access === "calendar" || access === "send" || access === "full";
  if (connected && writable) return base;
  const reason = provider === "gmail"
    ? "Reconnect Gmail from Settings with maintenance access to use provider organization actions."
    : "Reconnect Hotmail from Settings to grant Microsoft Mail.ReadWrite access for provider organization actions.";
  return {
    pin: base.pin.state === "supported" ? { state: "reconnect_required", reason } : base.pin,
    flag: base.flag.state === "supported" ? { state: "reconnect_required", reason } : base.flag,
  };
}

async function unsubscribeCapability(row: Row) {
  const cached = await execute(
    `SELECT one_click_unsubscribe, checked_at FROM email_capabilities WHERE message_id = ?`,
    [row.id],
  );
  if (cached.rows[0]) {
    const age = Date.now() - new Date(String(cached.rows[0].checked_at)).getTime();
    if (age < 7 * 86_400_000) return Number(cached.rows[0].one_click_unsubscribe) === 1;
  }
  let supported = false;
  let metadata: Record<string, unknown> = {};
  if (String(row.provider) === "gmail" && !String(row.account_email).endsWith(".test")) {
    try {
      const result = await getGmailUnsubscribeMetadata(
        String(row.account_email),
        String(row.external_message_id),
      );
      supported = Boolean(result.oneClickUrl);
      metadata = { supported, checked: true };
    } catch (error) {
      metadata = { supported: false, error: errorMessage(error) };
    }
  }
  await execute(
    `INSERT INTO email_capabilities
      (message_id, one_click_unsubscribe, checked_at, metadata)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       one_click_unsubscribe = excluded.one_click_unsubscribe,
       checked_at = excluded.checked_at,
       metadata = excluded.metadata`,
    [row.id, supported ? 1 : 0, nowIso(), JSON.stringify(metadata)],
  );
  return supported;
}

function isProtectedCleanup(row: Row) {
  const category = String(row.category || "").toLowerCase();
  if (PROTECTED_CATEGORIES.has(category)) return true;
  const text = `${row.sender_name} ${row.sender_email} ${row.subject} ${row.snippet}`.toLowerCase();
  if (/(verification code|security code|security alert|new sign[- ]?in|sign[- ]?in needs (your )?review|suspicious activity|password reset|receipt|order confirmation|payment|bank|medical|appointment|interview|job offer|legal notice|personally wrote)/i.test(text)) {
    return true;
  }
  const automatedSender = /(no[-_.]?reply|do[-_.]?not[-_.]?reply|newsletter|marketing|promotion|offers?|deals?)/i.test(
    String(row.sender_email),
  );
  return ["general", "correspondence", "personal", "human"].includes(category) && !automatedSender;
}

async function storeProviderResult(
  accountId: string,
  query: string,
  message: EmailEnvelope,
  organizationObservedAt: string,
) {
  const existing = await execute(
    `SELECT id FROM email_messages WHERE account_id = ? AND external_message_id = ?`,
    [accountId, message.externalMessageId],
  );
  const messageId = existing.rows[0]?.id ? String(existing.rows[0].id) : newId("mail");
  const now = nowIso();
  const organization = providerOrganizationState(message);
  if (existing.rows[0]) {
    await execute(
      `UPDATE email_messages
       SET is_unread = ?,
         gmail_labels = ?,
         snippet = ?,
         is_pinned = CASE
           WHEN COALESCE(organization_confirmed_at, '') >= ? THEN is_pinned
           ELSE ?
         END,
         is_flagged = CASE
           WHEN COALESCE(organization_confirmed_at, '') >= ? THEN is_flagged
           ELSE ?
         END,
         organization_confirmed_at = CASE
           WHEN COALESCE(organization_confirmed_at, '') >= ? THEN organization_confirmed_at
           ELSE ?
         END,
         status = CASE
           WHEN ? = 0 AND status IN ('new', 'triaged', 'backlog_queued') THEN 'read'
           ELSE status
         END,
         updated_at = ?
       WHERE id = ?`,
      [
        message.isUnread ? 1 : 0,
        JSON.stringify(message.labels),
        message.snippet,
        organizationObservedAt,
        organization.isPinned ? 1 : 0,
        organizationObservedAt,
        organization.isFlagged ? 1 : 0,
        organizationObservedAt,
        organizationObservedAt,
        message.isUnread ? 1 : 0,
        now,
        messageId,
      ],
    );
  } else {
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, history_id, sender_name, sender_email,
         subject, received_at, snippet, gmail_url, has_attachments, gmail_labels, is_unread,
         is_pinned, is_flagged, organization_confirmed_at,
         ingest_source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provider_search', 'search_result', ?, ?)`,
      [
        messageId,
        accountId,
        message.externalMessageId,
        message.threadId,
        message.historyId || null,
        message.senderName,
        message.senderEmail,
        message.subject,
        message.receivedAt,
        message.snippet,
        message.gmailUrl,
        message.attachments.length ? 1 : 0,
        JSON.stringify(message.labels),
        message.isUnread ? 1 : 0,
        organization.isPinned ? 1 : 0,
        organization.isFlagged ? 1 : 0,
        organizationObservedAt,
        now,
        now,
      ],
    );
  }
  await syncMessageSearchIndex(messageId);
  await execute(
    `INSERT INTO provider_search_results
      (id, query, account_id, message_id, searched_at, metadata)
     VALUES (?, ?, ?, ?, ?, '{}')
     ON CONFLICT(query, account_id, message_id) DO UPDATE SET searched_at = excluded.searched_at`,
    [newId("search"), query, accountId, messageId, now],
  );
  return messageId;
}

async function mailItemsByIds(ids: string[]) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const result = await execute(
    `SELECT m.*, a.label AS account_label, a.provider AS account_provider,
      a.email AS account_email, a.status AS account_status,
      credentials.access AS account_access,
      COALESCE(t.user_corrected_attention, t.attention) AS attention,
      t.urgency, t.confidence, t.category, t.summary, t.reason,
      t.recommendation, t.needs_reply, t.deadline, t.injection_flags, t.model,
      1 AS thread_count, NULL AS notified_at
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     LEFT JOIN provider_account_credentials credentials ON credentials.account_id = a.id
     LEFT JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE m.id IN (${placeholders}) ORDER BY m.received_at DESC`,
    ids,
  );
  return result.rows.map(mailThreadItemFromRow);
}

async function actionRows(ids: string[]) {
  const placeholders = ids.map(() => "?").join(",");
  const result = await execute(
    `SELECT m.*, a.email AS account_email, a.label AS account_label, a.provider AS account_provider,
      a.status AS account_status, credentials.access AS account_access,
      (SELECT category FROM triage_decisions td
       WHERE td.message_id = m.id ORDER BY td.created_at DESC LIMIT 1) AS category,
      (SELECT user_corrected_attention FROM triage_decisions td
       WHERE td.message_id = m.id ORDER BY td.created_at DESC LIMIT 1) AS prior_correction
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     LEFT JOIN provider_account_credentials credentials ON credentials.account_id = a.id
     WHERE m.id IN (${placeholders})`,
    ids,
  );
  return result.rows;
}

function actionSnapshot(row: Row) {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    accountEmail: String(row.account_email),
    accountProvider: String(row.account_provider || "gmail"),
    externalMessageId: String(row.external_message_id),
    status: String(row.status),
    isUnread: Number(row.is_unread) === 1,
    isPinned: Number(row.is_pinned) === 1,
    isFlagged: Number(row.is_flagged) === 1,
    organizationConfirmedAt: row.organization_confirmed_at ? String(row.organization_confirmed_at) : null,
    labels: parseStringArray(row.gmail_labels),
    priorCorrection: row.prior_correction ? String(row.prior_correction) : null,
  };
}

async function applyProviderBatch(accountEmail: string, accountProvider: string, rows: Row[], action: "read" | "spam" | "trash") {
  if (accountEmail.endsWith(".test")) return;
  const ids = rows.map((row) => String(row.external_message_id));
  await providerAdapterFor(accountProvider as AccountProvider).applyWorkspaceAction(accountEmail, action, ids);
}

function rowNeedsProviderRead(row: Row) {
  return Number(row.is_unread || 0) === 1 || parseStringArray(row.gmail_labels).includes("UNREAD");
}

function isActionAlreadySatisfied(row: Row, action: MailActionName) {
  const status = String(row.status || "");
  const labels = parseStringArray(row.gmail_labels);
  const unread = Number(row.is_unread || 0) === 1 || labels.includes("UNREAD");
  if (action === "done") return status === "cleared" && !unread;
  if (action === "mark_read") return (status === "read" || status === "cleared") && !unread;
  if (action === "spam") return status === "spammed" || labels.includes("SPAM");
  if (action === "delete" || action === "delete_and_teach") return status === "deleted" || labels.includes("TRASH");
  if (action === "pin") return Number(row.is_pinned) === 1;
  if (action === "unpin") return Number(row.is_pinned) === 0;
  if (action === "flag") return Number(row.is_flagged) === 1;
  if (action === "unflag") return Number(row.is_flagged) === 0;
  return false;
}

function organizationAction(action: MailActionName): { kind: "pin" | "flag"; desired: boolean } | null {
  if (action === "pin") return { kind: "pin", desired: true };
  if (action === "unpin") return { kind: "pin", desired: false };
  if (action === "flag") return { kind: "flag", desired: true };
  if (action === "unflag") return { kind: "flag", desired: false };
  return null;
}

async function updateLocalOrganizationState(row: Row, kind: "pin" | "flag", desired: boolean) {
  const now = nowIso();
  await execute(
    `UPDATE email_messages
     SET ${kind === "pin" ? "is_pinned" : "is_flagged"} = ?, organization_confirmed_at = ?, updated_at = ?
     WHERE id = ?`,
    [desired ? 1 : 0, now, now, row.id],
  );
}

async function updateLocalAfterProviderAction(row: Row, action: MailActionName) {
  let labels = parseStringArray(row.gmail_labels);
  labels = labels.filter((label) => label !== "UNREAD");
  let status = action === "done" ? "cleared" : "read";
  if (action === "spam") {
    labels = labels.filter((label) => label !== "INBOX" && label !== "SPAM");
    labels.push("SPAM");
    status = "spammed";
  } else if (action === "delete" || action === "delete_and_teach") {
    labels = labels.filter((label) => label !== "INBOX" && label !== "TRASH");
    labels.push("TRASH");
    status = "deleted";
  }
  await execute(
    `UPDATE email_messages SET status = ?, is_unread = 0, gmail_labels = ?, updated_at = ?
     WHERE id = ?`,
    [status, JSON.stringify(labels), nowIso(), row.id],
  );
}

async function undoMailAction(actionId: string): Promise<MailActionResult> {
  const result = await execute(`SELECT * FROM mail_actions WHERE id = ?`, [actionId]);
  const row = result.rows[0];
  if (!row || String(row.undo_status) !== "available") {
    throw new Error("This action is not available to undo.");
  }
  const action = String(row.action) as MailActionName;
  const details = parseRecord(row.details);
  const changedSet = Array.isArray(details.changedIds)
    ? new Set(details.changedIds.map((id) => String(id)))
    : null;
  const snapshots = parseRecords(row.undo_data).filter((snapshot) =>
    !changedSet || changedSet.has(String(snapshot.id)),
  );
  const failures: Array<{ id: string; error: string }> = [];
  let successCount = 0;
  if (action === "quiet") {
    for (const nestedId of Array.isArray(details.nestedActions) ? details.nestedActions : []) {
      try {
        const undone = await undoMaintenanceAction(String(nestedId), "mail");
        successCount += undone.messageCount;
      } catch (error) {
        failures.push({ id: String(nestedId), error: errorMessage(error) });
      }
    }
  } else if (action === "lower_priority" || action === "keep" || action === "raise_priority") {
    for (const snapshot of snapshots) {
      await execute(
        `UPDATE triage_decisions SET user_corrected_attention = ?
         WHERE id = (SELECT id FROM triage_decisions WHERE message_id = ?
           ORDER BY created_at DESC LIMIT 1)`,
        [snapshot.priorCorrection ? String(snapshot.priorCorrection) : null, String(snapshot.id)],
      );
      successCount += 1;
    }
  } else if (organizationAction(action)) {
    const organization = organizationAction(action)!;
    const currentRows = await actionRows(snapshots.map((snapshot) => String(snapshot.id)));
    const currentById = new Map(currentRows.map((current) => [String(current.id), current]));
    for (const snapshot of snapshots) {
      try {
        const current = currentById.get(String(snapshot.id));
        if (!current) throw new Error("The selected message was not found.");
        const provider = String(current.account_provider) as AccountProvider;
        const accountEmail = String(current.account_email);
        const adapter = providerAdapterFor(provider);
        const capability = organizationCapabilitiesForRow(current)[organization.kind];
        if (capability.state !== "supported") throw new Error(capability.reason);
        if (!accountEmail.endsWith(".test")) {
          await adapter.applyOrganizationState(
            accountEmail,
            organization.kind,
            !organization.desired,
            [String(current.external_message_id)],
          );
        }
        const confirmedAt = nowIso();
        await execute(
          `UPDATE email_messages
           SET ${organization.kind === "pin" ? "is_pinned" : "is_flagged"} = ?,
             organization_confirmed_at = ?, updated_at = ?
           WHERE id = ?`,
          [
            organization.kind === "pin" ? (snapshot.isPinned ? 1 : 0) : (snapshot.isFlagged ? 1 : 0),
            confirmedAt,
            confirmedAt,
            String(snapshot.id),
          ],
        );
        successCount += 1;
      } catch (error) {
        failures.push({ id: String(snapshot.id), error: errorMessage(error) });
      }
    }
  } else {
    for (const group of groupSnapshotsByAccount(snapshots)) {
      try {
        const unreadIds = group.items
          .filter((item) => item.isUnread)
          .map((item) => String(item.externalMessageId));
        if (!group.accountEmail.endsWith(".test")) {
          const externalIds = group.items.map((item) => String(item.externalMessageId));
          const workspaceAction = action === "spam" ? "spam" : action === "delete" || action === "delete_and_teach" ? "trash" : "read";
          await providerAdapterFor(group.accountProvider as AccountProvider)
            .undoWorkspaceAction(group.accountEmail, workspaceAction, externalIds, unreadIds);
        }
        for (const snapshot of group.items) {
          await execute(
            `UPDATE email_messages SET status = ?, is_unread = ?, gmail_labels = ?, updated_at = ?
             WHERE id = ?`,
            [
              String(snapshot.status),
              snapshot.isUnread ? 1 : 0,
              JSON.stringify(snapshot.labels || []),
              nowIso(),
              String(snapshot.id),
            ],
          );
          if (action === "delete_and_teach") {
            await execute(
              `UPDATE triage_decisions SET user_corrected_attention = ?
               WHERE id = (SELECT id FROM triage_decisions WHERE message_id = ?
                 ORDER BY created_at DESC LIMIT 1)`,
              [
                snapshot.priorCorrection ? String(snapshot.priorCorrection) : null,
                String(snapshot.id),
              ],
            );
          }
          successCount += 1;
        }
      } catch (error) {
        for (const snapshot of group.items) {
          failures.push({ id: String(snapshot.id), error: errorMessage(error) });
        }
      }
    }
  }
  const undoRows = snapshots.length ? await actionRows(snapshots.map((snapshot) => String(snapshot.id))) : [];
  const safeFailures = normalizeActionFailures(failures, undoRows);
  await execute(
    `UPDATE mail_actions SET undo_status = ?, undone_at = ?, details = ? WHERE id = ?`,
    [safeFailures.length ? "partial" : "undone", nowIso(), JSON.stringify({ ...details, undo: { successCount, failures: safeFailures } }), actionId],
  );
  await audit("mail.action.undone", "owner", "mail_action", actionId, {
    action,
    successCount,
    failureCount: safeFailures.length,
  });
  return {
    actionId,
    action: "undo",
    successCount,
    failureCount: safeFailures.length,
    reversible: false,
    failures: safeFailures,
  };
}

function uniqueSenderTargets(rows: Row[]) {
  const seen = new Set<string>();
  return rows
    .map((row) => ({ accountId: String(row.account_id), senderEmail: String(row.sender_email) }))
    .filter((target) => {
      const key = `${target.accountId}:${target.senderEmail.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function groupByAccount(rows: Row[]) {
  const groups = new Map<string, { accountEmail: string; accountProvider: string; rows: Row[] }>();
  for (const row of rows) {
    const key = String(row.account_id);
    const group = groups.get(key) || {
      accountEmail: String(row.account_email),
      accountProvider: String(row.account_provider || "gmail"),
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

function groupSnapshotsByAccount(items: Array<Record<string, unknown>>) {
  const groups = new Map<string, { accountEmail: string; accountProvider: string; items: Array<Record<string, unknown>> }>();
  for (const item of items) {
    const key = String(item.accountId);
    const group = groups.get(key) || {
      accountEmail: String(item.accountEmail),
      accountProvider: String(item.accountProvider || "gmail"),
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

function encodeCursor(receivedAt: string, id: string) {
  return Buffer.from(JSON.stringify({ receivedAt, id })).toString("base64url");
}

function decodeCursor(value?: string | null): { receivedAt: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed && typeof parsed.receivedAt === "string" && typeof parsed.id === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
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

function parseRecords(value: unknown): Array<Record<string, unknown>> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      : [];
  } catch {
    return [];
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
