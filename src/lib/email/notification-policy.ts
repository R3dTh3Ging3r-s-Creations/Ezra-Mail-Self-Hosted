import { isQuietTime } from "./policy";
import type { InboxItem } from "./types";

export type BriefDeliveryMode = "morning" | "afternoon" | "manual";

type NudgeContext = {
  item: InboxItem;
  now?: Date;
  timezone?: string;
  quietStart?: string;
  quietEnd?: string;
  lastAnySentAt?: string | null;
  lastSenderSentAt?: string | null;
};

const CRITICAL_CATEGORY = /(account-security|account-compromise|security threat|fraud|legal)/i;
const EXCLUDED_LABELS = new Set(["SPAM", "TRASH", "SENT"]);

export function evaluateInterruptNudge(context: NudgeContext) {
  const { item } = context;
  const now = context.now || new Date();
  if (!item.isUnread) return skip("The message is already read.");
  if (item.attention !== "interrupt") return skip("The message belongs in the next brief.");
  if (item.mailboxLabels.some((label) => EXCLUDED_LABELS.has(label))) {
    return skip("Sent, spam, and trash mail never trigger nudges.");
  }

  const receivedAt = new Date(item.receivedAt);
  const ageHours = (now.getTime() - receivedAt.getTime()) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours > 24) {
    return skip("Stale mail stays in Today instead of creating a late interruption.");
  }

  const critical = CRITICAL_CATEGORY.test(item.category || "");
  const deadlineHours = hoursUntil(item.deadline, now);
  const deadlineSoon = deadlineHours !== null && deadlineHours >= 0 && deadlineHours <= 24;
  if (!critical && Number(item.urgency || 0) < 90 && !deadlineSoon) {
    return skip("Only critical, exceptionally urgent, or next-day deadline mail triggers a nudge.");
  }

  const quiet = isQuietTime(
    now,
    context.timezone || "America/Chicago",
    context.quietStart || "22:00",
    context.quietEnd || "07:30",
  );
  if (quiet && !critical) return skip("Held for the morning brief during quiet hours.");

  const senderCooldownMinutes = critical ? 20 : 360;
  if (minutesSince(context.lastSenderSentAt, now) < senderCooldownMinutes) {
    return skip("A recent nudge from this sender is still fresh.");
  }
  if (!critical && minutesSince(context.lastAnySentAt, now) < 90) {
    return skip("Ezra is observing the general nudge cooldown.");
  }

  return {
    send: true,
    reason: critical
      ? "A fresh critical message may interrupt quiet hours."
      : deadlineSoon
        ? "A fresh message has a deadline within 24 hours."
        : "A fresh message crossed the exceptional urgency threshold.",
  };
}

export function evaluateBriefDelivery(
  items: InboxItem[],
  mode: BriefDeliveryMode,
  now = new Date(),
) {
  if (!items.length) return skip("No brief-ready messages.");
  if (mode !== "afternoon") return { send: true, reason: "Brief-ready mail is available." };

  const materiallyUseful = items.some((item) => {
    const deadlineHours = hoursUntil(item.deadline, now);
    return item.needsReply || Number(item.urgency || 0) >= 65 ||
      (deadlineHours !== null && deadlineHours >= 0 && deadlineHours <= 48);
  });
  if (items.length >= 2 || materiallyUseful) {
    return { send: true, reason: "Meaningful mail arrived after the morning brief." };
  }
  return skip("One low-pressure item can wait for the next morning brief.");
}

function hoursUntil(value: string | null, now: Date) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return (timestamp - now.getTime()) / 3_600_000;
}

function minutesSince(value: string | null | undefined, now: Date) {
  if (!value) return Number.POSITIVE_INFINITY;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - timestamp) / 60_000);
}

function skip(reason: string) {
  return { send: false, reason };
}
