import type { AccountProvider } from "./types";

export type ProviderErrorKind =
  | "credentials_expired"
  | "permission_required"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_error";

export type ProviderErrorDescription = {
  code: ProviderErrorKind;
  message: string;
  reconnectRecommended: boolean;
};

export function describeProviderError(
  provider: AccountProvider,
  error: unknown,
): ProviderErrorDescription {
  const raw = error instanceof Error ? error.message : String(error || "");
  const normalized = raw.toLowerCase();
  const label = provider === "microsoft" ? "Hotmail" : "Gmail";

  if (isCredentialFailure(normalized)) {
    return {
      code: "credentials_expired",
      message: `${label} authorization expired or was revoked. Reconnect ${label} from Settings > Accounts.`,
      reconnectRecommended: true,
    };
  }
  if (isPermissionFailure(normalized)) {
    return {
      code: "permission_required",
      message: `${label} needs an additional permission. Reconnect ${label} from Settings > Accounts and approve the requested access.`,
      reconnectRecommended: true,
    };
  }
  if (/\b(429|rate.?limit|too many requests|resource_exhausted|throttl)/i.test(raw)) {
    return {
      code: "rate_limited",
      message: `${label} is temporarily limiting requests. Ezra will leave this account connected and try again later.`,
      reconnectRecommended: false,
    };
  }
  if (/\b(502|503|504|service unavailable|temporarily unavailable|gateway timeout)\b/i.test(raw)) {
    return {
      code: "provider_unavailable",
      message: `${label} is temporarily unavailable. Ezra will try again later.`,
      reconnectRecommended: false,
    };
  }

  return {
    code: "provider_error",
    message: safeProviderMessage(label),
    reconnectRecommended: false,
  };
}

function isCredentialFailure(value: string) {
  return [
    "invalid_grant",
    "token has been expired or revoked",
    "token expired or revoked",
    "refresh token is invalid",
    "refresh token was revoked",
    "oauth2: cannot fetch token",
    "interaction_required",
    "login_required",
    "aadsts700082",
    "aadsts700084",
    "aadsts50173",
  ].some((signal) => value.includes(signal));
}

function isPermissionFailure(value: string) {
  return [
    "insufficient_scope",
    "insufficient privileges",
    "permission denied",
    "access_denied",
    "authorization_requestdenied",
    "consent_required",
  ].some((signal) => value.includes(signal));
}

function safeProviderMessage(label: string) {
  return `${label} could not complete the provider request. Review Settings > Accounts and try again.`;
}
