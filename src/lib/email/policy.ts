import type { AttentionLevel, TriageInput, TriageResult } from "./types";

const criticalCategories = new Set([
  "account-security",
  "fraud",
  "legal",
  "account-compromise",
]);

export function attentionForUrgency(urgency: number): AttentionLevel {
  if (urgency >= 80) return "interrupt";
  if (urgency >= 45) return "digest";
  return "suppress";
}

export function isQuietTime(
  date: Date,
  timezone = "America/Chicago",
  quietStart = "22:00",
  quietEnd = "07:00",
) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  const current = hour * 60 + minute;
  const [startHour, startMinute] = quietStart.split(":").map(Number);
  const [endHour, endMinute] = quietEnd.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return start > end ? current >= start || current < end : current >= start && current < end;
}

export function applyDeterministicPolicy(
  result: TriageResult,
  now = new Date(),
  options: {
    timezone?: string;
    quietStart?: string;
    quietEnd?: string;
  } = {},
): TriageResult {
  const normalized: TriageResult = {
    ...result,
    urgency: clamp(Math.round(result.urgency), 0, 100),
    confidence: clamp(result.confidence, 0, 1),
    injectionFlags: Array.from(new Set(result.injectionFlags)).slice(0, 10),
  };
  normalized.attention = attentionForUrgency(normalized.urgency);

  const category = normalized.category.toLowerCase();
  const promotional = /(promotion|newsletter|marketing|bulk|shopping|sale|social)/.test(category);
  const protectedOrTransactional =
    criticalCategories.has(category) ||
    /(receipt|transaction|invoice|payment|shipping|appointment|job|medical|financial|security)/.test(
      category,
    );
  if (promotional && !protectedOrTransactional && !normalized.criticalReason) {
    normalized.urgency = Math.min(normalized.urgency, 35);
    normalized.attention = "suppress";
    normalized.needsReply = false;
    normalized.reason = `${normalized.reason} Promotional urgency language was not treated as a real deadline.`;
  }

  if (
    normalized.confidence < 0.45 &&
    normalized.attention === "interrupt" &&
    !normalized.criticalReason &&
    !criticalCategories.has(normalized.category)
  ) {
    normalized.attention = "digest";
    normalized.reason = `${normalized.reason} Low model confidence prevented an interruption.`;
  }

  const quiet = isQuietTime(
    now,
    options.timezone,
    options.quietStart,
    options.quietEnd,
  );
  if (quiet && normalized.attention === "interrupt" && !canBypassQuietHours(normalized, now)) {
    normalized.attention = "digest";
    normalized.reason = `${normalized.reason} Held for digest during quiet hours.`;
  }

  return normalized;
}

export function deterministicFallback(input: TriageInput): TriageResult {
  const headlineText = [
    input.senderName,
    input.senderEmail,
    input.subject,
    input.snippet,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const text = [
    headlineText,
    input.bodyText,
    input.attachmentText,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  let urgency = 28;
  let category = "general";
  let needsReply = false;
  let reason = "No reliable local model response was available, so conservative rules were used.";

  const securitySignal =
    /(security alert|new sign[- ]?in|sign[- ]?in needs (your )?review|suspicious (sign[- ]?in|activity)|unrecognized sign[- ]?in|unauthorized (access|sign[- ]?in|login|transaction)|password (changed|reset)|verify your (account|identity)|account (locked|compromised))/i;

  if (
    securitySignal.test(headlineText) ||
    (securitySignal.test(text) && !isPromotionalFinancialOffer(text))
  ) {
    urgency = 92;
    category = "account-security";
    reason = "The message contains account or security warning language.";
  } else if (
    /(past due|final notice|subpoena|court order|legal notice|notice of legal action|fraud alert|chargeback|payment failed)/i.test(
      text,
    )
  ) {
    urgency = 88;
    category = /(subpoena|court order|legal notice|legal action)/i.test(text)
      ? "legal"
      : "finance";
    reason = "The message contains a high-consequence financial or legal signal.";
  } else if (/(deadline|due today|due tomorrow|action required|respond by)/i.test(text)) {
    urgency = 76;
    category = "deadline";
    reason = "The message appears to contain a near-term action or deadline.";
  } else if (/(newsletter|unsubscribe|promotion|sale ends|weekly digest)/i.test(text)) {
    urgency = 18;
    category = "newsletter";
    reason = "The message appears informational or promotional.";
  }

  if (/(can you|could you|please reply|please confirm|let me know|rsvp)/i.test(text)) {
    needsReply = true;
    urgency = Math.max(urgency, 52);
  }

  const injectionFlags = detectPromptInjection(text);
  return {
    attention: attentionForUrgency(urgency),
    urgency,
    confidence: 0.38,
    category,
    summary: input.snippet.slice(0, 320) || input.subject,
    reason,
    recommendation: needsReply
      ? "Review the message and prepare a response."
      : "Review when the assigned priority allows.",
    needsReply,
    deadline: null,
    draftReply: null,
    injectionFlags,
    criticalReason: criticalCategories.has(category) ? category : null,
  };
}

export function detectPromptInjection(text: string) {
  const flags: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/ignore (all|any|the) (previous|prior|system) instructions/i, "instruction-override"],
    [/(reveal|print|send|upload).*(secret|token|password|credential|environment)/i, "secret-request"],
    [/(run|execute|open).*(command|powershell|shell|terminal|browser)/i, "tool-request"],
    [/(system prompt|developer message|hidden instructions)/i, "prompt-exfiltration"],
    [/(mark this safe|bypass approval|send without approval)/i, "approval-bypass"],
  ];
  for (const [pattern, flag] of checks) {
    if (pattern.test(text)) flags.push(flag);
  }
  return flags;
}

function isPromotionalFinancialOffer(text: string) {
  const financialMarketing = /(cash rewards?|intro bonuses?|credit card|business purchasing|business card|purchase power|balance transfer|apr|pre[- ]?approved)/i.test(
    text,
  );
  const promoSignals = [
    /unsubscribe/i,
    /promotion|promotional/i,
    /offer|bonus|reward/i,
    /apply now|learn more|get started/i,
    /advertisement|marketing/i,
  ].filter((pattern) => pattern.test(text)).length;
  return financialMarketing && promoSignals >= 2;
}

function canBypassQuietHours(result: TriageResult, now: Date) {
  if (result.criticalReason || criticalCategories.has(result.category)) return true;
  if (!result.deadline) return false;
  const deadline = new Date(result.deadline);
  if (Number.isNaN(deadline.getTime())) return false;
  const hours = (deadline.getTime() - now.getTime()) / 3_600_000;
  return hours >= 0 && hours <= 8;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
