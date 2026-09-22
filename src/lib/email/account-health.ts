import { accountPurpose } from "./workspaces";
import {
  audit,
  execute,
  getSetting,
  getServiceState,
  nowIso,
  setServiceState,
  setSetting,
} from "./database";
import { pollMailAccount } from "./service";
import { describeProviderError, type ProviderErrorKind } from "./provider-errors";
import type { AccountFreshnessItem, AccountFreshnessPage, AccountProvider } from "./types";

const MANUAL_SYNC_COOLDOWN_MS = 60_000;
const SYNC_RANGE_DAYS = [2, 7, 14, 30] as const;

function boundedSyncRangeDays(value: unknown) {
  const days = Number(value);
  return SYNC_RANGE_DAYS.includes(days as typeof SYNC_RANGE_DAYS[number]) ? days : 2;
}

export async function getAccountFreshness(): Promise<AccountFreshnessPage> {
  const [accounts, mailActions, maintenanceActions, outgoingAttempts, calendarActions, auditErrors, pollSetting] = await Promise.all([
    execute(
      `SELECT a.id, a.provider, a.email, a.label, a.status, a.last_sync_at,
         p.purpose_label, p.sync_range_days, c.status AS calendar_status, c.last_sync_at AS calendar_last_sync_at,
         c.last_error AS calendar_error
       FROM email_accounts a
       LEFT JOIN account_profile_settings p ON p.account_id = a.id
       LEFT JOIN calendar_sync_state c ON c.account_id = a.id AND c.calendar_id = 'primary'
       ORDER BY CASE WHEN a.status = 'disabled' THEN 1 ELSE 0 END, a.provider DESC, a.label ASC`,
    ),
    execute(
      `SELECT m.account_id, MAX(ma.executed_at) AS action_at
       FROM mail_actions ma
       JOIN json_each(ma.message_ids) ids
       JOIN email_messages m ON m.id = ids.value
       WHERE ma.executed_at IS NOT NULL
       GROUP BY m.account_id`,
    ),
    execute(`SELECT account_id, MAX(executed_at) AS action_at FROM maintenance_actions WHERE executed_at IS NOT NULL GROUP BY account_id`),
    execute(`SELECT account_id, MAX(COALESCE(completed_at, started_at)) AS action_at FROM outgoing_message_attempts GROUP BY account_id`),
    execute(`SELECT account_id, MAX(updated_at) AS action_at FROM calendar_drafts WHERE status = 'created' GROUP BY account_id`),
    execute(
      `SELECT target_id AS account_id, metadata, created_at
       FROM audit_logs
       WHERE target_type = 'account' AND action LIKE '%.failed'
      ORDER BY created_at DESC`,
    ),
    getSetting("poll_minutes"),
  ]);
  const pollIntervalMinutes = Math.max(1, Number(pollSetting || 5) || 5);
  const actionMaps = [mailActions, maintenanceActions, outgoingAttempts, calendarActions].map((result) => new Map(
    result.rows.map((row) => [String(row.account_id), row.action_at ? String(row.action_at) : null]),
  ));
  const accountErrors = new Map<string, Array<{
    message: string;
    at: string;
    code: ProviderErrorKind | null;
    reconnectRecommended: boolean;
  }>>();
  for (const row of auditErrors.rows) {
    const accountId = String(row.account_id);
    const errors = accountErrors.get(accountId) || [];
    errors.push({ ...metadataError(row.metadata), at: String(row.created_at) });
    accountErrors.set(accountId, errors);
  }
  const items = await Promise.all(accounts.rows.map(async (row): Promise<AccountFreshnessItem> => {
    const accountId = String(row.id);
    const provider = String(row.provider) as AccountProvider;
    const status = String(row.status) as AccountFreshnessItem["status"];
    const lastSuccessfulPollAt = row.last_sync_at ? String(row.last_sync_at) : null;
    const manualSyncAt = await getServiceState(`manual_account_sync:${accountId}`);
    const manualSyncAvailableAt = manualSyncAt ? new Date(new Date(manualSyncAt).getTime() + MANUAL_SYNC_COOLDOWN_MS).toISOString() : null;
    const actionTimes = actionMaps.map((map) => map.get(accountId)).filter(Boolean) as string[];
    const lastProviderActionAt = actionTimes.sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
    const errorsSinceLastSuccess = (accountErrors.get(accountId) || []).filter((error) => (
      !lastSuccessfulPollAt || new Date(error.at).getTime() >= new Date(lastSuccessfulPollAt).getTime()
    ));
    const auditError = errorsSinceLastSuccess.find((error) => error.reconnectRecommended)
      || errorsSinceLastSuccess[0]
      || null;
    const calendarIssue = row.calendar_error ? (() => {
      const raw = String(row.calendar_error);
      const described = describeProviderError(provider, raw);
      return /calendar/i.test(raw) ? { ...described, message: raw } : described;
    })() : null;
    const auditIssue = status === "error" && auditError
      ? (auditError.code
          ? auditError
          : { ...describeProviderError(provider, auditError.message), at: auditError.at })
      : null;
    const reconnectIssue = [calendarIssue, auditIssue].find((issue) => issue?.reconnectRecommended) || null;
    const lastError = reconnectIssue?.message || calendarIssue?.message || (status === "error" ? auditIssue?.message || "The last provider check failed." : null);
    const mailReconnectRecommended = status === "disabled"
      || Boolean(auditIssue?.reconnectRecommended)
      || (status === "error" && !auditIssue);
    const reconnectRecommended = mailReconnectRecommended || Boolean(calendarIssue?.reconnectRecommended);
    const recoveryMessage = status === "disabled"
      ? "This account is disconnected. Local mail, rules, drafts, and history are still preserved."
      : reconnectRecommended
        ? lastError || `Reconnect ${provider === "microsoft" ? "Hotmail" : "Gmail"} to restore provider access.`
        : null;
    return {
      accountId,
      accountLabel: String(row.label),
      accountEmail: String(row.email),
      accountProvider: provider,
      purposeLabel: row.purpose_label ? String(row.purpose_label) : accountPurpose(provider),
      syncRangeDays: boundedSyncRangeDays(row.sync_range_days),
      status,
      lastSuccessfulPollAt,
      lastProviderActionAt,
      lastError,
      nextExpectedCheckAt: status !== "disabled" && lastSuccessfulPollAt ? new Date(new Date(lastSuccessfulPollAt).getTime() + pollIntervalMinutes * 60_000).toISOString() : null,
      manualSyncAvailableAt,
      canSyncNow: status !== "disabled" && !mailReconnectRecommended && (!manualSyncAvailableAt || new Date(manualSyncAvailableAt).getTime() <= Date.now()),
      reconnectRecommended,
      recoveryMessage,
      issues: [
        {
          feature: "mail" as const,
          status: status === "connected" ? "ok" as const : status === "error" ? "error" as const : "needs_setup" as const,
          message: status === "connected" ? null : auditIssue?.message || (status === "disabled" ? "Mail polling is disabled for this account." : "Mail access needs attention."),
          reconnectRecommended: mailReconnectRecommended,
          lastSuccessAt: lastSuccessfulPollAt,
        },
        {
          feature: "calendar" as const,
          status: String(row.calendar_status || "needs_setup") === "connected" && !calendarIssue
            ? "ok" as const
            : calendarIssue ? "error" as const : "needs_setup" as const,
          message: calendarIssue?.message || (String(row.calendar_status || "") === "connected" ? null : "Calendar access has not been validated."),
          reconnectRecommended: Boolean(calendarIssue?.reconnectRecommended),
          lastSuccessAt: row.calendar_last_sync_at ? String(row.calendar_last_sync_at) : null,
        },
      ],
    };
  }));
  return {
    generatedAt: nowIso(),
    pollIntervalMinutes,
    manualSyncCooldownSeconds: MANUAL_SYNC_COOLDOWN_MS / 1000,
    items,
  };
}

export async function updateAccountPurpose(input: { accountId: string; purposeLabel: string }) {
  const purposeLabel = input.purposeLabel.replace(/\s+/g, " ").trim();
  if (purposeLabel.length < 2 || purposeLabel.length > 80) throw new Error("Account purpose must be between 2 and 80 characters.");
  const account = await execute(`SELECT id FROM email_accounts WHERE id = ? AND status <> 'disabled'`, [input.accountId]);
  if (!account.rows[0]) throw new Error("Connected account was not found.");
  await execute(
    `INSERT INTO account_profile_settings (account_id, purpose_label, sync_range_days, color, updated_at)
     VALUES (?, ?, 2, NULL, ?)
     ON CONFLICT(account_id) DO UPDATE SET purpose_label = excluded.purpose_label, updated_at = excluded.updated_at`,
    [input.accountId, purposeLabel, nowIso()],
  );
  await audit("account.purpose.updated", "user", "account", input.accountId, { purposeLabel });
  return getAccountFreshness();
}

export async function updateAccountSetup(input: { accountId: string; purposeLabel: string; syncRangeDays: number }) {
  const purposeLabel = input.purposeLabel.replace(/\s+/g, " ").trim();
  if (purposeLabel.length < 2 || purposeLabel.length > 80) throw new Error("Account purpose must be between 2 and 80 characters.");
  const syncRangeDays = boundedSyncRangeDays(input.syncRangeDays);
  if (Number(input.syncRangeDays) !== syncRangeDays) throw new Error("Initial sync range must be 2, 7, 14, or 30 days.");
  const account = await execute(`SELECT id FROM email_accounts WHERE id = ? AND status <> 'disabled'`, [input.accountId]);
  if (!account.rows[0]) throw new Error("Connected account was not found.");
  await execute(
    `INSERT INTO account_profile_settings (account_id, purpose_label, sync_range_days, color, updated_at)
     VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(account_id) DO UPDATE SET purpose_label = excluded.purpose_label, sync_range_days = excluded.sync_range_days, updated_at = excluded.updated_at`,
    [input.accountId, purposeLabel, syncRangeDays, nowIso()],
  );
  await audit("account.setup.updated", "user", "account", input.accountId, { purposeLabel, syncRangeDays });
  return getAccountFreshness();
}

export async function markWorkspacePurposesReviewed() {
  await setSetting("workspace_purposes_reviewed_at", nowIso());
  return getAccountFreshness();
}

export async function syncAccountNow(accountId: string) {
  const lastManualSyncAt = await getServiceState(`manual_account_sync:${accountId}`);
  if (lastManualSyncAt) {
    const availableAt = new Date(lastManualSyncAt).getTime() + MANUAL_SYNC_COOLDOWN_MS;
    if (availableAt > Date.now()) throw new Error(`Sync now is cooling down. Try again in ${Math.ceil((availableAt - Date.now()) / 1000)} seconds.`);
  }
  await setServiceState(`manual_account_sync:${accountId}`, nowIso());
  const result = await pollMailAccount(accountId);
  return { result, freshness: await getAccountFreshness() };
}

function metadataError(value: unknown): {
  message: string;
  code: ProviderErrorKind | null;
  reconnectRecommended: boolean;
} {
  try {
    const parsed = JSON.parse(String(value || "{}")) as {
      error?: unknown;
      errorCode?: unknown;
      reconnectRecommended?: unknown;
    };
    return {
      message: parsed.error ? String(parsed.error) : "The provider action failed.",
      code: providerErrorKind(parsed.errorCode),
      reconnectRecommended: parsed.reconnectRecommended === true,
    };
  } catch {
    return { message: "The provider action failed.", code: null, reconnectRecommended: false };
  }
}

function providerErrorKind(value: unknown): ProviderErrorKind | null {
  return value === "credentials_expired"
    || value === "permission_required"
    || value === "rate_limited"
    || value === "provider_unavailable"
    || value === "provider_error"
    ? value
    : null;
}
