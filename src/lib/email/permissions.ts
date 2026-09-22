import { execute, getServiceState, nowIso } from "./database";
import { getGmailAuthorizationCapabilities } from "./gmail";
import type {
  AccountProvider,
  ProviderPermissionAccount,
  ProviderPermissionFeature,
  ProviderPermissionPage,
  ProviderPermissionStatus,
} from "./types";
import { accountWorkspaceIdentity, providerForWorkspace } from "./workspaces";

type Row = Awaited<ReturnType<typeof execute>>["rows"][number];
type IntegrationRow = {
  feature: string;
  access: string;
  status: string;
  lastConnectedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
};

export async function getProviderPermissions(input: { workspaceId?: string } = {}): Promise<ProviderPermissionPage> {
  const account = accountWorkspaceIdentity(input.workspaceId);
  const provider = providerForWorkspace(input.workspaceId);
  const where = account
    ? "a.id = ? AND a.provider = ? AND a.status <> 'disabled'"
    : provider === "all" ? "a.status <> 'disabled'" : "a.provider = ? AND a.status <> 'disabled'";
  const rows = await execute(
    `SELECT a.id, a.provider, a.email, a.label, a.status, a.last_sync_at,
       s.status AS calendar_status, s.last_sync_at AS calendar_sync_at,
       s.last_error AS calendar_error, s.updated_at AS calendar_updated_at
     FROM email_accounts a
     LEFT JOIN calendar_sync_state s ON s.account_id = a.id AND s.calendar_id = 'primary'
     WHERE ${where}
     ORDER BY a.provider DESC, a.label ASC`,
    account ? [account.accountId, account.provider] : provider === "all" ? [] : [provider],
  );
  const [gmailCapabilities, integrationRows] = await Promise.all([
    getGmailAuthorizationCapabilities(),
    execute(
      `SELECT account_id, feature, access, status, last_connected_at, last_error, updated_at
       FROM account_integrations`,
    ),
  ]);
  const integrations = new Map<string, IntegrationRow[]>();
  for (const row of integrationRows.rows) {
    const accountId = String(row.account_id);
    const items = integrations.get(accountId) || [];
    items.push({
      feature: String(row.feature),
      access: String(row.access || "none"),
      status: String(row.status || "needs_setup"),
      lastConnectedAt: row.last_connected_at ? String(row.last_connected_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      updatedAt: row.updated_at ? String(row.updated_at) : null,
    });
    integrations.set(accountId, items);
  }
  const accounts = await Promise.all(rows.rows.map((row) =>
    permissionAccount(row, integrations.get(String(row.id)) || [], gmailCapabilities.modify),
  ));
  const summary = {
    accounts: accounts.length,
    connectedAccounts: accounts.filter((account) => account.accountStatus === "connected").length,
    needsSetup: accounts.filter((account) => account.reconnectRecommended || account.features.some((feature) => feature.status === "needs_setup")).length,
    errors: accounts.filter((account) => account.tokenStatus === "error" || account.features.some((feature) => feature.status === "error")).length,
    readOnly: accounts.filter((account) => account.features.some((feature) => feature.status === "read_only")).length,
    disabled: accounts.filter((account) => account.features.some((feature) => feature.status === "disabled")).length,
  };
  return {
    generatedAt: nowIso(),
    workspaceId: input.workspaceId || null,
    summary,
    accounts,
  };
}

async function permissionAccount(
  row: Row,
  integrations: IntegrationRow[],
  gmailModifyAuthorized: boolean,
): Promise<ProviderPermissionAccount> {
  const provider = providerOrNull(row.provider) || "gmail";
  const accountId = String(row.id);
  const accountStatus = accountStatusOrDefault(row.status);
  const microsoftAccess = provider === "microsoft"
    ? await getServiceState(`microsoft_access:${String(row.email).toLowerCase()}`)
    : null;
  const microsoftScopes = provider === "microsoft"
    ? parseScopes(await getServiceState(`microsoft_scopes:${String(row.email).toLowerCase()}`))
    : [];
  const calendarIntegration = integrations.find((item) => item.feature === "calendar") || null;
  const calendarError = row.calendar_error ? String(row.calendar_error) : null;
  const features = [
    mailReadFeature(provider, accountStatus, row),
    mailActionsFeature(provider, accountStatus, gmailModifyAuthorized, microsoftAccess),
    sendFeature(provider, accountStatus, gmailModifyAuthorized, microsoftAccess, microsoftScopes),
    calendarReadFeature(provider, accountStatus, calendarIntegration, row),
    calendarWriteFeature(provider, accountStatus, calendarIntegration, row),
  ];
  const tokenStatus = tokenStatusFor(provider, accountStatus, microsoftAccess, gmailModifyAuthorized, calendarIntegration);
  const lastError = [
    accountStatus === "error" ? "Mail account is in an error state." : null,
    calendarError,
    ...integrations.map((item) => item.lastError),
  ].find(Boolean) || null;
  return {
    accountId,
    accountLabel: String(row.label),
    accountEmail: String(row.email),
    accountProvider: provider,
    accountStatus,
    tokenStatus,
    tokenDetail: tokenDetailFor(provider, tokenStatus, microsoftAccess, gmailModifyAuthorized),
    lastMailSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
    lastCalendarSyncAt: row.calendar_sync_at ? String(row.calendar_sync_at) : null,
    lastError,
    reconnectRecommended: tokenStatus === "needs_setup" || tokenStatus === "error" || features.some((feature) => feature.status === "needs_setup" || feature.status === "error"),
    features,
  };
}

function mailReadFeature(
  provider: AccountProvider,
  accountStatus: ProviderPermissionAccount["accountStatus"],
  row: Row,
): ProviderPermissionFeature {
  if (accountStatus === "error") {
    return feature("mail_read", "Mail read", "error", "none", "Mail polling hit an account error. Reconnect or check provider status.", null, null);
  }
  return feature(
    "mail_read",
    "Mail read",
    accountStatus === "connected" ? "connected" : "needs_setup",
    "read",
    accountStatus === "connected"
      ? `${providerLabel(provider)} inbox polling is available.`
      : "Connect this account before Ezra can read mail.",
    row.last_sync_at ? String(row.last_sync_at) : null,
    null,
  );
}

function mailActionsFeature(
  provider: AccountProvider,
  accountStatus: ProviderPermissionAccount["accountStatus"],
  gmailModifyAuthorized: boolean,
  microsoftAccess: string | null,
): ProviderPermissionFeature {
  if (accountStatus !== "connected") {
    return feature("mail_actions", "Mail actions", accountStatus === "error" ? "error" : "needs_setup", "none", "Mail actions need a connected account.", null, null);
  }
  if (provider === "gmail") {
    return feature(
      "mail_actions",
      "Mail actions",
      gmailModifyAuthorized ? "connected" : "read_only",
      gmailModifyAuthorized ? "write" : "read",
      gmailModifyAuthorized
        ? "Gmail modify permission is available for mark read, trash, spam, and maintenance actions."
        : "Gmail is connected read-only. Reconnect Gmail with maintenance access for provider writes.",
      null,
      null,
    );
  }
  const writable = microsoftAccess === "maintenance" || microsoftAccess === "calendar" || microsoftAccess === "send" || microsoftAccess === "full";
  return feature(
    "mail_actions",
    "Mail actions",
    writable ? "connected" : "read_only",
    writable ? "write" : "read",
    writable
      ? "Microsoft Mail.ReadWrite access is available for mark read, trash, junk, and maintenance actions."
      : "Hotmail is connected for reading only. Reconnect Hotmail with mail actions access for provider writes.",
    null,
    null,
  );
}

function sendFeature(
  provider: AccountProvider,
  accountStatus: ProviderPermissionAccount["accountStatus"],
  gmailModifyAuthorized: boolean,
  microsoftAccess: string | null,
  microsoftScopes: string[],
): ProviderPermissionFeature {
  if (accountStatus !== "connected") {
    return feature("send", "Send", accountStatus === "error" ? "error" : "needs_setup", "none", "Send needs a connected account.", null, null);
  }
  if (provider === "gmail") {
    return feature(
      "send",
      "Send",
      "connected",
      "write",
      gmailModifyAuthorized
        ? "Gmail exact-review sending is available through Outbox after explicit approval."
        : "Gmail exact-review sending is available through Outbox; reconnect Gmail if the provider reports a send-scope error.",
      null,
      null,
    );
  }
  const connected = (microsoftAccess === "send" || microsoftAccess === "full")
    && microsoftScopes.some((scope) => scope.toLowerCase() === "mail.send");
  return feature(
    "send",
    "Send",
    connected ? "connected" : "needs_setup",
    connected ? "write" : "none",
    connected
      ? "Microsoft Mail.Send access is available for exact-review Hotmail sends."
      : "Reconnect Hotmail with Send access before approved Hotmail drafts can leave Outbox.",
    null,
    null,
  );
}

function parseScopes(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function calendarReadFeature(
  provider: AccountProvider,
  accountStatus: ProviderPermissionAccount["accountStatus"],
  integration: IntegrationRow | null,
  row: Row,
): ProviderPermissionFeature {
  const access = integration?.access || "none";
  const status = calendarStatus(accountStatus, integration, row);
  return feature(
    "calendar_read",
    "Calendar read",
    status,
    access === "write" || access === "read" ? "read" : "none",
    status === "connected"
      ? `${providerLabel(provider)} calendar sync is available.`
      : status === "error"
        ? (row.calendar_error ? String(row.calendar_error) : integration?.lastError || "Calendar sync reported an error.")
        : "Calendar permission upgrade is needed.",
    integration?.lastConnectedAt || null,
    row.calendar_error ? String(row.calendar_error) : integration?.lastError || null,
  );
}

function calendarWriteFeature(
  provider: AccountProvider,
  accountStatus: ProviderPermissionAccount["accountStatus"],
  integration: IntegrationRow | null,
  row: Row,
): ProviderPermissionFeature {
  const access = integration?.access || "none";
  const status = calendarStatus(accountStatus, integration, row);
  return feature(
    "calendar_write",
    "Calendar write",
    status === "connected" && access === "write" ? "connected" : status,
    access === "write" ? "write" : "none",
    status === "connected" && access === "write"
      ? `${providerLabel(provider)} calendar event creation is available after explicit approval.`
      : status === "error"
        ? (row.calendar_error ? String(row.calendar_error) : integration?.lastError || "Calendar write access reported an error.")
        : "Calendar write permission is not connected yet.",
    integration?.lastConnectedAt || null,
    row.calendar_error ? String(row.calendar_error) : integration?.lastError || null,
  );
}

function calendarStatus(
  accountStatus: ProviderPermissionAccount["accountStatus"],
  integration: IntegrationRow | null,
  row: Row,
): ProviderPermissionStatus {
  if (accountStatus === "error") return "error";
  if (row.calendar_error) return "error";
  if (!integration) return "needs_setup";
  if (integration.status === "error") return "error";
  if (integration.status === "connected") return "connected";
  if (integration.status === "syncing") return "available";
  return "needs_setup";
}

function tokenStatusFor(
  provider: AccountProvider,
  accountStatus: ProviderPermissionAccount["accountStatus"],
  microsoftAccess: string | null,
  gmailModifyAuthorized: boolean,
  integration: IntegrationRow | null,
): ProviderPermissionStatus {
  if (accountStatus === "error") return "error";
  if (accountStatus !== "connected") return "needs_setup";
  if (provider === "microsoft" && !microsoftAccess) return "needs_setup";
  if (provider === "gmail" && !gmailModifyAuthorized && (!integration || integration.access === "none")) return "read_only";
  return "connected";
}

function tokenDetailFor(
  provider: AccountProvider,
  status: ProviderPermissionStatus,
  microsoftAccess: string | null,
  gmailModifyAuthorized: boolean,
) {
  if (status === "error") return "Reconnect is recommended because this account is in an error state.";
  if (provider === "microsoft") {
    return microsoftAccess
      ? `Microsoft token access mode: ${microsoftAccess}.`
      : "Microsoft account is connected, but Ezra could not find the recorded access mode. Reconnect from Settings.";
  }
  if (gmailModifyAuthorized) return "Google authorization includes Gmail modify access.";
  return "Google authorization appears read-only unless calendar access is connected.";
}

function feature(
  id: ProviderPermissionFeature["id"],
  label: string,
  status: ProviderPermissionStatus,
  access: ProviderPermissionFeature["access"],
  detail: string,
  lastConnectedAt: string | null,
  lastError: string | null,
): ProviderPermissionFeature {
  return { id, label, status, access, detail, lastConnectedAt, lastError };
}

function providerOrNull(value: unknown): AccountProvider | null {
  return value === "gmail" || value === "microsoft" ? value : null;
}

function accountStatusOrDefault(value: unknown): ProviderPermissionAccount["accountStatus"] {
  return value === "connected" || value === "needs_setup" || value === "error" || value === "disabled"
    ? value
    : "needs_setup";
}

function providerLabel(provider: AccountProvider) {
  return provider === "microsoft" ? "Hotmail" : "Gmail";
}
