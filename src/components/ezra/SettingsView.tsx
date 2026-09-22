"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  CalendarDays,
  Check,
  ChevronRight,
  CloudDownload,
  Database,
  KeyRound,
  ListChecks,
  LoaderCircle,
  MailPlus,
  Play,
  RefreshCw,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  Unplug,
  UserRoundCog,
} from "lucide-react";
import type {
  AccountFreshnessPage,
  AccountFreshnessItem,
  CalendarActionResult,
  CalendarAccountStatus,
  CalendarPage,
  DashboardState,
  NotificationPolicyPage,
  NotificationPreference,
  OnboardingChecklistItem,
  OnboardingChecklistPage,
  ProviderPermissionFeature,
  ProviderPermissionPage,
  ProviderSetupDiscovery,
  RuleItem,
  SystemRecoveryStatus,
  TrustedDeviceSummary,
} from "@/lib/email/types";
import { ruleActionLabel as sharedRuleActionLabel } from "@/lib/email/vocabulary";
import { api, post } from "./api";
import { isInitialPanelLoad } from "./refreshState";
import { isAbortError, useLatestRequest } from "./useLatestRequest";
import { WritingPreferencesPanel } from "./WritingPreferencesPanel";
import { OpenSourceNotice } from "./OpenSourceNotice";
import { PwaControls } from "./PwaControls";
import { NotificationAttentionControls } from "./NotificationAttentionControls";
import { TelegramNotificationSettings } from "./TelegramNotificationSettings";
import { BrowserNotificationControls } from "./BrowserNotificationControls";
import styles from "./EzraMail.module.css";

type SettingsTab = "setup" | "accounts" | "permissions" | "rules" | "models" | "delivery" | "system";
type RuleFilter = "all" | "sender" | "topic" | "cleanup" | "disabled";
type LegacyResponse<T = unknown> = { ok: boolean; result?: T; error?: string };
type GoogleAccessMode = "readonly" | "maintenance" | "calendar";
type MicrosoftAccessMode = "readonly" | "maintenance" | "calendar" | "send" | "full";
type GoogleAuthorizationStart = {
  status: "started";
  email: string;
  access: GoogleAccessMode;
  mode?: "browser" | "remote";
  processId?: number | null;
  authUrl?: string | null;
  message?: string | null;
};
type GoogleAuthChallenge = {
  email: string;
  access: GoogleAccessMode;
  authUrl: string;
  message: string | null;
  sourceWorkspaceId: string;
};
type GoogleCompletion = {
  status: "connected";
  email: string;
  access: GoogleAccessMode;
};
type MicrosoftAuthorizationStart = {
  connectionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: string;
  message: string | null;
  interval: number;
  access?: MicrosoftAccessMode;
};
type MicrosoftAuthChallenge = MicrosoftAuthorizationStart & {
  sourceWorkspaceId: string;
  email: string;
  setup?: { purposeLabel: string; syncRangeDays: number };
};
type MicrosoftCompletion =
  | { status: "pending"; message: string }
  | { status: "connected"; email: string };
type ProviderSetupTest = {
  provider: "gmail" | "microsoft";
  capability: "mail_read" | "send";
  ready: boolean;
  authorization: "browser" | "device_code";
  message: string;
};
type NotificationPolicyDraft = {
  timezone: string;
  digestTimes: string[];
  quietStart: string;
  quietEnd: string;
  categoryPreferences: Record<string, NotificationPreference>;
};
type OwnerSecurityPage = {
  devices: TrustedDeviceSummary[];
  passkeys: Array<{ id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }>;
  currentDeviceId: string | null;
  bypassActive: boolean;
  configured: boolean;
};

const TABS = [
  { id: "setup" as const, label: "Setup", icon: ListChecks },
  { id: "accounts" as const, label: "Accounts", icon: UserRoundCog },
  { id: "permissions" as const, label: "Permissions", icon: KeyRound },
  { id: "rules" as const, label: "Rules", icon: SlidersHorizontal },
  { id: "models" as const, label: "AI models", icon: Bot },
  { id: "delivery" as const, label: "Delivery", icon: Send },
  { id: "system" as const, label: "System", icon: Server },
];
const RULE_FILTERS: Array<{ id: RuleFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "sender", label: "Senders" },
  { id: "topic", label: "Topics" },
  { id: "cleanup", label: "Cleanup" },
  { id: "disabled", label: "Disabled" },
];
const GUIDED_ACCOUNT_SETUP_STORAGE_KEY = "ezra-mail-guided-account-setup";
const SYNC_RANGE_OPTIONS = new Set([2, 7, 14, 30]);

export function SettingsView(props: {
  workspaceId: string;
  onAccountsChanged?: () => void | Promise<void>;
  onDailyBriefChanged?: (sourceWorkspaceId: string) => void | Promise<void>;
  onOpenView?: (view: "mail" | "calendar" | "outbox") => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("setup");
  const [ruleFilter, setRuleFilter] = useState<RuleFilter>("all");
  const [state, setState] = useState<DashboardState | null>(null);
  const [rules, setRules] = useState<RuleItem[]>([]);
  const [calendarAccounts, setCalendarAccounts] = useState<CalendarAccountStatus[]>([]);
  const [permissions, setPermissions] = useState<ProviderPermissionPage | null>(null);
  const [notificationPolicyError, setNotificationPolicyError] = useState("");
  const [notificationPolicy, setNotificationPolicy] = useState<NotificationPolicyPage | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingChecklistPage | null>(null);
  const [accountFreshness, setAccountFreshness] = useState<AccountFreshnessPage | null>(null);
  const [recovery, setRecovery] = useState<SystemRecoveryStatus | null>(null);
  const [ownerSecurity, setOwnerSecurity] = useState<OwnerSecurityPage | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [purposeDrafts, setPurposeDrafts] = useState<Record<string, string>>({});
  const [policyDraft, setPolicyDraft] = useState<NotificationPolicyDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [newAccount, setNewAccount] = useState("");
  const [setupPurpose, setSetupPurpose] = useState("");
  const [setupSyncRangeDays, setSetupSyncRangeDays] = useState(2);
  const [provider, setProvider] = useState<"gmail" | "microsoft">("gmail");
  const [setupDiscovery, setSetupDiscovery] = useState<ProviderSetupDiscovery | null>(null);
  const [setupPreflight, setSetupPreflight] = useState<ProviderSetupTest | null>(null);
  const [googleChallenge, setGoogleChallenge] = useState<GoogleAuthChallenge | null>(null);
  const [googleRedirectUrl, setGoogleRedirectUrl] = useState("");
  const [checkingGoogle, setCheckingGoogle] = useState(false);
  const [microsoftChallenge, setMicrosoftChallenge] = useState<MicrosoftAuthChallenge | null>(null);
  const [checkingMicrosoft, setCheckingMicrosoft] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);
  const beginRequest = useLatestRequest();
  const purposeDirtyRef = useRef(new Set<string>());
  const policyDirtyRef = useRef(false);
  const setupDraftHydratedRef = useRef(false);

  useEffect(() => {
    try {
      if (!setupDraftHydratedRef.current) {
        setupDraftHydratedRef.current = true;
        const draft = JSON.parse(window.sessionStorage.getItem(GUIDED_ACCOUNT_SETUP_STORAGE_KEY) || "null") as {
          provider?: unknown;
          email?: unknown;
          purpose?: unknown;
          syncRangeDays?: unknown;
        } | null;
        if (!draft || typeof draft !== "object") return;
        if (draft.provider === "gmail" || draft.provider === "microsoft") setProvider(draft.provider);
        if (typeof draft.email === "string") setNewAccount(draft.email.slice(0, 320));
        if (typeof draft.purpose === "string") setSetupPurpose(draft.purpose.slice(0, 80));
        const syncRangeDays = Number(draft.syncRangeDays);
        if (SYNC_RANGE_OPTIONS.has(syncRangeDays)) setSetupSyncRangeDays(syncRangeDays);
        return;
      }
      window.sessionStorage.setItem(GUIDED_ACCOUNT_SETUP_STORAGE_KEY, JSON.stringify({
        provider,
        email: newAccount,
        purpose: setupPurpose,
        syncRangeDays: setupSyncRangeDays,
      }));
    } catch {
      // Setup recovery is optional and must never prevent account setup.
    }
  }, [newAccount, provider, setupPurpose, setupSyncRangeDays]);

  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    const request = beginRequest();
    if (options.quiet) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setError("");
    }
    void api<NotificationPolicyPage>("/api/notifications/policy", { signal: request.signal }).then(policyPage => {
      if (!request.isLatest()) return;
      setNotificationPolicy(policyPage);
      setNotificationPolicyError("");
      setPolicyDraft(current => policyDirtyRef.current && current ? current : draftFromPolicy(policyPage));
    }, () => {
      if (!request.isLatest()) return;
      setNotificationPolicy(null);
      setNotificationPolicyError("Notification policy unavailable. Trust this device in System and check the configured notification origin.");
    });
    try {
      const [dashboard, nextRules, calendarPage, permissionPage, onboardingPage, freshnessPage, recoveryPage, securityPage] = await Promise.all([
        api<DashboardState>("/api/settings", { signal: request.signal }),
        api<RuleItem[]>(`/api/rules?${new URLSearchParams({ workspaceId: props.workspaceId }).toString()}`, { signal: request.signal }),
        api<CalendarPage>(`/api/calendar?${new URLSearchParams({ workspaceId: props.workspaceId, sync: "false" }).toString()}`, { signal: request.signal }),
        api<ProviderPermissionPage>(`/api/permissions?${new URLSearchParams({ workspaceId: props.workspaceId }).toString()}`, { signal: request.signal }),
        api<OnboardingChecklistPage>(`/api/onboarding?${new URLSearchParams({ workspaceId: props.workspaceId }).toString()}`, { signal: request.signal }),
        api<AccountFreshnessPage>("/api/accounts", { signal: request.signal }),
        api<SystemRecoveryStatus>("/api/system/recovery", { signal: request.signal }),
        api<OwnerSecurityPage>("/api/auth/devices", { signal: request.signal }),
      ]);
      if (!request.isLatest()) return;
      setState(dashboard);
      setRules(nextRules);
      setCalendarAccounts(calendarPage.accounts || []);
      setPermissions(permissionPage);
      setOnboarding(onboardingPage);
      setAccountFreshness(freshnessPage);
      setRecovery(recoveryPage);
      setOwnerSecurity(securityPage);
      setPurposeDrafts((current) => Object.fromEntries(freshnessPage.items.map((item) => [
        item.accountId,
        purposeDirtyRef.current.has(item.accountId) ? current[item.accountId] ?? item.purposeLabel : item.purposeLabel,
      ])));
    } catch (nextError) {
      if (!options.quiet && request.isLatest() && !isAbortError(nextError)) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      if (request.isLatest()) {
        if (options.quiet) setRefreshing(false);
        else setLoading(false);
      }
    }
  }, [beginRequest, props.workspaceId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const refresh = () => void load({ quiet: true });
    window.addEventListener("ezra:refresh", refresh);
    return () => window.removeEventListener("ezra:refresh", refresh);
  }, [load]);
  useEffect(() => {
    const hasDirty = () => policyDirtyRef.current || purposeDirtyRef.current.size > 0;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeNavigate = (event: Event) => {
      if (hasDirty() && !window.confirm("Discard the unsaved Settings changes?")) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("ezra:before-navigate", beforeNavigate);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("ezra:before-navigate", beforeNavigate);
    };
  }, []);

  async function legacyAction<T = unknown>(action: string, extra: Record<string, unknown> = {}, success = "Settings updated.") {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const response = await post<LegacyResponse<T>>("/api/email", { action, ...extra });
      if (!response.ok) throw new Error(response.error || "The action could not be completed.");
      setNotice(success);
      await load();
      return response.result || null;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      return null;
    } finally {
      setBusy("");
    }
  }

  async function recoveryAction(action: "verify_latest_backup" | "pause_polling" | "resume_polling") {
    if (action === "pause_polling" && !window.confirm("Pause Gmail, Hotmail, Calendar, and unread-backlog polling? The worker stays online so this control remains visible.")) return;
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const next = await post<SystemRecoveryStatus>("/api/system/recovery", {
        action,
        ...(action === "pause_polling"
          ? { confirmation: "PAUSE POLLING", reason: "Emergency pause requested from Settings" }
          : {}),
      });
      setRecovery(next);
      setNotice(
        action === "verify_latest_backup"
          ? "Latest deployment backup verified."
          : action === "pause_polling"
            ? "Provider polling is paused; the worker remains online."
            : "Provider polling resumed.",
      );
      await load({ quiet: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  async function trustThisDevice() {
    if (!deviceName.trim() || !ownerPassword) {
      setError("Enter a device name and your current owner password.");
      return;
    }
    setBusy("trust_device");
    setError("");
    setNotice("");
    try {
      const challenge = await post<{ id: string }>("/api/auth/devices/enroll/options", { password: ownerPassword });
      await post("/api/auth/devices/enroll/verify", { challengeId: challenge.id, label: deviceName });
      setOwnerPassword("");
      setDeviceName("");
      setNotice("This browser is now trusted until you revoke it or clear its site data.");
      await load({ quiet: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  async function revokeDevice(device: TrustedDeviceSummary) {
    const message = device.current
      ? `Forget ${device.label}? You will be signed out on the next request.`
      : `Revoke ${device.label}? That browser will need to be enrolled again.`;
    if (!window.confirm(message)) return;
    setBusy(`revoke_device_${device.id}`);
    setError("");
    try {
      await api(`/api/auth/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
      setNotice(`${device.label} was revoked.`);
      await load({ quiet: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  async function addOwnerPasskey() {
    if (!window.PublicKeyCredential) {
      setError("This browser does not support passkeys.");
      return;
    }
    const name = window.prompt("Name this passkey", "Owner passkey")?.trim();
    if (!name) return;
    setBusy("add_passkey");
    setError("");
    try {
      const start = await post<{ challengeId: string; options: RegistrationOptionsJson }>("/api/auth/passkeys/register/options", {});
      const credential = await navigator.credentials.create({ publicKey: registrationOptions(start.options) }) as PublicKeyCredential | null;
      if (!credential) throw new Error("Passkey setup was cancelled.");
      await post("/api/auth/passkeys/register/verify", {
        challengeId: start.challengeId,
        name,
        response: registrationCredentialJson(credential),
      });
      setNotice("Owner passkey added. Ezra will use it only for rare security changes.");
      await load({ quiet: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  async function changeBypassPolicy(enable: boolean) {
    if (!window.PublicKeyCredential) {
      setError("This browser does not support the passkey confirmation required for this change.");
      return;
    }
    const verb = enable ? "enable" : "disable";
    if (!window.confirm(`${enable ? "Enable" : "Disable"} the private-installation authentication bypass?`)) return;
    setBusy(`${verb}_bypass`);
    setError("");
    try {
      const start = await post<{ challengeId: string; options: AuthenticationOptionsJson }>("/api/auth/step-up/options", { action: "change_auth_policy" });
      const credential = await navigator.credentials.get({ publicKey: authenticationOptions(start.options) }) as PublicKeyCredential | null;
      if (!credential) throw new Error("Passkey confirmation was cancelled.");
      const verified = await post<{ receiptId: string }>("/api/auth/step-up/verify", {
        challengeId: start.challengeId,
        action: "change_auth_policy",
        response: authenticationCredentialJson(credential),
      });
      await post("/api/auth/policy", { action: enable ? "enable_bypass" : "disable_bypass", receiptId: verified.receiptId });
      setNotice(enable ? "Private-installation bypass enabled." : "Trusted-device protection is active. Normal mail use will not prompt again.");
      await load({ quiet: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  async function connectAccount() {
    if (!newAccount.trim()) return;
    const sourceWorkspaceId = props.workspaceId;
    setBusy("discover_provider");
    setError("");
    setNotice("");
    setSetupPreflight(null);
    try {
      const result = await post<{ discovery: ProviderSetupDiscovery }>("/api/accounts/discover", { provider });
      if (result.discovery.provider !== provider) throw new Error("Provider setup information did not match your selection.");
      setSetupDiscovery(result.discovery);
      setBusy("check_provider");
      const preflight = await post<{ test: ProviderSetupTest }>("/api/accounts/test", {
        provider,
        capability: "mail_read",
      });
      if (preflight.test.provider !== provider || preflight.test.capability !== "mail_read") {
        throw new Error("Provider connection check did not match your selection.");
      }
      setSetupPreflight(preflight.test);
      if (!preflight.test.ready) return;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      return;
    } finally {
      setBusy("");
    }
    if (provider === "gmail") {
      const result = await legacyAction<GoogleAuthorizationStart>(
        "connect_gmail",
        { email: newAccount.trim(), access: "maintenance" },
        "Google sign-in started.",
      );
      handleGoogleAuthorizationStart(result, sourceWorkspaceId);
      await props.onAccountsChanged?.();
      if (result?.mode !== "remote") setNewAccount("");
      return;
    }
    setGoogleChallenge(null);
    const challenge = await legacyAction<MicrosoftAuthorizationStart>(
      "connect_microsoft",
      { email: newAccount.trim(), access: "maintenance" },
      "Microsoft sign-in code created for mail actions. Finish the browser prompt, then check the connection.",
    );
    if (challenge) setMicrosoftChallenge({ ...challenge, sourceWorkspaceId, email: newAccount.trim(), setup: { purposeLabel: setupPurpose.trim(), syncRangeDays: setupSyncRangeDays } });
  }

  async function saveNewAccountSetup(email: string, setup = { purposeLabel: setupPurpose.trim(), syncRangeDays: setupSyncRangeDays }) {
    const freshness = await api<AccountFreshnessPage>("/api/accounts");
    const account = freshness.items.find((item) => item.accountEmail.toLowerCase() === email.trim().toLowerCase());
    if (!account) throw new Error("Connected account setup could not be found. Reopen Accounts and set its purpose and sync range.");
    await post("/api/accounts", {
      action: "update_setup",
      accountId: account.accountId,
      purposeLabel: setup.purposeLabel || account.purposeLabel,
      syncRangeDays: setup.syncRangeDays,
    });
  }

  function chooseProvider(nextProvider: "gmail" | "microsoft") {
    setProvider(nextProvider);
    setSetupDiscovery(null);
    setSetupPreflight(null);
    setGoogleChallenge(null);
    setMicrosoftChallenge(null);
  }

  function handleGoogleAuthorizationStart(result: GoogleAuthorizationStart | null, sourceWorkspaceId: string) {
    if (result?.mode === "remote" && result.authUrl) {
      setMicrosoftChallenge(null);
      setGoogleRedirectUrl("");
      setGoogleChallenge({
        email: result.email,
        access: result.access,
        authUrl: result.authUrl,
        message: result.message || null,
        sourceWorkspaceId,
      });
      setNotice("Google sign-in link is ready. Open it below, then paste the final browser URL.");
      return;
    }
    setGoogleChallenge(null);
  }

  async function completeGoogleConnection() {
    if (!googleChallenge || !googleRedirectUrl.trim()) return;
    const sourceWorkspaceId = googleChallenge.sourceWorkspaceId;
    setCheckingGoogle(true);
    setError("");
    const completedAccess = googleChallenge.access;
    try {
      const response = await post<LegacyResponse<GoogleCompletion>>("/api/email", {
        action: "complete_gmail_auth",
        email: googleChallenge.email,
        access: googleChallenge.access,
        authUrl: googleRedirectUrl.trim(),
      });
      if (!response.ok) throw new Error(response.error || "Google sign-in could not be completed.");
      setNotice(
        response.result?.email
          ? `Google account connected: ${response.result.email}.`
          : "Google account connected.",
      );
      if (response.result?.email) await saveNewAccountSetup(response.result.email);
      setGoogleChallenge(null);
      setGoogleRedirectUrl("");
      setNewAccount("");
      window.sessionStorage.removeItem(GUIDED_ACCOUNT_SETUP_STORAGE_KEY);
      if (completedAccess === "calendar") {
        try {
          const validation = await post<CalendarActionResult>("/api/calendar/actions", {
            action: "sync",
            workspaceId: "workspace:gmail",
          });
          if (validation.failures?.length) throw new Error(validation.failures[0].error);
          setNotice("Google account connected and Calendar access validated.");
        } catch (calendarError) {
          setNotice("Google account connected. Calendar still needs attention.");
          setError(calendarError instanceof Error ? calendarError.message : String(calendarError));
        }
      }
      await load();
      await props.onAccountsChanged?.();
      await props.onDailyBriefChanged?.(sourceWorkspaceId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCheckingGoogle(false);
    }
  }

  async function checkMicrosoftConnection() {
    if (!microsoftChallenge) return;
    const sourceWorkspaceId = microsoftChallenge.sourceWorkspaceId;
    setCheckingMicrosoft(true);
    setBusy("complete_microsoft_auth");
    setError("");
    try {
      const response = await post<LegacyResponse<MicrosoftCompletion>>("/api/email", {
        action: "complete_microsoft_auth",
        connectionId: microsoftChallenge.connectionId,
      });
      if (!response.ok) throw new Error(response.error || "Microsoft sign-in could not be completed.");
      if (response.result?.status === "pending") {
        setNotice(response.result.message || "Microsoft sign-in is still waiting.");
        return;
      }
      if (response.result?.status !== "connected" || !response.result.email?.trim()) {
        throw new Error("Microsoft did not confirm a connected mailbox. Start again from account setup.");
      }
      setNotice(response.result?.email ? `Microsoft mailbox connected: ${response.result.email}.` : "Microsoft mailbox connected.");
      if (microsoftChallenge.setup) await saveNewAccountSetup(response.result.email, microsoftChallenge.setup);
      setMicrosoftChallenge(null);
      if (microsoftChallenge.setup) {
        setNewAccount("");
        window.sessionStorage.removeItem(GUIDED_ACCOUNT_SETUP_STORAGE_KEY);
      }
      await load();
      await props.onAccountsChanged?.();
      await props.onDailyBriefChanged?.(sourceWorkspaceId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCheckingMicrosoft(false);
      setBusy("");
    }
  }

  async function connectCalendar(account: { provider: "gmail" | "microsoft"; email: string }) {
    const sourceWorkspaceId = props.workspaceId;
    if (account.provider === "gmail") {
      const result = await legacyAction<GoogleAuthorizationStart>(
        "connect_gmail",
        { email: account.email, access: "calendar" },
        "Google Calendar sign-in started.",
      );
      handleGoogleAuthorizationStart(result, sourceWorkspaceId);
      return;
    }
    setGoogleChallenge(null);
    const challenge = await legacyAction<MicrosoftAuthorizationStart>(
      "connect_microsoft",
      { email: account.email, access: "calendar" },
      "Microsoft calendar sign-in code created. Finish the browser prompt, then check the connection.",
    );
    if (challenge) setMicrosoftChallenge({ ...challenge, sourceWorkspaceId, email: account.email });
  }

  async function retryCalendar(provider: "gmail" | "microsoft") {
    const sourceWorkspaceId = props.workspaceId;
    setBusy(`calendar-retry-${provider}`);
    setError("");
    setNotice("");
    try {
      const result = await post<CalendarActionResult>("/api/calendar/actions", {
        action: "sync",
        workspaceId: provider === "gmail" ? "workspace:gmail" : "workspace:microsoft",
      });
      if (!result.ok || result.failures?.length) {
        throw new Error(result.failures?.[0]?.error || result.message || "Calendar check could not be completed.");
      }
      setNotice(`${provider === "gmail" ? "Google" : "Microsoft"} Calendar check completed.`);
      await load({ quiet: true });
      await props.onAccountsChanged?.();
      await props.onDailyBriefChanged?.(sourceWorkspaceId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  async function connectSend(account: { provider: "gmail" | "microsoft"; email: string }) {
    const sourceWorkspaceId = props.workspaceId;
    if (account.provider === "gmail") {
      const result = await legacyAction<GoogleAuthorizationStart>(
        "connect_gmail",
        { email: account.email, access: "maintenance" },
        "Google sign-in started. Finish reconnecting if Gmail send reports a provider scope error.",
      );
      handleGoogleAuthorizationStart(result, sourceWorkspaceId);
      return;
    }
    setGoogleChallenge(null);
    const challenge = await legacyAction<MicrosoftAuthorizationStart>(
      "connect_microsoft",
      { email: account.email, access: "full" },
      "Microsoft sign-in code created for replies, mail actions, and Calendar. Finish the browser prompt, then check the connection.",
    );
    if (challenge) setMicrosoftChallenge({ ...challenge, access: "full", sourceWorkspaceId, email: account.email });
  }

  async function saveNotificationPolicy() {
    if (!policyDraft) return;
    setBusy("notification-policy");
    setError("");
    setNotice("");
    try {
      const saved = await api<NotificationPolicyPage>("/api/notifications/policy", {
        method: "PATCH",
        body: JSON.stringify({
          timezone: policyDraft.timezone,
          digestTimes: policyDraft.digestTimes,
          quietStart: policyDraft.quietStart,
          quietEnd: policyDraft.quietEnd,
          categoryPreferences: policyDraft.categoryPreferences,
        }),
      });
      setNotificationPolicy(saved);
      setPolicyDraft(draftFromPolicy(saved));
      policyDirtyRef.current = false;
      setNotice("Notification policy updated.");
      await load({ quiet: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  async function saveAccountPurpose(accountId: string) {
    setBusy(`purpose-${accountId}`);
    setError("");
    try {
      const next = await post<AccountFreshnessPage>("/api/accounts", {
        action: "update_purpose",
        accountId,
        purposeLabel: purposeDrafts[accountId] || "",
      });
      setAccountFreshness(next);
      purposeDirtyRef.current.delete(accountId);
      setPurposeDrafts((current) => Object.fromEntries(next.items.map((item) => [
        item.accountId,
        purposeDirtyRef.current.has(item.accountId) ? current[item.accountId] ?? item.purposeLabel : item.purposeLabel,
      ])));
      setNotice("Account purpose updated without changing account routing.");
      await props.onAccountsChanged?.();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  async function markPurposesReviewed() {
    setBusy("purpose-review");
    setError("");
    try {
      await post<AccountFreshnessPage>("/api/accounts", { action: "mark_purposes_reviewed" });
      setNotice("Workspace purposes marked reviewed.");
      await load({ quiet: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  async function syncAccount(accountId: string) {
    const sourceWorkspaceId = props.workspaceId;
    setBusy(`sync-${accountId}`);
    setError("");
    try {
      const response = await post<{ freshness: AccountFreshnessPage }>("/api/accounts", { action: "sync_now", accountId });
      setAccountFreshness(response.freshness);
      setNotice("Account sync completed.");
      await props.onAccountsChanged?.();
      await props.onDailyBriefChanged?.(sourceWorkspaceId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  async function reconnectAccount(account: AccountFreshnessItem) {
    const sourceWorkspaceId = props.workspaceId;
    if (account.accountProvider === "gmail") setNewAccount(account.accountEmail);
    setProvider(account.accountProvider);
    setDisconnectTarget(null);
    if (account.accountProvider === "gmail") {
      const access: GoogleAccessMode = "calendar";
      const result = await legacyAction<GoogleAuthorizationStart>(
        "connect_gmail",
        { email: account.accountEmail, access },
        "Google reconnect started. Finish the sign-in steps below.",
      );
      handleGoogleAuthorizationStart(result, sourceWorkspaceId);
      return;
    }
    setGoogleChallenge(null);
    const permissionAccount = permissions?.accounts.find((item) => item.accountId === account.accountId);
    const sendConnected = permissionAccount?.features.some((feature) => feature.id === "send" && feature.status === "connected");
    const calendarConnected = calendarAccounts.some((item) => item.accountId === account.accountId && item.calendarStatus === "connected");
    const access: MicrosoftAccessMode = sendConnected ? "full" : calendarConnected ? "calendar" : "maintenance";
    const challenge = await legacyAction<MicrosoftAuthorizationStart>(
      "connect_microsoft",
      { email: account.accountEmail, access },
      "Microsoft reconnect code created. Finish the browser prompt, then check the connection.",
    );
    if (challenge) setMicrosoftChallenge({ ...challenge, access, sourceWorkspaceId, email: account.accountEmail });
  }

  async function disconnectAccount(account: AccountFreshnessItem) {
    const sourceWorkspaceId = props.workspaceId;
    setBusy(`disconnect-${account.accountId}`);
    setError("");
    setNotice("");
    try {
      const response = await post<{
        result: { credentialRemoved: boolean; retainedLocalData: true };
        freshness: AccountFreshnessPage;
      }>("/api/accounts", {
        action: "disconnect",
        accountId: account.accountId,
        confirmEmail: account.accountEmail,
      });
      setAccountFreshness(response.freshness);
      setPurposeDrafts(Object.fromEntries(response.freshness.items.map((item) => [item.accountId, item.purposeLabel])));
      setDisconnectTarget(null);
      setNotice(
        response.result.credentialRemoved
          ? `${account.accountLabel} disconnected and its stored provider credential was removed. Local mail and history were preserved.`
          : `${account.accountLabel} disconnected. No stored provider credential remained; local mail and history were preserved.`,
      );
      await load({ quiet: true });
      await props.onAccountsChanged?.();
      await props.onDailyBriefChanged?.(sourceWorkspaceId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  function updatePolicyDraft(update: Partial<NotificationPolicyDraft>) {
    policyDirtyRef.current = true;
    setPolicyDraft((current) => current ? { ...current, ...update } : current);
  }

  function updateDigestTime(index: number, value: string) {
    policyDirtyRef.current = true;
    setPolicyDraft((current) => {
      if (!current) return current;
      const digestTimes = [...current.digestTimes];
      digestTimes[index] = value;
      return { ...current, digestTimes };
    });
  }

  function updateCategoryPreference(id: string, preference: NotificationPreference) {
    policyDirtyRef.current = true;
    setPolicyDraft((current) => current ? {
      ...current,
      categoryPreferences: { ...current.categoryPreferences, [id]: preference },
    } : current);
  }

  async function toggleRule(rule: RuleItem) {
    setBusy(rule.id);
    setError("");
    try {
      const nextRules = await api<RuleItem[]>("/api/rules", {
        method: "PATCH",
        body: JSON.stringify({
          id: rule.id,
          source: rule.source,
          enabled: !rule.enabled,
          workspaceId: props.workspaceId,
        }),
      });
      setRules(nextRules);
      setNotice(`${ruleTargetLabel(rule)} ${rule.enabled ? "disabled" : "enabled"}.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  async function updateRuleAction(rule: RuleItem, action: string) {
    if (rule.source === "cleanup" && action === "spam" && !window.confirm(`Change the rule for "${ruleTargetLabel(rule)}" to move future matching mail to Spam?`)) return;
    setBusy(`action-${rule.id}`);
    setError("");
    try {
      const nextRules = await api<RuleItem[]>("/api/rules", {
        method: "PATCH",
        body: JSON.stringify({ id: rule.id, source: rule.source, action, workspaceId: props.workspaceId }),
      });
      setRules(nextRules);
      setNotice(`${ruleTargetLabel(rule)} now uses ${ruleActionLabel(action)}.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  async function removeRule(rule: RuleItem) {
    const label = ruleTargetLabel(rule);
    if (!window.confirm(`Remove Ezra's learned rule for "${label}"? Future mail will be triaged normally unless another rule applies.`)) return;
    setBusy(`remove-${rule.id}`);
    setError("");
    try {
      const nextRules = await api<RuleItem[]>("/api/rules", {
        method: "DELETE",
        body: JSON.stringify({ id: rule.id, source: rule.source, workspaceId: props.workspaceId }),
      });
      setRules(nextRules);
      setNotice(`${label} removed from Ezra's learned rules.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy("");
    }
  }

  if (isInitialPanelLoad(loading, Boolean(state))) return <div className={styles.settingsLoading}><LoaderCircle aria-hidden="true" /> Loading settings...</div>;
  if (!state) return <div className={styles.errorState}><strong>Settings unavailable</strong><p>{error}</p><button onClick={() => void load()}>Try again</button></div>;
  const accountById = new Map(state.accounts.map((account) => [account.id, account]));
  const ruleCounts: Record<RuleFilter, number> = {
    all: rules.length,
    sender: rules.filter((rule) => rule.kind === "sender" && rule.source === "priority").length,
    topic: rules.filter((rule) => rule.kind === "topic").length,
    cleanup: rules.filter((rule) => rule.source === "cleanup").length,
    disabled: rules.filter((rule) => !rule.enabled).length,
  };
  const visibleRules = rules.filter((rule) => {
    if (ruleFilter === "all") return true;
    if (ruleFilter === "disabled") return !rule.enabled;
    if (ruleFilter === "cleanup") return rule.source === "cleanup";
    return rule.kind === ruleFilter && rule.source === "priority";
  });

  function openChecklistTarget(item: OnboardingChecklistItem) {
    if (!item.target) return;
    if (item.target.type === "settings") setTab(item.target.tab);
    else props.onOpenView?.(item.target.view);
  }

  return (
    <div className={styles.settingsView} aria-busy={refreshing || loading}>
      <nav className={styles.settingsTabs} aria-label="Settings sections">
        {TABS.map((item) => {
          const Icon = item.icon;
          return <button key={item.id} className={tab === item.id ? styles.settingsTabActive : ""} onClick={() => setTab(item.id)}><Icon aria-hidden="true" /><span>{item.label}</span><ChevronRight aria-hidden="true" /></button>;
        })}
      </nav>
      <section className={styles.settingsContent}>
        {notice ? <div className={styles.successNotice} role="status"><Check aria-hidden="true" /> {notice}</div> : null}
        {error ? <div className={styles.inlineError} role="alert">{error}</div> : null}
        {tab === "setup" ? (
          <>
            <SettingsHeader title="Setup checklist" description="What is connected, what is missing, and the safest next step." icon={ListChecks} />
            {onboarding ? (
              <>
                <section className={styles.onboardingProgress} aria-label="Setup progress">
                  <div><strong>{onboarding.summary.percentComplete}%</strong><span>ready</span></div>
                  <div className={styles.onboardingProgressTrack}><span style={{ width: `${onboarding.summary.percentComplete}%` }} /></div>
                  <p>{onboarding.summary.complete} complete · {onboarding.summary.needsAttention} need attention · {onboarding.summary.planned} planned</p>
                </section>
                <div className={styles.onboardingList}>
                  {onboarding.items.map((item) => (
                    <article className={styles.onboardingItem} key={item.id}>
                      <span className={`${styles.onboardingStatus} ${styles[`onboardingStatus_${item.status}`]}`}>{item.status === "complete" ? <Check aria-hidden="true" /> : item.status === "planned" ? <CalendarDays aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</span>
                      <div>
                        <header><h3>{item.label}</h3><span>{item.statusLabel}</span></header>
                        <p>{item.description}</p>
                        <small><strong>Why it matters:</strong> {item.whyItMatters}</small>
                        <small>{item.detail}</small>
                      </div>
                      {item.actionLabel && item.target ? <button className={styles.secondaryButton} onClick={() => openChecklistTarget(item)}>{item.actionLabel}<ChevronRight aria-hidden="true" /></button> : null}
                    </article>
                  ))}
                </div>
              </>
            ) : <div className={styles.tableEmpty}>Setup status is loading.</div>}
          </>
        ) : null}
        {tab === "accounts" ? (
          <>
            <SettingsHeader title="Mail accounts" description="Connected inboxes and provider permissions." icon={UserRoundCog} />
            <div className={styles.accountList}>
              {state.accounts.map((account) => (
                <article className={styles.accountRow} key={account.id}>
                  <span className={styles.accountMark}>{account.provider === "gmail" ? "G" : "M"}</span>
                  <div>
                    <strong>{account.label}</strong>
                    <span>{account.email} · {account.provider === "gmail" ? "Google" : "Microsoft"} · {account.purpose || accountPurposeLabel(account.provider)}</span>
                  </div>
                  <dl><div><dt>Unread</dt><dd>{account.counts.unread}</dd></div><div><dt>Priority</dt><dd>{account.counts.interrupt}</dd></div><div><dt>Last sync</dt><dd>{account.lastSyncAt ? relativeDate(account.lastSyncAt) : "Not yet"}</dd></div></dl>
                  <span className={`${styles.connectionStatus} ${account.status === "connected" ? styles.connected : ""}`}>{account.status.replace("_", " ")}</span>
                </article>
              ))}
            </div>
            <SettingsHeader title="Account purpose and freshness" description="Edit presentation labels and inspect provider timing without changing identity or routing." icon={RefreshCw} />
            <div className={styles.accountFreshnessList}>
              {accountFreshness?.items.map((account) => (
                <article className={styles.accountFreshnessCard} key={account.accountId}>
                  <header>
                    <span className={account.accountProvider === "microsoft" ? styles.accountBadgeMicrosoft : styles.accountBadgeGmail}>{account.accountProvider === "microsoft" ? "Hotmail" : "Gmail"}</span>
                    <div><strong>{account.accountLabel}</strong><small>{account.accountEmail}</small></div>
                    <span className={`${styles.connectionStatus} ${account.status === "connected" ? styles.connected : ""}`}>{account.status.replace("_", " ")}</span>
                  </header>
                  {account.issues?.length ? <div className={styles.accountFeatureHealth} aria-label="Feature health">{account.issues.map((issue) => <span key={issue.feature} className={issue.status === "ok" ? styles.featureHealthGood : styles.featureHealthWarn}><strong>{issue.feature === "mail" ? "Mail" : "Calendar"}</strong>{issue.status === "ok" ? "Current" : issue.status === "needs_setup" ? "Setup needed" : "Needs attention"}</span>)}</div> : null}
                  {account.recoveryMessage ? <div className={styles.accountRecoveryNotice}><ShieldAlert aria-hidden="true" /><div><strong>{account.status === "disabled" ? "Account disconnected" : "Reconnect recommended"}</strong><span>{account.recoveryMessage}</span></div></div> : null}
                  <label>Purpose label<div><input value={purposeDrafts[account.accountId] || ""} maxLength={80} disabled={account.status === "disabled"} onChange={(event) => { purposeDirtyRef.current.add(account.accountId); setPurposeDrafts((current) => ({ ...current, [account.accountId]: event.target.value })); }} /><button className={styles.secondaryButton} disabled={Boolean(busy) || account.status === "disabled"} onClick={() => saveAccountPurpose(account.accountId)}>{busy === `purpose-${account.accountId}` ? "Saving..." : "Save purpose"}</button></div></label>
                  <dl>
                    <div><dt>Last successful poll</dt><dd>{account.lastSuccessfulPollAt ? relativeDate(account.lastSuccessfulPollAt) : "Not yet"}</dd></div>
                    <div><dt>Last provider action</dt><dd>{account.lastProviderActionAt ? relativeDate(account.lastProviderActionAt) : "None recorded"}</dd></div>
                    <div><dt>Next background check</dt><dd>{account.nextExpectedCheckAt ? relativeFuture(account.nextExpectedCheckAt) : "After first poll"}</dd></div>
                    <div><dt>Last error</dt><dd className={account.lastError ? styles.freshnessError : ""}>{account.lastError || "None"}</dd></div>
                  </dl>
                  <div className={styles.accountRecoveryActions}>
                    {account.reconnectRecommended ? <button className={styles.primaryButton} disabled={Boolean(busy)} onClick={() => reconnectAccount(account)}><RefreshCw aria-hidden="true" /> {busy === "connect_gmail" || busy === "connect_microsoft" ? "Starting..." : `Reconnect ${account.accountProvider === "microsoft" ? "Hotmail" : "Gmail"}`}</button> : null}
                    {account.status !== "disabled" ? <button className={styles.secondaryButton} disabled={Boolean(busy) || !account.canSyncNow} onClick={() => syncAccount(account.accountId)}><RefreshCw aria-hidden="true" /> {busy === `sync-${account.accountId}` ? "Syncing..." : account.canSyncNow ? "Sync now" : account.reconnectRecommended ? "Reconnect before syncing" : `Available ${account.manualSyncAvailableAt ? relativeFuture(account.manualSyncAvailableAt) : "soon"}`}</button> : null}
                    {account.status !== "disabled" ? <button className={styles.textButton} disabled={Boolean(busy)} onClick={() => setDisconnectTarget((current) => current === account.accountId ? null : account.accountId)}><Unplug aria-hidden="true" /> Disconnect</button> : null}
                  </div>
                  {disconnectTarget === account.accountId ? (
                    <div className={styles.accountDisconnectConfirm} role="group" aria-label={`Disconnect ${account.accountEmail}`}>
                      <div><strong>Disconnect {account.accountLabel}?</strong><span>This removes the stored provider credential and stops polling this account. Downloaded mail, drafts, rules, purpose labels, and activity history stay on this server.</span></div>
                      <div><button className={styles.secondaryButton} disabled={Boolean(busy)} onClick={() => setDisconnectTarget(null)}>Keep connected</button><button className={styles.dangerButton} disabled={Boolean(busy)} onClick={() => disconnectAccount(account)}><Unplug aria-hidden="true" /> {busy === `disconnect-${account.accountId}` ? "Disconnecting..." : "Confirm disconnect"}</button></div>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
            {accountFreshness?.items.length ? <button className={styles.secondaryButton} disabled={Boolean(busy)} onClick={markPurposesReviewed}>{busy === "purpose-review" ? "Saving review..." : "Mark workspace purposes reviewed"}</button> : null}
            <WritingPreferencesPanel accounts={state.accounts.map((account) => ({ id: account.id, label: account.label, email: account.email }))} />
            <div className={styles.addAccount}>
              <h3>Guided account setup</h3>
              <p>Choose a provider, review the requested access, authorize it, check the connection, set its purpose and sync range, then confirm the verified result. Ezra never asks for server settings or a provider password here.</p>
              <ol aria-label="Account setup stages">
                <li>1. Provider</li><li>2. Permissions</li><li>3. Authorization</li><li>4. Connection check</li><li>5. Purpose and sync range</li><li>6. Verified result</li>
              </ol>
              <div className={styles.segmentedControl}><button disabled={Boolean(busy)} className={provider === "gmail" ? styles.segmentActive : ""} onClick={() => chooseProvider("gmail")}>Gmail</button><button disabled={Boolean(busy)} className={provider === "microsoft" ? styles.segmentActive : ""} onClick={() => chooseProvider("microsoft")}>Microsoft</button></div>
              <div className={styles.addAccountForm}><input type="email" placeholder="you@example.com" disabled={Boolean(busy) || Boolean(microsoftChallenge)} value={newAccount} onChange={(event) => setNewAccount(event.target.value)} aria-label={`${provider === "gmail" ? "Gmail" : "Microsoft"} email address`} /><button className={styles.primaryButton} disabled={Boolean(busy) || Boolean(microsoftChallenge) || !newAccount.trim()} onClick={connectAccount}><MailPlus aria-hidden="true" /> {busy === "discover_provider" ? "Preparing..." : busy === "check_provider" ? "Checking connection..." : "Continue to authorization"}</button></div>
              <label>Purpose for this account<input disabled={Boolean(busy) || Boolean(microsoftChallenge)} value={setupPurpose} maxLength={80} placeholder={provider === "gmail" ? "General / Signup / Noise Catcher" : "Professional / Personal / Submissions"} onChange={(event) => setSetupPurpose(event.target.value)} /></label>
              <label>Initial sync range<select disabled={Boolean(busy) || Boolean(microsoftChallenge)} aria-label="Initial sync range" value={setupSyncRangeDays} onChange={(event) => setSetupSyncRangeDays(Number(event.target.value))}><option value={2}>Last 2 days</option><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option></select><small>Ezra limits the first inbox read to this window. You can revise it later from Accounts.</small></label>
              {setupDiscovery ? <small>{setupDiscovery.label} uses {setupDiscovery.authorization === "browser" ? "browser sign-in" : "a device-code sign-in"}. Ezra will request mail access only after you explicitly continue.</small> : null}
              {setupPreflight ? <small>{setupPreflight.message}</small> : null}
              {microsoftChallenge ? (
                <div className={styles.microsoftChallenge}>
                  <p>Connecting {microsoftChallenge.email}</p>
                  <span>Microsoft code</span>
                  <strong>{microsoftChallenge.userCode}</strong>
                  <small>Expires {formatDateTime(microsoftChallenge.expiresAt)}. Sign in with the account above, then click Check connection.</small>
                  <p>If Microsoft chooses another account, choose “Use another account” on its sign-in page. If that option is missing, open the sign-in link in a private or InPrivate window and enter this code. Typing an address here does not switch your Microsoft browser session.</p>
                  <small>Work accounts may require your organization’s approval. Ezra checks the signed-in account before saving the connection.</small>
                  <div>
                    <a className={styles.secondaryButton} href={microsoftChallenge.verificationUriComplete || microsoftChallenge.verificationUri} target="_blank" rel="noreferrer">Open Microsoft sign-in</a>
                    <button className={styles.primaryButton} disabled={checkingMicrosoft} onClick={checkMicrosoftConnection}>
                      {checkingMicrosoft ? "Checking..." : "Check connection"}
                    </button>
                    <button className={styles.textButton} type="button" disabled={checkingMicrosoft} onClick={() => setMicrosoftChallenge(null)}>Back to setup</button>
                  </div>
                </div>
              ) : null}
              {googleChallenge ? (
                <div className={styles.googleChallenge}>
                  <span>Google authorization</span>
                  <strong>{googleChallenge.email}</strong>
                  <small>
                    {googleChallenge.message ||
                      "Open Google sign-in. After approval, copy the final browser URL from the address bar and paste it here."}
                  </small>
                  <div>
                    <a className={styles.secondaryButton} href={googleChallenge.authUrl} target="_blank" rel="noreferrer">Open Google sign-in</a>
                  </div>
                  <label>
                    Final Google redirect URL
                    <textarea
                      value={googleRedirectUrl}
                      onChange={(event) => setGoogleRedirectUrl(event.target.value)}
                      placeholder="Paste the full http://127.0.0.1:4865/oauth2/callback?... URL after Google redirects."
                      rows={3}
                    />
                  </label>
                  <button className={styles.primaryButton} disabled={checkingGoogle || !googleRedirectUrl.trim()} onClick={completeGoogleConnection}>
                    {checkingGoogle ? "Completing..." : "Complete Google connection"}
                  </button>
                  <button className={styles.textButton} type="button" onClick={() => { setGoogleChallenge(null); setGoogleRedirectUrl(""); }}>Back to setup</button>
                </div>
              ) : null}
            </div>
            <SettingsHeader title="Calendar access" description="Enable primary-calendar read and approved event creation per workspace account." icon={CalendarDays} />
            <div className={styles.calendarAccessList}>
              {state.accounts.map((account) => {
                const calendar = calendarAccounts.find((item) => item.accountId === account.id);
                const connected = calendar?.calendarStatus === "connected";
                return (
                  <article key={account.id} className={styles.calendarAccessRow}>
                    <span className={account.provider === "microsoft" ? styles.accountBadgeMicrosoft : styles.accountBadgeGmail}>{account.provider === "microsoft" ? "Hotmail" : "Gmail"}</span>
                    <div>
                      <strong>{account.label}</strong>
                      <CalendarAccessMessage message={calendar?.lastError || (connected ? "Calendar connected for read + approved event creation." : "Calendar permission upgrade needed.")} />
                    </div>
                    <div className={styles.calendarAccessActions}>
                      {!connected ? <button className={styles.secondaryButton} disabled={Boolean(busy)} onClick={() => retryCalendar(account.provider)}><RefreshCw aria-hidden="true" /> Retry check</button> : null}
                      <button className={connected ? styles.secondaryButton : styles.primaryButton} disabled={Boolean(busy)} onClick={() => connectCalendar(account)}>
                        <CalendarDays aria-hidden="true" /> {connected ? "Reconnect calendar" : "Enable calendar"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            <SettingsHeader title="Send access" description="Enable exact-review provider sending per workspace account." icon={Send} />
            <div className={styles.calendarAccessList}>
              {state.accounts.map((account) => {
                const permissionAccount = permissions?.accounts.find((item) => item.accountId === account.id);
                const send = permissionAccount?.features.find((feature) => feature.id === "send");
                const connected = send?.status === "connected";
                return (
                  <article key={account.id} className={styles.calendarAccessRow}>
                    <span className={account.provider === "microsoft" ? styles.accountBadgeMicrosoft : styles.accountBadgeGmail}>{account.provider === "microsoft" ? "Hotmail" : "Gmail"}</span>
                    <div>
                      <strong>{account.label}</strong>
                      <CalendarAccessMessage message={send?.detail || "Send access is checked from provider permissions."} />
                    </div>
                    <button className={connected ? styles.secondaryButton : styles.primaryButton} disabled={Boolean(busy)} onClick={() => connectSend(account)}>
                      <Send aria-hidden="true" /> {account.provider === "microsoft" ? (connected ? "Reconnect replies and Calendar" : "Enable replies and keep Calendar") : (connected ? "Reconnect send" : "Enable send")}
                    </button>
                  </article>
                );
              })}
            </div>
          </>
        ) : null}

        {tab === "permissions" ? (
          <>
            <SettingsHeader title="Provider Permissions Dashboard" description="Per-account mail, calendar, send, token, and sync capability status." icon={KeyRound} />
            {permissions ? (
              <>
                <div className={styles.permissionSummaryGrid}>
                  <div><span>Accounts</span><strong>{permissions.summary.accounts}</strong></div>
                  <div><span>Connected</span><strong>{permissions.summary.connectedAccounts}</strong></div>
                  <div><span>Needs setup</span><strong>{permissions.summary.needsSetup}</strong></div>
                  <div><span>Read-only</span><strong>{permissions.summary.readOnly}</strong></div>
                  <div><span>Errors</span><strong>{permissions.summary.errors}</strong></div>
                </div>
                <div className={styles.permissionsList}>
                  {permissions.accounts.map((account) => (
                    <article className={styles.permissionAccountCard} key={account.accountId}>
                      <header>
                        <span className={account.accountProvider === "microsoft" ? styles.accountBadgeMicrosoft : styles.accountBadgeGmail}>{account.accountProvider === "microsoft" ? "Hotmail" : "Gmail"}</span>
                        <div>
                          <strong>{account.accountLabel}</strong>
                          <small>{account.accountEmail}</small>
                        </div>
                        <span className={permissionStatusClass(account.tokenStatus)}>
                          {permissionStatusLabel(account.tokenStatus)}
                        </span>
                      </header>
                      <p>{account.tokenDetail}</p>
                      <dl className={styles.permissionSyncMeta}>
                        <div><dt>Mail sync</dt><dd>{account.lastMailSyncAt ? relativeDate(account.lastMailSyncAt) : "Not yet"}</dd></div>
                        <div><dt>Calendar sync</dt><dd>{account.lastCalendarSyncAt ? relativeDate(account.lastCalendarSyncAt) : "Not yet"}</dd></div>
                        <div><dt>Reconnect</dt><dd>{account.reconnectRecommended ? "Recommended" : "Not needed"}</dd></div>
                      </dl>
                      {account.lastError ? <div className={styles.permissionError}>{account.lastError}</div> : null}
                      <div className={styles.permissionFeatureGrid}>
                        {account.features.map((feature) => <PermissionFeatureCard key={feature.id} feature={feature} />)}
                      </div>
                    </article>
                  ))}
                  {!permissions.accounts.length ? <div className={styles.tableEmpty}>No connected accounts in this workspace yet.</div> : null}
                </div>
              </>
            ) : (
              <div className={styles.tableEmpty}>Permission status is loading.</div>
            )}
          </>
        ) : null}

        {tab === "rules" ? (
          <>
            <SettingsHeader title="Rules & Learning Manager" description="Review the sender rules, topic preferences, and cleanup automation Ezra has learned in this workspace." icon={SlidersHorizontal} />
            <div className={styles.rulesIntro}><ShieldCheck aria-hidden="true" /><div><strong>Account-scoped by default</strong><p>Gmail learning stays with Gmail, Hotmail learning stays with Hotmail, and All accounts is only an explicit combined review.</p></div></div>
            <div className={styles.ruleSummaryGrid}>
              <div><span>Total rules</span><strong>{ruleCounts.all}</strong></div>
              <div><span>Sender care</span><strong>{ruleCounts.sender}</strong></div>
              <div><span>Topic care</span><strong>{ruleCounts.topic}</strong></div>
              <div><span>Cleanup rules</span><strong>{ruleCounts.cleanup}</strong></div>
              <div><span>Disabled</span><strong>{ruleCounts.disabled}</strong></div>
            </div>
            <div className={styles.ruleFilterBar} aria-label="Filter learned rules">
              {RULE_FILTERS.map((filter) => (
                <button key={filter.id} className={ruleFilter === filter.id ? styles.segmentActive : ""} onClick={() => setRuleFilter(filter.id)}>
                  {filter.label} <span>{ruleCounts[filter.id]}</span>
                </button>
              ))}
            </div>
            <div className={styles.ruleTable}>
              <div className={styles.ruleTableHeader}><span>Learned target</span><span>Workspace scope</span><span>Action</span><span>Evidence</span><span>Controls</span></div>
              {visibleRules.map((rule) => {
                const account = rule.accountId ? accountById.get(rule.accountId) : null;
                return (
                  <div className={!rule.enabled ? `${styles.ruleRow} ${styles.ruleRowDisabled}` : styles.ruleRow} key={`${rule.source}-${rule.id}`}>
                    <span>
                      <strong>{ruleTargetLabel(rule)}</strong>
                      <small>{ruleKindLabel(rule)} · {rule.source === "cleanup" ? "Cleanup automation" : "Care tuning"}</small>
                    </span>
                    <span>
                      <strong>{ruleAccountLabel(rule, account)}</strong>
                      <small>{rule.accountEmail || account?.email || "Needs review"}</small>
                    </span>
                    <span>
                      {rule.action === "unsubscribe" ? (
                        <strong>{ruleActionLabel(rule.action)}</strong>
                      ) : (
                        <select aria-label={`Action for ${ruleTargetLabel(rule)}`} value={rule.action} disabled={busy === `action-${rule.id}`} onChange={(event) => void updateRuleAction(rule, event.target.value)}>
                          {rule.source === "cleanup" ? (
                            <><option value="mark_read">Mark read</option><option value="spam">Spam</option></>
                          ) : (
                            <><option value="interrupt">Care more</option><option value="digest">Useful</option><option value="suppress">Care less</option></>
                          )}
                        </select>
                      )}
                      <small>{rule.enabled ? "Active" : "Paused"}</small>
                    </span>
                    <span>
                      <strong>{rule.evidenceCount} approval{rule.evidenceCount === 1 ? "" : "s"}</strong>
                      <small>Updated {relativeDate(rule.updatedAt)}</small>
                    </span>
                    <span className={styles.ruleControls}>
                      <label className={styles.toggle} title={rule.enabled ? "Disable rule" : "Enable rule"}>
                        <input type="checkbox" checked={rule.enabled} disabled={busy === rule.id} onChange={() => void toggleRule(rule)} />
                        <span />
                      </label>
                      <button className={`${styles.secondaryButton} ${styles.dangerButtonText}`} disabled={busy === `remove-${rule.id}`} onClick={() => void removeRule(rule)}>
                        <Trash2 aria-hidden="true" /> Remove
                      </button>
                    </span>
                  </div>
                );
              })}
              {!rules.length ? <div className={styles.tableEmpty}>No learned rules yet. Ezra will add them only after you approve an action.</div> : null}
              {rules.length > 0 && !visibleRules.length ? <div className={styles.tableEmpty}>No rules match this filter.</div> : null}
            </div>
          </>
        ) : null}

        {tab === "models" ? (
          <>
            <SettingsHeader title="AI models" description="Local models used for triage, analysis, and reply drafting." icon={Bot} />
            <div className={styles.modelList}>
              {state.updates.models.map((model) => (
                <article className={styles.modelRow} key={model.id}>
                  <div><strong>{model.label}</strong><span>{model.baseModel} · {Math.round(model.configuredContext / 1024)}K context</span></div>
                  <span className={model.installed ? styles.installedBadge : styles.missingBadge}>{model.installed ? "Installed" : "Not installed"}</span>
                  {state.activeModel === model.id ? <span className={styles.activeModel}>Active</span> : <button disabled={!model.installed || Boolean(busy)} onClick={() => legacyAction("switch_model", { model: model.id }, `${model.label} is now active.`)}>Use model</button>}
                </article>
              ))}
            </div>
            <button className={styles.secondaryButton} disabled={Boolean(busy)} onClick={() => legacyAction("start_model_benchmark", {}, "Model comparison started.")}><Play aria-hidden="true" /> Run model comparison</button>
          </>
        ) : null}

        {tab === "delivery" ? (
          <>
            <SettingsHeader title="Notification Policy Center" description="Control when Ezra interrupts, digests, or stays quiet." icon={Send} />
            <PwaControls />
            <section aria-label="Browser notifications"><BrowserNotificationControls /></section>
            {notificationPolicy && policyDraft ? (
              <>
                <div className={styles.notificationStatsGrid}>
                  <div><span>Historical interrupts sent</span><strong>{notificationPolicy.stats.interruptsSent}</strong></div>
                  <div><span>Interrupts accepted</span><strong>{notificationPolicy.stats.interruptsAccepted ?? 0}</strong></div>
                  <div><span>Interrupts displayed</span><strong>{notificationPolicy.stats.interruptsDisplayed ?? 0}</strong></div>
                  <div><span>Briefs accepted</span><strong>{notificationPolicy.stats.digestsAccepted ?? 0}</strong></div>
                  <div><span>Briefs displayed</span><strong>{notificationPolicy.stats.digestsDisplayed ?? 0}</strong></div>
                  <div><span>Held/skipped</span><strong>{notificationPolicy.stats.interruptsSkipped}</strong></div>
                  <div><span>Historical digests sent</span><strong>{notificationPolicy.stats.digestsSent}</strong></div>
                  <div><span>Failures</span><strong>{notificationPolicy.stats.interruptsFailed + notificationPolicy.stats.digestsFailed}</strong></div>
                </div>
                <div className={styles.deliveryGrid}>
                  {notificationPolicy.channels.map((channel) => (
                    <section key={channel.id}>
                      <strong>{channel.label}</strong>
                      <span className={channel.status === "needs_setup" ? styles.deliveryNeedsSetup : channel.status === "deferred" ? styles.deliveryDeferred : undefined}>{notificationChannelLabel(channel.status)}</span>
                      <p>{channel.detail}</p>
                      {channel.lastError ? <em>{channel.lastError}</em> : null}
                      {channel.id === "telegram" ? <TelegramNotificationSettings /> : null}
                    </section>
                  ))}
                </div>
                <div className={styles.schedulePanel}>
                  <header>
                    <div>
                      <h3>Schedule and quiet hours</h3>
                      <p>These settings govern shared notifications on explicitly enrolled devices.</p>
                    </div>
                    <button className={styles.primaryButton} disabled={Boolean(busy)} onClick={() => void saveNotificationPolicy()}>{busy === "notification-policy" ? "Saving..." : "Save policy"}</button>
                  </header>
                  <div className={styles.notificationFormGrid}>
                    <label>Timezone<input value={policyDraft.timezone} onChange={(event) => updatePolicyDraft({ timezone: event.target.value })} /></label>
                    <label>Quiet start<input type="time" value={policyDraft.quietStart} onChange={(event) => updatePolicyDraft({ quietStart: event.target.value })} /></label>
                    <label>Quiet end<input type="time" value={policyDraft.quietEnd} onChange={(event) => updatePolicyDraft({ quietEnd: event.target.value })} /></label>
                    <label>Morning digest<input type="time" value={policyDraft.digestTimes[0] || ""} onChange={(event) => updateDigestTime(0, event.target.value)} /></label>
                    <label>Afternoon digest<input type="time" value={policyDraft.digestTimes[1] || ""} onChange={(event) => updateDigestTime(1, event.target.value)} /></label>
                  </div>
                </div>
                <NotificationAttentionControls policy={notificationPolicy} onSaved={saved => setNotificationPolicy(current => current ? { ...current, ...saved } : current)} />
                <div className={styles.notificationPolicyList}>
                  <header><h3>Category preferences</h3><p>Interrupt means Ezra may nudge immediately if the message is fresh and important. Digest holds it for briefs. Quiet suppresses immediate external alerts.</p></header>
                  {notificationPolicy.categoryPolicies.map((policy) => (
                    <article key={policy.id}>
                      <div>
                        <strong>{policy.label}</strong>
                        <p>{policy.description}</p>
                        <small>{policy.quietHoursBypass ? "Critical categories can bypass quiet hours." : `Matches: ${policy.categories.slice(0, 4).join(", ")}`}</small>
                      </div>
                      <select value={policyDraft.categoryPreferences[policy.id] || policy.preference} onChange={(event) => updateCategoryPreference(policy.id, event.target.value as NotificationPreference)}>
                        <option value="interrupt">Interrupt</option>
                        <option value="digest">Digest</option>
                        <option value="quiet">Quiet</option>
                      </select>
                    </article>
                  ))}
                </div>
                <div className={styles.notificationRules}>
                  <h3>Guardrails</h3>
                  <dl>
                    {notificationPolicy.guardrails.map((rule) => <div key={rule.label}><dt>{rule.label}</dt><dd>{rule.detail}</dd></div>)}
                  </dl>
                  <p>
                    In Telegram, use <b>/today</b>, <b>/status</b>, or <b>/help</b>.{
                      notificationPolicy.channels.some((channel) => channel.id === "browser" && channel.status === "available")
                        ? " Browser notification permission is requested only from the explicit control above."
                        : " Browser/app notifications remain disabled until the owner enables the feature."
                    }
                  </p>
                </div>
              </>
            ) : <div className={styles.tableEmpty}>{notificationPolicyError || "Notification policy is loading."}</div>}
          </>
        ) : null}

        {tab === "system" ? (
          <>
            <SettingsHeader title="System" description="Runtime health, verified recovery evidence, and guarded worker controls." icon={Server} />
            <div className={styles.healthGrid}>
              <HealthItem label="Background worker" value={state.health.worker} good={state.health.worker === "running"} icon={Settings2} />
              <HealthItem label="Local AI" value={state.health.ollama ? "Available" : "Unavailable"} good={state.health.ollama} icon={Bot} />
              <HealthItem label="Database" value={recovery ? `${formatBytes(recovery.database.sizeBytes)} · schema ${recovery.database.schemaVersion}` : "Checking"} good={Boolean(recovery?.database.sizeBytes)} icon={Database} />
              <HealthItem label="Web / worker revision" value={revisionLabel(recovery)} good={recovery?.runtime.revisionsMatch === true} icon={ShieldCheck} />
            </div>
            {ownerSecurity ? (
              <section className={styles.ownerSecurityPanel} aria-label="Owner trust and passkeys">
                <header>
                  <div><h3>Trusted devices</h3><p>Enroll once, then use Ezra normally without repeated prompts. Device trust lasts until you revoke it.</p></div>
                  <span className={ownerSecurity.bypassActive ? styles.recoveryWarn : styles.recoveryGood}>{ownerSecurity.bypassActive ? "Bypass still active" : "Owner protection active"}</span>
                </header>
                {!ownerSecurity.currentDeviceId && ownerSecurity.configured ? (
                  <div className={styles.deviceEnrollment}>
                    <label>Device name<input value={deviceName} maxLength={80} placeholder="Office computer" onChange={(event) => setDeviceName(event.target.value)} /></label>
                    <label>Owner password<input type="password" autoComplete="current-password" value={ownerPassword} onChange={(event) => setOwnerPassword(event.target.value)} /></label>
                    <button disabled={Boolean(busy)} onClick={() => void trustThisDevice()}><ShieldCheck aria-hidden="true" /> {busy === "trust_device" ? "Trusting..." : "Trust this device"}</button>
                  </div>
                ) : null}
                {!ownerSecurity.currentDeviceId && !ownerSecurity.configured ? (
                  <div className={styles.deviceEnrollmentIntro}>
                    <strong>Create the administrator credential locally first</strong>
                    <p>From a local administrator terminal, run <code>cd &lt;YOUR_APP_DIRECTORY&gt; &amp;&amp; npm run auth:recover</code>. It hides the password while you type, rotates the authentication secret, and keeps this migration bypass active so you can return here to trust this browser.</p>
                  </div>
                ) : null}
                <div className={styles.deviceList}>
                  {ownerSecurity.devices.filter((device) => !device.revokedAt).map((device) => (
                    <article key={device.id}>
                      <div><strong>{device.label}{device.current ? " · This device" : ""}</strong><small>First used {relativeDate(device.createdAt)} · Last used {relativeDate(device.lastUsedAt)}</small><small>{device.lastUserAgent || "Browser unavailable"} · {device.lastIpAddress || "Network unavailable"} (audit context only)</small></div>
                      <button disabled={Boolean(busy)} onClick={() => void revokeDevice(device)}><Trash2 aria-hidden="true" /> Revoke</button>
                    </article>
                  ))}
                  {!ownerSecurity.devices.some((device) => !device.revokedAt) ? <p>No trusted devices yet.</p> : null}
                </div>
                <div className={styles.passkeyRow}>
                  <div><strong>Owner passkeys</strong><small>{ownerSecurity.passkeys.filter((item) => !item.revokedAt).length ? ownerSecurity.passkeys.filter((item) => !item.revokedAt).map((item) => item.name).join(", ") : "None enrolled yet"}</small><p>Used only to enroll another device, change owner security, view recovery material, or export the complete private archive.</p></div>
                  <button disabled={Boolean(busy) || !ownerSecurity.currentDeviceId} onClick={() => void addOwnerPasskey()}><KeyRound aria-hidden="true" /> {busy === "add_passkey" ? "Waiting..." : "Add passkey"}</button>
                </div>
                {ownerSecurity.currentDeviceId && ownerSecurity.passkeys.some((item) => !item.revokedAt) ? (
                  <div className={styles.passkeyRow}>
                    <div><strong>Private-installation bypass</strong><small>{ownerSecurity.bypassActive ? "Enabled during migration" : "Disabled"}</small><p>This emergency option is owner-controlled. Turning it off does not add prompts to normal use on trusted devices.</p></div>
                    <button disabled={Boolean(busy)} onClick={() => void changeBypassPolicy(!ownerSecurity.bypassActive)}><ShieldCheck aria-hidden="true" /> {ownerSecurity.bypassActive ? "Finish migration" : "Enable emergency bypass"}</button>
                  </div>
                ) : null}
              </section>
            ) : null}
            {recovery ? (
              <section className={styles.recoveryPanel} aria-label="Safe recovery and backup">
                <header>
                  <div><h3>Safe Recovery</h3><p>Evidence from the preserved SQLite data directory. Verification never opens the live database as a backup.</p></div>
                  <span className={recovery.backup.verified ? styles.recoveryGood : styles.recoveryWarn}>{recovery.backup.verified ? "Verified" : "Needs verification"}</span>
                </header>
                <dl>
                  <div><dt>Latest backup</dt><dd>{recovery.backup.latest?.fileName || "Not found"}</dd><small>{recovery.backup.latest ? `${formatBytes(recovery.backup.latest.sizeBytes)} · ${relativeDate(recovery.backup.latest.createdAt)}` : recovery.backup.detail}</small></div>
                  <div><dt>Integrity evidence</dt><dd>{recovery.backup.verifiedAt ? `Passed ${relativeDate(recovery.backup.verifiedAt)}` : "Not recorded"}</dd><small>{recovery.backup.sha256 ? `SHA-256 ${recovery.backup.sha256.slice(0, 16)}…` : recovery.backup.detail}</small></div>
                  <div><dt>Provider polling</dt><dd>{recovery.polling.paused ? "Paused" : "Running"}</dd><small>{recovery.polling.pausedAt ? `Paused ${relativeDate(recovery.polling.pausedAt)} · ${recovery.polling.reason}` : "Gmail, Hotmail, Calendar, and backlog polling are enabled."}</small></div>
                  <div><dt>Worker evidence</dt><dd>{recovery.runtime.workerHealthy ? "Heartbeat current" : "Heartbeat stale"}</dd><small>{recovery.runtime.workerHeartbeatAt ? relativeDate(recovery.runtime.workerHeartbeatAt) : "No worker heartbeat recorded."}</small></div>
                  <div><dt>Managed backup</dt><dd>{recovery.backup.managed?.stale !== false ? "Attention needed" : "Current"}</dd><small>{recovery.backup.managed?.lastCreatedAt ? `${relativeDate(recovery.backup.managed.lastCreatedAt)} · 14 daily / 8 weekly retained` : "No scheduled backup evidence yet."}</small></div>
                  <div><dt>Restore rehearsal</dt><dd>{recovery.backup.rehearsal?.overdue !== false ? "Due" : "Current"}</dd><small>{recovery.backup.rehearsal?.lastCompletedAt ? `Passed ${relativeDate(recovery.backup.rehearsal.lastCompletedAt)} from ${recovery.backup.rehearsal.sourceFile}` : "No monthly rehearsal recorded yet."}</small></div>
                </dl>
              </section>
            ) : <div className={styles.tableEmpty}>Recovery evidence is loading.</div>}
            <div className={styles.systemActions}>
              <button disabled={Boolean(busy)} onClick={() => legacyAction("poll", {}, "Mailbox check complete.")}><RefreshCw aria-hidden="true" /> Check mail now</button>
              <button disabled={Boolean(busy)} onClick={() => legacyAction("sync_accounts", {}, "Accounts synchronized.")}><CloudDownload aria-hidden="true" /> Sync accounts</button>
              {state.backlog.status === "running" ? <button disabled={Boolean(busy)} onClick={() => legacyAction("pause_backlog", {}, "Unread review paused.")}>Pause unread review</button> : <button disabled={Boolean(busy)} onClick={() => legacyAction("start_backlog", {}, "Unread review started.")}>Start unread review</button>}
              <button disabled={Boolean(busy) || !recovery?.backup.latest} onClick={() => void recoveryAction("verify_latest_backup")}><ShieldCheck aria-hidden="true" /> {busy === "verify_latest_backup" ? "Verifying..." : "Verify latest backup"}</button>
              {recovery?.polling.paused
                ? <button disabled={Boolean(busy)} onClick={() => void recoveryAction("resume_polling")}><Play aria-hidden="true" /> Resume provider polling</button>
                : <button disabled={Boolean(busy)} onClick={() => void recoveryAction("pause_polling")}><ShieldAlert aria-hidden="true" /> Emergency pause polling</button>}
              <a className={styles.systemExportLink} href="/api/system/recovery/export"><CloudDownload aria-hidden="true" /> Export safe settings</a>
              <button disabled={Boolean(busy)} onClick={() => legacyAction("check_updates", {}, "Software status refreshed.")}>Check for updates</button>
            </div>
            <OpenSourceNotice />
            <div className={styles.systemMeta}><span>App {state.updates.app.currentVersion}{state.updates.app.commit ? ` · ${state.updates.app.commit}` : ""}</span><span>Last poll {state.health.lastPollAt ? relativeDate(state.health.lastPollAt) : "not yet"}</span><span>Unread review {state.backlog.status} · {state.backlog.discovered} discovered</span></div>
          </>
        ) : null}
      </section>
    </div>
  );
}

function SettingsHeader(props: { title: string; description: string; icon: typeof Bot }) {
  const Icon = props.icon;
  return <header className={styles.settingsHeader}><span><Icon aria-hidden="true" /></span><div><h2>{props.title}</h2><p>{props.description}</p></div></header>;
}

function formatBytes(value: number | null) {
  if (value === null) return "Remote database";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function revisionLabel(recovery: SystemRecoveryStatus | null) {
  if (!recovery) return "Checking";
  if (!recovery.runtime.webRevision || !recovery.runtime.workerRevision) return "Revision evidence incomplete";
  return recovery.runtime.revisionsMatch
    ? `${recovery.runtime.webRevision.slice(0, 8)} · matched`
    : `${recovery.runtime.webRevision.slice(0, 8)} / ${recovery.runtime.workerRevision.slice(0, 8)} mismatch`;
}

function draftFromPolicy(policy: NotificationPolicyPage): NotificationPolicyDraft {
  return {
    timezone: policy.timezone,
    digestTimes: policy.digestTimes.length ? policy.digestTimes : ["08:30", "16:30"],
    quietStart: policy.quietStart,
    quietEnd: policy.quietEnd,
    categoryPreferences: Object.fromEntries(policy.categoryPolicies.map((item) => [item.id, item.preference])),
  };
}

function notificationChannelLabel(status: NotificationPolicyPage["channels"][number]["status"]) {
  if (status === "enabled") return "Enabled";
  if (status === "configured") return "Configured";
  if (status === "available") return "Available";
  if (status === "deferred") return "Deferred";
  return "Needs setup";
}

type RegistrationOptionsJson = Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> & {
  challenge: string;
  user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
  excludeCredentials?: Array<Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }>;
};
type AuthenticationOptionsJson = Omit<PublicKeyCredentialRequestOptions, "challenge" | "allowCredentials"> & {
  challenge: string;
  allowCredentials?: Array<Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }>;
};

function registrationOptions(options: RegistrationOptionsJson): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: decodeBase64Url(options.challenge),
    user: { ...options.user, id: decodeBase64Url(options.user.id) },
    excludeCredentials: options.excludeCredentials?.map((credential) => ({
      ...credential,
      id: decodeBase64Url(credential.id),
    })),
  };
}

function registrationCredentialJson(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = typeof response.getTransports === "function" ? response.getTransports() : [];
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment,
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      attestationObject: encodeBase64Url(response.attestationObject),
      transports,
      publicKeyAlgorithm: typeof response.getPublicKeyAlgorithm === "function" ? response.getPublicKeyAlgorithm() : undefined,
    },
  };
}

function authenticationOptions(options: AuthenticationOptionsJson): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: decodeBase64Url(options.challenge),
    allowCredentials: options.allowCredentials?.map((credential) => ({
      ...credential,
      id: decodeBase64Url(credential.id),
    })),
  };
}

function authenticationCredentialJson(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment,
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      authenticatorData: encodeBase64Url(response.authenticatorData),
      signature: encodeBase64Url(response.signature),
      userHandle: response.userHandle ? encodeBase64Url(response.userHandle) : undefined,
    },
  };
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function PermissionFeatureCard(props: { feature: ProviderPermissionFeature }) {
  return (
    <section className={styles.permissionFeatureCard}>
      <header>
        <strong>{props.feature.label}</strong>
        <span className={permissionStatusClass(props.feature.status)}>{permissionStatusLabel(props.feature.status)}</span>
      </header>
      <p>{props.feature.detail}</p>
      <small>Access: {permissionAccessLabel(props.feature.access)}{props.feature.lastConnectedAt ? ` · connected ${relativeDate(props.feature.lastConnectedAt)}` : ""}</small>
      {props.feature.lastError ? <em>{props.feature.lastError}</em> : null}
    </section>
  );
}

function CalendarAccessMessage(props: { message: string }) {
  const projectId = props.message.match(/project\s+(\d+)/i)?.[1] || null;
  const setupUrl = projectId
    ? `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=${projectId}`
    : null;
  return (
    <small>
      {props.message}
      {setupUrl ? (
        <>
          {" "}
          <a href={setupUrl} target="_blank" rel="noreferrer">
            Open Google Cloud API settings
          </a>
        </>
      ) : null}
    </small>
  );
}

function HealthItem(props: { label: string; value: string; good: boolean; icon: typeof Bot }) {
  const Icon = props.icon;
  return <div className={styles.healthItem}><Icon aria-hidden="true" /><span><strong>{props.label}</strong><small>{props.value}</small></span><i className={props.good ? styles.healthGood : ""} /></div>;
}

function ruleTargetLabel(rule: RuleItem) {
  return rule.target || rule.senderEmail;
}

function ruleKindLabel(rule: RuleItem) {
  if (rule.source === "cleanup") return "Sender cleanup rule";
  return rule.kind === "topic" ? "Topic preference" : "Sender preference";
}

function ruleAccountLabel(rule: RuleItem, account?: DashboardState["accounts"][number] | null) {
  const provider = rule.accountProvider || account?.provider;
  const workspace = provider === "microsoft" ? "Hotmail" : provider === "gmail" ? "Gmail" : "Unassigned";
  const label = rule.accountLabel || account?.label;
  return label ? `${workspace} · ${label}` : workspace;
}

function ruleActionLabel(action: string) {
  return sharedRuleActionLabel(action);
}

function permissionStatusClass(status: ProviderPermissionFeature["status"]) {
  if (status === "connected" || status === "available") return `${styles.permissionPill} ${styles.permissionGood}`;
  if (status === "read_only" || status === "needs_setup") return `${styles.permissionPill} ${styles.permissionWarn}`;
  if (status === "error") return `${styles.permissionPill} ${styles.permissionBad}`;
  return styles.permissionPill;
}

function permissionStatusLabel(status: ProviderPermissionFeature["status"]) {
  if (status === "read_only") return "Read only";
  if (status === "needs_setup") return "Needs setup";
  return humanize(status);
}

function permissionAccessLabel(access: ProviderPermissionFeature["access"]) {
  if (access === "write") return "Read + write";
  if (access === "read") return "Read";
  if (access === "deferred") return "Deferred";
  return "None";
}

function accountPurposeLabel(provider: "gmail" | "microsoft") {
  return provider === "microsoft"
    ? "Professional / Personal / Submissions"
    : "General / Signup / Noise Catcher";
}

function humanize(value: string) { return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function relativeDate(value: string) { const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000)); if (minutes < 60) return `${Math.max(1, minutes)}m ago`; if (minutes < 1_440) return `${Math.round(minutes / 60)}h ago`; return `${Math.round(minutes / 1_440)}d ago`; }
function relativeFuture(value: string) { const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000); if (seconds <= 0) return "now"; if (seconds < 60) return `in ${seconds}s`; if (seconds < 3_600) return `in ${Math.ceil(seconds / 60)}m`; return `in ${Math.ceil(seconds / 3_600)}h`; }
