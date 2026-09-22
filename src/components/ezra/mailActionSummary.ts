import type { MailActionResult } from "@/lib/email/types";
import { mailActionCopy } from "@/lib/email/vocabulary";

export type MailActionSummary = {
  headline: string;
  detailLines: string[];
  retryGuidance: string | null;
  variant: "success" | "partial" | "error" | "info";
  changedCount: number;
  unchangedCount: number;
  failedCount: number;
  hasDetails: boolean;
};

export function summarizeMailActionResult(result: MailActionResult, successHeadline?: string): MailActionSummary {
  const changedCount = result.changedIds?.length ?? result.successCount;
  const unchangedCount = result.unchangedIds?.length || 0;
  const failedCount = result.failureCount;
  const firstFailure = friendlyFailure(result.failures[0]?.error || "");
  const savedPreferenceCount = result.savedPreferences?.length || 0;
  const variant: MailActionSummary["variant"] = failedCount
    ? changedCount || unchangedCount ? "partial" : "error"
    : changedCount || savedPreferenceCount ? "success" : "info";

  const detailLines: string[] = [];
  if (changedCount) detailLines.push(`Changed: ${changedCount} ${messageNoun(changedCount)} ${actionPhrase(result.action)}.`);
  if (unchangedCount) detailLines.push(`Unchanged: ${unchangedCount} ${messageNoun(unchangedCount)} already ${unchangedPhrase(result.action)}.`);
  if (savedPreferenceCount) detailLines.push(`Learned: ${savedPreferenceCount} care preference${savedPreferenceCount === 1 ? "" : "s"} saved.`);
  if (failedCount) {
    const failureText = firstFailure ? ` — ${trimTerminalPunctuation(firstFailure)}` : "";
    detailLines.push(`Failed: ${failedCount} ${messageNoun(failedCount)} could not be changed${failureText}.`);
  }

  const headline = headlineForResult({
    result,
    changedCount,
    unchangedCount,
    failedCount,
    firstFailure,
    savedPreferenceCount,
    successHeadline,
  });
  const retryGuidance = failedCount ? retryGuidanceFor(result.failures.map((failure) => failure.error).join("\n")) : null;

  return {
    headline,
    detailLines,
    retryGuidance,
    variant,
    changedCount,
    unchangedCount,
    failedCount,
    hasDetails: detailLines.length > 1 || Boolean(retryGuidance) || failedCount > 0,
  };
}

function headlineForResult(input: {
  result: MailActionResult;
  changedCount: number;
  unchangedCount: number;
  failedCount: number;
  firstFailure: string;
  savedPreferenceCount: number;
  successHeadline?: string;
}) {
  const { result, changedCount, unchangedCount, failedCount, firstFailure, savedPreferenceCount, successHeadline } = input;
  if (failedCount) {
    if (!changedCount && !unchangedCount) return firstFailure || `${failedCount} ${messageNoun(failedCount)} could not be changed.`;
    const parts = [`${changedCount} changed`];
    if (unchangedCount) parts.push(`${unchangedCount} unchanged`);
    parts.push(`${failedCount} failed`);
    return `Partial action: ${parts.join(", ")}.`;
  }
  if (successHeadline) return successHeadline;
  if (!changedCount && unchangedCount) {
    return `${unchangedCount === 1 ? "This message was" : `${unchangedCount} messages were`} already ${unchangedPhrase(result.action)}.`;
  }
  if (changedCount && unchangedCount) {
    return `${changedCount} changed; ${unchangedCount} already ${unchangedPhrase(result.action)}.`;
  }
  if (result.action === "teach_care") {
    return savedPreferenceCount
      ? `Ezra learned ${savedPreferenceCount} care preference${savedPreferenceCount === 1 ? "" : "s"}.`
      : `${result.successCount} care correction saved.`;
  }
  if (result.action === "done" || result.action === "mark_read") return `${result.successCount} acknowledged.`;
  if (result.action === "keep") return `${result.successCount} kept useful.`;
  if (result.action === "raise_priority") return `${result.successCount} changed to Care more.`;
  if (result.action === "lower_priority") return `${result.successCount} changed to Care less.`;
  if (result.action === "quiet") return `${result.successCount} quieted sender and learned.`;
  if (result.action === "unsubscribe") return `Unsubscribed from ${result.successCount} ${messageNoun(result.successCount)}.`;
  if (result.action === "spam") return `${result.successCount} moved to spam.`;
  if (result.action === "delete") return `${result.successCount} moved to Trash.`;
  if (result.action === "delete_and_teach") return `${result.successCount} moved to Trash and learned.`;
  if (result.action === "undo") return `${result.successCount} restored.`;
  return `${result.successCount} ${actionPhrase(result.action)}.`;
}

export function friendlyFailure(error: string) {
  if (!error) return "";
  if (/Reconnect Hotmail/i.test(error)) {
    return "Reconnect Hotmail from Settings to grant Microsoft Mail.ReadWrite access.";
  }
  if (/Protected mail was excluded/i.test(error)) {
    return "Protected mail was excluded from this cleanup action.";
  }
  const withoutTrace = error.split(/\s+Trace ID:/i)[0]?.trim() || error;
  return withoutTrace.length > 180 ? `${withoutTrace.slice(0, 177)}...` : withoutTrace;
}

function retryGuidanceFor(errorText: string) {
  if (/Reconnect Hotmail|Mail\.ReadWrite|Calendars\.ReadWrite|permission|scope|AADSTS/i.test(errorText)) {
    return "Reconnect or upgrade the account permissions in Settings, then retry.";
  }
  if (/not found|missing|stale/i.test(errorText)) {
    return "Refresh Mail to clear stale selections, then try again if the message still appears.";
  }
  if (/Protected mail was excluded/i.test(errorText)) {
    return "This exclusion is intentional. Open the protected message and decide manually.";
  }
  return "Check the account connection and retry only if the selected messages still look correct.";
}

function actionPhrase(action: MailActionResult["action"]) {
  return mailActionCopy(action).pastTense;
}

function unchangedPhrase(action: MailActionResult["action"]) {
  return mailActionCopy(action).unchanged;
}

function messageNoun(count: number) {
  return count === 1 ? "message" : "messages";
}

function trimTerminalPunctuation(value: string) {
  return value.replace(/[.!?]+$/g, "");
}
