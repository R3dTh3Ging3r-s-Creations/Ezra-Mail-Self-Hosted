"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Filter,
  Inbox,
  LoaderCircle,
  MailCheck,
  Send,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import type {
  ActionCenterTarget,
  ActivityTimelineItem,
  ActivityTimelineKind,
  ActivityTimelinePage,
  MailActionDetail,
} from "@/lib/email/types";
import { api } from "./api";
import { isInitialPanelLoad } from "./refreshState";
import { isAbortError, useLatestRequest } from "./useLatestRequest";
import styles from "./EzraMail.module.css";

type ActivityFilters = {
  q: string;
  kind: ActivityTimelineKind | "all";
  accountId: string;
  provider: "all" | "gmail" | "microsoft";
  from: string;
  to: string;
};

const KIND_OPTIONS: Array<{ id: ActivityTimelineKind | "all"; label: string }> = [
  { id: "all", label: "All activity" },
  { id: "message_received", label: "Mail received" },
  { id: "classification", label: "Classification" },
  { id: "mail_action", label: "Mail actions" },
  { id: "outgoing_mail", label: "Outgoing mail" },
  { id: "feedback", label: "Corrections" },
  { id: "learned_rule", label: "Learning" },
  { id: "notification", label: "Notifications" },
  { id: "mail_sync", label: "Mail sync" },
  { id: "calendar_sync", label: "Calendar sync" },
  { id: "integration", label: "Permissions" },
];

const defaultFilters: ActivityFilters = {
  q: "",
  kind: "all",
  accountId: "",
  provider: "all",
  from: "",
  to: "",
};

export function ActivityTimelineView(props: {
  workspaceId: string;
  onOpenTarget: (target: ActionCenterTarget) => void;
}) {
  const [page, setPage] = useState<ActivityTimelinePage | null>(null);
  const [filters, setFilters] = useState<ActivityFilters>(defaultFilters);
  const [draftFilters, setDraftFilters] = useState<ActivityFilters>(defaultFilters);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [actionDetail, setActionDetail] = useState<MailActionDetail | null>(null);
  const [actionDetailLoading, setActionDetailLoading] = useState(false);
  const beginRequest = useLatestRequest();
  const beginDetailRequest = useLatestRequest();

  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    const request = beginRequest();
    if (options.quiet) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setError("");
    }
    try {
      const params = new URLSearchParams({ workspaceId: props.workspaceId, limit: "120" });
      if (filters.q.trim()) params.set("q", filters.q.trim());
      if (filters.kind !== "all") params.set("kind", filters.kind);
      if (filters.accountId) params.set("accountId", filters.accountId);
      if (filters.provider !== "all") params.set("provider", filters.provider);
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      const next = await api<ActivityTimelinePage>(`/api/activity?${params.toString()}`, { signal: request.signal });
      if (request.isLatest()) setPage(next);
    } catch (nextError) {
      if (!options.quiet && request.isLatest() && !isAbortError(nextError)) setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (request.isLatest()) {
        if (options.quiet) setRefreshing(false);
        else setLoading(false);
      }
    }
  }, [beginRequest, filters, props.workspaceId]);

  useEffect(() => {
    setFilters(defaultFilters);
    setDraftFilters(defaultFilters);
  }, [props.workspaceId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const refresh = () => void load({ quiet: true });
    window.addEventListener("ezra:refresh", refresh);
    return () => window.removeEventListener("ezra:refresh", refresh);
  }, [load]);

  function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters(draftFilters);
  }

  function resetFilters() {
    setDraftFilters(defaultFilters);
    setFilters(defaultFilters);
  }

  async function openActivityItem(item: ActivityTimelineItem) {
    if (item.kind !== "mail_action" || !item.actionId) {
      if (item.target) props.onOpenTarget(item.target);
      return;
    }
    setActionDetailLoading(true);
    setError("");
    const request = beginDetailRequest();
    try {
      const next = await api<MailActionDetail>(`/api/activity/actions/${encodeURIComponent(item.actionId)}`, { signal: request.signal });
      if (request.isLatest()) setActionDetail(next);
    } catch (nextError) {
      if (request.isLatest() && !isAbortError(nextError)) setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (request.isLatest()) setActionDetailLoading(false);
    }
  }

  if (isInitialPanelLoad(loading, Boolean(page))) {
    return <div className={styles.activityTimelineSkeleton}><div /><div /><div /></div>;
  }
  if (!page) {
    return <div className={styles.errorState}><strong>Activity timeline could not load.</strong><p>{error}</p><button onClick={() => void load()}>Try again</button></div>;
  }

  return (
    <div className={styles.activityTimelineView} aria-busy={refreshing || loading}>
      {error ? <div className={styles.inlineError} role="alert">{error}</div> : null}
      <section className={styles.activityTimelineHero}>
        <div>
          <span className={styles.dateLabel}>Activity Timeline</span>
          <h2>Ezra's receipts, in order</h2>
          <p>Search what Ezra saw, classified, changed, learned, notified, synced, or failed. This is the calm audit trail behind Today, Mail, Calendar, and Actions.</p>
        </div>
        <div className={styles.activityTimelineCounts}>
          <ActivityCount label="Shown" value={page.counts.shown} />
          <ActivityCount label="Warnings" value={page.counts.warnings} tone="warning" />
          <ActivityCount label="Errors" value={page.counts.errors} tone="error" />
        </div>
      </section>

      <form className={styles.activityTimelineFilters} onSubmit={submitFilters}>
        <label>
          <Search aria-hidden="true" />
          <input
            value={draftFilters.q}
            onChange={(event) => setDraftFilters((current) => ({ ...current, q: event.target.value }))}
            placeholder="Search sender, subject, action, account, or error"
          />
        </label>
        <select value={draftFilters.kind} onChange={(event) => setDraftFilters((current) => ({ ...current, kind: event.target.value as ActivityFilters["kind"] }))}>
          {KIND_OPTIONS.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
        </select>
        <select value={draftFilters.accountId} onChange={(event) => setDraftFilters((current) => ({ ...current, accountId: event.target.value }))}>
          <option value="">All workspace accounts</option>
          {page.accounts.map((account) => <option key={account.id} value={account.id}>{account.label} · {account.email}</option>)}
        </select>
        <select value={draftFilters.provider} onChange={(event) => setDraftFilters((current) => ({ ...current, provider: event.target.value as ActivityFilters["provider"] }))}>
          <option value="all">All providers</option>
          <option value="gmail">Gmail</option>
          <option value="microsoft">Hotmail</option>
        </select>
        <input type="date" value={draftFilters.from} onChange={(event) => setDraftFilters((current) => ({ ...current, from: event.target.value }))} aria-label="From date" />
        <input type="date" value={draftFilters.to} onChange={(event) => setDraftFilters((current) => ({ ...current, to: event.target.value }))} aria-label="To date" />
        <button type="submit" className={styles.primaryButton}><Filter aria-hidden="true" /> Apply</button>
        <button type="button" className={styles.secondaryButton} onClick={resetFilters}><RefreshCw aria-hidden="true" /> Reset</button>
      </form>

      <div className={styles.activityKindChips} aria-label="Activity counts by type">
        {page.counts.byKind.length ? page.counts.byKind.map((item) => (
          <span key={item.kind}>{kindLabel(item.kind)} <b>{item.count}</b></span>
        )) : <span>No matching activity yet.</span>}
      </div>

      <section className={styles.activityTimelineList} aria-label="Activity events">
        {page.items.length ? page.items.map((item) => (
          <ActivityTimelineRow
            key={item.id}
            item={item}
            onOpen={() => void openActivityItem(item)}
          />
        )) : (
          <div className={styles.actionCenterEmpty}><CheckCircle2 aria-hidden="true" /><span>No matching activity found.</span></div>
        )}
      </section>
      {actionDetail ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => setActionDetail(null)}>
          <section className={`${styles.confirmDialog} ${styles.actionDetailDialog}`} role="dialog" aria-modal="true" aria-labelledby="action-detail-heading" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className={styles.dialogEyebrow}>Provider action receipt</span><h2 id="action-detail-heading">{actionDetail.changedCount} changed, {actionDetail.unchangedCount} unchanged, {actionDetail.failedCount} failed</h2></div><button className={styles.iconButtonSmall} onClick={() => setActionDetail(null)} aria-label="Close action details">x</button></header>
            <div className={styles.actionOutcomeList}>
              {actionDetail.outcomes.map((outcome) => (
                <article key={`${outcome.status}-${outcome.id}`} className={styles[`actionOutcome_${outcome.status}`]}>
                  <div><strong>{outcome.subject}</strong><span>{outcome.senderName} · {outcome.accountLabel} · {outcome.provider === "microsoft" ? "Hotmail" : "Gmail"}</span></div>
                  <b>{outcome.status}</b>
                  {outcome.error ? <p>{outcome.error}{outcome.retryable ? " You can retry after the account recovers." : ""}</p> : null}
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}
      {actionDetailLoading ? <div className={styles.inlineRefreshStatus}><LoaderCircle aria-hidden="true" /> Loading action details.</div> : null}
    </div>
  );
}

function ActivityCount(props: { label: string; value: number; tone?: "warning" | "error" }) {
  return (
    <div className={`${styles.activityTimelineCount} ${props.tone === "error" ? styles.activityTimelineCountError : props.tone === "warning" ? styles.activityTimelineCountWarning : ""}`}>
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  );
}

function ActivityTimelineRow(props: { item: ActivityTimelineItem; onOpen: () => void }) {
  const Icon = iconForKind(props.item.kind);
  const content = (
    <>
      <span className={`${styles.activityTimelineIcon} ${styles[`activitySeverity_${props.item.severity}`] || ""}`}><Icon aria-hidden="true" /></span>
      <span className={styles.activityTimelineRowMain}>
        <span className={styles.activityTimelineMeta}>
          <b>{kindLabel(props.item.kind)}</b>
          <span>{props.item.accountLabel || "System"}</span>
          {props.item.accountProvider ? <span>{props.item.accountProvider === "microsoft" ? "Hotmail" : "Gmail"}</span> : null}
          <time>{relativeTime(props.item.occurredAt)}</time>
        </span>
        <strong>{props.item.title}</strong>
        <small>{props.item.subtitle}</small>
        <span>{props.item.detail}</span>
      </span>
      <span className={styles.activityTimelineStatus}>
        <b>{props.item.status || props.item.severity}</b>
        <small>{formatDateTime(props.item.occurredAt)}</small>
      </span>
    </>
  );
  if (props.item.target || (props.item.kind === "mail_action" && props.item.actionId)) {
    return <button className={styles.activityTimelineRow} onClick={props.onOpen}>{content}</button>;
  }
  return <div className={styles.activityTimelineRow}>{content}</div>;
}

function iconForKind(kind: ActivityTimelineKind) {
  if (kind === "message_received") return Inbox;
  if (kind === "classification") return Sparkles;
  if (kind === "mail_action") return MailCheck;
  if (kind === "outgoing_mail") return Send;
  if (kind === "feedback") return SlidersHorizontal;
  if (kind === "learned_rule") return Settings2;
  if (kind === "notification") return Bell;
  if (kind === "mail_sync") return RefreshCw;
  if (kind === "calendar_sync") return CalendarClock;
  if (kind === "integration") return AlertTriangle;
  return Clock3;
}

function kindLabel(kind: ActivityTimelineKind) {
  if (kind === "message_received") return "Mail received";
  if (kind === "classification") return "Classification";
  if (kind === "mail_action") return "Mail action";
  if (kind === "outgoing_mail") return "Outgoing mail";
  if (kind === "feedback") return "Correction";
  if (kind === "learned_rule") return "Learning";
  if (kind === "notification") return "Notification";
  if (kind === "mail_sync") return "Mail sync";
  if (kind === "calendar_sync") return "Calendar sync";
  if (kind === "integration") return "Permission";
  return kind;
}

function relativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
