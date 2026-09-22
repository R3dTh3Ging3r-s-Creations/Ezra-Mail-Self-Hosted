import { listBriefMemory, markBriefItemCompletedWithEvidence } from "./brief-memory";
import { execute, nowIso } from "./database";
import { providerAdapterFor, type ProviderSentEvidence } from "./provider-adapter";
import type { AccountProvider, LivingBriefItem } from "./types";
import { resolveBriefWorkspace } from "./workspaces";

const maximumResults = 100;
const maximumWindowMs = 14 * 24 * 60 * 60 * 1000;
const gmailInclusiveSafetyMs = 2_000;

export type SentEvidenceAccountHealth = {
  accountId: string;
  provider: AccountProvider;
  status: "current" | "truncated" | "error";
  lastAttemptedAt: string;
  lastSuccessfulAt: string | null;
  errorCode: string | null;
  truncated: boolean;
};

export type ExternalReplyEvidenceResult = {
  completedSourceKeys: string[];
  accountHealth: SentEvidenceAccountHealth[];
};

export async function reconcileExternalReplyEvidence(input: {
  workspaceId: string;
  openReplies: LivingBriefItem[];
  now?: string;
}): Promise<ExternalReplyEvidenceResult> {
  const workspace = await resolveBriefWorkspace(input.workspaceId);
  const observedAt = canonicalTimestamp(input.now || nowIso(), "Sent evidence timestamp is invalid");
  const observedMs = Date.parse(observedAt);
  const openReplies = [...input.openReplies];
  for (const item of openReplies) validateInputItem(item, workspace.id, workspace.accountIds);
  await validateStoredItems(workspace.id, openReplies);
  if (!openReplies.length) return { completedSourceKeys: [], accountHealth: [] };

  const accountIds = [...new Set(openReplies.map((item) => item.sourceAccountId!))];
  const accounts = await loadAccounts(accountIds);
  if (accounts.length !== accountIds.length) throw new Error("Sent evidence item is outside the selected workspace");
  const itemsByAccount = new Map<string, LivingBriefItem[]>();
  for (const item of openReplies) {
    const account = accounts.find((candidate) => candidate.id === item.sourceAccountId);
    if (!account || account.provider !== item.provider) throw new Error("Sent evidence item is outside the selected workspace");
    const group = itemsByAccount.get(account.id) || [];
    group.push(item);
    itemsByAccount.set(account.id, group);
  }

  const completedSourceKeys: string[] = [];
  const accountHealth: SentEvidenceAccountHealth[] = [];
  for (const account of accounts) {
    const accountItems = (itemsByAccount.get(account.id) || []).sort(compareItems);
    if (!accountItems.length) continue;
    const cutoffMs = observedMs - maximumWindowMs + gmailInclusiveSafetyMs;
    const relevantRevisionMs = accountItems
      .map((item) => Date.parse(item.revisionAt))
      .filter((value) => value < observedMs);
    const earliestRevisionMs = relevantRevisionMs.length ? Math.min(...relevantRevisionMs) : cutoffMs;
    const after = new Date(Math.max(cutoffMs, earliestRevisionMs)).toISOString();
    let rawPage: { items: unknown[]; truncated: boolean };
    try {
      const untrustedPage: unknown = await providerAdapterFor(account.provider).readSentEvidence(account.email, account.id, {
        after,
        before: observedAt,
        maxResults: maximumResults,
      });
      if (!validPage(untrustedPage) || untrustedPage.items.length > maximumResults) throw new MalformedProviderResponse();
      rawPage = untrustedPage;
    } catch (error) {
      const code = error instanceof MalformedProviderResponse ? "malformed_provider_response" : "provider_read_failed";
      await recordFailedRead(account, observedAt, code);
      accountHealth.push(await readHealth(account));
      continue;
    }
    const evidence = rawPage.items
      .map((row) => normalizeEvidence(row, account, after, observedAt))
      .filter((row): row is ProviderSentEvidence => row !== null)
      .sort(compareEvidence);
    await recordSuccessfulRead(account, observedAt, rawPage.truncated);
    for (const item of accountItems) {
      const match = evidence.find((row) => row.providerThreadId === item.providerThreadId && row.sentAt > item.revisionAt);
      if (!match) continue;
      const completed = await markBriefItemCompletedWithEvidence({
        workspaceId: workspace.id,
        itemId: item.id,
        sourceKey: item.sourceKey,
        accountId: account.id,
        provider: account.provider,
        providerThreadId: match.providerThreadId,
        sourceRevisionAt: item.revisionAt,
        providerMessageId: match.providerMessageId,
        providerSentAt: match.sentAt,
        observedAt,
      });
      if (completed) completedSourceKeys.push(item.sourceKey);
    }
    accountHealth.push(await readHealth(account));
  }

  return {
    completedSourceKeys: [...new Set(completedSourceKeys)].sort(),
    accountHealth,
  };
}

type AccountRow = { id: string; provider: AccountProvider; email: string };

function validateInputItem(item: LivingBriefItem, workspaceId: string, accountIds: string[]) {
  if (item.state !== "open" || item.sourceType !== "mail_thread" || !item.sourceAccountId || !item.provider || !item.providerThreadId?.trim()) {
    throw new Error("Sent evidence requires exact open mail replies");
  }
  if (item.workspaceId !== workspaceId || !accountIds.includes(item.sourceAccountId)) {
    throw new Error("Sent evidence item is outside the selected workspace");
  }
  if (!item.id.trim() || !item.sourceKey.trim()) throw new Error("Sent evidence requires exact open mail replies");
  canonicalTimestamp(item.revisionAt, "Sent evidence item revision is invalid");
}

async function validateStoredItems(workspaceId: string, items: LivingBriefItem[]) {
  const stored = new Map((await listBriefMemory(workspaceId)).items.map((item) => [item.id, item]));
  for (const item of items) {
    const exact = stored.get(item.id);
    if (
      !exact
      || exact.sourceType !== "mail_thread"
      || exact.sourceKey !== item.sourceKey
      || exact.sourceAccountId !== item.sourceAccountId
      || exact.provider !== item.provider
      || exact.providerThreadId !== item.providerThreadId!.trim()
      || exact.revisionAt !== canonicalTimestamp(item.revisionAt, "Sent evidence item revision is invalid")
    ) throw new Error("Sent evidence requires exact open workspace replies");
  }
}

async function loadAccounts(ids: string[]): Promise<AccountRow[]> {
  const result = await execute(
    `SELECT id, provider, email FROM email_accounts
     WHERE status <> 'disabled' AND id IN (${ids.map(() => "?").join(", ")})
     ORDER BY provider, id`,
    ids,
  );
  return result.rows.flatMap((row) => {
    const provider = String(row.provider);
    const email = String(row.email || "").trim();
    return (provider === "gmail" || provider === "microsoft") && email
      ? [{ id: String(row.id), provider, email }]
      : [];
  });
}

function validPage(value: unknown): value is { items: unknown[]; truncated: boolean } {
  return !!value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items) && typeof (value as { truncated?: unknown }).truncated === "boolean";
}

function normalizeEvidence(raw: unknown, account: AccountRow, after: string, before: string): ProviderSentEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.accountId !== account.id || value.provider !== account.provider) return null;
  const providerMessageId = typeof value.providerMessageId === "string" ? value.providerMessageId.trim() : "";
  const providerThreadId = typeof value.providerThreadId === "string" ? value.providerThreadId.trim() : "";
  if (!providerMessageId || !providerThreadId || typeof value.sentAt !== "string") return null;
  const sentAt = safeCanonicalTimestamp(value.sentAt);
  if (!sentAt || sentAt !== value.sentAt || sentAt < after || sentAt > before) return null;
  return { accountId: account.id, provider: account.provider, providerMessageId, providerThreadId, sentAt };
}

function compareEvidence(left: ProviderSentEvidence, right: ProviderSentEvidence) {
  return left.sentAt.localeCompare(right.sentAt) || left.providerMessageId.localeCompare(right.providerMessageId);
}

function compareItems(left: LivingBriefItem, right: LivingBriefItem) {
  return left.sourceKey.localeCompare(right.sourceKey) || left.id.localeCompare(right.id);
}

async function recordSuccessfulRead(account: AccountRow, attemptedAt: string, truncated: boolean) {
  const status = truncated ? "truncated" : "current";
  await execute(
    `INSERT INTO sent_evidence_sync_state
      (account_id, provider, status, last_attempted_at, last_successful_at, last_error_code, truncated, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(account_id, provider) DO UPDATE SET
       status = excluded.status,
       last_attempted_at = excluded.last_attempted_at,
       last_successful_at = excluded.last_successful_at,
       last_error_code = NULL,
       truncated = excluded.truncated,
       updated_at = excluded.updated_at`,
    [account.id, account.provider, status, attemptedAt, attemptedAt, truncated ? 1 : 0, attemptedAt, attemptedAt],
  );
}

async function recordFailedRead(account: AccountRow, attemptedAt: string, errorCode: string) {
  await execute(
    `INSERT INTO sent_evidence_sync_state
      (account_id, provider, status, last_attempted_at, last_successful_at, last_error_code, truncated, created_at, updated_at)
     VALUES (?, ?, 'error', ?, NULL, ?, 0, ?, ?)
     ON CONFLICT(account_id, provider) DO UPDATE SET
       status = 'error',
       last_attempted_at = excluded.last_attempted_at,
       last_error_code = excluded.last_error_code,
       truncated = 0,
       updated_at = excluded.updated_at`,
    [account.id, account.provider, attemptedAt, errorCode, attemptedAt, attemptedAt],
  );
}

async function readHealth(account: AccountRow): Promise<SentEvidenceAccountHealth> {
  const result = await execute(
    `SELECT status, last_attempted_at, last_successful_at, last_error_code, truncated
     FROM sent_evidence_sync_state WHERE account_id = ? AND provider = ?`,
    [account.id, account.provider],
  );
  const row = result.rows[0];
  return {
    accountId: account.id,
    provider: account.provider,
    status: String(row.status) as SentEvidenceAccountHealth["status"],
    lastAttemptedAt: String(row.last_attempted_at),
    lastSuccessfulAt: row.last_successful_at ? String(row.last_successful_at) : null,
    errorCode: row.last_error_code ? String(row.last_error_code) : null,
    truncated: Number(row.truncated) === 1,
  };
}

function canonicalTimestamp(value: string, message: string) {
  const canonical = safeCanonicalTimestamp(value);
  if (!canonical) throw new Error(message);
  return canonical;
}

function safeCanonicalTimestamp(value: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  try { return new Date(milliseconds).toISOString(); } catch { return null; }
}

class MalformedProviderResponse extends Error {}
