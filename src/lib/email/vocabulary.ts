import type { AttentionLevel, MailActionName } from "./types";

export type ActionVocabulary = {
  label: string;
  confirmationLabel: string;
  progressLabel: string;
  pastTense: string;
  unchanged: string;
  description: string;
  destructive: boolean;
};

const ACTION_COPY: Record<MailActionName, ActionVocabulary> = {
  done: {
    label: "Acknowledge",
    confirmationLabel: "acknowledge",
    progressLabel: "Acknowledging...",
    pastTense: "acknowledged",
    unchanged: "acknowledged",
    description: "Mark the selected mail handled/read so it leaves active Today attention.",
    destructive: false,
  },
  mark_read: {
    label: "Acknowledge",
    confirmationLabel: "acknowledge",
    progressLabel: "Acknowledging...",
    pastTense: "acknowledged",
    unchanged: "acknowledged",
    description: "Mark the selected mail read and handled so it no longer looks unfinished.",
    destructive: false,
  },
  keep: {
    label: "Keep useful",
    confirmationLabel: "keep useful",
    progressLabel: "Keeping...",
    pastTense: "kept useful",
    unchanged: "already useful",
    description: "Tell Ezra this mail is useful context, not cleanup or priority.",
    destructive: false,
  },
  raise_priority: {
    label: "Care more",
    confirmationLabel: "care more",
    progressLabel: "Raising care...",
    pastTense: "raised to priority",
    unchanged: "already priority",
    description: "Teach Ezra that this sender or subject should be treated as priority mail.",
    destructive: false,
  },
  lower_priority: {
    label: "Care less",
    confirmationLabel: "care less",
    progressLabel: "Lowering care...",
    pastTense: "moved out of priority",
    unchanged: "already lower priority",
    description: "Teach Ezra this mail needs less attention in the future.",
    destructive: false,
  },
  teach_care: {
    label: "Teach Ezra",
    confirmationLabel: "teach Ezra",
    progressLabel: "Teaching...",
    pastTense: "updated with care tuning",
    unchanged: "already tuned",
    description: "Save sender or subject-matter care learning for this account.",
    destructive: false,
  },
  quiet: {
    label: "Quiet sender",
    confirmationLabel: "quiet sender",
    progressLabel: "Quieting...",
    pastTense: "quieted",
    unchanged: "already quiet",
    description: "Mark matching low-priority mail handled and teach Ezra to keep this sender quiet.",
    destructive: false,
  },
  unsubscribe: {
    label: "Unsubscribe",
    confirmationLabel: "unsubscribe",
    progressLabel: "Unsubscribing...",
    pastTense: "unsubscribed",
    unchanged: "already unsubscribed",
    description: "Use the sender's verified one-click unsubscribe endpoint, then acknowledge related mail.",
    destructive: true,
  },
  spam: {
    label: "Spam/Junk",
    confirmationLabel: "move to spam/junk",
    progressLabel: "Moving...",
    pastTense: "moved to Spam/Junk",
    unchanged: "in Spam/Junk",
    description: "Move the selected mail to Spam/Junk. Use this only for abusive or unsolicited mail.",
    destructive: true,
  },
  delete: {
    label: "Delete",
    confirmationLabel: "delete",
    progressLabel: "Deleting...",
    pastTense: "moved to Trash",
    unchanged: "in Trash",
    description: "Move the selected mail to provider Trash. This is not permanent deletion.",
    destructive: true,
  },
  delete_and_teach: {
    label: "Trash & teach",
    confirmationLabel: "trash and teach Ezra",
    progressLabel: "Moving...",
    pastTense: "moved to Trash and taught",
    unchanged: "in Trash",
    description: "Move the selected mail to Trash and teach Ezra to lower this sender's future priority.",
    destructive: true,
  },
  pin: {
    label: "Pin",
    confirmationLabel: "pin",
    progressLabel: "Pinning...",
    pastTense: "pinned",
    unchanged: "already pinned",
    description: "Pin this mail in its connected provider when Ezra has a proven provider mapping.",
    destructive: false,
  },
  unpin: {
    label: "Unpin",
    confirmationLabel: "unpin",
    progressLabel: "Unpinning...",
    pastTense: "unpinned",
    unchanged: "already unpinned",
    description: "Remove the provider-backed Pin when Ezra has a proven provider mapping.",
    destructive: false,
  },
  flag: {
    label: "Flag",
    confirmationLabel: "flag",
    progressLabel: "Flagging...",
    pastTense: "flagged",
    unchanged: "already flagged",
    description: "Flag this mail only when Ezra has a faithful provider mapping.",
    destructive: false,
  },
  unflag: {
    label: "Unflag",
    confirmationLabel: "unflag",
    progressLabel: "Unflagging...",
    pastTense: "unflagged",
    unchanged: "already unflagged",
    description: "Remove the provider-backed Flag when Ezra has a faithful provider mapping.",
    destructive: false,
  },
  undo: {
    label: "Undo",
    confirmationLabel: "undo",
    progressLabel: "Restoring...",
    pastTense: "restored",
    unchanged: "already restored",
    description: "Restore the provider state recorded for the previous reversible action.",
    destructive: false,
  },
};

export function mailActionCopy(action: MailActionName | string): ActionVocabulary {
  return ACTION_COPY[(action as MailActionName)] || {
    label: "Mail action",
    confirmationLabel: "mail action",
    progressLabel: "Working...",
    pastTense: "updated",
    unchanged: "up to date",
    description: "Apply the selected mail action.",
    destructive: false,
  };
}

export function mailActionTitle(action: MailActionName | null | undefined, prefix = "") {
  if (!action) return `${prefix}Mail action`;
  return `${prefix}${mailActionCopy(action).label}`;
}

export function mailActionHistoryTitle(action: MailActionName | null | undefined, prefix = "") {
  if (action === "done" || action === "mark_read") return `${prefix}Acknowledged mail`;
  if (action === "delete") return `${prefix}Moved mail to Trash`;
  if (action === "delete_and_teach") return `${prefix}Trash & teach`;
  if (action === "teach_care") return `${prefix}Taught Ezra`;
  if (action === "keep") return `${prefix}Kept useful`;
  if (action === "raise_priority") return `${prefix}Care more`;
  if (action === "lower_priority") return `${prefix}Care less`;
  if (action === "quiet") return `${prefix}Quieted sender`;
  if (action === "unsubscribe") return `${prefix}Unsubscribe`;
  if (action === "spam") return `${prefix}Moved mail to Spam/Junk`;
  if (action === "undo") return `${prefix}Undo`;
  return `${prefix}Mail action`;
}

export function attentionLabel(value: AttentionLevel | string | null | undefined) {
  if (value === "interrupt") return "Priority";
  if (value === "digest") return "Useful";
  if (value === "suppress") return "Quiet";
  return "None recorded";
}

export function ruleActionLabel(action: string | null | undefined) {
  if (action === "interrupt") return "Care more";
  if (action === "digest") return "Keep useful";
  if (action === "suppress") return "Care less";
  if (action === "mark_read") return "Acknowledge";
  if (action === "spam") return "Spam/Junk";
  return humanize(action || "rule");
}

export function notificationStatusLabel(status: string | null | undefined, sentAt?: string | null) {
  if (!status || status === "none") return "No external notification recorded";
  if (status === "sent") return sentAt ? `Notification sent ${sentAt}` : "Notification sent";
  if (status === "skipped") return "Notification held or skipped";
  if (status === "failed") return "Notification failed";
  if (status === "pending") return "Notification pending";
  return humanize(status);
}

export function whyThisMattersRows(input: {
  summary?: string | null;
  reason?: string | null;
  recommendation?: string | null;
  currentAttention?: AttentionLevel | string | null;
  correctedAttention?: AttentionLevel | string | null;
  preferenceCount?: number;
  notificationStatus?: string | null;
}) {
  const rows = [
    { label: "What Ezra saw", value: input.summary || "Ezra has only the message excerpt available." },
    { label: "Why it matters", value: input.reason || "No additional priority reason was recorded." },
    { label: "Suggested move", value: input.recommendation || "Review and decide when convenient." },
  ];
  if (input.currentAttention || input.correctedAttention) {
    rows.push({
      label: "Current care",
      value: input.correctedAttention
        ? `${attentionLabel(input.currentAttention)} corrected to ${attentionLabel(input.correctedAttention)}`
        : attentionLabel(input.currentAttention),
    });
  }
  if (typeof input.preferenceCount === "number") {
    rows.push({
      label: "Learning applied",
      value: input.preferenceCount
        ? `${input.preferenceCount} sender/topic preference${input.preferenceCount === 1 ? "" : "s"} matched.`
        : "No sender or topic preference matched.",
    });
  }
  if (input.notificationStatus) {
    rows.push({ label: "Notification", value: notificationStatusLabel(input.notificationStatus) });
  }
  return rows;
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
