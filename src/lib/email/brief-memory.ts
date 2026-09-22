import { withNotificationStoreWrite } from "./notification-store";
import { ensureEmailDatabase, execute, executeBatch, getSetting, newId, nowIso } from "./database";
import type { AccountProvider, ActionCenterTarget, BriefCandidate, BriefMemoryAction, BriefMemoryState, BriefMemoryView, BriefSourceType, LivingBriefItem } from "./types";
import { resolveBriefWorkspace } from "./workspaces";

export { resolveBriefWorkspace };
const titleLimit = 300;
const summaryLimit = 700;

export async function reconcileBriefMemory(input: { workspaceId: string; candidates: BriefCandidate[]; now?: string }): Promise<BriefMemoryView> {
  const workspace = await resolveBriefWorkspace(input.workspaceId);
  const now = iso(input.now || nowIso());
  const current: LivingBriefItem[] = [];
  for (const raw of input.candidates) {
    const candidate = await candidateForWorkspace(raw, workspace.accountIds);
    const prior = await bySource(workspace.id, candidate.sourceKey, workspace.accountIds);
    if (prior && (prior.sourceType !== candidate.sourceType || prior.sourceAccountId !== candidate.sourceAccountId)) throw new Error("Brief source identity collision");
    await execute(
      `INSERT INTO brief_item_memory (id, workspace_id, source_type, source_key, source_account_id, source_revision_at, state, title, summary, occurred_at, target_json, first_seen_at, last_seen_at, completion_evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, '{}', ?, ?)
       ON CONFLICT(workspace_id, source_key) DO UPDATE SET
        source_revision_at = CASE WHEN excluded.source_revision_at > brief_item_memory.source_revision_at AND (brief_item_memory.state = 'open' OR excluded.source_revision_at > CASE WHEN brief_item_memory.state = 'completed' THEN brief_item_memory.completed_at ELSE brief_item_memory.dismissed_at END) THEN excluded.source_revision_at ELSE brief_item_memory.source_revision_at END,
        state = CASE WHEN brief_item_memory.state <> 'open' AND excluded.source_revision_at > brief_item_memory.source_revision_at AND excluded.source_revision_at > CASE WHEN brief_item_memory.state = 'completed' THEN brief_item_memory.completed_at ELSE brief_item_memory.dismissed_at END THEN 'open' ELSE brief_item_memory.state END,
        title = CASE WHEN excluded.source_revision_at > brief_item_memory.source_revision_at AND (brief_item_memory.state = 'open' OR excluded.source_revision_at > CASE WHEN brief_item_memory.state = 'completed' THEN brief_item_memory.completed_at ELSE brief_item_memory.dismissed_at END) THEN excluded.title ELSE brief_item_memory.title END,
        summary = CASE WHEN excluded.source_revision_at > brief_item_memory.source_revision_at AND (brief_item_memory.state = 'open' OR excluded.source_revision_at > CASE WHEN brief_item_memory.state = 'completed' THEN brief_item_memory.completed_at ELSE brief_item_memory.dismissed_at END) THEN excluded.summary ELSE brief_item_memory.summary END,
        occurred_at = CASE WHEN excluded.source_revision_at > brief_item_memory.source_revision_at AND (brief_item_memory.state = 'open' OR excluded.source_revision_at > CASE WHEN brief_item_memory.state = 'completed' THEN brief_item_memory.completed_at ELSE brief_item_memory.dismissed_at END) THEN excluded.occurred_at ELSE brief_item_memory.occurred_at END,
        target_json = CASE WHEN excluded.source_revision_at > brief_item_memory.source_revision_at AND (brief_item_memory.state = 'open' OR excluded.source_revision_at > CASE WHEN brief_item_memory.state = 'completed' THEN brief_item_memory.completed_at ELSE brief_item_memory.dismissed_at END) THEN excluded.target_json
          WHEN excluded.source_revision_at = brief_item_memory.source_revision_at
            AND json_valid(brief_item_memory.target_json)
            AND excluded.last_seen_at >= brief_item_memory.last_seen_at
            AND json_extract(excluded.target_json, '$.topicKind') IS NOT NULL
          THEN json_set(brief_item_memory.target_json, '$.topicKind', json_extract(excluded.target_json, '$.topicKind'))
          ELSE brief_item_memory.target_json END,
        last_seen_at = CASE WHEN excluded.last_seen_at > brief_item_memory.last_seen_at THEN excluded.last_seen_at ELSE brief_item_memory.last_seen_at END,
        restored_at = CASE WHEN brief_item_memory.state <> 'open' AND excluded.source_revision_at > brief_item_memory.source_revision_at AND excluded.source_revision_at > CASE WHEN brief_item_memory.state = 'completed' THEN brief_item_memory.completed_at ELSE brief_item_memory.dismissed_at END THEN excluded.last_seen_at ELSE brief_item_memory.restored_at END,
        updated_at = CASE WHEN excluded.last_seen_at > brief_item_memory.updated_at THEN excluded.updated_at ELSE brief_item_memory.updated_at END`,
      [newId("brief"), workspace.id, candidate.sourceType, candidate.sourceKey, candidate.sourceAccountId, candidate.revisionAt, candidate.title, candidate.summary, candidate.occurredAt, JSON.stringify(snapshot(candidate)), now, now, now, now],
    );
    const item = await bySource(workspace.id, candidate.sourceKey, workspace.accountIds);
    if (item?.state === "open") current.push(item);
  }
  const view = await listBriefMemory(workspace.id, now);
  return { ...view, current, carryovers: view.items };
}

export async function updateBriefItemMemory(input: { workspaceId: string; itemId: string; action: BriefMemoryAction; now?: string }): Promise<LivingBriefItem> {
  const workspace = await resolveBriefWorkspace(input.workspaceId);
  const now = iso(input.now || nowIso());
  if (!(["complete", "dismiss", "bring_back"] as string[]).includes(input.action)) throw new Error("Brief memory action is invalid");
  const owned = await byId(workspace.id, input.itemId, workspace.accountIds);
  if (!owned) throw new Error("Brief memory item was not found in this workspace");
  const scope = storedScope(workspace.accountIds);
  await withNotificationStoreWrite(async tx => {
    // Read and mutate under the same lock: repeated UI requests create no owner action.
    const prior = (await tx.execute({ sql: `SELECT * FROM brief_item_memory WHERE id=? AND workspace_id=? AND ${scope.sql}`, args: [input.itemId, workspace.id, ...scope.args] })).rows[0];
    if (!prior) throw new Error("Brief memory item was not found in this workspace");
    const changes = input.action === "bring_back" ? prior.state !== "open" : prior.state === "open";
    if (changes) await tx.execute({ sql: `INSERT INTO brief_notification_actions
      (id,source_type,source_account_id,source_key,provider,provider_thread_id,source_revision_at,effective_at,observed_at,kind)
      SELECT ?,m.source_type,m.source_account_id,m.source_key,a.provider,json_extract(m.target_json,'$.providerThreadId'),m.source_revision_at,?,?,?
      FROM brief_item_memory m JOIN email_accounts a ON a.id=m.source_account_id
      WHERE m.id=? AND m.source_type='mail_thread' AND json_valid(m.target_json)
        AND json_extract(m.target_json,'$.provider')=a.provider AND a.provider IN ('gmail','microsoft')
        AND length(json_extract(m.target_json,'$.providerThreadId'))>0
        AND m.source_key='mail:'||m.source_account_id||':'||json_extract(m.target_json,'$.providerThreadId')`,
      args: [newId("brief_action"), now, now, input.action, input.itemId] });
    const result = await tx.execute({ sql:
    `UPDATE brief_item_memory SET
      state = CASE WHEN ? = 'complete' AND state = 'open' THEN 'completed' WHEN ? = 'dismiss' AND state = 'open' THEN 'dismissed' WHEN ? = 'bring_back' AND state <> 'open' THEN 'open' ELSE state END,
      completed_at = CASE WHEN ? = 'complete' AND state = 'open' THEN ? ELSE completed_at END,
      dismissed_at = CASE WHEN ? = 'dismiss' AND state = 'open' THEN ? ELSE dismissed_at END,
      restored_at = CASE WHEN ? = 'bring_back' AND state <> 'open' THEN ? ELSE restored_at END,
      completion_evidence_json = CASE WHEN (? = 'complete' OR ? = 'dismiss') AND state = 'open' THEN '{}' ELSE completion_evidence_json END,
      updated_at = CASE WHEN (? = 'complete' AND state = 'open') OR (? = 'dismiss' AND state = 'open') OR (? = 'bring_back' AND state <> 'open') THEN ? ELSE updated_at END
      WHERE id = ? AND workspace_id = ? AND ${scope.sql}`,
    args: [input.action, input.action, input.action, input.action, now, input.action, now, input.action, now, input.action, input.action, input.action, input.action, input.action, now, input.itemId, workspace.id, ...scope.args],
    });
    if (result.rowsAffected !== 1) throw new Error("Brief memory item was not found in this workspace");
  });
  const item = await byId(workspace.id, input.itemId, workspace.accountIds);
  if (!item) throw new Error("Brief memory item was not found in this workspace");
  return item;
}

export async function markBriefItemCompletedWithEvidence(input: {
  workspaceId: string;
  itemId: string;
  sourceKey: string;
  accountId: string;
  provider: AccountProvider;
  providerThreadId: string;
  sourceRevisionAt: string;
  providerMessageId: string;
  providerSentAt: string;
  observedAt: string;
}): Promise<boolean> {
  const workspace = await resolveBriefWorkspace(input.workspaceId);
  const itemId = required(input.itemId, "Brief evidence item ID");
  const sourceKey = required(input.sourceKey, "Brief evidence source key");
  const accountId = required(input.accountId, "Brief evidence account ID");
  const providerThreadId = required(input.providerThreadId, "Brief evidence thread ID");
  const providerMessageId = required(input.providerMessageId, "Brief evidence message ID");
  if (!workspace.accountIds.includes(accountId)) return false;
  if (input.provider !== "gmail" && input.provider !== "microsoft") throw new Error("Brief evidence provider is invalid");
  const sourceRevisionAt = iso(input.sourceRevisionAt);
  const providerSentAt = iso(input.providerSentAt);
  const observedAt = iso(input.observedAt);
  if (providerSentAt <= sourceRevisionAt || providerSentAt > observedAt) return false;
  const evidenceId = newId("reply_evidence");
  const linkId = newId("reply_link");
  const exact = `m.id = ? AND m.workspace_id = ? AND m.source_type = 'mail_thread' AND m.source_key = ?
    AND m.source_account_id = ? AND m.source_revision_at = ? AND m.state = 'open'
    AND json_extract(m.target_json, '$.provider') = ?
    AND json_extract(m.target_json, '$.providerThreadId') = ?
    AND EXISTS (
      SELECT 1 FROM email_accounts a
      WHERE a.id = m.source_account_id
        AND a.provider = ? AND a.status <> 'disabled'
    )`;
  const exactArgs = [itemId, workspace.id, sourceKey, accountId, sourceRevisionAt, input.provider, providerThreadId, input.provider];
  await ensureEmailDatabase();
  const results = await executeBatch([
    {
      sql: `INSERT INTO reply_completion_evidence
        (id, brief_item_id, source_key, account_id, provider, provider_message_id,
         provider_thread_id, provider_sent_at, observed_at, created_at)
       SELECT ?, m.id, m.source_key, m.source_account_id, ?, ?, ?, ?, ?, ?
       FROM brief_item_memory m
       WHERE ${exact}
         AND NOT EXISTS (
           SELECT 1 FROM reply_completion_evidence e
           WHERE e.account_id = ? AND e.provider = ? AND e.provider_message_id = ?
         )`,
      args: [
        evidenceId, input.provider, providerMessageId, providerThreadId, providerSentAt, observedAt, observedAt,
        ...exactArgs, accountId, input.provider, providerMessageId,
      ],
    },
    {
      sql: `INSERT INTO reply_completion_evidence_links
        (id, evidence_id, brief_item_id, source_revision_at, created_at)
       SELECT ?, e.id, m.id, m.source_revision_at, ?
       FROM brief_item_memory m
       JOIN reply_completion_evidence e ON e.account_id = m.source_account_id
         AND e.source_key = m.source_key
         AND e.provider = json_extract(m.target_json, '$.provider')
         AND e.provider_thread_id = json_extract(m.target_json, '$.providerThreadId')
         AND e.provider_message_id = ? AND e.provider_sent_at = ?
         AND m.source_revision_at < e.provider_sent_at AND e.provider_sent_at <= e.observed_at
       WHERE ${exact}
         AND (e.id = ? OR EXISTS (
           SELECT 1 FROM reply_completion_evidence_links prior
           WHERE prior.evidence_id = e.id AND prior.source_revision_at = m.source_revision_at
         ))
         AND NOT EXISTS (
           SELECT 1 FROM reply_completion_evidence_links prior
           WHERE prior.evidence_id = e.id AND prior.brief_item_id = m.id
         )`,
      args: [linkId, observedAt, providerMessageId, providerSentAt, ...exactArgs, evidenceId],
    },
    {
      sql: `UPDATE brief_item_memory AS m SET
        state = 'completed', completed_at = ?,
        completion_evidence_json = (SELECT json_object('kind', 'external_reply', 'evidenceId', evidence_id) FROM reply_completion_evidence_links WHERE id = ?),
        updated_at = ?
       WHERE ${exact}
         AND EXISTS (
           SELECT 1 FROM reply_completion_evidence_links link
           WHERE link.id = ? AND link.brief_item_id = m.id AND link.source_revision_at = m.source_revision_at
         )`,
      args: [providerSentAt, linkId, observedAt, ...exactArgs, linkId],
    },
    {
      sql: `DELETE FROM reply_completion_evidence_links WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM brief_item_memory m WHERE m.id = reply_completion_evidence_links.brief_item_id
          AND m.state = 'completed' AND json_extract(m.completion_evidence_json, '$.evidenceId') = reply_completion_evidence_links.evidence_id
      )`,
      args: [linkId],
    },
    {
      sql: `DELETE FROM reply_completion_evidence
       WHERE id = ? AND NOT EXISTS (
         SELECT 1 FROM reply_completion_evidence_links link
         WHERE link.evidence_id = reply_completion_evidence.id
       )`,
      args: [evidenceId],
    },
    {
      sql: `INSERT OR IGNORE INTO brief_notification_actions
        (id,source_type,source_account_id,source_key,provider,provider_thread_id,source_revision_at,effective_at,observed_at,kind)
        SELECT 'external_'||l.id,'mail_thread',e.account_id,e.source_key,e.provider,e.provider_thread_id,l.source_revision_at,e.provider_sent_at,e.observed_at,'external'
        FROM reply_completion_evidence_links l JOIN reply_completion_evidence e ON e.id=l.evidence_id
        WHERE l.id=? AND e.source_key='mail:'||e.account_id||':'||e.provider_thread_id`,
      args: [linkId],
    },
  ], "write");
  return results[2].rowsAffected === 1;
}

export async function listBriefMemory(workspaceId: string, now = nowIso()): Promise<BriefMemoryView> {
  const workspace = await resolveBriefWorkspace(workspaceId);
  const date = iso(now);
  const scope = storedScope(workspace.accountIds, "m");
  const rows = await execute(
    `SELECT m.*, a.provider AS source_account_provider
     FROM brief_item_memory m
     LEFT JOIN email_accounts a ON a.id = m.source_account_id
     WHERE m.workspace_id = ? AND ${scope.sql}
     ORDER BY m.occurred_at DESC, m.id`,
    [workspace.id, ...scope.args],
  );
  const all = rows.rows.map((row) => decode(row)).filter((item): item is LivingBriefItem => !!item && (!item.sourceAccountId || workspace.accountIds.includes(item.sourceAccountId)));
  const zone = (await getSetting("timezone")) || "America/Chicago";
  const today = day(date, zone);
  return { workspaceId: workspace.id, items: all.filter((item) => item.state === "open"), current: [], carryovers: all.filter((item) => item.state === "open"), completedToday: all.filter((item) => item.state !== "open" && day(item.state === "completed" ? item.completedAt! : item.dismissedAt!, zone) === today) };
}

async function candidateForWorkspace(raw: BriefCandidate, accounts: string[]): Promise<BriefCandidate> {
  if (!raw.sourceKey.trim() || !["mail_thread", "calendar_event", "action_center"].includes(raw.sourceType) || !["agenda", "attention"].includes(raw.role)) throw new Error("Brief source is invalid");
  if (raw.topicKind !== undefined && !validTopicKind(raw.topicKind)) throw new Error("Brief topic kind is invalid");
  const sourceAccountId = raw.sourceAccountId?.trim() || null;
  if (raw.sourceType === "mail_thread" && (!sourceAccountId || !raw.provider || !raw.providerThreadId?.trim())) throw new Error("Brief mail thread source is invalid");
  if (raw.sourceType === "calendar_event" && (!sourceAccountId || !raw.provider)) throw new Error("Brief calendar source is invalid");
  if (raw.sourceType === "action_center" && !sourceAccountId && (raw.provider !== null || raw.providerThreadId !== null)) throw new Error("Brief Action Center source is invalid");
  if (sourceAccountId) {
    if (!accounts.includes(sourceAccountId)) throw new Error("Brief source account is outside the selected workspace");
    const result = await execute("SELECT provider FROM email_accounts WHERE id = ? AND status <> 'disabled'", [sourceAccountId]);
    if (!result.rows.length || raw.provider !== String(result.rows[0].provider) as AccountProvider) throw new Error("Brief source account is invalid");
  }
  const title = raw.title.trim().slice(0, titleLimit);
  if (!title) throw new Error("Brief item title is required");
  if (
    !target(raw.target)
    || (raw.sourceType === "calendar_event" && !calendarEventTarget(raw.target))
  ) throw new Error("Brief item target is invalid");
  return { ...raw, sourceKey: raw.sourceKey.trim(), sourceAccountId, providerThreadId: raw.providerThreadId?.trim() || null, revisionAt: iso(raw.revisionAt), occurredAt: iso(raw.occurredAt), title, summary: raw.summary.trim().slice(0, summaryLimit) };
}

function target(value: ActionCenterTarget) {
  if (!value || typeof value !== "object" || !("view" in value)) return false;
  const fields = value as Record<string, unknown>;
  const optional = (key: "messageId" | "draftId" | "eventId" | "accountId") => !(key in fields) || (typeof fields[key] === "string" && !!fields[key].trim());
  if (!optional("messageId") || !optional("draftId") || !optional("eventId") || !optional("accountId")) return false;
  if (value.view === "mail") return typeof value.messageId === "string" && !!value.messageId;
  if (value.view === "drafts") return typeof value.draftId === "string" || typeof value.messageId === "string";
  if (value.view === "outbox") return !("draftId" in value) || typeof value.draftId === "string";
  if (value.view === "calendar") {
    if ("date" in fields && !validTargetDate(fields.date)) return false;
    return true;
  }
  return value.view === "today" || value.view === "settings";
}

function validTargetDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function calendarEventTarget(value: ActionCenterTarget) {
  return value.view === "calendar"
    && typeof value.eventId === "string"
    && !!value.eventId.trim()
    && validTargetDate(value.date);
}

function snapshot(value: BriefCandidate) { return { target: value.target, provider: value.provider, providerThreadId: value.providerThreadId, role: value.role, ...(value.topicKind ? { topicKind: value.topicKind } : {}) }; }
function validTopicKind(value: unknown): value is NonNullable<BriefCandidate["topicKind"]> { return value === "action" || value === "reply" || value === "deadline" || value === "fyi"; }
function storedScope(accounts: string[], alias = "") {
  const column = (name: string) => alias ? `${alias}.${name}` : name;
  if (!accounts.length) {
    return { sql: `(${column("source_type")} = 'action_center' AND ${column("source_account_id")} IS NULL)`, args: [] as string[] };
  }
  return {
    sql: `((${column("source_type")} = 'action_center' AND ${column("source_account_id")} IS NULL) OR ${column("source_account_id")} IN (${accounts.map(() => "?").join(", ")}))`,
    args: accounts,
  };
}
async function bySource(workspace: string, key: string, accounts: string[]) {
  const scope = storedScope(accounts, "m");
  const result = await execute(
    `SELECT m.*, a.provider AS source_account_provider
     FROM brief_item_memory m
     LEFT JOIN email_accounts a ON a.id = m.source_account_id
     WHERE m.workspace_id = ? AND m.source_key = ? AND ${scope.sql}`,
    [workspace, key, ...scope.args],
  );
  const item = result.rows[0] ? decode(result.rows[0]) : null;
  return item && (!item.sourceAccountId || accounts.includes(item.sourceAccountId)) ? item : null;
}
async function byId(workspace: string, id: string, accounts: string[]) {
  const scope = storedScope(accounts, "m");
  const result = await execute(
    `SELECT m.*, a.provider AS source_account_provider
     FROM brief_item_memory m
     LEFT JOIN email_accounts a ON a.id = m.source_account_id
     WHERE m.workspace_id = ? AND m.id = ? AND ${scope.sql}`,
    [workspace, id, ...scope.args],
  );
  const item = result.rows[0] ? decode(result.rows[0]) : null;
  return item && (!item.sourceAccountId || accounts.includes(item.sourceAccountId)) ? item : null;
}
function decode(row: Record<string, unknown>): LivingBriefItem | null {
  try {
    const parsed = JSON.parse(String(row.target_json)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const stored = parsed as Record<string, unknown>;
    const sourceType = String(row.source_type);
    const state = String(row.state);
    const accountId = row.source_account_id === null || row.source_account_id === undefined ? null : String(row.source_account_id).trim();
    const provider = stored.provider;
    const providerThreadId = stored.providerThreadId === null
      ? null
      : typeof stored.providerThreadId === "string" && stored.providerThreadId.trim()
        ? stored.providerThreadId.trim()
        : undefined;
    const role = stored.role;
    const accountProvider = row.source_account_provider;
    const revisionAt = iso(String(row.source_revision_at));
    const occurredAt = iso(String(row.occurred_at));
    const firstSeenAt = iso(String(row.first_seen_at));
    const lastSeenAt = iso(String(row.last_seen_at));
    const completedAt = optionalIso(row.completed_at);
    const dismissedAt = optionalIso(row.dismissed_at);
    const restoredAt = optionalIso(row.restored_at);
    if (
      !target(stored.target as ActionCenterTarget)
      || !["mail_thread", "calendar_event", "action_center"].includes(sourceType)
      || !["open", "completed", "dismissed"].includes(state)
      || (accountId === null && sourceType !== "action_center")
      || accountId === ""
      || (provider !== "gmail" && provider !== "microsoft" && provider !== null)
      || providerThreadId === undefined
      || (role !== "agenda" && role !== "attention")
      || (accountId !== null && (accountProvider !== "gmail" && accountProvider !== "microsoft"))
      || (accountId !== null && provider !== accountProvider)
      || (sourceType === "mail_thread" && (accountId === null || providerThreadId === null))
      || (sourceType === "calendar_event" && accountId === null)
      || (sourceType === "calendar_event" && !calendarEventTarget(stored.target as ActionCenterTarget))
      || (sourceType === "action_center" && accountId === null && (provider !== null || providerThreadId !== null))
      || (state === "completed" && completedAt === null)
      || (state === "dismissed" && dismissedAt === null)
    ) return null;
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      sourceType: sourceType as BriefSourceType,
      sourceKey: String(row.source_key),
      sourceAccountId: accountId,
      provider,
      providerThreadId,
      revisionAt,
      occurredAt,
      role,
      ...(validTopicKind(stored.topicKind) ? { topicKind: stored.topicKind } : {}),
      title: String(row.title),
      summary: String(row.summary),
      target: stored.target as ActionCenterTarget,
      state: state as BriefMemoryState,
      firstSeenAt,
      lastSeenAt,
      completedAt,
      dismissedAt,
      restoredAt,
    };
  } catch {
    return null;
  }
}
function iso(value: string) { const date = new Date(value); if (Number.isNaN(date.getTime())) throw new Error("Brief timestamp is invalid"); return date.toISOString(); }
function optionalIso(value: unknown) { return value === null || value === undefined ? null : iso(String(value)); }
function required(value: string, label: string) { const result = value.trim(); if (!result) throw new Error(`${label} is required`); return result; }
function day(value: string, zone: string) { const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value)); const v = (t: string) => p.find((x) => x.type === t)?.value || ""; return `${v("year")}-${v("month")}-${v("day")}`; }
