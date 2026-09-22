import type { AccountProvider, AccountStatus, MailWorkspace } from "./types";
import { execute } from "./database";
export { accountWorkspaceId } from "./workspace-identity";
import { accountWorkspaceId } from "./workspace-identity";

export const GMAIL_WORKSPACE_ID = "workspace:gmail";
export const MICROSOFT_WORKSPACE_ID = "workspace:microsoft";
export const ALL_WORKSPACE_ID = "workspace:all";

export function accountWorkspaceIdentity(workspaceId?: string | null): { provider: AccountProvider; accountId: string } | null {
  if (!workspaceId) return null;
  const match = /^workspace:account:(gmail|microsoft):([^:\s]+)$/.exec(workspaceId);
  return match ? { provider: match[1] as AccountProvider, accountId: match[2] } : null;
}

export function accountPurpose(provider: AccountProvider) {
  return provider === "microsoft"
    ? "Professional / Personal / Submissions"
    : "General / Signup / Noise Catcher";
}

export function buildMailWorkspaces(accounts: AccountStatus[]): MailWorkspace[] {
  const activeAccounts = accounts.filter((account) => account.status !== "disabled");

  return [
    ...activeAccounts.map((account) => ({
      id: accountWorkspaceId(account.provider, account.id),
      label: account.label,
      purpose: account.purpose?.trim() || accountPurpose(account.provider),
      accountIds: [account.id],
      isAllAccounts: false,
      calendarRole: account.provider === "microsoft" ? "primary_future" as const : "none" as const,
      provider: account.provider,
    })),
    {
      id: ALL_WORKSPACE_ID,
      label: "All accounts",
      purpose: "Explicit combined view",
      accountIds: activeAccounts.map((account) => account.id),
      isAllAccounts: true,
      calendarRole: "none",
      provider: "all",
    },
  ];
}

function workspacePurpose(accounts: AccountStatus[], provider: AccountProvider) {
  const matching = accounts.filter((account) => account.provider === provider);
  if (!matching.length) return accountPurpose(provider);
  const purposes = [...new Set(matching.map((account) => account.purpose?.trim()).filter(Boolean) as string[])];
  if (purposes.length === 1) return purposes[0];
  if (purposes.length > 1) return `${matching.length} accounts · ${purposes.slice(0, 2).join(" / ")}`;
  return accountPurpose(provider);
}

export function providerForWorkspace(workspaceId?: string | null): AccountProvider | "all" {
  const account = accountWorkspaceIdentity(workspaceId);
  if (account) return account.provider;
  if (workspaceId === ALL_WORKSPACE_ID) return "all";
  if (workspaceId === MICROSOFT_WORKSPACE_ID) return "microsoft";
  return "gmail";
}

export function workspaceSqlFilter(workspaceId?: string | null, alias = "m") {
  const account = accountWorkspaceIdentity(workspaceId);
  if (account) return { sql: `${alias}.account_id = ?`, args: [account.accountId] };
  const provider = providerForWorkspace(workspaceId);
  if (provider === "all") return { sql: "1 = 1", args: [] as string[] };
  return {
    sql: `${alias}.account_id IN (
      SELECT id FROM email_accounts WHERE provider = ? AND status <> 'disabled'
    )`,
    args: [provider],
  };
}

export async function resolveBriefWorkspace(
  workspaceId?: string | null,
): Promise<{ id: string; accountIds: string[] }> {
  const id = workspaceId || GMAIL_WORKSPACE_ID;
  const account = accountWorkspaceIdentity(id);
  if (account) {
    const result = await execute(
      "SELECT id FROM email_accounts WHERE id = ? AND provider = ? AND status <> 'disabled'",
      [account.accountId, account.provider],
    );
    if (!result.rows.length) throw new Error("Brief workspace is not active");
    return { id, accountIds: [account.accountId] };
  }
  if (![GMAIL_WORKSPACE_ID, MICROSOFT_WORKSPACE_ID, ALL_WORKSPACE_ID].includes(id)) {
    throw new Error("Brief workspace is invalid");
  }
  const provider = id === ALL_WORKSPACE_ID ? null : providerForWorkspace(id);
  const result = await execute(
    provider
      ? "SELECT id FROM email_accounts WHERE status <> 'disabled' AND provider = ? ORDER BY provider, created_at, id"
      : "SELECT id FROM email_accounts WHERE status <> 'disabled' ORDER BY provider, created_at, id",
    provider ? [provider] : [],
  );
  return { id, accountIds: result.rows.map((row) => String(row.id)) };
}
