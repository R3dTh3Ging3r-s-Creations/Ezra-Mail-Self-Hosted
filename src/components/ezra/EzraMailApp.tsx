"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  Clock3,
  FilePenLine,
  Inbox,
  ListChecks,
  LogOut,
  Menu,
  MoreHorizontal,
  RefreshCw,
  Send,
  Settings,
  SunMedium,
} from "lucide-react";
import type { AccountFreshnessPage, ActionCenterTarget, AuthSessionState, BriefMemoryAction, MailActionResult, MailWorkspace, TodayBrief } from "@/lib/email/types";
import { parseNotificationTarget, type NotificationTarget } from "@/lib/email/notification-target";
import { api, post } from "./api";
import { ActionCenterView } from "./ActionCenterView";
import { ActivityTimelineView } from "./ActivityTimelineView";
import { DraftsView } from "./DraftsView";
import { ForegroundNotificationListener } from "./ForegroundNotificationListener";
import { CalendarView } from "./CalendarView";
import { calendarDrilldownFromParams, isCalendarDrilldownTarget, type CalendarDrilldownRequest } from "./calendarViewState";
import type { CalendarDrilldownTarget } from "@/lib/email/types";
import { LoginScreen } from "./LoginScreen";
import { summarizeMailActionResult, type MailActionSummary } from "./mailActionSummary";
import { MailView } from "./MailView";
import { OutboxView } from "./OutboxView";
import { SettingsView } from "./SettingsView";
import { TodayView } from "./TodayView";
import { EZRA_MAIL_PRODUCT_VERSION } from "./version";
import { directShortcutCommand, isEditableShortcutTarget, navigationShortcut } from "./shortcuts";
import { isAbortError, useLatestRequest } from "./useLatestRequest";
import styles from "./EzraMail.module.css";

type View = "today" | "mail" | "calendar" | "drafts" | "outbox" | "actions" | "activity" | "settings";
type MailMeta = { workspaces: MailWorkspace[] };
type MailDrilldown = Record<string, string | number | boolean | string[] | null | undefined>;

const NAV_ITEMS = [
  { id: "today" as const, label: "Today", icon: SunMedium },
  { id: "mail" as const, label: "Mail", icon: Inbox },
  { id: "calendar" as const, label: "Calendar", icon: CalendarDays },
  { id: "drafts" as const, label: "Drafts", icon: FilePenLine },
  { id: "outbox" as const, label: "Outbox", icon: Send },
  { id: "actions" as const, label: "Actions", icon: ListChecks },
  { id: "activity" as const, label: "Activity", icon: Clock3 },
];
const MAIL_DRILLDOWN_PARAMS = ["folder", "date", "priority", "category", "account", "inboxCategory", "unread", "attachments", "handled", "needsReply", "hasDeadline", "q", "messageId", "todaySection"];
const MOBILE_NAV_ITEMS = NAV_ITEMS.filter((item) => ["today", "mail", "calendar", "actions"].includes(item.id));
const MOBILE_MORE_ITEMS = NAV_ITEMS.filter((item) => ["drafts", "outbox", "activity"].includes(item.id));

export function EzraMailApp() {
  const [session, setSession] = useState<AuthSessionState | null>(null);
  const [view, setView] = useState<View>("today");
  const [workspaces, setWorkspaces] = useState<MailWorkspace[]>([]);
  const [accountFreshness, setAccountFreshness] = useState<AccountFreshnessPage | null>(null);
  const [exactMailTarget, setExactMailTarget] = useState(readExactMailLocation);
  const [workspaceMetaLoaded, setWorkspaceMetaLoaded] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(() => {
    const target = readExactMailLocation();
    if (target && target !== "invalid") return target.workspaceId;
    if (typeof window === "undefined") return "workspace:gmail";
    try { return localStorage.getItem("ezra-mail-workspace") || "workspace:gmail"; } catch { return "workspace:gmail"; }
  });
  const workspaceIdRef = useRef(workspaceId);
  const [today, setToday] = useState<TodayBrief | null>(null);
  const [todayLoading, setTodayLoading] = useState(true);
  const [todayRefreshing, setTodayRefreshing] = useState(false);
  const [todayError, setTodayError] = useState("");
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [selectedOutboxDraftId, setSelectedOutboxDraftId] = useState<string | null>(null);
  const [calendarTarget, setCalendarTarget] = useState<CalendarDrilldownRequest | null>(null);
  const calendarRequestKey = useRef(0);
  const calendarWorkspace = useRef(workspaceId);
  const [toast, setToast] = useState<{ summary: MailActionSummary; action?: MailActionResult } | null>(null);
  const [toastExpanded, setToastExpanded] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const pendingGo = useRef<number | null>(null);
  const historyIndex = useRef(0);
  const restoringHistory = useRef(false);
  const beginTodayRequest = useLatestRequest();
  const beginMetaRequest = useLatestRequest();

  const loadSession = useCallback(async () => {
    try {
      setSession(await api<AuthSessionState>("/api/auth/session"));
    } catch {
      setSession({ authenticated: false, configured: true, developmentBypass: false, expiresAt: null });
    }
  }, []);

  const loadToday = useCallback(async (options?: { quiet?: boolean }) => {
    const quiet = Boolean(options?.quiet);
    const request = beginTodayRequest();
    if (quiet) setTodayRefreshing(true);
    else {
      setTodayLoading(true);
      setTodayError("");
    }
    try {
      const params = new URLSearchParams({ workspaceId });
      const next = await api<TodayBrief>(`/api/today?${params.toString()}`, { signal: request.signal });
      if (!request.isLatest()) return;
      setToday(next);
      setLastRefreshAt(new Date().toISOString());
    } catch (error) {
      if (!quiet && request.isLatest() && !isAbortError(error)) setTodayError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request.isLatest()) {
        if (quiet) setTodayRefreshing(false);
        else setTodayLoading(false);
      }
    }
  }, [beginTodayRequest, workspaceId]);

  const refreshDailyBrief = useCallback(async (options: {
    quiet?: boolean;
    sourceWorkspaceId?: string;
  } = {}) => {
    if (options.sourceWorkspaceId && workspaceIdRef.current !== options.sourceWorkspaceId) return;
    await loadToday({ quiet: options.quiet ?? true });
  }, [loadToday]);

  const loadWorkspaceMeta = useCallback(async () => {
    const request = beginMetaRequest();
    try {
      const [meta, freshness] = await Promise.all([
        api<MailMeta>("/api/mail/meta", { signal: request.signal }),
        api<AccountFreshnessPage>("/api/accounts", { signal: request.signal }).catch((error) => isAbortError(error) ? null : null),
      ]);
      if (!request.isLatest()) return;
      setWorkspaces(meta.workspaces || []);
      setAccountFreshness(freshness);
      setWorkspaceMetaLoaded(true);
    } catch (error) {
      if (request.isLatest() && !isAbortError(error)) { setWorkspaces([]); setWorkspaceMetaLoaded(true); }
    }
  }, [beginMetaRequest]);

  useEffect(() => {
    const existingIndex = Number(window.history.state?.ezraIndex);
    historyIndex.current = Number.isFinite(existingIndex) ? existingIndex : 0;
    if (!Number.isFinite(existingIndex)) {
      window.history.replaceState({ ...(window.history.state || {}), ezraIndex: historyIndex.current }, "", window.location.href);
    }
    void loadSession();
    const params = new URLSearchParams(window.location.search);
    const requestedView = params.get("view");
    if (requestedView === "mail" || requestedView === "calendar" || requestedView === "drafts" || requestedView === "outbox" || requestedView === "actions" || requestedView === "activity" || requestedView === "settings") {
      setView(requestedView);
    }
    setSelectedMessageId(params.get("message"));
    setSelectedOutboxDraftId(params.get("draft"));
    const target = calendarDrilldownFromParams(params);
    setCalendarTarget(target ? { ...target, requestKey: ++calendarRequestKey.current } : null);
  }, [loadSession]);

  useEffect(() => {
    if (session?.authenticated) void loadToday();
  }, [loadToday, session?.authenticated]);

  useEffect(() => {
    if (session?.authenticated) void loadWorkspaceMeta();
  }, [loadWorkspaceMeta, session?.authenticated]);

  useEffect(() => {
    if (!session?.authenticated) return undefined;
    const refresh = () => {
      if (document.hidden) return;
      void refreshDailyBrief({ quiet: true, sourceWorkspaceId: workspaceIdRef.current });
      void loadWorkspaceMeta();
      window.dispatchEvent(new Event("ezra:refresh"));
    };
    const timer = window.setInterval(() => {
      refresh();
    }, 60_000);
    const onVisibility = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadWorkspaceMeta, refreshDailyBrief, session?.authenticated]);

  useEffect(() => {
    const restoreLocation = (event: PopStateEvent) => {
      const targetIndex = Number(event.state?.ezraIndex);
      if (restoringHistory.current) {
        restoringHistory.current = false;
      } else if (!window.dispatchEvent(new Event("ezra:before-navigate", { cancelable: true }))) {
        const delta = historyIndex.current - (Number.isFinite(targetIndex) ? targetIndex : historyIndex.current);
        if (delta) {
          restoringHistory.current = true;
          window.history.go(delta);
        }
        return;
      }
      if (Number.isFinite(targetIndex)) historyIndex.current = targetIndex;
      const params = new URLSearchParams(window.location.search);
      const exact = readExactMailLocation();
      setExactMailTarget(exact);
      if (exact && exact !== "invalid") { workspaceIdRef.current = exact.workspaceId; setWorkspaceId(exact.workspaceId); }
      setView(viewFromParams(params));
      setSelectedMessageId(params.get("message"));
      setSelectedOutboxDraftId(params.get("draft"));
      const target = calendarDrilldownFromParams(params);
      setCalendarTarget(target ? { ...target, requestKey: ++calendarRequestKey.current } : null);
      setMobileMoreOpen(false);
    };
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, []);

  useEffect(() => {
    workspaceIdRef.current = workspaceId;
    try { localStorage.setItem("ezra-mail-workspace", workspaceId); } catch {}
    if (calendarWorkspace.current !== workspaceId) {
      calendarWorkspace.current = workspaceId;
      clearCalendarTarget();
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaces.length || exactMailTarget) return;
    const current = workspaces.find((workspace) => workspace.id === workspaceId);
    if (current && (current.isAllAccounts || current.accountIds.length)) return;
    const gmail = workspaces.find((workspace) => workspace.id === "workspace:gmail");
    const fallbackId = gmail?.id || workspaces[0].id;
    workspaceIdRef.current = fallbackId;
    setWorkspaceId(fallbackId);
  }, [workspaceId, workspaces, exactMailTarget]);

  function navigate(nextView: View, messageId: string | null = null, target?: CalendarDrilldownTarget, exactWorkspace?: string) {
    if (!window.dispatchEvent(new Event("ezra:before-navigate", { cancelable: true }))) return;
    if (exactWorkspace) { workspaceIdRef.current = exactWorkspace; setWorkspaceId(exactWorkspace); }
    setMobileMoreOpen(false);
    setView(nextView);
    setSelectedMessageId(messageId);
    setSelectedOutboxDraftId(null);
    setCalendarTarget(target ? { ...target, requestKey: ++calendarRequestKey.current } : null);
    const params = exactWorkspace ? new URLSearchParams() : new URLSearchParams(window.location.search);
    params.set("view", nextView);
    params.delete("workspace");
    if (messageId && workspaceIdRef.current.startsWith("workspace:account:")) params.set("workspace", workspaceIdRef.current);
    params.delete("drill");
    params.delete("draft");
    params.delete("event");
    for (const key of MAIL_DRILLDOWN_PARAMS) params.delete(key);
    if (messageId) params.set("message", messageId);
    else params.delete("message");
    params.delete("viewId");
    params.delete("searchMode");
    if (target) { params.set("event", target.eventId); params.set("date", target.date); }
    historyIndex.current = pushLocation(params);
    setExactMailTarget(readExactMailLocation());
  }

  function clearCalendarTarget() {
    setCalendarTarget(null);
    const params = new URLSearchParams(window.location.search);
    if (!params.has("event")) return;
    params.delete("event");
    if (params.get("view") === "calendar") params.delete("date");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const editable = isEditableShortcutTarget(event.target);
      if (event.key === "Escape") {
        if (shortcutHelpOpen) {
          event.preventDefault();
          setShortcutHelpOpen(false);
          return;
        }
        if (mobileMoreOpen) {
          event.preventDefault();
          setMobileMoreOpen(false);
          return;
        }
      }
      if (editable || document.querySelector("[aria-modal='true']")) return;
      if (pendingGo.current !== null) {
        window.clearTimeout(pendingGo.current);
        pendingGo.current = null;
        const destination = navigationShortcut(event.key);
        if (destination) {
          event.preventDefault();
          navigate(destination);
        }
        return;
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        pendingGo.current = window.setTimeout(() => { pendingGo.current = null; }, 1_000);
        return;
      }
      const command = directShortcutCommand(event);
      if (!command) return;
      if (command === "help") {
        event.preventDefault();
        setShortcutHelpOpen(true);
        return;
      }
      if (command === "search") {
        event.preventDefault();
        if (view !== "mail") navigate("mail");
        window.setTimeout(() => window.dispatchEvent(new Event("ezra:focus-mail-search")), 0);
        return;
      }
      if (view !== "mail") return;
      event.preventDefault();
      window.dispatchEvent(new CustomEvent("ezra:mail-command", { detail: { command } }));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (pendingGo.current !== null) window.clearTimeout(pendingGo.current);
    };
  }, [mobileMoreOpen, shortcutHelpOpen, view]);

  function openMailDrilldown(filters: MailDrilldown) {
    clearCalendarTarget();
    setView("mail");
    setSelectedMessageId(null);
    const params = new URLSearchParams(window.location.search);
    params.set("view", "mail");
    params.set("drill", "1");
    params.delete("workspace");
    setExactMailTarget(null);
    params.delete("message");
    for (const key of MAIL_DRILLDOWN_PARAMS) params.delete(key);
    params.delete("viewId");
    params.delete("searchMode");
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === "" || value === false) continue;
      if (Array.isArray(value)) {
        for (const item of value) params.append(key === "messageIds" ? "messageId" : key, item);
      } else {
        params.set(key, String(value));
      }
    }
    historyIndex.current = pushLocation(params);
  }

  function selectMailMessage(messageId: string | null) {
    clearCalendarTarget();
    setView("mail");
    setSelectedMessageId(messageId);
    const params = new URLSearchParams(window.location.search);
    params.set("view", "mail");
    if (messageId) params.set("message", messageId);
    else params.delete("message");
    params.delete("workspace");
    if (messageId && workspaceIdRef.current.startsWith("workspace:account:")) params.set("workspace", workspaceIdRef.current);
    historyIndex.current = pushLocation(params);
    setExactMailTarget(readExactMailLocation());
  }

  function openOutboxDraft(draftId?: string | null) {
    clearCalendarTarget();
    setView("outbox");
    setSelectedMessageId(null);
    setSelectedOutboxDraftId(draftId || null);
    const params = new URLSearchParams(window.location.search);
    params.set("view", "outbox");
    params.delete("workspace");
    setExactMailTarget(null);
    params.delete("message");
    params.delete("drill");
    for (const key of MAIL_DRILLDOWN_PARAMS) params.delete(key);
    if (draftId) params.set("draft", draftId);
    else params.delete("draft");
    historyIndex.current = pushLocation(params);
  }

  function openActionCenterTarget(target: ActionCenterTarget) {
    if (target.view === "calendar" && isCalendarDrilldownTarget(target)) {
      navigate("calendar", null, target);
      return;
    }
    if (target.view === "mail") {
      navigate("mail", target.messageId);
      return;
    }
    if (target.view === "today" && target.messageId) {
      navigate("mail", target.messageId);
      return;
    }
    if (target.view === "outbox") {
      openOutboxDraft(target.draftId);
      return;
    }
    navigate(target.view === "today" ? "today" : target.view);
  }

  async function runAction(action: string, messageIds: string[], label?: string, payload: Record<string, unknown> = {}) {
    const actionWorkspaceId = workspaceId;
    const result = await post<MailActionResult>("/api/mail/actions", { action, messageIds, ...payload });
    setToastExpanded(false);
    setToast({ summary: summarizeMailActionResult(result, label), action: result.reversible ? result : undefined });
    if (result.successCount > 0 && ["done", "mark_read", "delete", "delete_and_teach", "spam", "quiet"].includes(action)) {
      const settled = new Set([...(result.changedIds || []), ...(result.unchangedIds || [])]);
      if (settled.size) {
        setToday((current) => current ? withTopicsRemoved(current, settled) : current);
      }
    }
    if (result.successCount > 0) {
      await refreshDailyBrief({ quiet: true, sourceWorkspaceId: actionWorkspaceId });
    }
    return result;
  }

  async function runBriefAction(itemId: string, action: BriefMemoryAction) {
    const actionWorkspaceId = workspaceId;
    await post("/api/today/items", {
      workspaceId: actionWorkspaceId,
      itemId,
      action,
    });
    await refreshDailyBrief({ quiet: true, sourceWorkspaceId: actionWorkspaceId });
  }

  async function undo(actionId: string) {
    const actionWorkspaceId = workspaceId;
    const result = await post<MailActionResult>("/api/mail/actions", { action: "undo", actionId });
    setToastExpanded(false);
    setToast({ summary: summarizeMailActionResult(result, result.failureCount ? undefined : "Action undone.") });
    if (result.successCount > 0) {
      await refreshDailyBrief({ quiet: true, sourceWorkspaceId: actionWorkspaceId });
    }
  }

  async function signOut() {
    if (session?.trustedDevice && !window.confirm(
      `Forget ${session.trustedDevice.label}? This browser will need the owner password or a passkey before it can be trusted again.`,
    )) return;
    await post("/api/auth/logout", {});
    await loadSession();
  }

  function selectWorkspace(id: string) {
    if (!window.dispatchEvent(new Event("ezra:before-navigate", { cancelable: true }))) return;
    const target = workspaces.find((workspace) => workspace.id === id);
    if (target && !target.isAllAccounts && !target.accountIds.length) return;
    workspaceIdRef.current = id;
    setWorkspaceId(id);
    setSelectedMessageId(null);
    setSelectedOutboxDraftId(null);
    setExactMailTarget(null);
    const params = new URLSearchParams(window.location.search);
    params.delete("workspace"); params.delete("message"); params.delete("drill");
    for (const key of MAIL_DRILLDOWN_PARAMS) params.delete(key);
    historyIndex.current = pushLocation(params);
    void loadWorkspaceMeta();
  }

  function openForegroundNotification(target: NotificationTarget) {
    if (target.view === "today") navigate("today");
    else navigate("mail", target.messageId, undefined, target.workspaceId);
  }

  function stopForegroundNotificationsForAuthentication() {
    void loadSession();
  }

  if (!session) return <div className={styles.bootState}>Opening Ezra Mail...</div>;
  if (!session.authenticated) {
    return <LoginScreen configured={session.configured} onAuthenticated={loadSession} />;
  }
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === workspaceId) ||
    (!exactMailTarget ? workspaces.find((workspace) => workspace.id === "workspace:gmail") : null) ||
    null;
  const exactTargetAvailable = !exactMailTarget || (exactMailTarget !== "invalid"
    && selectedWorkspace?.id === exactMailTarget.workspaceId
    && selectedWorkspace.provider === exactMailTarget.provider
    && selectedWorkspace.accountIds.length === 1 && selectedWorkspace.accountIds[0] === exactMailTarget.accountId
    && accountFreshness?.items.some((account) => account.accountId === exactMailTarget.accountId && account.accountProvider === exactMailTarget.provider && account.status === "connected"));
  const selectedFreshness = accountFreshness?.items.filter((account) => selectedWorkspace?.accountIds.includes(account.accountId)) || [];

  return (
    <div className={styles.appShell}>
      <ForegroundNotificationListener
        onOpen={openForegroundNotification}
        onAuthenticationFailure={stopForegroundNotificationsForAuthentication}
      />
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <img src="/branding/ezra-mail-logo-d4-120.png" alt="" aria-hidden="true" />
          </span>
          <div>
            <strong className={styles.brandTitle}>Ezra Mail <em className={styles.versionBadge}>v{EZRA_MAIL_PRODUCT_VERSION}</em></strong>
            <span>Private mail intelligence</span>
          </div>
        </div>
        <nav className={styles.primaryNav} aria-label="Primary">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={view === item.id ? styles.navActive : styles.navButton}
                onClick={() => navigate(item.id)}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
                {item.id === "drafts" && today?.counts.reply ? <b>{today.counts.reply}</b> : null}
              </button>
            );
          })}
        </nav>
        <div className={styles.sidebarFooter}>
          <button className={view === "settings" ? styles.navActive : styles.navButton} onClick={() => navigate("settings")}>
            <Settings aria-hidden="true" /><span>Settings</span>
          </button>
          <button className={styles.navButton} onClick={signOut}>
            <LogOut aria-hidden="true" /><span>{session.trustedDevice ? "Forget this device" : "Sign out"}</span>
          </button>
        </div>
      </aside>

      <main className={styles.workspace}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.eyebrow}>{view === "settings" ? "Workspace administration" : "Your mail, considered"}</p>
            <h1>{view === "today" ? "Today" : view === "mail" ? "Mail" : view === "calendar" ? "Calendar" : view === "drafts" ? "Drafts" : view === "outbox" ? "Outbox" : view === "actions" ? "Action Center" : view === "activity" ? "Activity" : "Settings"}</h1>
            <p className={styles.refreshStatus}>{lastRefreshAt ? `Last checked ${relativeTime(lastRefreshAt)}` : "Checking mail status..."}</p>
          </div>
          <div className={styles.topbarActions}>
            <div className={styles.releaseBadge} aria-label={`Ezra Mail version ${EZRA_MAIL_PRODUCT_VERSION}`}>
              <span>Ezra Mail</span>
              <strong>v{EZRA_MAIL_PRODUCT_VERSION}</strong>
            </div>
            {workspaces.length ? (
              <div className={styles.workspaceSelector} role="group" aria-label="Account workspace">
                {workspaces.map((workspace) => {
                  const disabled = !workspace.isAllAccounts && !workspace.accountIds.length;
                  return (
                    <button
                      key={workspace.id}
                      className={workspace.id === workspaceId ? styles.workspaceActive : ""}
                      disabled={disabled}
                      title={disabled ? `${workspace.label} is not connected yet.` : workspace.purpose}
                      onClick={() => selectWorkspace(workspace.id)}
                    >
                      <strong>{workspace.label}</strong>
                      <span>{workspace.isAllAccounts ? "Explicit blend" : workspace.purpose}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {selectedFreshness.length ? (
              <div className={styles.globalFreshness} title={selectedFreshness.map((account) => `${account.accountLabel}: ${(account.issues || []).filter((issue) => issue.status !== "ok").map((issue) => `${issue.feature}: ${issue.message}`).join("; ") || account.lastError || (account.lastSuccessfulPollAt ? `mail polled ${relativeTime(account.lastSuccessfulPollAt)}` : "mail not polled yet")}`).join("\n")}>
                <Clock3 aria-hidden="true" />
                <span>{freshnessLabel(selectedFreshness)}</span>
              </div>
            ) : null}
            <button
              className={`${styles.iconButton} ${todayRefreshing || todayLoading ? styles.refreshButtonActive : ""}`}
              aria-busy={todayRefreshing || todayLoading}
              onClick={() => {
                void loadWorkspaceMeta();
                void refreshDailyBrief({
                  quiet: Boolean(today),
                  sourceWorkspaceId: workspaceIdRef.current,
                });
                if (view !== "today") window.dispatchEvent(new Event("ezra:refresh"));
              }}
              title="Refresh"
            >
              <RefreshCw aria-hidden="true" /><span className={styles.srOnly}>Refresh</span>
            </button>
          </div>
        </header>

        {view === "today" ? (
          <TodayView
            data={today}
            loading={todayLoading}
            refreshing={todayRefreshing || (todayLoading && Boolean(today))}
            error={todayError}
            onOpen={(id) => navigate("mail", id)}
            onOpenMail={openMailDrilldown}
            onAction={runAction}
            onRefresh={loadToday}
            onOpenTarget={openActionCenterTarget}
            onBriefAction={runBriefAction}
          />
        ) : null}
        {view === "mail" && exactMailTarget && !workspaceMetaLoaded ? <p role="status">Checking this notification target...</p> : null}
        {view === "mail" && exactMailTarget && workspaceMetaLoaded && !exactTargetAvailable ? <p role="status">This notification target is unavailable. Its account may be disconnected or no longer available.</p> : null}
        {view === "mail" && (!exactMailTarget || (workspaceMetaLoaded && exactTargetAvailable)) ? (
          <MailView
            key={workspaceId}
            initialMessageId={selectedMessageId}
            workspaceId={workspaceId}
            workspace={selectedWorkspace}
            onSelectWorkspace={selectWorkspace}
            onSelectedMessage={selectMailMessage}
            onAction={runAction}
            onMailStateChanged={() => void refreshDailyBrief({ quiet: true, sourceWorkspaceId: workspaceId })}
            onOpenOutbox={openOutboxDraft}
          />
        ) : null}
        {view === "calendar" ? (
          <CalendarView
            target={calendarTarget}
            onClearTarget={clearCalendarTarget}
            workspaceId={workspaceId}
            workspace={selectedWorkspace}
            onOpenSettings={() => navigate("settings")}
            onDailyBriefChanged={(sourceWorkspaceId) => refreshDailyBrief({ quiet: true, sourceWorkspaceId })}
          />
        ) : null}
        {view === "drafts" ? (
          <DraftsView
            workspaceId={workspaceId}
            workspace={selectedWorkspace}
            onOpenMessage={(id) => navigate("mail", id)}
            onOpenOutbox={openOutboxDraft}
          />
        ) : null}
        {view === "outbox" ? <OutboxView workspaceId={workspaceId} initialDraftId={selectedOutboxDraftId} /> : null}
        {view === "actions" ? <ActionCenterView workspaceId={workspaceId} onOpenTarget={openActionCenterTarget} /> : null}
        {view === "activity" ? <ActivityTimelineView workspaceId={workspaceId} onOpenTarget={openActionCenterTarget} /> : null}
        {view === "settings" ? <SettingsView workspaceId={workspaceId} onAccountsChanged={loadWorkspaceMeta} onDailyBriefChanged={(sourceWorkspaceId) => refreshDailyBrief({ quiet: true, sourceWorkspaceId })} onOpenView={(target) => navigate(target)} /> : null}
      </main>

      <nav className={styles.mobileNav} aria-label="Primary mobile navigation">
        {MOBILE_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} className={view === item.id ? styles.mobileNavActive : ""} onClick={() => navigate(item.id)}>
              <Icon aria-hidden="true" /><span>{item.label}</span>
            </button>
          );
        })}
        <button className={mobileMoreOpen || ["drafts", "outbox", "activity", "settings"].includes(view) ? styles.mobileNavActive : ""} onClick={() => setMobileMoreOpen(true)}>
          <MoreHorizontal aria-hidden="true" /><span>More</span>
        </button>
      </nav>

      {mobileMoreOpen ? (
        <div className={styles.mobileSheetBackdrop} role="presentation" onMouseDown={() => setMobileMoreOpen(false)}>
          <section className={styles.mobileSheet} role="dialog" aria-modal="true" aria-labelledby="mobile-more-heading" onMouseDown={(event) => event.stopPropagation()}>
            <header><h2 id="mobile-more-heading">More</h2><button onClick={() => setMobileMoreOpen(false)} aria-label="Close More menu">x</button></header>
            {[...MOBILE_MORE_ITEMS, { id: "settings" as const, label: "Settings", icon: Settings }].map((item) => {
              const Icon = item.icon;
              return <button key={item.id} onClick={() => navigate(item.id)}><Icon aria-hidden="true" /><span>{item.label}</span></button>;
            })}
          </section>
        </div>
      ) : null}

      {shortcutHelpOpen ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => setShortcutHelpOpen(false)}>
          <section className={`${styles.confirmDialog} ${styles.shortcutDialog}`} role="dialog" aria-modal="true" aria-labelledby="shortcut-help-heading" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className={styles.dialogEyebrow}>Keyboard navigation</span><h2 id="shortcut-help-heading">Ezra Mail shortcuts</h2></div><button className={styles.iconButtonSmall} onClick={() => setShortcutHelpOpen(false)} aria-label="Close shortcut help">x</button></header>
            <dl className={styles.shortcutGrid}>
              <div><dt><kbd>?</kbd></dt><dd>Shortcut help</dd></div><div><dt><kbd>/</kbd></dt><dd>Search Mail</dd></div>
              <div><dt><kbd>g</kbd> then <kbd>t/m/c/d/o/a/l/s</kbd></dt><dd>Go to a workspace</dd></div><div><dt><kbd>j</kbd> / <kbd>k</kbd></dt><dd>Next / previous mail</dd></div>
              <div><dt><kbd>Enter</kbd></dt><dd>Open selected mail</dd></div><div><dt><kbd>e</kbd></dt><dd>Acknowledge</dd></div>
              <div><dt><kbd>+</kbd> / <kbd>-</kbd></dt><dd>Care more / less</dd></div><div><dt><kbd>#</kbd></dt><dd>Move to Trash with Undo</dd></div>
              <div><dt><kbd>Esc</kbd></dt><dd>Close or clear</dd></div>
            </dl>
          </section>
        </div>
      ) : null}

      {toast ? (
        <div className={`${styles.toast} ${styles[`toast${capitalize(toast.summary.variant)}`] || ""}`} role={toast.summary.variant === "error" || toast.summary.variant === "partial" ? "alert" : "status"}>
          <div className={styles.toastBody}>
            <span>{toast.summary.headline}</span>
            {toast.summary.hasDetails ? (
              <button type="button" onClick={() => setToastExpanded((current) => !current)}>
                {toastExpanded ? "Hide details" : "Details"}
              </button>
            ) : null}
            {toastExpanded ? (
              <div className={styles.toastDetail}>
                {toast.summary.detailLines.map((line) => <p key={line}>{line}</p>)}
                {toast.summary.retryGuidance ? <p><strong>Retry:</strong> {toast.summary.retryGuidance}</p> : null}
              </div>
            ) : null}
          </div>
          {toast.action ? <button onClick={() => undo(toast.action!.actionId)}>Undo</button> : null}
          <button className={styles.toastClose} onClick={() => setToast(null)} aria-label="Dismiss notification">x</button>
        </div>
      ) : null}
    </div>
  );
}

function viewFromParams(params: URLSearchParams): View {
  const requested = params.get("view");
  return requested === "mail" || requested === "calendar" || requested === "drafts" || requested === "outbox"
    || requested === "actions" || requested === "activity" || requested === "settings"
    ? requested
    : "today";
}

function pushLocation(params: URLSearchParams) {
  const next = `${window.location.pathname}?${params.toString()}`;
  const current = `${window.location.pathname}${window.location.search}`;
  const currentIndex = Number(window.history.state?.ezraIndex);
  const index = Number.isFinite(currentIndex) ? currentIndex : 0;
  if (next === current) return index;
  const nextIndex = index + 1;
  window.history.pushState({ ...(window.history.state || {}), ezraIndex: nextIndex }, "", next);
  return nextIndex;
}

function withTopicsRemoved(brief: TodayBrief, removed: Set<string>): TodayBrief {
  const topics = brief.topics.filter((topic) => !removed.has(topic.id));
  if (topics.length === brief.topics.length) return brief;
  return {
    ...brief,
    topics,
    counts: {
      action: topics.filter((topic) => topic.kind === "action").length,
      reply: topics.filter((topic) => topic.kind === "reply").length,
      deadline: topics.filter((topic) => topic.kind === "deadline").length,
      fyi: topics.filter((topic) => topic.kind === "fyi").length,
    },
  };
}

function relativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function oldestTimestamp(values: Array<string | null>) {
  return values.filter(Boolean).sort((left, right) => new Date(left!).getTime() - new Date(right!).getTime())[0] || new Date().toISOString();
}

function freshnessLabel(accounts: AccountFreshnessPage["items"]) {
  if (accounts.some((account) => (account.issues || []).some((issue) => issue.feature === "mail" && issue.status !== "ok"))) return "Mail needs attention";
  if (accounts.some((account) => (account.issues || []).some((issue) => issue.feature === "calendar" && issue.status !== "ok"))) return "Mail current · Calendar setup needed";
  if (accounts.some((account) => !(account.issues || []).length && account.lastError)) return "Account needs attention";
  if (accounts.every((account) => account.lastSuccessfulPollAt)) return `Fresh · ${relativeTime(oldestTimestamp(accounts.map((account) => account.lastSuccessfulPollAt)))}`;
  return "Waiting for first sync";
}

function capitalize(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function readExactMailLocation(): Extract<NotificationTarget, { view: "mail" }> | "invalid" | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") !== "mail" || !params.has("workspace")) return null;
  const coreKeys = ["view", "workspace", "message"];
  const allowed = new Set([...coreKeys, ...MAIL_DRILLDOWN_PARAMS, "drill", "viewId", "searchMode"]);
  if (window.location.pathname !== "/" || window.location.hash || coreKeys.some((key) => params.getAll(key).length !== 1) || [...params.keys()].some((key) => !allowed.has(key))) return "invalid";
  try { if (/[\\\x00-\x1f\x7f]/.test(decodeURIComponent(window.location.search))) return "invalid"; } catch { return "invalid"; }
  const core = new URLSearchParams(coreKeys.map((key) => [key, params.get(key)!]));
  const target = parseNotificationTarget(`/?${core.toString()}`);
  return target?.view === "mail" ? target : "invalid";
}
