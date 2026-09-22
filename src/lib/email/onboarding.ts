import { execute, getSetting, nowIso } from "./database";
import { getProviderPermissions } from "./permissions";
import { getTelegramStatus } from "./telegram";
import { getActiveTelegramBinding } from "./notification-telegram";
import type {
  OnboardingChecklistItem,
  OnboardingChecklistPage,
  ProviderPermissionAccount,
} from "./types";

export async function getOnboardingChecklist(input: { workspaceId?: string | null } = {}): Promise<OnboardingChecklistPage> {
  const [permissions, policyReviewedAt, purposesReviewedAt, managedBackupAt, restoreRehearsalAt, approvedActions] = await Promise.all([
    getProviderPermissions({ workspaceId: "workspace:all" }),
    getSetting("notification_policy_reviewed_at"),
    getSetting("workspace_purposes_reviewed_at"),
    getSetting("last_managed_backup_at"),
    getSetting("last_restore_rehearsal_at"),
    execute(`SELECT COUNT(*) AS count FROM mail_actions WHERE success_count > 0 AND status IN ('completed', 'executed', 'partial')`),
  ]);
  const accounts = permissions.accounts.filter((account) => account.accountStatus !== "disabled");
  const telegram = { ...getTelegramStatus(), enrolled: !!await getActiveTelegramBinding() };
  const items: OnboardingChecklistItem[] = [
    providerAccountItem("gmail", "Gmail account", accounts, "gmail"),
    providerAccountItem("hotmail", "Hotmail / Outlook account", accounts, "microsoft"),
    capabilityItem("calendars", "Calendar access", accounts, ["calendar_read", "calendar_write"], "Enable calendar access so Ezra can show events and hold new event drafts for approval.", "Calendar context keeps scheduling work beside the right mailbox.", "Enable calendars", { type: "settings", tab: "accounts" }),
    capabilityItem("send", "Exact-review send access", accounts, ["send"], "Enable provider send access only for accounts you want to use through Outbox.", "Every outgoing message remains locked to its account and exact approved content.", "Review send access", { type: "settings", tab: "permissions" }),
    markerItem("notification_policy", "Notification policy", policyReviewedAt, "Choose quiet hours, digest times, and which categories may interrupt you.", "A reviewed policy keeps alerts useful without turning Ezra into another noisy inbox.", "Review delivery policy", { type: "settings", tab: "delivery" }),
    {
      id: "telegram",
      label: "Private Telegram bot",
      description: "Configure a private bot, then explicitly enable Telegram in Delivery settings.",
      whyItMatters: "Telegram delivers notifications and local feedback controls; mail actions require review in Ezra.",
      status: telegram.enrolled ? "complete" : telegram.configured ? "needs_attention" : "not_started",
      statusLabel: telegram.enrolled ? "Enrolled" : telegram.configured ? "Enrollment required" : "Not configured",
      detail: telegram.enrolled ? "Telegram is enrolled. The worker manages commands when polling is enabled. Use the explicit generic test in Delivery settings to check API acceptance." : "Configuration alone does not enable alerts. Enroll from a trusted device in Delivery settings.",
      actionLabel: "Open Delivery",
      target: { type: "settings", tab: "delivery" },
    },
    markerItem("workspace_purposes", "Workspace purposes", purposesReviewedAt, "Review what Gmail and Hotmail are for so account routing stays predictable.", "Purpose labels make account separation visible before search, actions, and sends.", "Review accounts", { type: "settings", tab: "accounts" }),
    {
      id: "first_approved_action",
      label: "First approved mailbox action",
      description: "Complete one supervised provider action and confirm its result.",
      whyItMatters: "A small successful action proves permissions, account routing, audit history, and recovery copy work together.",
      status: Number(approvedActions.rows[0]?.count || 0) > 0 ? "complete" : accounts.length ? "needs_attention" : "not_started",
      statusLabel: Number(approvedActions.rows[0]?.count || 0) > 0 ? "Completed" : "Not tried yet",
      detail: Number(approvedActions.rows[0]?.count || 0) > 0 ? "Ezra has recorded at least one successful supervised mailbox action." : "Start with a reversible action such as Acknowledge/mark read after reviewing its exact scope.",
      actionLabel: accounts.length ? "Open Mail" : "Connect an account",
      target: accounts.length ? { type: "view", view: "mail" } : { type: "settings", tab: "accounts" },
    },
    {
      id: "backup_restore",
      label: "Backup and restore readiness",
      description: "Verify a current local backup and a usable restore point.",
      whyItMatters: "Mailbox learning, approvals, rules, and configuration should be recoverable before broader release.",
      status: managedBackupAt && restoreRehearsalAt ? "complete" : "needs_attention",
      statusLabel: managedBackupAt && restoreRehearsalAt ? "Protected" : "Setup needed",
      detail: managedBackupAt && restoreRehearsalAt
        ? `Last managed backup: ${managedBackupAt}. Last restore rehearsal: ${restoreRehearsalAt}.`
        : "Install the daily backup and monthly restore-rehearsal timers, then confirm both evidence records in System.",
      actionLabel: "Open System",
      target: { type: "settings", tab: "system" },
    },
  ];
  const complete = items.filter((item) => item.status === "complete").length;
  const planned = items.filter((item) => item.status === "planned").length;
  return {
    generatedAt: nowIso(),
    workspaceId: input.workspaceId || null,
    summary: {
      total: items.length,
      complete,
      needsAttention: items.filter((item) => item.status === "needs_attention" || item.status === "not_started").length,
      planned,
      percentComplete: Math.round((complete / Math.max(1, items.length - planned)) * 100),
    },
    items,
  };
}

function providerAccountItem(
  id: "gmail" | "hotmail",
  label: string,
  accounts: ProviderPermissionAccount[],
  provider: "gmail" | "microsoft",
): OnboardingChecklistItem {
  const matching = accounts.filter((account) => account.accountProvider === provider);
  const connected = matching.filter((account) => account.accountStatus === "connected" && account.tokenStatus !== "error");
  return {
    id,
    label,
    description: `Connect ${provider === "gmail" ? "Google Gmail" : "Microsoft Hotmail/Outlook"} for supervised mail access.`,
    whyItMatters: "Connected accounts stay separate and keep every provider action locked to the correct identity.",
    status: connected.length ? "complete" : matching.length ? "needs_attention" : "not_started",
    statusLabel: connected.length ? `${connected.length} connected` : matching.length ? "Reconnect needed" : "Not connected",
    detail: connected.length ? connected.map((account) => account.accountEmail).join(", ") : matching[0]?.lastError || `No ${label} is ready yet.`,
    actionLabel: connected.length ? "Review account" : `Connect ${provider === "gmail" ? "Gmail" : "Hotmail"}`,
    target: { type: "settings", tab: "accounts" },
  };
}

function capabilityItem(
  id: "calendars" | "send",
  label: string,
  accounts: ProviderPermissionAccount[],
  featureIds: Array<ProviderPermissionAccount["features"][number]["id"]>,
  description: string,
  whyItMatters: string,
  actionLabel: string,
  target: OnboardingChecklistItem["target"],
): OnboardingChecklistItem {
  const ready = accounts.filter((account) => featureIds.every((id) => account.features.find((feature) => feature.id === id)?.status === "connected"));
  const complete = accounts.length > 0 && ready.length === accounts.length;
  return {
    id,
    label,
    description,
    whyItMatters,
    status: complete ? "complete" : ready.length ? "needs_attention" : accounts.length ? "needs_attention" : "not_started",
    statusLabel: complete ? "Ready" : accounts.length ? `${ready.length} of ${accounts.length} ready` : "Connect an account first",
    detail: complete ? `All ${accounts.length} connected account${accounts.length === 1 ? " is" : "s are"} ready.` : "Review each account; Ezra will not blend or silently borrow another account's permissions.",
    actionLabel,
    target,
  };
}

function markerItem(
  id: "notification_policy" | "workspace_purposes",
  label: string,
  marker: string | null,
  description: string,
  whyItMatters: string,
  actionLabel: string,
  target: OnboardingChecklistItem["target"],
): OnboardingChecklistItem {
  return {
    id,
    label,
    description,
    whyItMatters,
    status: marker ? "complete" : "needs_attention",
    statusLabel: marker ? "Reviewed" : "Review needed",
    detail: marker ? `Reviewed ${marker}.` : "Open this section, confirm the current choices, and save/review them explicitly.",
    actionLabel,
    target,
  };
}
