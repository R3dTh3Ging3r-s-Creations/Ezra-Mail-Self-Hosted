import { createHash } from "node:crypto";
import { z } from "zod";
import type { InboxItem, NotificationPolicySettings } from "./types";
import type { NotificationKind, NotificationReasonCode } from "./notification-types";

export type AttentionDecision = {
  level: NotificationKind;
  reasonCode: NotificationReasonCode;
  ruleTrace: string[];
  critical: boolean;
  groupingKey: string;
  categoryTag: string;
  notBefore: string;
};

/** Canonical admitted interrupts only. Never pass delivery attempts or per-device rows. */
export type AttentionHistoryEvent = {
  eventId: string;
  accountId: string;
  senderEmail: string;
  admittedAt: string;
  critical: boolean;
};

export type AttentionFeedback = {
  accountId: string;
  senderEmail: string;
  kind: "useful" | "too_noisy";
  createdAt: string;
};

export type AttentionCandidateContext = {
  item: InboxItem;
  policy: NotificationPolicySettings;
  now: Date;
  feedback: readonly AttentionFeedback[];
  /** Derived locally from revision-aware completion evidence by the transaction caller. */
  handled?: boolean;
  /** Caller checks enrollment and channel feature switches. Missing means no external delivery. */
  hasEnrolledDevice?: boolean;
};

export type AttentionContext = AttentionCandidateContext & {
  history: readonly AttentionHistoryEvent[];
};

const timestampSchema = z.string().max(64).datetime({ offset: true });
const deadlineSchema = z.union([timestampSchema, z.string().date()]);

const HANDLED = new Set(["snoozed", "maintained", "spammed", "read", "cleared", "digested"]);

const EXCLUDED = new Set(["SENT", "SPAM", "TRASH"]);

const CRITICAL = new Set(["account-security", "account-compromise", "fraud", "legal"]);

const SECURITY_ALIASES: Record<string, string> = {
  "account security": "account-security",
  "security alert": "account-security",
  "security threat": "account-security",
  "account compromise": "account-compromise",
};

const ROUTINE = /(?:^|[ /-])(routine|promotion|promotional|newsletter|marketing|bulk|shopping|sale|social|discount|receipt|shipping|learned-low-priority)(?:$|[ /-])/;

export function normalizeAttentionCategory(value: string | null) {
  const normalized = (value || "").trim().toLowerCase().replace(/\s+/g, " ");
  return Object.hasOwn(SECURITY_ALIASES, normalized) ? SECURITY_ALIASES[normalized] : normalized;
}

/** Preserve explicit preference matching independently of exact critical classification. */
export function matchesNotificationCategoryPreference(category: string, candidate: string) {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normalized = normalize(category);
  const next = normalize(candidate);
  return Boolean(normalized && next && (
    normalized === next || normalized.includes(next) || next.includes(normalized)
  ));
}

function opaqueKey(kind: string, account: string, value: string) {
  return createHash("sha256").update(JSON.stringify([kind, account, value])).digest("hex");
}

function sender(value: string) {
  return value.trim().toLowerCase();
}

function localFormatter(timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function localParts(now: Date, timezone: string, formatter = localFormatter(timezone)) {
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`
  };
}

export function localAttentionDay(now: Date, timezone: string) {
  return localParts(now, timezone).day;
}

function quietAt(time: string, start: string, end: string) {
  return start > end ? time >= start || time < end : time >= start && time < end;
}

/** Minute search handles DST gaps/folds without constructing ambiguous local dates. */
export function nextAttentionTime(now: Date, timezone: string, times: readonly string[], quiet?: {
  quietStart: string;
  quietEnd: string;
}): string | null {
  const formatter = localFormatter(timezone);
  const eligibleTimes = quiet ? times.filter(time => !quietAt(time, quiet.quietStart, quiet.quietEnd)) : times;
  if (!eligibleTimes.length)
    return null;
  const start = Math.floor(now.getTime() / 60000) * 60000 + 60000;
  for (let offset = 0; offset < 3 * 24 * 60; offset++) {
    const date = new Date(start + offset * 60000);
    const { time } = localParts(date, timezone, formatter);
    if (eligibleTimes.includes(time) && (!quiet || !quietAt(time, quiet.quietStart, quiet.quietEnd)))
      return date.toISOString();
  }
  // A schedule wholly inside quiet hours has no external delivery slot.
  return null;
}

function briefDecision(decision: AttentionDecision, policy: NotificationPolicySettings, now: Date, reasonCode: NotificationReasonCode, rule: string): AttentionDecision {
  const notBefore = nextAttentionTime(now, policy.timezone, policy.digestTimes, policy);
  return {
    ...decision,
    level: notBefore ? "brief" : "in_app",
    reasonCode,
    ruleTrace: [...decision.ruleTrace, rule, ...(notBefore ? [] : ["no_delivery_slot"])].slice(0, 16),
    notBefore: notBefore || now.toISOString(),
  };
}

/** Eligibility/explicit policy phase. Reuse for group joins and claims without charging history again. */
export function evaluateAttentionCandidate(context: AttentionCandidateContext): AttentionDecision {
  const { item, policy, now } = context;
  const category = normalizeAttentionCategory(item.category);
  const decision: AttentionDecision = {
    level: "in_app",
    reasonCode: "attention",
    ruleTrace: [],
    critical: false,
    groupingKey: opaqueKey("thread", item.accountId, item.threadId || item.id),
    categoryTag: opaqueKey("category", item.accountId, category),
    notBefore: Number.isFinite(now.getTime()) ? now.toISOString() : "1970-01-01T00:00:00.000Z",
  };
  const reject = (reasonCode: NotificationReasonCode, rule: string): AttentionDecision => ({
    ...decision,
    reasonCode,
    ruleTrace: [...decision.ruleTrace, rule].slice(0, 16),
  });
  if (!Number.isFinite(now.getTime()))
    return reject("stale", "invalid_clock");
  if (!item.isUnread || context.handled || HANDLED.has(item.status.toLowerCase()))
    return reject("handled", "read_or_handled");
  if (item.mailboxLabels.some(label => EXCLUDED.has(label.toUpperCase())))
    return reject("handled", "excluded_folder");
  const received = timestampSchema.safeParse(item.receivedAt).success ? Date.parse(item.receivedAt) : NaN;
  const age = now.getTime() - received;
  if (!Number.isFinite(age) || age < 0 || age > 86400000)
    return reject("stale", "invalid_future_or_stale");
  if (item.injectionFlags.length)
    return reject("low_confidence", "injection_flags");
  if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0.8 || item.confidence > 1) {
    return reject("low_confidence", "confidence_floor");
  }
  decision.ruleTrace.push("fresh_unread_confident");
  const preferences = policy.categoryPolicies.filter(entry =>
    entry.categories.some(value => matchesNotificationCategoryPreference(item.category || "", value)),
  ).map(entry => entry.preference);
  if (preferences.includes("quiet"))
    return reject("routine", "category_quiet");
  if (item.attention === "suppress" || ROUTINE.test(category))
    return reject("routine", "routine_or_suppressed");
  const snoozed = policy.snoozedUntil && Date.parse(policy.snoozedUntil) > now.getTime();
  if (snoozed)
    return reject("snoozed", "external_snooze");
  if (!context.hasEnrolledDevice)
    return reject("attention", "no_enrolled_device");
  if (preferences.includes("digest"))
    return briefDecision(decision, policy, now, "brief", "category_digest");
  if (item.attention !== "interrupt")
    return briefDecision(decision, policy, now, "brief", "baseline_not_interrupt");
  const urgency = typeof item.urgency === "number" && Number.isFinite(item.urgency) && item.urgency >= 90 && item.urgency <= 100;
  decision.critical = CRITICAL.has(category) && urgency;
  const deadline = item.deadline && deadlineSchema.safeParse(item.deadline).success ? Date.parse(item.deadline) : NaN;
  const deadlineSoon = Number.isFinite(deadline) && deadline >= now.getTime() && deadline <= now.getTime() + 86400000;
  if (!urgency && !deadlineSoon)
    return briefDecision(decision, policy, now, "brief", "urgency_or_deadline_required");
  const feedback = context.feedback.filter(entry => entry.accountId === item.accountId && sender(entry.senderEmail) === sender(item.senderEmail)
    && Number.isFinite(Date.parse(entry.createdAt)) && Date.parse(entry.createdAt) <= now.getTime());
  feedback.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.kind === "too_noisy" ? -1 : 1));
  if (feedback[0]?.kind === "too_noisy")
    return briefDecision(decision, policy, now, "brief", "sender_too_noisy");
  const quiet = quietAt(localParts(now, policy.timezone).time, policy.quietStart, policy.quietEnd);
  if (quiet && !decision.critical)
    return briefDecision(decision, policy, now, "quiet_hours", "ordinary_quiet_hours");
  if (quiet)
    decision.ruleTrace.push("critical_quiet_bypass");
  return {
    ...decision,
    level: "interrupt",
    reasonCode: decision.critical ? "critical" : "attention",
    ruleTrace: [...decision.ruleTrace, decision.critical ? "critical_eligible" : deadlineSoon ? "deadline_eligible" : "urgency_eligible"],
    notBefore: new Date(now.getTime() + policy.burstWindowSeconds * 1000).toISOString(),
  };
}

/** Call only when creating a new canonical event, after checking for an eligible pending group. */
export function evaluateAttentionAdmission(context: AttentionContext & {
  candidate: AttentionDecision;
}): AttentionDecision {
  const { item, policy, now, candidate } = context;
  if (candidate.level !== "interrupt")
    return candidate;
  const events = [...new Map(context.history.filter(event => {
    const timestamp = Date.parse(event.admittedAt);
    return Number.isFinite(timestamp) && timestamp <= now.getTime();
  }).map(event => [event.eventId, event])).values()];
  const elapsed = (event: AttentionHistoryEvent) => (now.getTime() - Date.parse(event.admittedAt)) / 60000;
  const hold = (reason: NotificationReasonCode, rule: string) => briefDecision(candidate, policy, now, reason, rule);
  if (!candidate.critical) {
    const day = localAttentionDay(now, policy.timezone);
    const used = events.filter(event => !event.critical && localAttentionDay(new Date(event.admittedAt), policy.timezone) === day).length;
    if (used >= policy.dailyInterruptBudget)
      return hold("over_budget", "ordinary_daily_budget");
  }
  if (candidate.critical && events.filter(event => event.critical && elapsed(event) < 15).length >= 2)
    return hold("burst", "critical_rolling_cap");
  const senderCooldown = candidate.critical ? 20 : policy.senderCooldownMinutes;
  if (events.some(event => event.accountId === item.accountId && sender(event.senderEmail) === sender(item.senderEmail) && elapsed(event) < senderCooldown)) {
    return hold("cooldown", "sender_cooldown");
  }
  if (!candidate.critical && events.some(event => elapsed(event) < 90))
    return hold("cooldown", "general_cooldown");
  return {
    ...candidate,
    ruleTrace: [...candidate.ruleTrace, "new_event_admitted"].slice(0, 16)
  };
}

export function evaluateAttention(context: AttentionContext): AttentionDecision {
  return evaluateAttentionAdmission({
    ...context,
    candidate: evaluateAttentionCandidate(context)
  });
}
