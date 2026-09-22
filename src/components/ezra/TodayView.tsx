"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarClock,
  Check,
  ExternalLink,
  Eye,
  Info,
  ListChecks,
  MailCheck,
  MailOpen,
  MessageSquareReply,
  RotateCcw,
  Sparkles,
  VolumeX,
  X,
} from "lucide-react";
import type {
  ActionCenterTarget,
  BriefMemoryAction,
  CleanupSuggestion,
  LivingBriefItem,
  MailActionResult,
  TodayBrief,
  TodayBriefSourceStatus,
  TodayTopic,
  TodayTopicKind,
} from "@/lib/email/types";
import { mailActionCopy } from "@/lib/email/vocabulary";
import { attentionAge, groupTodayAttention } from "@/lib/email/today-attention";
import type { TodayAttentionMeta } from "@/lib/email/morning-brief-types";
import { briefItemStateTimestamp } from "@/lib/email/brief-item-state";
import { TodayMorningBrief } from "./TodayMorningBrief";
import { isInitialPanelLoad } from "./refreshState";
import styles from "./EzraMail.module.css";

type MailDrilldown = {
  folder?: string;
  date?: string;
  priority?: string;
  category?: string;
  unread?: boolean;
  handled?: "active" | "handled" | "any";
  needsReply?: boolean;
  hasDeadline?: boolean;
  q?: string;
  messageIds?: string[];
  todaySection?: TodayTopicKind;
};

const SECTION_META: Array<{
  kind: TodayTopicKind;
  title: string;
  description: string;
  icon: typeof MailCheck;
}> = [
  { kind: "action", title: "Action now", description: "Consequences are close or attention is genuinely needed.", icon: MailCheck },
  { kind: "reply", title: "Needs reply", description: "Conversations waiting on you.", icon: MessageSquareReply },
  { kind: "deadline", title: "Deadlines", description: "Upcoming commitments and time-bound mail.", icon: CalendarClock },
  { kind: "fyi", title: "Worth knowing", description: "Useful context without an interruption.", icon: Info },
];

export function TodayView(props: {
  data: TodayBrief | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
  onOpen: (messageId: string) => void;
  onOpenMail: (filters: MailDrilldown) => void;
  onAction: (action: string, ids: string[], label?: string) => Promise<MailActionResult>;
  onRefresh: () => Promise<void>;
  onOpenTarget: (target: ActionCenterTarget) => void;
  onBriefAction: (itemId: string, action: BriefMemoryAction) => Promise<void>;
}) {
  const [pending, setPending] = useState<CleanupSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [briefPending, setBriefPending] = useState<{
    workspaceId: string;
    itemId: string;
    action: BriefMemoryAction;
  } | null>(null);
  const [briefError, setBriefError] = useState<{ workspaceId: string; message: string } | null>(null);
  const activeBriefWorkspaceRef = useRef(props.data?.workspaceId || null);
  activeBriefWorkspaceRef.current = props.data?.workspaceId || null;
  const [reviewedGlanceIds, setReviewedGlanceIds] = useState<Set<string>>(() => new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const oneMoreGlance = useMemo(() => {
    return (props.data?.oneMoreGlance || []).filter((item) => !reviewedGlanceIds.has(item.id));
  }, [props.data?.oneMoreGlance, reviewedGlanceIds]);
  const historyTotal = useMemo(() => {
    return props.data?.history.sections.reduce((total, section) => total + section.count, 0) || 0;
  }, [props.data?.history.sections]);

  useEffect(() => {
    setBriefError(null);
  }, [props.data?.workspaceId]);

  if (isInitialPanelLoad(props.loading, Boolean(props.data))) return <TodaySkeleton />;
  if (props.error && !props.data) {
    return <div className={styles.errorState}><strong>Today could not be prepared.</strong><p>{props.error}</p><button onClick={props.onRefresh}>Try again</button></div>;
  }
  if (!props.data) return null;

  async function confirmCleanup() {
    if (!pending) return;
    setBusy(true);
    try {
      await props.onAction(pending.recommendation, [pending.latestMessageId]);
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  async function correctCleanup(item: CleanupSuggestion, action: "keep" | "raise_priority") {
    setBusy(true);
    try {
      await props.onAction(
        action,
        [item.latestMessageId],
        action === "keep"
          ? "Kept this sender as useful mail."
          : "Changed this sender to Care more.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function actOnGlance(messageId: string, action: "keep" | "raise_priority" | "lower_priority") {
    setBusy(true);
    try {
      await props.onAction(
        action,
        [messageId],
        action === "keep"
          ? "Marked as fine for One More Glance."
          : action === "raise_priority"
            ? "Ezra will care more about this kind of mail."
            : "Ezra will care less about this kind of mail.",
      );
      setReviewedGlanceIds((current) => new Set(current).add(messageId));
    } finally {
      setBusy(false);
    }
  }

  async function actOnBrief(itemId: string, action: BriefMemoryAction) {
    const workspaceId = props.data?.workspaceId;
    if (!workspaceId) return;
    const request = { workspaceId, itemId, action };
    setBriefError(null);
    setBriefPending(request);
    try {
      await props.onBriefAction(itemId, action);
    } catch (error) {
      if (activeBriefWorkspaceRef.current === workspaceId) {
        setBriefError({
          workspaceId,
          message: error instanceof Error ? error.message : "The brief item could not be updated.",
        });
      }
    } finally {
      setBriefPending((current) => current === request ? null : current);
    }
  }

  const visibleBriefPending = briefPending?.workspaceId === props.data.workspaceId ? briefPending : null;
  const visibleBriefError = briefError?.workspaceId === props.data.workspaceId ? briefError.message : "";

  // Exact message identities join the two representations; local memory owns decisions.
  const topicById = new Map(props.data.topics.map(topic => [topic.id, topic]));
  const topicFor = (item: LivingBriefItem) => item.sourceType === "mail_thread" && item.target.view === "mail"
    ? topicById.get(item.target.messageId) : undefined;
  const openItems = [...props.data.needsAttention, ...props.data.carryovers];
  const representedIds = new Set([...openItems, ...props.data.completedSinceLastBrief, ...props.data.briefCandidates]
    .flatMap(item => item.sourceType === "mail_thread" && item.target.view === "mail" ? [item.target.messageId] : []));
  const attentionItems = openItems.filter(item => (topicFor(item)?.kind ?? item.topicKind) !== "fyi");
  const fyiItems = openItems.filter(item => (topicFor(item)?.kind ?? item.topicKind) === "fyi");
  const fallbackTopics = props.data.topics.filter(topic => !representedIds.has(topic.id));
  const attentionTopics = fallbackTopics.filter(topic => topic.kind !== "fyi");
  const fyiTopics = fallbackTopics.filter(topic => topic.kind === "fyi");
  const carriedIds = new Set(props.data.carryovers.map(item => item.id));
  const visibleTopics = openItems.flatMap(item => { const topic = topicFor(item); return topic ? [topic] : []; }).concat(fallbackTopics);
  const timezone = props.data.timezone || "America/Chicago";
  const attentionFacts = new Map(Object.entries(props.data.attentionMetadata || {}));
  const attentionGroups = groupTodayAttention(attentionItems, attentionFacts, props.data.generatedAt, timezone);
  const sectionProps = { now: props.data.generatedAt, timezone, attentionFacts, pending: visibleBriefPending, onOpen: props.onOpenTarget, onAction: actOnBrief,
    onOpenTopic: props.onOpen, topicById, carriedIds };

  return (
    <div
      className={styles.todayLayout}
      aria-label="Living daily brief page"
      aria-busy={props.refreshing || Boolean(visibleBriefPending)}
    >
      <header className={styles.todayOverview}>
        <div className={styles.todayHeading}>
          <h2>{formatBriefDate(props.data.date)}</h2>
          <span className={styles.livingBriefStatusSlot}>
            {props.refreshing ? <span className={styles.inlineRefreshStatusSmall} aria-live="polite"><RotateCcw aria-hidden="true" /> Updating</span>
              : <span className={styles.livingBriefUpdated}>Updated {relativeTime(props.data.generatedAt)} ago</span>}
          </span>
        </div>
        <div className={styles.todayActivity} role="group" aria-label="Today's mail activity">
          <ActivityStat label="Received today" value={props.data.mailActivity.receivedToday} onClick={() => props.onOpenMail({ folder: "all", date: "today", handled: "any" })} />
          <ActivityStat label="Handled" value={props.data.mailActivity.handledToday} onClick={() => props.onOpenMail({ folder: "all", date: "today", handled: "handled" })} />
          <ActivityStat label="Kept quiet" value={props.data.mailActivity.attentionCounts.suppress} onClick={() => props.onOpenMail({ folder: "all", date: "today", priority: "suppress", handled: "any" })} />
        </div>
        <SourceStatusList key={props.data.workspaceId} items={props.data.sourceStatus} pollError={props.data.mailActivity.lastPollError} />
      </header>
      {visibleBriefError ? <p className={styles.livingBriefError} role="alert">{visibleBriefError}</p> : null}
      <div className={styles.todaySections}>
        <LivingBriefSection {...sectionProps} id="living-agenda" title="Today's agenda"
          description="Your calendar commitments for today." empty="No calendar commitments are in this brief." items={props.data.agenda} />
        {props.data.morningBrief ? <TodayMorningBrief key={props.data.workspaceId + ":" + props.data.date + ":" + timezone} value={props.data.morningBrief} onOpen={props.onOpenTarget} /> : null}
        <LivingBriefSection {...sectionProps} id="living-attention" title="Needs your attention"
          description="Mark handled records your decision in Ezra. It does not reply, mark mail read, archive, or change an external task."
          empty="No open decisions in this brief." items={attentionGroups.current} earlierItems={attentionGroups.earlier} topics={attentionTopics}
          links={<TopicLinks topics={visibleTopics.filter(topic => topic.kind !== "fyi")} onOpenMail={props.onOpenMail} />} />

        {fyiItems.length || fyiTopics.length ? <LivingBriefSection {...sectionProps} id="today-fyi" title="Worth knowing"
          description="Useful context without a decision to make." empty="No updates to catch up on." items={fyiItems} topics={fyiTopics}
          links={<TopicLinks topics={visibleTopics.filter(topic => topic.kind === "fyi")} onOpenMail={props.onOpenMail} />} /> : null}
      </div>
      <details className={styles.todayHistory} key={props.data.workspaceId}>
        <summary><span>Completed and history</span><span>{props.data.completedSinceLastBrief.length} recent</span></summary>
        <LivingBriefSection {...sectionProps} id="living-completed" title="Completed or dismissed today"
          description="Local decisions and confirmed external replies. Bring an item back if it needs another look."
          empty="No completions or dismissals recorded today." items={props.data.completedSinceLastBrief} />
        <div className={styles.todayHistoryTools}>
          <ActivityStat label="Still needs attention" value={props.data.mailActivity.stillNeedsAttention} onClick={() => props.onOpenMail({ folder: "inbox", date: "today", handled: "active" })} />
          <button className={styles.secondaryButton} onClick={() => setHistoryOpen(true)}><ListChecks aria-hidden="true" /> Open history <b>{historyTotal}</b></button>
        </div>
        <div className={styles.activityCategories}>
          {props.data.mailActivity.categoryCounts.map(category => <button key={category.category} onClick={() => props.onOpenMail({ folder: "all", date: "today", category: category.category })}>{humanize(category.category)} <b>{category.count}</b></button>)}
        </div>
        <p className={styles.todayHistoryNote}>Ezra reviewed {props.data.quietReviewed} quieter messages today. Last poll {props.data.mailActivity.lastPollAt ? relativeTime(props.data.mailActivity.lastPollAt) + " ago" : "not yet"}.</p>
      </details>

      {props.data.cleanup.length ? (
        <section className={styles.cleanupSection} aria-labelledby="cleanup-heading">
          <header className={styles.sectionHeader}>
            <span className={styles.sectionIcon}><Sparkles aria-hidden="true" /></span>
            <div><h2 id="cleanup-heading">A quick cleanup</h2><p>Small, reviewable suggestions. Nothing happens without approval.</p></div>
            <b>{props.data.cleanup.length}</b>
          </header>
          <div className={styles.cleanupList}>
            {props.data.cleanup.map((item) => (
              <div className={styles.cleanupRow} key={`${item.accountId}-${item.senderEmail}`}>
                <button className={styles.cleanupOpen} onClick={() => props.onOpen(item.latestMessageId)}>
                  <span className={styles.avatar}>{initials(item.senderName)}</span>
                  <span><strong>{item.senderName}</strong><small>{item.messageCount} message{item.messageCount === 1 ? "" : "s"} · {item.latestSubject}</small></span>
                </button>
                <p>{item.reason}</p>
                <div className={styles.cleanupActions}>
                  <button className={styles.secondarySuggestionButton} disabled={busy} onClick={() => correctCleanup(item, "keep")}><Check aria-hidden="true" /> {mailActionCopy("keep").label}</button>
                  <button className={styles.secondarySuggestionButton} disabled={busy} onClick={() => correctCleanup(item, "raise_priority")}><ArrowRight aria-hidden="true" /> {mailActionCopy("raise_priority").label}</button>
                  <button className={styles.suggestionButton} disabled={busy} onClick={() => setPending(item)}>
                    {item.recommendation === "unsubscribe" ? <MailCheck aria-hidden="true" /> : item.recommendation === "quiet" ? <VolumeX aria-hidden="true" /> : <Eye aria-hidden="true" />}
                    {cleanupActionLabel(item.recommendation)}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {oneMoreGlance.length ? (
        <section className={styles.glanceSection} aria-labelledby="glance-heading">
          <header className={styles.sectionHeader}>
            <span className={styles.sectionIcon}><Eye aria-hidden="true" /></span>
            <div>
              <h2 id="glance-heading">One More Glance</h2>
              <p>A gentle last pass through mail that already looks handled. Ignore this when you are done for the day.</p>
            </div>
            <b>{oneMoreGlance.length}</b>
          </header>
          <div className={styles.glanceList}>
            {oneMoreGlance.map((item) => (
              <div className={styles.glanceRow} key={item.id}>
                <button className={styles.glanceOpen} onClick={() => props.onOpen(item.id)}>
                  <span className={styles.avatar}>{initials(item.senderName)}</span>
                  <span className={styles.glanceMain}>
                    <span className={styles.glanceMeta}>
                      <b className={`${styles.accountBadge} ${item.accountProvider === "microsoft" ? styles.accountBadgeMicrosoft : styles.accountBadgeGmail}`}>
                        {item.accountLabel}
                      </b>
                      <span>{relativeTime(item.receivedAt)}</span>
                      <span>{item.reasonLabel}</span>
                    </span>
                    <strong>{item.subject}</strong>
                    <small>{item.senderName} · {item.category ? humanize(item.category) : "Uncategorized"}</small>
                  </span>
                </button>
                <p>{item.summary}</p>
                <div className={styles.glanceActions}>
                  <button className={styles.secondarySuggestionButton} disabled={busy} onClick={() => actOnGlance(item.id, "keep")}><Check aria-hidden="true" /> Looks fine</button>
                  <button className={styles.secondarySuggestionButton} disabled={busy} onClick={() => actOnGlance(item.id, "raise_priority")}><ArrowRight aria-hidden="true" /> Care more</button>
                  <button className={styles.secondarySuggestionButton} disabled={busy} onClick={() => actOnGlance(item.id, "lower_priority")}><VolumeX aria-hidden="true" /> Care less</button>
                  <button className={styles.suggestionButton} onClick={() => props.onOpen(item.id)}><MailOpen aria-hidden="true" /> Open</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {pending ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => !busy && setPending(null)}>
          <section className={styles.confirmDialog} role="alertdialog" aria-modal="true" aria-labelledby="cleanup-confirm" onMouseDown={(event) => event.stopPropagation()}>
            <h2 id="cleanup-confirm">Approve {cleanupConfirmationLabel(pending.recommendation)}?</h2>
            <p>{pending.senderName} · {pending.senderEmail}</p>
            <div className={styles.actionPreview}>
              <strong>Ezra will:</strong>
              <span>{pending.reason}</span>
              {pending.recommendation === "unsubscribe" ? <small>Unsubscribe is permanent and cannot be undone.</small> : <small>You can undo this action after it runs.</small>}
            </div>
            <div className={styles.dialogActions}>
              <button className={styles.secondaryButton} disabled={busy} onClick={() => setPending(null)}>Cancel</button>
              <button className={styles.primaryButton} disabled={busy} onClick={confirmCleanup}>{busy ? "Applying..." : "Approve"}</button>
            </div>
          </section>
        </div>
      ) : null}

      {historyOpen ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => setHistoryOpen(false)}>
          <aside className={styles.historyDrawer} role="dialog" aria-modal="true" aria-labelledby="today-history-heading" onMouseDown={(event) => event.stopPropagation()}>
            <header className={styles.historyDrawerHeader}>
              <div>
                <p className={styles.dateLabel}>{formatBriefDate(props.data.date)}</p>
                <h2 id="today-history-heading">Today history</h2>
                <span>Workspace-scoped audit trail generated {relativeTime(props.data.history.generatedAt)} ago.</span>
              </div>
              <button className={styles.iconButton} onClick={() => setHistoryOpen(false)} aria-label="Close Today history">x</button>
            </header>
            <div className={styles.historySections}>
              {props.data.history.sections.map((section) => (
                <section className={styles.historySection} key={section.kind}>
                  <header>
                    <div>
                      <h3>{section.title}</h3>
                      <p>{section.description}</p>
                    </div>
                    <b>{section.count}</b>
                  </header>
                  {section.items.length ? (
                    <div className={styles.historyItemList}>
                      {section.items.map((item) => {
                        const content = (
                          <>
                            <span className={styles.historyItemTop}>
                              <strong>{item.title}</strong>
                              <time>{relativeTime(item.occurredAt)}</time>
                            </span>
                            <span className={styles.historyItemMeta}>
                              {item.accountLabel ? (
                                <b className={`${styles.accountBadge} ${item.accountProvider === "microsoft" ? styles.accountBadgeMicrosoft : styles.accountBadgeGmail}`}>
                                  {item.accountLabel}
                                </b>
                              ) : null}
                              <span>{item.subtitle}</span>
                            </span>
                            <small>{item.detail}</small>
                          </>
                        );
                        return item.messageId ? (
                          <button
                            className={styles.historyItem}
                            key={item.id}
                            onClick={() => {
                              setHistoryOpen(false);
                              props.onOpen(item.messageId!);
                            }}
                          >
                            {content}
                          </button>
                        ) : (
                          <div className={styles.historyItem} key={item.id}>{content}</div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className={styles.historyEmpty}>Nothing in this bucket yet.</p>
                  )}
                </section>
              ))}
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function LivingBriefSection(props: {
  id: string;
  title: string;
  description: string;
  empty: string;
  items: LivingBriefItem[];
  earlierItems?: LivingBriefItem[];
  now: string;
  timezone: string;
  attentionFacts: Map<string, TodayAttentionMeta>;
  topics?: TodayTopic[];
  topicById?: Map<string, TodayTopic>;
  carriedIds?: Set<string>;
  links?: React.ReactNode;
  onOpenTopic?: (id: string) => void;
  pending: { itemId: string; action: BriefMemoryAction } | null;
  onOpen: (target: ActionCenterTarget) => void;
  onAction: (itemId: string, action: BriefMemoryAction) => Promise<void>;
}) {
  const receivedAt = (item: LivingBriefItem) => item.sourceType === "mail_thread"
    ? props.attentionFacts.get(item.sourceKey)?.receivedAt || (item.target.view === "mail" ? props.topicById?.get(item.target.messageId)?.receivedAt : null) || item.occurredAt : null;
  const controlsDisabled = Boolean(props.pending);
  const renderItem = (item: LivingBriefItem) => (
            <article className={styles.livingBriefItem} key={item.id}>
              <div className={styles.briefItemContent}>
              <button
                type="button"
                className={styles.livingBriefOpen}
                aria-label={`Open ${item.title}`}
                onClick={() => props.onOpen(item.target)}
              >
                <span className={styles.livingBriefItemTop}>
                  <strong>{item.title}</strong>
                  <ExternalLink aria-hidden="true" />
                </span>
                <span>{item.summary}</span>
                <small>
                  {props.carriedIds?.has(item.id) ? <><b>Carried over</b> · </> : null}
                  {briefSourceLabel(item)}{item.sourceType !== "calendar_event" || item.state !== "open" ? " · " + briefItemTime(item, props.now, props.timezone, receivedAt(item)) : ""}
                </small>
                {item.target.view === "mail" && props.topicById?.get(item.target.messageId) ? <MailTopicContext topic={props.topicById.get(item.target.messageId)!} /> : null}
                {item.topicKind && !(item.target.view === "mail" && props.topicById?.has(item.target.messageId)) ? <small>{SECTION_META.find(section => section.kind === item.topicKind)?.title}</small> : null}
              </button>
              {item.state === "open" && item.sourceType !== "calendar_event" ? <details className={styles.briefExactDate}>
                <summary>Exact dates<span className={styles.srOnly}> for {item.title}</span></summary>
                <p>{attentionAge({receivedAt:receivedAt(item),firstSeenAt:item.firstSeenAt,now:props.now,timezone:props.timezone}).exact}</p>
              </details> : null}
              </div>
              <div className={styles.livingBriefActions}>
                {item.state === "open" ? (
                  <>
                    <button
                      type="button"
                      className={styles.briefActionPrimary}
                      aria-label={`Mark handled ${item.title}`}
                      disabled={controlsDisabled}
                      onClick={() => void props.onAction(item.id, "complete")}
                    >
                      <Check aria-hidden="true" />
                      {props.pending?.itemId === item.id && props.pending.action === "complete" ? "Marking handled…" : "Mark handled"}
                    </button>
                    <button
                      type="button"
                      className={styles.briefActionSecondary}
                      aria-label={`Dismiss ${item.title}`}
                      disabled={controlsDisabled}
                      onClick={() => void props.onAction(item.id, "dismiss")}
                    >
                      <X aria-hidden="true" />
                      {props.pending?.itemId === item.id && props.pending.action === "dismiss" ? "Dismissing..." : "Dismiss"}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={styles.briefActionSecondary}
                    aria-label={`Bring back ${item.title}`}
                    disabled={controlsDisabled}
                    onClick={() => void props.onAction(item.id, "bring_back")}
                  >
                    <RotateCcw aria-hidden="true" />
                    {props.pending?.itemId === item.id ? "Bringing back..." : "Bring back"}
                  </button>
                )}
              </div>
            </article>
  );
  const count = props.items.length + (props.topics?.length || 0);
  return (
    <section className={styles.livingBriefSection} aria-labelledby={props.id}>
      <header className={styles.livingBriefSectionHeader}>
        <div>
          <h2 id={props.id}>{props.title}</h2>
          <p>{props.description}</p>
        </div>
        <b aria-label={`${count} items`}>{count}</b>
      </header>
      {props.links}
      {count ? (
        <div className={styles.livingBriefList}>
          {props.items.map(renderItem)}
          {props.topics?.map(topic => <button key={topic.id} className={styles.todayTopic} onClick={() => props.onOpenTopic?.(topic.id)}>
            <strong>{topic.title}</strong><span>{topic.summary}</span>
            <small>{topicLabel(topic)} · {topic.senderName} · {topic.accountLabel}{topic.deadline ? " · " + formatDeadline(topic.deadline) : ""}</small>
          </button>)}
        </div>
      ) : (
        <p className={styles.livingBriefEmpty}>{props.earlierItems?.length ? "Earlier open work is available below." : props.empty}</p>
      )}
      {props.earlierItems?.length ? <details className={styles.briefEarlier}>
        <summary>Earlier, still open ({props.earlierItems.length})</summary>
        <div className={styles.livingBriefList}>{props.earlierItems.map(renderItem)}</div>
      </details> : null}
    </section>
  );
}

function TopicLinks(props: { topics: TodayTopic[]; onOpenMail: (filters: MailDrilldown) => void }) {
  if (!props.topics.length) return null;
  return <div className={styles.todayTopicLinks}>
    {SECTION_META.map(section => {
      const topics = props.topics.filter(topic => topic.kind === section.kind);
      return topics.length ? <span key={section.kind}>{section.title}
        <button onClick={() => props.onOpenMail({ ...sectionDrilldown(section.kind), messageIds: topics.map(topic => topic.id), todaySection: section.kind })}>View {topics.length}</button>
      </span> : null;
    })}
  </div>;
}

function MailTopicContext({ topic }: { topic: TodayTopic }) {
  return <small>{topicLabel(topic)} · {topic.senderName} · {topic.accountLabel}
    {topic.deadline ? " · " + formatDeadline(topic.deadline) : ""}{topic.threadCount > 1 ? " · " + topic.threadCount + " in thread" : ""}
  </small>;
}

function topicLabel(topic: TodayTopic) {
  return SECTION_META.find(section => section.kind === topic.kind)!.title;
}

function SourceStatusList(props: { items: TodayBriefSourceStatus[]; pollError: string | null }) {
  const issues = props.items.filter(item => item.status !== "current");
  const warning = issues.length > 0 || Boolean(props.pollError);
  return <div className={styles.todaySources} data-warning={warning}>
    {warning ? <p role="status">{props.pollError || issues[0]?.detail || sourceStatusFallback(issues[0].status)}</p> : null}
    <details>
    <summary>{warning ? "Some sources need attention" : props.items.length ? "Sources up to date" : "Source status not available"}</summary>
    <ul className={styles.sourceStatusList}>
      {props.items.map((item, index) => <li className={styles.sourceStatusRow} data-status={item.status} key={item.source + "-" + (item.accountId || "workspace") + "-" + index}>
        <span><strong>{briefStatusSourceLabel(item.source)}</strong><small>{item.detail || sourceStatusFallback(item.status)}</small></span>
        <b>{sourceStatusLabel(item.status)}</b>
      </li>)}
    </ul>
    </details>
  </div>;
}

function briefSourceLabel(item: LivingBriefItem) {
  if (item.sourceType === "calendar_event") return "Calendar";
  if (item.sourceType === "action_center") return "Action Center";
  return "Mail";
}

function briefItemTime(item: LivingBriefItem, now: string, timezone: string, receivedAt: string | null) {
  const observedAt = briefItemStateTimestamp(item);
  if (item.state === "completed") return `completed ${relativeTime(observedAt)} ago`;
  if (item.state === "dismissed") return `dismissed ${relativeTime(observedAt)} ago`;
  const age = attentionAge({receivedAt,firstSeenAt:item.firstSeenAt,now,timezone});
  return [age.received,age.waiting].filter(Boolean).join(" · ");
}

function briefStatusSourceLabel(source: TodayBriefSourceStatus["source"]) {
  if (source === "action_center") return "Action Center";
  if (source === "freshness") return "Account freshness";
  if (source === "sent") return "Sent proof";
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function sourceStatusLabel(status: TodayBriefSourceStatus["status"]) {
  if (status === "current") return "Current";
  if (status === "stale") return "Last cached";
  if (status === "truncated") return "Partial";
  if (status === "unavailable") return "Unavailable";
  return "Needs attention";
}

function sourceStatusFallback(status: TodayBriefSourceStatus["status"]) {
  if (status === "current") return "Current evidence is available.";
  if (status === "stale") return "Ezra is showing the last safe cached state.";
  if (status === "truncated") return "Only bounded positive evidence was available.";
  if (status === "unavailable") return "This source is not available in the selected workspace.";
  return "This source could not be checked safely.";
}

function ActivityStat(props: { label: string; value: number; tone?: "alert"; onClick?: () => void }) {
  const content = (
    <>
      <MailOpen aria-hidden="true" />
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </>
  );
  if (props.onClick) {
    return (
      <button className={`${styles.activityStat} ${props.tone === "alert" ? styles.activityStatAlert : ""}`} onClick={props.onClick}>
        {content}
      </button>
    );
  }
  return (
    <div className={`${styles.activityStat} ${props.tone === "alert" ? styles.activityStatAlert : ""}`}>
      {content}
    </div>
  );
}

function sectionDrilldown(kind: TodayTopicKind): MailDrilldown {
  if (kind === "action") return { folder: "inbox", priority: "interrupt", handled: "active" };
  if (kind === "reply") return { folder: "inbox", needsReply: true, handled: "active" };
  if (kind === "deadline") return { folder: "inbox", hasDeadline: true, handled: "active" };
  return { folder: "inbox", priority: "digest", handled: "active" };
}

function cleanupActionLabel(action: CleanupSuggestion["recommendation"]) {
  if (action === "quiet") return mailActionCopy("quiet").label;
  if (action === "unsubscribe") return mailActionCopy("unsubscribe").label;
  return mailActionCopy("mark_read").label;
}

function cleanupConfirmationLabel(action: CleanupSuggestion["recommendation"]) {
  if (action === "quiet") return mailActionCopy("quiet").confirmationLabel;
  if (action === "unsubscribe") return mailActionCopy("unsubscribe").confirmationLabel;
  return mailActionCopy("mark_read").confirmationLabel;
}

function TodaySkeleton() {
  return <div className={styles.todaySkeleton} aria-label="Preparing today's brief"><div /><div /><div /><div /></div>;
}

function formatBriefDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(date);
}

function formatDeadline(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `Due ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date)}`;
}

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1_440)}d`;
}

function initials(value: string) {
  return value.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
