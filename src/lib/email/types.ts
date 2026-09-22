export const attentionLevels = ["interrupt", "digest", "suppress"] as const;
export type AttentionLevel = (typeof attentionLevels)[number];

export const modelIds = [
  "qwen3:8b-maxctx",
  "qwen3.5:9b-maxctx",
  "qwen3:14b-maxctx",
] as const;
export type ModelId = (typeof modelIds)[number];

export type EmailEnvelope = {
  accountId: string;
  externalMessageId: string;
  threadId: string;
  historyId?: string | null;
  senderName: string;
  senderEmail: string;
  subject: string;
  receivedAt: string;
  snippet: string;
  bodyText?: string;
  bodyHtml?: string;
  providerRevision?: string | null;
  gmailUrl: string;
  isUnread: boolean;
  isPinned?: boolean;
  isFlagged?: boolean;
  labels: string[];
  attachments: EmailAttachment[];
};

export type EmailAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};

export type TriageInput = {
  senderName: string;
  senderEmail: string;
  subject: string;
  receivedAt: string;
  snippet: string;
  bodyText?: string;
  attachmentText?: string;
  userContext?: string;
  learnedPreferences?: string[];
};

export type TriageResult = {
  attention: AttentionLevel;
  urgency: number;
  confidence: number;
  category: string;
  summary: string;
  reason: string;
  recommendation: string;
  needsReply: boolean;
  deadline: string | null;
  draftReply: string | null;
  injectionFlags: string[];
  criticalReason: string | null;
};

export type NotificationDecisionRecord = {
  sequence: number;
  decisionId: string;
  messageId: string;
  reason: string;
  decidedAt: string;
};

export type ForegroundNotificationEvent = {
  cursor: string;
  decisionId: string;
  messageId: string;
  accountId: string;
  provider: AccountProvider;
  decidedAt: string;
  senderName: string;
  subject: string;
};

export type ForegroundNotificationFeed = {
  enabled: boolean;
  cursor: string | null;
  hasMore: boolean;
  events: ForegroundNotificationEvent[];
};

export type InboxItem = {
  id: string;
  accountId: string;
  accountLabel: string;
  accountProvider?: AccountProvider;
  externalMessageId: string;
  threadId: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  receivedAt: string;
  snippet: string;
  gmailUrl: string;
  hasAttachments: boolean;
  isUnread: boolean;
  isPinned?: boolean;
  isFlagged?: boolean;
  organizationConfirmedAt?: string | null;
  mailboxLabels: string[];
  status: string;
  attention: AttentionLevel | null;
  urgency: number | null;
  confidence: number | null;
  category: string | null;
  summary: string | null;
  reason: string | null;
  recommendation: string | null;
  needsReply: boolean;
  deadline: string | null;
  injectionFlags: string[];
  model: string | null;
  notifiedAt: string | null;
};

export type ContactMemoryCategory = {
  label: "Relationship" | "Patterns" | "Preferences" | "Recent history";
  summary: string;
};

export type ContactMemory = {
  summary: string;
  messageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  categories: ContactMemoryCategory[];
};

export type MessageDetail = {
  message: InboxItem;
  bodyText: string;
  bodyIsExcerpt: boolean;
  content?: {
    plainText: string;
    sanitizedHtml: string | null;
    contentHash: string;
    providerRevision: string | null;
    fetchedAt: string | null;
    source: "provider" | "cache" | "excerpt";
    remoteImageCount: number;
    trackingPixelCount: number;
    truncated: boolean;
  };
  attachments: EmailAttachment[];
  contactMemory: ContactMemory;
  careTrace?: MailCareTrace;
};

export type MailCareLevel = "more" | "less" | "useful";
export type MailCareScope = "message" | "sender" | "topic";

export type MailCarePreferenceSummary = {
  id?: string;
  kind: "sender" | "topic";
  pattern: string;
  action: AttentionLevel;
  evidenceCount?: number;
};

export type MailCareTrace = {
  originalAttention: AttentionLevel | null;
  correctedAttention: AttentionLevel | null;
  currentAttention: AttentionLevel | null;
  matchingPreferences: MailCarePreferenceSummary[];
  notificationStatus: string | null;
  notificationSentAt: string | null;
  notificationError: string | null;
};

export type DraftPreparation = {
  messageId: string;
  content: string;
  contactMemorySummary: string;
  appliedContext: string[];
};

export type ReplyMode = "sender" | "all";

export type ReplyDraftPreparation = DraftPreparation & {
  replyMode: ReplyMode;
  accountId: string;
  accountLabel: string;
  accountEmail: string;
  accountProvider: AccountProvider;
  to: EmailRecipient[];
  cc: EmailRecipient[];
  bcc: EmailRecipient[];
};

export type DraftItem = {
  id: string;
  messageId: string;
  subject: string;
  senderName: string;
  senderEmail: string;
  content: string;
  version: number;
  status: "draft" | "awaiting_approval" | "approved" | "sent" | "cancelled";
  approvalStatus: string | null;
  approvalExpiresAt: string | null;
  updatedAt: string;
};

export type EmailRecipient = {
  name?: string | null;
  email: string;
};

export type ContactSuggestionSource = "manual" | "sender" | "recipient" | "mixed";

export type ContactSuggestion = {
  id: string;
  accountId: string;
  accountLabel: string;
  accountProvider: AccountProvider;
  name: string | null;
  email: string;
  source: ContactSuggestionSource;
  messageCount: number;
  lastSeenAt: string | null;
  relationship: string;
};

export type ContactSuggestionPage = {
  generatedAt: string;
  query: string;
  workspaceId: string | null;
  accountId: string | null;
  items: ContactSuggestion[];
};

export type OutgoingDraftSourceType = "reply" | "forward" | "new";
export type OutgoingDraftStatus =
  | "draft"
  | "awaiting_approval"
  | "approved"
  | "sending"
  | "sent"
  | "failed"
  | "send_unknown"
  | "cancelled";

export type OutgoingAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  available: boolean;
};

export type OutgoingDraft = {
  id: string;
  sourceType: OutgoingDraftSourceType;
  sourceMessageId: string | null;
  replyMode?: ReplyMode | null;
  legacyReplyDraftId?: string | null;
  accountId: string;
  accountLabel: string;
  accountEmail: string;
  accountProvider: AccountProvider;
  fromEmail: string;
  to: EmailRecipient[];
  cc: EmailRecipient[];
  bcc: EmailRecipient[];
  subject: string;
  body: string;
  attachments: OutgoingAttachment[];
  contentHash: string;
  version: number;
  status: OutgoingDraftStatus;
  approvalSnapshot: string | null;
  providerMessageId: string | null;
  providerDraftId?: string | null;
  lastError: string | null;
  sendDisabledReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OutgoingApprovalSnapshot = {
  draftId: string;
  sourceType: OutgoingDraftSourceType;
  sourceMessageId: string | null;
  replyMode?: ReplyMode | null;
  accountId: string;
  accountLabel: string;
  accountEmail: string;
  accountProvider: AccountProvider;
  fromEmail: string;
  to: EmailRecipient[];
  cc: EmailRecipient[];
  bcc: EmailRecipient[];
  subject: string;
  body: string;
  attachments: OutgoingAttachment[];
  contentHash: string;
  version: number;
  requestedAt: string;
};

export type OutboxItem = {
  id: string;
  draftId: string;
  sourceType: OutgoingDraftSourceType;
  sourceMessageId: string | null;
  replyMode?: ReplyMode | null;
  accountId: string;
  accountLabel: string;
  accountEmail: string;
  accountProvider: AccountProvider;
  fromEmail: string;
  to: EmailRecipient[];
  cc: EmailRecipient[];
  bcc: EmailRecipient[];
  recipientCount: number;
  subject: string;
  body: string;
  attachments: OutgoingAttachment[];
  bodyPreview: string;
  status: OutgoingDraftStatus;
  version: number;
  contentHash: string;
  approvalSnapshot: string | null;
  providerMessageId: string | null;
  providerDraftId?: string | null;
  lastError: string | null;
  canSend: boolean;
  canCancel: boolean;
  canRetry: boolean;
  canReconcile?: boolean;
  blockedReason: string | null;
  updatedAt: string;
  createdAt: string;
};

export type OutboxPage = {
  generatedAt: string;
  counts: {
    total: number;
    draft: number;
    awaitingApproval: number;
    approved: number;
    sending: number;
    sent: number;
    failed: number;
    sendUnknown?: number;
    cancelled: number;
    blocked: number;
    cancellable: number;
  };
  items: OutboxItem[];
};

export type OutboxActionResult = {
  ok: boolean;
  message: string;
  item?: OutboxItem;
  attemptId?: string;
  providerMessageId?: string | null;
};

export type LearnedPreference = {
  id: string;
  accountId?: string | null;
  kind: string;
  pattern: string;
  action: string;
  weight: number;
  evidenceCount: number;
  enabled: boolean;
  updatedAt: string;
};

export type ModelRun = {
  id: string;
  messageId: string | null;
  model: string;
  purpose: string;
  classification: string | null;
  durationMs: number;
  memoryMb: number | null;
  inputChars: number;
  outputChars: number;
  valid: boolean;
  error: string | null;
  createdAt: string;
};

export type ModelBenchmarkSummary = {
  runId: string;
  model: ModelId;
  cases: number;
  score: number;
  attentionAccuracy: number;
  validPercent: number;
  averageDurationMs: number;
  averageMemoryMb: number;
  completedAt: string;
};

export type ModelBenchmarkState = {
  status: "idle" | "running" | "completed" | "error";
  runId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  progress: string | null;
  error: string | null;
  caseCount: number;
  summaries: ModelBenchmarkSummary[];
};

export type UpdateStatus = {
  checkedAt: string;
  app: {
    currentVersion: string;
    commit: string | null;
    remoteConfigured: boolean;
    latestVersion: string | null;
    updateAvailable: boolean;
  };
  ollama: {
    installedVersion: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
  };
  models: Array<{
    id: ModelId;
    label: string;
    baseModel: string;
    installed: boolean;
    configuredContext: number;
    nativeContext: number;
    updateState: "idle" | "running" | "completed" | "error";
    updateMessage: string | null;
  }>;
};

export type AccountProvider = "gmail" | "microsoft";
export type OrganizationKind = "pin" | "flag";
export type ProviderOrganizationCapability =
  | { state: "supported"; mapping: "gmail_star" | "gmail_important" | "microsoft_follow_up" }
  | { state: "unavailable"; reason: string }
  | { state: "reconnect_required"; reason: string };
export type ProviderOrganizationCapabilities = Record<OrganizationKind, ProviderOrganizationCapability>;
export type ProviderCatalogId = AccountProvider | "standards";
export type ProviderPreset = "yahoo" | "icloud" | "fastmail" | "zoho" | "aol" | "custom";

export type ProviderCapabilityName =
  | "mailRead"
  | "readState"
  | "move"
  | "trash"
  | "spam"
  | "undo"
  | "send"
  | "threadedReply"
  | "attachments"
  | "unsubscribe"
  | "calendarRead"
  | "calendarWrite"
  | "pin"
  | "flag";

export type ProviderInventoryItem = {
  id: ProviderCatalogId;
  label: string;
  available: boolean;
  setupGuidance: string;
  presets?: ProviderPreset[];
  capabilities: Record<ProviderCapabilityName, boolean>;
};

export type ProviderSetupDiscovery = {
  provider: AccountProvider;
  label: string;
  authorization: "browser" | "device_code";
  capabilities: Pick<Record<ProviderCapabilityName, boolean>, "mailRead" | "send">;
};

export type AccountStatus = {
  id: string;
  provider: AccountProvider;
  email: string;
  label: string;
  purpose?: string;
  status: "connected" | "needs_setup" | "error" | "disabled";
  lastSyncAt: string | null;
  counts: {
    inbox: number;
    unread: number;
    interrupt: number;
    digest: number;
    maintenance: number;
  };
};

export type WorkspaceCalendarRole = "none" | "primary_future";

export type MailWorkspace = {
  id: string;
  label: string;
  purpose: string;
  accountIds: string[];
  isAllAccounts: boolean;
  calendarRole: WorkspaceCalendarRole;
  provider: AccountProvider | "all";
};

export type CalendarAttendee = {
  email: string;
  name?: string;
  responseStatus?: string;
};

export type CalendarDateRange = { startDate: string; endDate: string };

export type CalendarEvent = {
  id: string;
  accountId: string;
  accountLabel: string;
  accountProvider: AccountProvider;
  externalEventId: string;
  calendarId: string;
  calendarName: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  /** Provider/local calendar dates; endDate is exclusive. Null for timed events. */
  dateRange: CalendarDateRange | null;
  timezone: string | null;
  status: string;
  visibility: string | null;
  isBusy: boolean;
  organizerName: string | null;
  organizerEmail: string | null;
  attendees: CalendarAttendee[];
  webLink: string | null;
  updatedAt: string | null;
  syncedAt: string;
};

export type CalendarDraftStatus = "draft" | "created" | "cancelled";
export type CalendarPrivacy = "default" | "private" | "public";

export type CalendarDraft = {
  id: string;
  accountId: string;
  accountLabel: string;
  accountProvider: AccountProvider;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  timezone: string;
  attendees: string[];
  reminderMinutes: number | null;
  isBusy: boolean;
  privacy: CalendarPrivacy;
  sendUpdates: boolean;
  status: CalendarDraftStatus;
  providerEventId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CalendarAccountStatus = {
  accountId: string;
  accountLabel: string;
  accountEmail: string;
  provider: AccountProvider;
  status: "connected" | "needs_setup" | "error" | "disabled";
  calendarStatus: "connected" | "needs_setup" | "error" | "syncing";
  calendarAccess: "none" | "read" | "write";
  lastSyncAt: string | null;
  lastError: string | null;
};

export type CalendarPage = {
  events: CalendarEvent[];
  drafts: CalendarDraft[];
  accounts: CalendarAccountStatus[];
  range: {
    from: string;
    to: string;
    timezone: string;
  };
};

export type CalendarActionResult = {
  ok: boolean;
  message: string;
  draft?: CalendarDraft;
  event?: CalendarEvent;
  synced?: number;
  failures?: Array<{ accountId: string; error: string }>;
};

export type OnboardingChecklistStatus = "complete" | "needs_attention" | "not_started" | "planned";

export type OnboardingChecklistItem = {
  id: "gmail" | "hotmail" | "calendars" | "send" | "notification_policy" | "telegram" | "workspace_purposes" | "first_approved_action" | "backup_restore";
  label: string;
  description: string;
  whyItMatters: string;
  status: OnboardingChecklistStatus;
  statusLabel: string;
  detail: string;
  actionLabel: string | null;
  target: { type: "settings"; tab: "accounts" | "permissions" | "delivery" | "system" } | { type: "view"; view: "mail" | "calendar" | "outbox" } | null;
};

export type OnboardingChecklistPage = {
  generatedAt: string;
  workspaceId: string | null;
  summary: {
    total: number;
    complete: number;
    needsAttention: number;
    planned: number;
    percentComplete: number;
  };
  items: OnboardingChecklistItem[];
};

export type AccountFreshnessItem = {
  accountId: string;
  accountLabel: string;
  accountEmail: string;
  accountProvider: AccountProvider;
  purposeLabel: string;
  syncRangeDays: number;
  status: AccountStatus["status"];
  lastSuccessfulPollAt: string | null;
  lastProviderActionAt: string | null;
  lastError: string | null;
  nextExpectedCheckAt: string | null;
  manualSyncAvailableAt: string | null;
  canSyncNow: boolean;
  reconnectRecommended: boolean;
  recoveryMessage: string | null;
  issues?: Array<{
    feature: "mail" | "calendar";
    status: "ok" | "needs_setup" | "error";
    message: string | null;
    reconnectRecommended: boolean;
    lastSuccessAt: string | null;
  }>;
};

export type AccountFreshnessPage = {
  generatedAt: string;
  pollIntervalMinutes: number;
  manualSyncCooldownSeconds: number;
  items: AccountFreshnessItem[];
};

export type CalendarDrilldownTarget = { view: "calendar"; eventId: string; date: string };

export type ActionCenterTarget =
  | { view: "mail"; messageId: string }
  | { view: "drafts"; draftId?: string; messageId?: string }
  | { view: "outbox"; draftId?: string }
  | { view: "calendar"; draftId?: string; eventId?: string; date?: string }
  | { view: "today"; messageId?: string }
  | { view: "settings"; accountId?: string };

export type BriefMemoryState = "open" | "completed" | "dismissed";
export type BriefMemoryAction = "complete" | "dismiss" | "bring_back";
export type BriefSourceType = "mail_thread" | "calendar_event" | "action_center";

export type BriefCandidate = {
  sourceType: BriefSourceType;
  sourceKey: string;
  sourceAccountId: string | null;
  provider: AccountProvider | null;
  providerThreadId: string | null;
  revisionAt: string;
  occurredAt: string;
  topicKind?: TodayTopicKind;
  role: "agenda" | "attention";
  title: string;
  summary: string;
  target: ActionCenterTarget;
};

export type LivingBriefItem = BriefCandidate & {
  id: string;
  workspaceId: string;
  state: BriefMemoryState;
  firstSeenAt: string;
  lastSeenAt: string;
  completedAt: string | null;
  dismissedAt: string | null;
  restoredAt: string | null;
};

export type BriefMemoryView = {
  workspaceId: string;
  items: LivingBriefItem[];
  current: LivingBriefItem[];
  carryovers: LivingBriefItem[];
  completedToday: LivingBriefItem[];
};

export type ActionCenterItemType =
  | "reply_draft"
  | "outgoing_draft"
  | "calendar_draft"
  | "cleanup_suggestion"
  | "failed_action"
  | "permission_issue";

export type ActionCenterPriority = "approval" | "repair" | "review";

export type ActionCenterItem = {
  id: string;
  type: ActionCenterItemType;
  priority: ActionCenterPriority;
  accountId: string | null;
  accountLabel: string | null;
  accountProvider?: AccountProvider;
  title: string;
  subtitle: string;
  detail: string;
  updatedAt: string;
  status: string;
  count: number;
  target: ActionCenterTarget;
};

export type ActionCenterSection = {
  id: "approvals" | "cleanup" | "repairs";
  title: string;
  description: string;
  count: number;
  items: ActionCenterItem[];
};

export type ActionCenterPage = {
  generatedAt: string;
  counts: {
    approvals: number;
    cleanup: number;
    repairs: number;
    total: number;
  };
  sections: ActionCenterSection[];
};

export type ActivityTimelineKind =
  | "message_received"
  | "classification"
  | "mail_action"
  | "outgoing_mail"
  | "feedback"
  | "learned_rule"
  | "notification"
  | "mail_sync"
  | "calendar_sync"
  | "integration";

export type ActivityTimelineSeverity = "info" | "success" | "warning" | "error" | "learning";

export type ActivityTimelineItem = {
  id: string;
  kind: ActivityTimelineKind;
  severity: ActivityTimelineSeverity;
  accountId: string | null;
  accountLabel: string | null;
  accountEmail: string | null;
  accountProvider: AccountProvider | null;
  messageId: string | null;
  actionId: string | null;
  title: string;
  subtitle: string;
  detail: string;
  occurredAt: string;
  status: string | null;
  target?: ActionCenterTarget;
  metadata?: Record<string, string | number | boolean | null>;
};

export type ActivityTimelineAccount = {
  id: string;
  label: string;
  email: string;
  provider: AccountProvider;
};

export type ActivityTimelinePage = {
  generatedAt: string;
  filters: {
    workspaceId: string | null;
    q: string;
    kind: ActivityTimelineKind | "all";
    accountId: string;
    provider: AccountProvider | "all";
    from: string | null;
    to: string | null;
    limit: number;
  };
  counts: {
    total: number;
    shown: number;
    errors: number;
    warnings: number;
    byKind: Array<{ kind: ActivityTimelineKind; count: number }>;
  };
  accounts: ActivityTimelineAccount[];
  items: ActivityTimelineItem[];
};

export type ProviderPermissionFeatureId =
  | "mail_read"
  | "mail_actions"
  | "send"
  | "calendar_read"
  | "calendar_write";

export type ProviderPermissionStatus =
  | "connected"
  | "available"
  | "read_only"
  | "needs_setup"
  | "disabled"
  | "error";

export type ProviderPermissionFeature = {
  id: ProviderPermissionFeatureId;
  label: string;
  status: ProviderPermissionStatus;
  access: "none" | "read" | "write" | "deferred";
  detail: string;
  lastConnectedAt: string | null;
  lastError: string | null;
};

export type ProviderPermissionAccount = {
  accountId: string;
  accountLabel: string;
  accountEmail: string;
  accountProvider: AccountProvider;
  accountStatus: AccountStatus["status"];
  tokenStatus: ProviderPermissionStatus;
  tokenDetail: string;
  lastMailSyncAt: string | null;
  lastCalendarSyncAt: string | null;
  lastError: string | null;
  reconnectRecommended: boolean;
  features: ProviderPermissionFeature[];
};

export type ProviderPermissionPage = {
  generatedAt: string;
  workspaceId: string | null;
  summary: {
    accounts: number;
    connectedAccounts: number;
    needsSetup: number;
    errors: number;
    readOnly: number;
    disabled: number;
  };
  accounts: ProviderPermissionAccount[];
};

export type NotificationPreference = "interrupt" | "digest" | "quiet";

export type NotificationChannelStatus = {
  id: "in_app" | "telegram" | "browser";
  label: string;
  status: "enabled" | "configured" | "needs_setup" | "deferred" | "available";
  detail: string;
  lastError: string | null;
};

export type NotificationCategoryPolicy = {
  id: string;
  label: string;
  description: string;
  categories: string[];
  preference: NotificationPreference;
  quietHoursBypass: boolean;
};

export type NotificationPolicySettings = {
  dailyInterruptBudget: number;
  burstWindowSeconds: number;
  senderCooldownMinutes: number;
  snoozedUntil: string | null;
  calmCheckinEnabled: boolean;
  calmCheckinTime: string;
  timezone: string;
  digestTimes: string[];
  quietStart: string;
  quietEnd: string;
  categoryPolicies: NotificationCategoryPolicy[];
};

export type NotificationPolicyPage = NotificationPolicySettings & {
  generatedAt: string;
  channels: NotificationChannelStatus[];
  guardrails: Array<{ label: string; detail: string }>;
  stats: {
    windowDays: number;
    /** Legacy history only; shared transport acceptance does not prove display. */
    interruptsSent: number;
    interruptsAccepted?: number;
    interruptsDisplayed?: number;
    interruptsSkipped: number;
    interruptsFailed: number;
    digestsSent: number;
    digestsAccepted?: number;
    digestsDisplayed?: number;
    digestsSkipped: number;
    digestsFailed: number;
    lastNotificationAt: string | null;
    lastDigestAt: string | null;
  };
};

export type ServiceHealth = {
  worker: "running" | "stopped" | "unknown";
  lastPollAt: string | null;
  lastPollError: string | null;
  ollama: boolean;
  telegramConfigured: boolean;
  telegramRunning: boolean;
  gogInstalled: boolean;
  gmailModifyAuthorized: boolean;
};

export type SystemRecoveryStatus = {
  generatedAt: string;
  database: {
    kind: "file" | "remote";
    sizeBytes: number | null;
    schemaVersion: number;
  };
  backup: {
    latest: {
      fileName: string;
      sizeBytes: number;
      createdAt: string;
    } | null;
    verified: boolean;
    verifiedAt: string | null;
    sha256: string | null;
    detail: string;
    managed: {
      lastCreatedAt: string | null;
      fileName: string | null;
      sha256: string | null;
      ageHours: number | null;
      stale: boolean;
      dailyRetention: number;
      weeklyRetention: number;
    };
    rehearsal: {
      lastCompletedAt: string | null;
      sourceFile: string | null;
      overdue: boolean;
    };
  };
  runtime: {
    webRevision: string | null;
    workerRevision: string | null;
    revisionsMatch: boolean | null;
    workerHeartbeatAt: string | null;
    workerHealthy: boolean;
  };
  polling: {
    paused: boolean;
    pausedAt: string | null;
    reason: string | null;
  };
};

export type MaintenanceAction = "mark_read" | "unsubscribe" | "spam";

export type MaintenanceGroup = {
  accountId: string;
  accountEmail: string;
  latestMessageId: string;
  senderName: string;
  senderEmail: string;
  messageCount: number;
  latestSubject: string;
  latestReceivedAt: string;
  categories: string[];
  approvedActions: MaintenanceAction[];
};

export type DigestPreview = {
  label: string;
  scheduledFor: string;
  itemCount: number;
  items: InboxItem[];
};

export type DigestRecord = {
  id: string;
  label: string;
  channel: "telegram";
  status: "pending" | "sent" | "skipped" | "failed";
  itemCount: number;
  scheduledFor: string | null;
  createdAt: string;
  sentAt: string | null;
  error: string | null;
  items: InboxItem[];
};

export type ContinuityCheckpoint = {
  summary: string;
  durablePreferences: string[];
  decisions: string[];
  unresolved: string[];
  corrections: string[];
  actionBoundaries: string[];
};

export type DashboardState = {
  inbox: InboxItem[];
  mailbox: InboxItem[];
  drafts: DraftItem[];
  preferences: LearnedPreference[];
  modelRuns: ModelRun[];
  accounts: AccountStatus[];
  workspaces?: MailWorkspace[];
  maintenance: MaintenanceGroup[];
  digests: {
    upcoming: DigestPreview[];
    history: DigestRecord[];
  };
  activeModel: ModelId;
  effectiveModel?: string;
  benchmarks: ModelBenchmarkState;
  updates: UpdateStatus;
  health: ServiceHealth;
  counts: {
    interrupt: number;
    digest: number;
    suppress: number;
    maintenance: number;
    awaitingApproval: number;
  };
  backlog: {
    status: "idle" | "running" | "paused" | "completed" | "error";
    query: string;
    accounts: number;
    pagesScanned: number;
    discovered: number;
    queued: number;
    ruleHandled: number;
    modelHandled: number;
    lastRunAt: string | null;
    error: string | null;
  };
  schedule: {
    timezone: string;
    pollMinutes: number;
    digestTimes: string[];
    quietStart: string;
    quietEnd: string;
  };
};

export type TodayTopicKind = "action" | "reply" | "deadline" | "fyi";

export type TodayTopic = {
  id: string;
  kind: TodayTopicKind;
  title: string;
  summary: string;
  senderName: string;
  accountLabel: string;
  receivedAt: string;
  deadline: string | null;
  urgency: number;
  threadCount: number;
};

export type CleanupRecommendation = "mark_read" | "quiet" | "unsubscribe";

export type CleanupSuggestion = {
  accountId: string;
  accountLabel: string;
  latestMessageId: string;
  senderName: string;
  senderEmail: string;
  latestSubject: string;
  latestReceivedAt: string;
  messageCount: number;
  category: string;
  recommendation: CleanupRecommendation;
  reason: string;
  unsubscribeSupported: boolean;
};

export type TodayReviewItem = {
  id: string;
  accountId: string;
  accountLabel: string;
  accountProvider?: AccountProvider;
  senderName: string;
  senderEmail: string;
  subject: string;
  summary: string;
  receivedAt: string;
  category: string | null;
  attention: AttentionLevel | null;
  reasonLabel: string;
};

export type TodayHistoryKind = "received" | "quieted" | "handled" | "still_needs_action" | "failed";

export type TodayHistoryItem = {
  id: string;
  kind: TodayHistoryKind;
  itemType: "message" | "action";
  messageId: string | null;
  actionId: string | null;
  accountId: string | null;
  accountLabel: string | null;
  accountProvider?: AccountProvider;
  title: string;
  subtitle: string;
  detail: string;
  occurredAt: string;
  action: MailActionName | null;
  status: string | null;
  successCount: number | null;
  failureCount: number | null;
};

export type TodayHistorySection = {
  kind: TodayHistoryKind;
  title: string;
  description: string;
  count: number;
  items: TodayHistoryItem[];
};

export type TodayHistory = {
  generatedAt: string;
  sections: TodayHistorySection[];
};

export type MailTodaySnapshot = {
  id: string;
  date: string;
  generatedAt: string;
  quietReviewed: number;
  mailActivity: {
    receivedToday: number;
    handledToday: number;
    unhandledToday: number;
    attentionCounts: {
      interrupt: number;
      digest: number;
      suppress: number;
      unknown: number;
    };
    stillNeedsAttention: number;
    categoryCounts: Array<{ category: string; count: number }>;
    lastPollAt: string | null;
    lastPollError: string | null;
  };
  topics: TodayTopic[];
  cleanup: CleanupSuggestion[];
  oneMoreGlance: TodayReviewItem[];
  history: TodayHistory;
  counts: {
    action: number;
    reply: number;
    deadline: number;
    fyi: number;
  };
  briefCandidates: BriefCandidate[];
  replyCandidates: BriefCandidate[];
};

export type TodayBriefSource =
  | "mail"
  | "calendar"
  | "action_center"
  | "activity"
  | "freshness"
  | "sent";

export type TodayBriefSourceStatus = {
  source: TodayBriefSource;
  status: "current" | "stale" | "unavailable" | "truncated" | "error";
  accountId: string | null;
  checkedAt: string | null;
  detail: string | null;
};

export type TodayBrief = MailTodaySnapshot & {
  morningBrief?: import("./morning-brief-types").MorningBriefView;
  timezone?: string;
  attentionMetadata?: Record<string, import("./morning-brief-types").TodayAttentionMeta>;
  workspaceId: string;
  sourceStatus: TodayBriefSourceStatus[];
  agenda: LivingBriefItem[];
  needsAttention: LivingBriefItem[];
  carryovers: LivingBriefItem[];
  completedSinceLastBrief: LivingBriefItem[];
};

export type MailThreadItem = InboxItem & {
  threadCount: number;
  organizationCapabilities?: ProviderOrganizationCapabilities;
};

export type MailPage = {
  items: MailThreadItem[];
  nextCursor: string | null;
  total: number;
};

export type SavedViewDateFilter =
  | "any"
  | "today"
  | "week"
  | "month"
  | "recent"
  | "last7"
  | "last30";

export type SavedViewMailFilters = {
  folder?: string;
  account?: string;
  inboxCategory?: string;
  priority?: AttentionLevel | "";
  category?: string;
  categories?: string[];
  unread?: boolean;
  attachments?: boolean;
  date?: SavedViewDateFilter;
  search?: string;
  needsReply?: boolean;
  hasDeadline?: boolean;
  handled?: "active" | "handled" | "any";
};

export type SavedViewDefinition = {
  kind: "mail";
  filters: SavedViewMailFilters;
  sort?: "newest" | "oldest" | "priority";
  semanticKey?: string;
};

export type SavedView = {
  id: string;
  workspaceId: string;
  label: string;
  description: string;
  definition: SavedViewDefinition;
  isBuiltin: boolean;
  isEnabled: boolean;
  isAllAccounts: boolean;
  accountScopeLabel: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type SavedViewPage = {
  generatedAt: string;
  workspaceId: string;
  items: SavedView[];
};

export type NaturalLanguageSearchAppliedFilter = {
  field: string;
  label: string;
  value: string;
  reason: string;
};

export type NaturalLanguageSearchInterpretation = {
  query: string;
  workspaceId: string;
  workspaceLabel: string;
  mode: "local";
  confidence: "high" | "medium" | "low";
  filters: SavedViewMailFilters;
  filterParams: Record<string, string>;
  applied: NaturalLanguageSearchAppliedFilter[];
  ignoredTerms: string[];
  warnings: string[];
  explanation: string;
  providerSearch: {
    readOnly: true;
    available: boolean;
    requested: boolean;
    reason: string;
  };
};

export type NaturalLanguageSearchPage = {
  generatedAt: string;
  query: string;
  interpretation: NaturalLanguageSearchInterpretation;
  results: MailPage;
};

export type MailActionName =
  | "done"
  | "keep"
  | "raise_priority"
  | "lower_priority"
  | "mark_read"
  | "teach_care"
  | "quiet"
  | "unsubscribe"
  | "spam"
  | "delete"
  | "delete_and_teach"
  | "pin"
  | "unpin"
  | "flag"
  | "unflag"
  | "undo";

export type MailActionResult = {
  actionId: string;
  action: MailActionName;
  successCount: number;
  failureCount: number;
  reversible: boolean;
  failures: MailActionFailure[];
  changedIds?: string[];
  unchangedIds?: string[];
  savedPreferences?: MailCarePreferenceSummary[];
};

export type MailActionFailure = {
  id: string;
  error: string;
  code?: "credentials_expired" | "permission_required" | "rate_limited" | "provider_unavailable" | "provider_error" | "protected" | "not_found" | "local_error";
  accountId?: string | null;
  accountLabel?: string | null;
  provider?: AccountProvider | null;
  retryable?: boolean;
};

export type MailActionOutcome = {
  id: string;
  subject: string;
  senderName: string;
  accountLabel: string;
  provider: AccountProvider;
  status: "changed" | "unchanged" | "failed";
  error: string | null;
  code: MailActionFailure["code"] | null;
  retryable: boolean;
};

export type MailActionDetail = {
  actionId: string;
  action: MailActionName;
  status: string;
  occurredAt: string;
  reversible: boolean;
  undoStatus: string | null;
  changedCount: number;
  unchangedCount: number;
  failedCount: number;
  outcomes: MailActionOutcome[];
};

export type RuleItem = {
  id: string;
  source: "cleanup" | "priority";
  kind: "sender" | "topic";
  accountId: string | null;
  accountLabel: string | null;
  accountEmail: string | null;
  accountProvider: AccountProvider | null;
  target: string;
  senderEmail: string;
  action: string;
  enabled: boolean;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AskEzraResult = {
  answer: string;
  sources: Array<{
    id: string;
    senderName: string;
    subject: string;
    receivedAt: string;
    summary: string;
  }>;
};

export type AuthSessionState = {
  authenticated: boolean;
  configured: boolean;
  developmentBypass: boolean;
  expiresAt: string | null;
  authenticationMethod?: "session" | "trusted_device" | "bypass" | null;
  trustedDevice?: { id: string; label: string } | null;
  requiresDeviceEnrollment?: boolean;
};

export type TrustedDeviceSummary = {
  id: string;
  label: string;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  lastUserAgent: string | null;
  lastIpAddress: string | null;
  revokedAt: string | null;
};
