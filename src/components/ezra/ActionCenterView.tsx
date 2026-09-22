"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ClipboardCheck, LoaderCircle, MailCheck, Sparkles } from "lucide-react";
import type { ActionCenterItem, ActionCenterPage, ActionCenterTarget } from "@/lib/email/types";
import { api } from "./api";
import { isInitialPanelLoad } from "./refreshState";
import { isAbortError, useLatestRequest } from "./useLatestRequest";
import styles from "./EzraMail.module.css";

const SECTION_ICONS = {
  approvals: MailCheck,
  cleanup: Sparkles,
  repairs: AlertTriangle,
} as const;

export function ActionCenterView(props: {
  workspaceId: string;
  onOpenTarget: (target: ActionCenterTarget) => void;
}) {
  const [page, setPage] = useState<ActionCenterPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const beginRequest = useLatestRequest();

  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    const request = beginRequest();
    if (options.quiet) setRefreshing(true);
    else {
      setLoading(true);
      setError("");
    }
    try {
      const params = new URLSearchParams({ workspaceId: props.workspaceId });
      const next = await api<ActionCenterPage>(`/api/actions/center?${params.toString()}`, { signal: request.signal });
      if (request.isLatest()) setPage(next);
    } catch (nextError) {
      if (!options.quiet && request.isLatest() && !isAbortError(nextError)) setError(nextError instanceof Error ? nextError.message : String(nextError));
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

  const total = page?.counts.total || 0;
  const hasItems = Boolean(total);
  const summary = useMemo(() => {
    if (!page) return "Checking approvals, repairs, and review queues.";
    if (!page.counts.total) return "Nothing is waiting on you right now.";
    return `${page.counts.approvals} approval${page.counts.approvals === 1 ? "" : "s"}, ${page.counts.cleanup} cleanup review${page.counts.cleanup === 1 ? "" : "s"}, and ${page.counts.repairs} repair${page.counts.repairs === 1 ? "" : "s"}.`;
  }, [page]);

  if (isInitialPanelLoad(loading, Boolean(page))) {
    return <div className={styles.actionCenterSkeleton}><div /><div /><div /></div>;
  }
  if (error && !page) {
    return <div className={styles.errorState}><strong>Action Center could not load.</strong><p>{error}</p><button onClick={() => load()}>Try again</button></div>;
  }
  if (!page) return null;

  return (
    <div className={styles.actionCenterView} aria-busy={refreshing || loading}>
      <section className={styles.actionCenterHero}>
        <div>
          <span className={styles.dateLabel}>Action Center</span>
          <h2>{hasItems ? "A few things are waiting for review" : "Nothing is waiting on you"}</h2>
          <p>{summary}</p>
        </div>
        <div className={styles.actionCenterCounts}>
          <ActionCenterCount label="Approvals" value={page.counts.approvals} />
          <ActionCenterCount label="Cleanup" value={page.counts.cleanup} />
          <ActionCenterCount label="Repairs" value={page.counts.repairs} tone={page.counts.repairs ? "repair" : undefined} />
        </div>
      </section>

      <div className={styles.actionCenterSections}>
        {page.sections.map((section) => {
          const Icon = SECTION_ICONS[section.id];
          return (
            <section className={styles.actionCenterSection} key={section.id}>
              <header>
                <span className={styles.sectionIcon}><Icon aria-hidden="true" /></span>
                <div>
                  <h2>{section.title}</h2>
                  <p>{section.description}</p>
                </div>
                <b>{section.count}</b>
              </header>
              {section.items.length ? (
                <div className={styles.actionCenterList}>
                  {section.items.map((item) => (
                    <ActionCenterRow key={item.id} item={item} onOpen={() => props.onOpenTarget(item.target)} />
                  ))}
                </div>
              ) : (
                <div className={styles.actionCenterEmpty}><CheckCircle2 aria-hidden="true" /><span>Clear for now.</span></div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ActionCenterCount(props: { label: string; value: number; tone?: "repair" }) {
  return (
    <div className={`${styles.actionCenterCount} ${props.tone === "repair" ? styles.actionCenterCountRepair : ""}`}>
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  );
}

function ActionCenterRow(props: { item: ActionCenterItem; onOpen: () => void }) {
  return (
    <button className={`${styles.actionCenterRow} ${styles[`actionCenter_${props.item.priority}`]}`} onClick={props.onOpen}>
      <span className={styles.actionCenterRowMain}>
        <span className={styles.actionCenterMeta}>
          {props.item.accountLabel ? (
            <b className={`${styles.accountBadge} ${props.item.accountProvider === "microsoft" ? styles.accountBadgeMicrosoft : styles.accountBadgeGmail}`}>
              {props.item.accountLabel}
            </b>
          ) : null}
          <span>{humanize(props.item.type)}</span>
          <time>{relativeTime(props.item.updatedAt)}</time>
        </span>
        <strong>{props.item.title}</strong>
        <small>{props.item.subtitle}</small>
        <span>{props.item.detail}</span>
      </span>
      <span className={styles.actionCenterStatus}>
        <ClipboardCheck aria-hidden="true" />
        <b>{props.item.count}</b>
        <small>{humanize(props.item.status)}</small>
      </span>
    </button>
  );
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function relativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1_440)}d`;
}
