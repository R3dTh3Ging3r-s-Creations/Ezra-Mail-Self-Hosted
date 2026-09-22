import type { AccountProvider } from "./types";

export function accountWorkspaceId(provider: AccountProvider, accountId: string) {
  return `workspace:account:${provider}:${accountId}`;
}
