import { getAccountFreshness } from "./account-health";
import { getActionCenter } from "./action-center";
import { getActivityTimeline } from "./activity";
import { listBriefMemory, reconcileBriefMemory } from "./brief-memory";
import { getCalendarPage } from "./calendar";
import { calendarEventOverlapsDate, localDayRange } from "./calendar-day";
import { briefItemStateTimestamp } from "./brief-item-state";
import { getSetting, nowIso } from "./database";
import { getMailTodaySnapshot } from "./professional";
import {
  reconcileExternalReplyEvidence,
  type ExternalReplyEvidenceResult,
} from "./sent-evidence";
import type {
  AccountFreshnessPage,
  AccountProvider,
  ActionCenterPage,
  ActivityTimelinePage,
  BriefCandidate,
  BriefMemoryView,
  CalendarPage,
  LivingBriefItem,
  MailTodaySnapshot,
  TodayBrief,
  TodayBriefSource,
  TodayBriefSourceStatus,
} from "./types";
import { ALL_WORKSPACE_ID, resolveBriefWorkspace } from "./workspaces";

const DEFAULT_TIMEZONE = "America/Chicago";
const CALENDAR_STALE_MS = 10 * 60_000;
const ACTIVITY_LIMIT = 40;

type Settled<T> = PromiseSettledResult<T>;

type TodaySources = {
  mail: Settled<MailTodaySnapshot>;
  calendar: Settled<CalendarPage>;
  actions: Settled<ActionCenterPage>;
  activity: Settled<ActivityTimelinePage>;
  freshness: Settled<AccountFreshnessPage>;
};

type ComposeInput = {
  workspaceId: string;
  accountIds: string[];
  generatedAt: string;
  timezone: string;
  date: string;
  sources: TodaySources;
  memory: BriefMemoryView;
  currentSourceKeys: Set<string>;
  sent: Settled<ExternalReplyEvidenceResult>;
  sentSkipped: TodayBriefSourceStatus[];
};

export async function getTodayBrief(
  input: { workspaceId?: string } = {},
): Promise<TodayBrief> {
  const page = await collectTodayBrief(input, false);
  const { getMorningBriefData } = await import("./morning-brief-view");
  return { ...page, ...await getMorningBriefData(page.workspaceId, page.generatedAt, page) };
}

/** Compose synchronized local data without initiating provider or Sent reads. */
export async function getLocalTodayBrief(input: { workspaceId: string; now: string }): Promise<TodayBrief> {
  return collectTodayBrief(input, true);
}

async function collectTodayBrief(input: { workspaceId?: string; now?: string }, localOnly: boolean): Promise<TodayBrief> {
  const workspace = await resolveBriefWorkspace(input.workspaceId);
  const workspaceId = workspace.id;
  const generatedAt = input.now || nowIso();
  const timezone = (await getSetting("timezone")) || DEFAULT_TIMEZONE;
  const day = localDayRange(timezone, new Date(generatedAt));
  const sources = await settleTodaySources(workspaceId, {
    generatedAt,
    timezone,
    from: day.startIso,
    to: day.endIso,
  });
  const candidates = collectCandidates({
    accountIds: workspace.accountIds,
    isAllAccounts: workspaceId === ALL_WORKSPACE_ID,
    sources,
    generatedAt,
    timezone,
    date: day.date,
  });
  const reconciled = await reconcileBriefMemory({
    workspaceId,
    candidates,
    now: generatedAt,
  });
  const replySourceKeys = new Set(
    sources.mail.status === "fulfilled"
      ? sources.mail.value.replyCandidates.map((candidate) => candidate.sourceKey)
      : [],
  );
  const openReplies = reconciled.current.filter((item) => (
    item.state === "open"
    && item.sourceType === "mail_thread"
    && replySourceKeys.has(item.sourceKey)
  ));
  const sentEligibility = partitionSentEligible(openReplies, sources, generatedAt);
  let sent: Settled<ExternalReplyEvidenceResult>;
  try {
    sent = {
      status: "fulfilled",
      value: localOnly ? { completedSourceKeys: [], accountHealth: [] } : await reconcileExternalReplyEvidence({
        workspaceId,
        openReplies: sentEligibility.eligible,
        now: generatedAt,
      }),
    };
  } catch (reason) {
    sent = { status: "rejected", reason };
  }
  const memory = await listBriefMemory(workspaceId, generatedAt);
  return composeTodayBrief({
    workspaceId,
    accountIds: workspace.accountIds,
    generatedAt,
    timezone,
    date: day.date,
    sources,
    memory,
    currentSourceKeys: new Set(candidates.map((candidate) => candidate.sourceKey)),
    sent,
    sentSkipped: localOnly ? [{source: "sent", status: "unavailable", accountId: null, checkedAt: generatedAt, detail: "Only previously stored completion evidence is used in this brief."}] : sentEligibility.skipped,
  });
}

async function settleTodaySources(
  workspaceId: string,
  day: { generatedAt: string; timezone: string; from: string; to: string },
): Promise<TodaySources> {
  const [mail, calendar, actions, activity, freshness] = await Promise.allSettled([
    getMailTodaySnapshot({ workspaceId, timezone: day.timezone, now: day.generatedAt }),
    getCalendarPage({ workspaceId, from: day.from, to: day.to, sync: false }),
    getActionCenter({ workspaceId, includeCleanup: false }),
    getActivityTimeline({ workspaceId, limit: ACTIVITY_LIMIT }),
    getAccountFreshness(),
  ]);
  return { mail, calendar, actions, activity, freshness };
}

function composeTodayBrief(input: ComposeInput): TodayBrief {
  const timezone = input.timezone;
  const date = input.date;
  const mail = input.sources.mail.status === "fulfilled"
    ? input.sources.mail.value
    : emptyMailSnapshot(input.workspaceId, date, input.generatedAt);
  const openItems = input.memory.items;
  const agenda = openItems
    .filter((item) => item.role === "agenda" && input.currentSourceKeys.has(item.sourceKey))
    .map((item) => {
      const event = input.sources.calendar.status === "fulfilled" ? input.sources.calendar.value.events.find(event => `calendar:${event.accountId}:${event.externalEventId}` === item.sourceKey && event.accountId === item.sourceAccountId) : null;
      return event ? {...item,summary:calendarSummary(event,timezone)} : item;
    })
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.sourceKey.localeCompare(right.sourceKey));
  const needsAttention = openItems
    .filter((item) => (
      item.role === "attention"
      && input.currentSourceKeys.has(item.sourceKey)
      && (
        localDate(item.firstSeenAt, timezone) === date
        || (item.restoredAt !== null && localDate(item.restoredAt, timezone) === date)
      )
    ))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.sourceKey.localeCompare(right.sourceKey));
  const shown = new Set([...agenda, ...needsAttention].map((item) => item.id));
  const carryovers = openItems
    .filter((item) => item.role === "attention" && !shown.has(item.id))
    .sort((left, right) => left.firstSeenAt.localeCompare(right.firstSeenAt) || left.sourceKey.localeCompare(right.sourceKey));
  const completedSinceLastBrief = [...input.memory.completedToday]
    .sort((left, right) => briefItemStateTimestamp(right).localeCompare(briefItemStateTimestamp(left)) || left.sourceKey.localeCompare(right.sourceKey));
  return {
    ...mail,
    workspaceId: input.workspaceId,
    sourceStatus: sourceStatuses(input),
    agenda,
    needsAttention,
    carryovers,
    completedSinceLastBrief,
  };
}

function collectCandidates(input: {
  accountIds: string[];
  isAllAccounts: boolean;
  sources: TodaySources;
  generatedAt: string;
  timezone: string;
  date: string;
}) {
  const allowed = new Set(input.accountIds);
  const candidates: BriefCandidate[] = [];
  if (input.sources.mail.status === "fulfilled") {
    candidates.push(...input.sources.mail.value.briefCandidates.filter((candidate) => (
      candidate.sourceAccountId !== null && allowed.has(candidate.sourceAccountId)
    )));
  }
  const timezone = input.timezone;
  const date = input.date;
  if (input.sources.calendar.status === "fulfilled") {
    for (const event of input.sources.calendar.value.events) {
      if (
        !allowed.has(event.accountId)
        || !calendarEventOverlapsDate(event, date, timezone)
      ) continue;
      const revisionAt = canonicalOrNull(event.updatedAt || event.startsAt);
      const occurredAt = canonicalOrNull(event.startsAt);
      if (!revisionAt || !occurredAt || !event.id.trim() || !event.externalEventId.trim()) continue;
      candidates.push({
        sourceType: "calendar_event",
        sourceKey: `calendar:${event.accountId}:${event.externalEventId}`,
        sourceAccountId: event.accountId,
        provider: event.accountProvider,
        providerThreadId: null,
        revisionAt,
        occurredAt,
        role: "agenda",
        title: event.title,
        summary: calendarSummary(event, timezone),
        target: {
          view: "calendar",
          eventId: event.id,
          date,
        },
      });
    }
  }
  if (input.sources.actions.status === "fulfilled") {
    for (const section of input.sources.actions.value.sections) {
      if (section.id !== "approvals" && section.id !== "repairs") continue;
      for (const item of section.items) {
        if (item.accountId === null) {
          if (!input.isAllAccounts) continue;
          const revisionAt = canonicalOrNull(item.updatedAt);
          if (!revisionAt) continue;
          candidates.push({
            sourceType: "action_center",
            sourceKey: `action:${item.id}`,
            sourceAccountId: null,
            provider: null,
            providerThreadId: null,
            revisionAt,
            occurredAt: revisionAt,
            role: "attention",
            title: item.title,
            summary: item.detail || item.subtitle,
            target: item.target,
          });
          continue;
        }
        if (!allowed.has(item.accountId)) continue;
        const revisionAt = canonicalOrNull(item.updatedAt);
        if (!revisionAt) continue;
        const provider = providerForAccount(item.accountId, input.sources);
        if (!provider) continue;
        candidates.push({
          sourceType: "action_center",
          sourceKey: `action:${item.id}`,
          sourceAccountId: item.accountId,
          provider,
          providerThreadId: null,
          revisionAt,
          occurredAt: revisionAt,
          role: "attention",
          title: item.title,
          summary: item.detail || item.subtitle,
          target: item.target,
        });
      }
    }
  }
  return uniqueCandidates(candidates);
}

function providerForAccount(accountId: string, sources: TodaySources): AccountProvider | null {
  if (sources.mail.status === "fulfilled") {
    const candidate = sources.mail.value.briefCandidates.find((item) => item.sourceAccountId === accountId);
    if (candidate?.provider) return candidate.provider;
  }
  if (sources.calendar.status === "fulfilled") {
    const account = sources.calendar.value.accounts.find((item) => item.accountId === accountId);
    if (account) return account.provider;
  }
  if (sources.freshness.status === "fulfilled") {
    const account = sources.freshness.value.items.find((item) => item.accountId === accountId);
    if (account) return account.accountProvider;
  }
  if (sources.actions.status === "fulfilled") {
    for (const section of sources.actions.value.sections) {
      const item = section.items.find((candidate) => candidate.accountId === accountId);
      if (item?.accountProvider) return item.accountProvider;
    }
  }
  return null;
}

function partitionSentEligible(
  openReplies: LivingBriefItem[],
  sources: TodaySources,
  generatedAt: string,
): { eligible: LivingBriefItem[]; skipped: TodayBriefSourceStatus[] } {
  const byAccount = new Map<string, LivingBriefItem[]>();
  for (const item of openReplies) {
    if (!item.sourceAccountId) continue;
    const group = byAccount.get(item.sourceAccountId) || [];
    group.push(item);
    byAccount.set(item.sourceAccountId, group);
  }
  const eligible: LivingBriefItem[] = [];
  const skipped: TodayBriefSourceStatus[] = [];
  for (const [accountId, items] of [...byAccount.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const blocked = sentInboundBlock(accountId, items[0].provider, sources, generatedAt);
    if (blocked) {
      skipped.push(status("sent", blocked.value, accountId, blocked.checkedAt, blocked.detail));
    } else {
      eligible.push(...items);
    }
  }
  return { eligible, skipped };
}

function sentInboundBlock(
  accountId: string,
  provider: AccountProvider | null,
  sources: TodaySources,
  generatedAt: string,
): {
  value: "stale" | "unavailable" | "error";
  checkedAt: string | null;
  detail: string;
} | null {
  if (sources.mail.status === "rejected") {
    return {
      value: "error",
      checkedAt: generatedAt,
      detail: "Sent proof was skipped because current inbound mail is unavailable.",
    };
  }
  if (sources.freshness.status === "rejected") {
    return {
      value: "stale",
      checkedAt: generatedAt,
      detail: "Sent proof was skipped until inbound mail freshness can be confirmed.",
    };
  }
  const freshness = sources.freshness.value.items.find((item) => item.accountId === accountId);
  if (!freshness || freshness.accountProvider !== provider) {
    return {
      value: "unavailable",
      checkedAt: sources.freshness.value.generatedAt,
      detail: "Sent proof was skipped because this account has no current inbound mail status.",
    };
  }
  const mailIssue = freshness.issues?.find((issue) => issue.feature === "mail");
  if (
    freshness.status === "error"
    || mailIssue?.status === "error"
    || mailIssue?.reconnectRecommended
    || (!freshness.issues && freshness.reconnectRecommended)
  ) {
    return {
      value: "error",
      checkedAt: freshness.lastSuccessfulPollAt,
      detail: "Sent proof was skipped because inbound mail needs attention for this account.",
    };
  }
  if (
    freshness.status !== "connected"
    || mailIssue?.status === "needs_setup"
  ) {
    return {
      value: "unavailable",
      checkedAt: freshness.lastSuccessfulPollAt,
      detail: "Sent proof was skipped until inbound mail is connected for this account.",
    };
  }
  if (
    !freshness.lastSuccessfulPollAt
    || !freshness.nextExpectedCheckAt
    || !Number.isFinite(Date.parse(freshness.nextExpectedCheckAt))
    || Date.parse(freshness.nextExpectedCheckAt) < Date.parse(generatedAt)
  ) {
    return {
      value: "stale",
      checkedAt: freshness.lastSuccessfulPollAt,
      detail: "Sent proof was skipped because inbound mail is showing a stale cached revision.",
    };
  }
  return null;
}

function sourceStatuses(input: ComposeInput): TodayBriefSourceStatus[] {
  const statuses = [
    mailStatus(input),
    calendarStatus(input),
    settlementStatus("action_center", input.sources.actions, input.generatedAt),
    settlementStatus("activity", input.sources.activity, input.generatedAt),
    freshnessStatus(input),
  ];
  statuses.push(...input.sentSkipped);
  if (input.sent.status === "rejected") {
    statuses.push(status("sent", "error", null, input.generatedAt, "Sent-folder evidence could not be checked."));
  } else if (!input.sent.value.accountHealth.length && !input.sentSkipped.length) {
    statuses.push(status("sent", "current", null, input.generatedAt, "No open reply evidence needed checking."));
  } else {
    for (const account of [...input.sent.value.accountHealth].sort((left, right) => left.accountId.localeCompare(right.accountId))) {
      statuses.push(status(
        "sent",
        account.status,
        account.accountId,
        account.lastAttemptedAt,
        account.status === "truncated"
          ? "Sent results reached the safe cap; exact returned matches remain usable."
          : account.status === "error"
            ? "Sent-folder evidence is temporarily unavailable for this account."
            : null,
      ));
    }
  }
  return statuses;
}

function mailStatus(input: ComposeInput): TodayBriefSourceStatus {
  if (input.sources.mail.status === "rejected") {
    return status("mail", "error", null, input.generatedAt, "Mail is temporarily unavailable.");
  }
  if (input.sources.freshness.status === "rejected") {
    return status("mail", "stale", null, input.generatedAt, "Mail is showing the last cached state.");
  }
  const allowed = new Set(input.accountIds);
  const items = input.sources.freshness.value.items.filter((item) => allowed.has(item.accountId));
  if (!items.length) {
    return status("mail", "unavailable", null, input.generatedAt, "No active mail account is available in this workspace.");
  }
  if (items.some((item) => {
    const mailIssue = item.issues?.find((issue) => issue.feature === "mail");
    return item.status === "error"
      || mailIssue?.status === "error"
      || mailIssue?.reconnectRecommended
      || (!item.issues && item.reconnectRecommended);
  })) {
    return status("mail", "error", null, input.generatedAt, "One or more selected mail accounts need attention.");
  }
  if (items.some((item) => (
    !item.lastSuccessfulPollAt
    || !item.nextExpectedCheckAt
    || !Number.isFinite(Date.parse(item.nextExpectedCheckAt))
    || Date.parse(item.nextExpectedCheckAt) < Date.parse(input.generatedAt)
  ))) {
    return status("mail", "stale", null, input.generatedAt, "Mail is showing the last successfully observed provider state.");
  }
  return status("mail", "current", null, input.generatedAt, null);
}

function settlementStatus(
  source: TodayBriefSource,
  settled: Settled<unknown>,
  checkedAt: string,
): TodayBriefSourceStatus {
  return settled.status === "fulfilled"
    ? status(source, "current", null, checkedAt, null)
    : status(source, "error", null, checkedAt, `${sourceLabel(source)} is temporarily unavailable.`);
}

function calendarStatus(input: ComposeInput): TodayBriefSourceStatus {
  if (input.sources.calendar.status === "rejected") {
    return status("calendar", "error", null, input.generatedAt, "Calendar is temporarily unavailable.");
  }
  const allowed = new Set(input.accountIds);
  const accounts = input.sources.calendar.value.accounts.filter((account) => allowed.has(account.accountId));
  if (!accounts.length) {
    return status("calendar", "unavailable", null, input.generatedAt, "Calendar access is not available in this workspace.");
  }
  if (accounts.some((account) => account.calendarStatus === "error")) {
    return status("calendar", "error", null, input.generatedAt, "Calendar needs attention for one or more accounts.");
  }
  if (accounts.some((account) => account.calendarStatus === "needs_setup" || account.calendarAccess === "none")) {
    return status("calendar", "unavailable", null, input.generatedAt, "Calendar access is not set up for one or more accounts.");
  }
  const now = Date.parse(input.generatedAt);
  if (accounts.some((account) => (
    account.calendarStatus === "syncing"
    || !account.lastSyncAt
    || !Number.isFinite(Date.parse(account.lastSyncAt))
    || now - Date.parse(account.lastSyncAt) > CALENDAR_STALE_MS
  ))) {
    return status("calendar", "stale", null, input.generatedAt, "Calendar is showing its last cached state.");
  }
  return status("calendar", "current", null, input.generatedAt, null);
}

function freshnessStatus(input: ComposeInput): TodayBriefSourceStatus {
  if (input.sources.freshness.status === "rejected") {
    return status("freshness", "error", null, input.generatedAt, "Account freshness is temporarily unavailable.");
  }
  const allowed = new Set(input.accountIds);
  const items = input.sources.freshness.value.items.filter((item) => allowed.has(item.accountId));
  if (!items.length) {
    return status("freshness", "unavailable", null, input.generatedAt, "No active account health is available in this workspace.");
  }
  if (items.some((item) => item.status === "error" || item.reconnectRecommended)) {
    return status("freshness", "error", null, input.generatedAt, "One or more selected accounts need attention.");
  }
  if (items.some((item) => (
    !item.lastSuccessfulPollAt
    || !item.nextExpectedCheckAt
    || !Number.isFinite(Date.parse(item.nextExpectedCheckAt))
    || Date.parse(item.nextExpectedCheckAt) < Date.parse(input.generatedAt)
  ))) {
    return status("freshness", "stale", null, input.generatedAt, "Mail is showing the last successfully observed provider state.");
  }
  return status("freshness", "current", null, input.generatedAt, null);
}

function status(
  source: TodayBriefSource,
  value: TodayBriefSourceStatus["status"],
  accountId: string | null,
  checkedAt: string | null,
  detail: string | null,
): TodayBriefSourceStatus {
  return { source, status: value, accountId, checkedAt, detail };
}

function sourceLabel(source: TodayBriefSource) {
  if (source === "action_center") return "Action Center";
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function emptyMailSnapshot(
  workspaceId: string,
  date: string,
  generatedAt: string,
): MailTodaySnapshot {
  return {
    id: `living:${workspaceId}:${date}`,
    date,
    generatedAt,
    quietReviewed: 0,
    mailActivity: {
      receivedToday: 0,
      handledToday: 0,
      unhandledToday: 0,
      attentionCounts: { interrupt: 0, digest: 0, suppress: 0, unknown: 0 },
      stillNeedsAttention: 0,
      categoryCounts: [],
      lastPollAt: null,
      lastPollError: null,
    },
    topics: [],
    cleanup: [],
    oneMoreGlance: [],
    history: { generatedAt, sections: [] },
    counts: { action: 0, reply: 0, deadline: 0, fyi: 0 },
    briefCandidates: [],
    replyCandidates: [],
  };
}

function uniqueCandidates(candidates: BriefCandidate[]) {
  const unique = new Map<string, BriefCandidate>();
  for (const candidate of candidates) {
    const prior = unique.get(candidate.sourceKey);
    if (!prior || candidate.revisionAt > prior.revisionAt) unique.set(candidate.sourceKey, candidate);
  }
  return [...unique.values()].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

function calendarSummary(event: CalendarPage["events"][number], timezone: string) {
  const format = (value: string) => new Intl.DateTimeFormat("en-US", {timeZone:timezone,hour:"numeric",minute:"2-digit"}).format(new Date(value));
  const parts = [event.isAllDay ? "All day" : `${format(event.startsAt)} – ${format(event.endsAt)}`, event.accountLabel];
  if (event.location?.trim()) parts.push(event.location.trim());
  return parts.join(" · ");
}

function canonicalOrNull(value: string | null | undefined) {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

function localDate(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
