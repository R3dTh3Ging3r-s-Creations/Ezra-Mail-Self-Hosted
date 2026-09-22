import { z } from "zod";
import { withNotificationStoreWrite } from "./notification-store";
import { localAttentionDay, matchesNotificationCategoryPreference } from "./notification-attention";
import { execute, getSetting, nowIso } from "./database";
import { getTelegramStatus } from "./telegram";
import { getActiveTelegramBinding } from "./notification-telegram";
import { foregroundBrowserNotificationsEnabled } from "./foreground-notifications";
import type {
  NotificationCategoryPolicy,
  NotificationPolicyPage,
  NotificationPolicySettings,
  NotificationPreference,
} from "./types";

const CATEGORY_SETTING = "notification_category_preferences";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const DEFAULT_DIGEST_TIMES = ["08:30", "16:30"];

const CATEGORY_POLICIES: Omit<NotificationCategoryPolicy, "preference">[] = [
  {
    id: "security",
    label: "Security, fraud, legal",
    description: "Account security, fraud, legal, and privacy alerts should be allowed to interrupt when fresh.",
    categories: ["account-security", "account security", "security alert", "security threat", "fraud", "legal", "account-compromise"],
    quietHoursBypass: true,
  },
  {
    id: "jobs",
    label: "Jobs and submissions",
    description: "Recruiters, interviews, job applications, book submissions, and professional follow-ups.",
    categories: ["job", "job alert", "job application", "interview", "recruiter", "submission", "book submission"],
    quietHoursBypass: false,
  },
  {
    id: "personal",
    label: "Personal correspondence",
    description: "Human-to-human messages that may deserve a same-day look without being treated like emergencies.",
    categories: ["personal", "correspondence", "reply", "family", "friend", "general"],
    quietHoursBypass: false,
  },
  {
    id: "deadlines",
    label: "Deadlines and commitments",
    description: "Time-bound commitments, bills, appointments, and due dates.",
    categories: ["deadline", "appointment", "calendar", "bill", "commitment", "payment"],
    quietHoursBypass: false,
  },
  {
    id: "updates",
    label: "Useful updates",
    description: "Account updates, receipts, shipping, and useful context that normally belongs in a digest.",
    categories: ["account update", "account/privacy update", "receipt", "shipping", "useful update", "worth knowing"],
    quietHoursBypass: false,
  },
  {
    id: "promotions",
    label: "Promotions and newsletters",
    description: "Sales, marketing, newsletters, and recurring low-pressure senders.",
    categories: ["marketing/promotional", "promotion", "newsletter", "sale", "discount"],
    quietHoursBypass: false,
  },
];

const DEFAULT_PREFERENCES: Record<string, NotificationPreference> = {
  security: "interrupt",
  jobs: "interrupt",
  personal: "digest",
  deadlines: "interrupt",
  updates: "digest",
  promotions: "quiet",
};

const settingNames = {
  timezone: "timezone",
  digestTimes: "digest_times",
  quietStart: "quiet_start",
  quietEnd: "quiet_end",
  categoryPreferences: CATEGORY_SETTING,
  dailyInterruptBudget: "notification_daily_interrupt_budget",
  burstWindowSeconds: "notification_burst_window_seconds",
  senderCooldownMinutes: "notification_sender_cooldown_minutes",
  snoozedUntil: "notification_snoozed_until",
  calmCheckinEnabled: "notification_calm_checkin_enabled",
  calmCheckinTime: "notification_calm_checkin_time",
} as const;

/** Select only these keys inside an existing transaction, then use the pure parser. */
export const notificationPolicySettingKeys = Object.values(settingNames);

export type NotificationPolicySettingsSnapshot = Readonly<Record<string, unknown>>;

const timeSchema = (label: string) => z.string().max(5).regex(TIME_RE, `Enter a valid ${label} time as HH:MM.`);

const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}, "Choose a valid IANA timezone, like America/Chicago.");

const preferencesSchema = z.record(z.enum(["interrupt", "digest", "quiet"]))
  .refine(value => Object.keys(value).every(key => CATEGORY_POLICIES.some(policy => policy.id === key)), "Unknown category preference.");

/** Shared route/direct-call validation. No writes occur until the whole object passes. */
export function notificationPolicyUpdateSchema(now = new Date()) {
  return z.object({
    timezone: timezoneSchema.optional(),
    digestTimes: z.array(timeSchema("digest")).min(1).max(4)
      .transform(values => [...new Set(values)].sort()).optional(),
    quietStart: timeSchema("quiet start").optional(),
    quietEnd: timeSchema("quiet end").optional(),
    categoryPreferences: preferencesSchema.optional(),
    dailyInterruptBudget: z.number().int().min(0).max(20).optional(),
    burstWindowSeconds: z.number().int().min(0).max(300).optional(),
    senderCooldownMinutes: z.number().int().min(20).max(1440).optional(),
    snoozedUntil: z.string().max(40).datetime({ offset: true }).refine(value => {
      const delta = Date.parse(value) - now.getTime();
      return delta > 0 && delta <= 7 * 86_400_000;
    }, "Choose a future snooze within seven days.").nullable().optional(),
    calmCheckinEnabled: z.boolean().optional(),
    calmCheckinTime: timeSchema("calm check-in").optional(),
    snooze: z.enum(["hour", "tomorrow", "clear"]).optional(),
  }).strict().refine(value => value.snooze === undefined || value.snoozedUntil === undefined, "Choose one snooze action.");
}

export type NotificationPolicyUpdate = z.input<ReturnType<typeof notificationPolicyUpdateSchema>>;

/** Pure, bounded parsing: malformed stored fields revert individually to reviewed defaults. */
export function parseNotificationPolicySettings(
  snapshot: NotificationPolicySettingsSnapshot,
  now = new Date(),
): NotificationPolicySettings {
  const defaults = {
    timezone: "America/Chicago",
    digestTimes: [...DEFAULT_DIGEST_TIMES],
    quietStart: "22:00",
    quietEnd: "07:30",
    categoryPreferences: {},
    dailyInterruptBudget: 3,
    burstWindowSeconds: 60,
    senderCooldownMinutes: 360,
    snoozedUntil: null,
    calmCheckinEnabled: false,
    calmCheckinTime: "12:30",
  };
  const schema = notificationPolicyUpdateSchema(now);
  const values: Record<string, unknown> = { ...defaults };
  for (const [field, key] of Object.entries(settingNames)) {
    const raw = snapshot[key];
    if (typeof raw !== "string" || raw.length > 4096) continue;
    try {
      if (field === "categoryPreferences") {
        const object: unknown = JSON.parse(raw);
        if (object && typeof object === "object" && !Array.isArray(object)) {
          const valid: Record<string, NotificationPreference> = {};
          for (const entry of CATEGORY_POLICIES) {
            const preference = (object as Record<string, unknown>)[entry.id];
            if (preference === "interrupt" || preference === "digest" || preference === "quiet") valid[entry.id] = preference;
          }
          values.categoryPreferences = valid;
        }
        continue;
      }
      const jsonField = ["digestTimes", "categoryPreferences", "dailyInterruptBudget", "burstWindowSeconds", "senderCooldownMinutes", "calmCheckinEnabled", "snoozedUntil"].includes(field);
      const parsed = schema.safeParse({ [field]: jsonField ? JSON.parse(raw) : raw });
      if (parsed.success) Object.assign(values, parsed.data);
    } catch {
      // Corrupt local settings do not grant extra delivery privileges.
    }
  }
  const { categoryPreferences, ...parsed } = schema.parse(values);
  const { categoryPreferences: defaultPreferences, ...defaultSettings } = defaults;
  return {
    ...defaultSettings,
    ...parsed,
    categoryPolicies: categoryPolicies(categoryPreferences || defaultPreferences),
  };
}

export async function getNotificationPolicySettings(now = new Date()) {
  const result = await execute(
    `SELECT key, value FROM settings WHERE key IN (${notificationPolicySettingKeys.map(() => "?").join(",")})`,
    notificationPolicySettingKeys,
  );
  return parseNotificationPolicySettings(Object.fromEntries(result.rows.map(row => [String(row.key), row.value])), now);
}

export async function getNotificationPolicyCenter(): Promise<NotificationPolicyPage> {
  const browserNotificationsAvailable = foregroundBrowserNotificationsEnabled();
  const [settings, stats, telegram] = await Promise.all([
    getNotificationPolicySettings(),
    notificationStats(),
    getActiveTelegramBinding().then(binding => ({ ...getTelegramStatus(), enrolled: !!binding })),
  ]);
  return {
    generatedAt: nowIso(),
    ...settings,
    channels: [
      {
        id: "in_app",
        label: "In-app Today",
        status: "enabled",
        detail: "Always on. Today, Mail, Calendar, and Action Center remain available without external services.",
        lastError: null,
      },
      {
        id: "telegram",
        label: "Telegram",
        status: telegram.enrolled ? "enabled" : "needs_setup",
        detail: telegram.enrolled
          ? "Telegram notifications are enrolled. Command polling is managed by the worker when enabled; acceptance does not confirm display or reading."
          : telegram.configured ? "Telegram is configured; explicit enrollment in these Settings is required." : "Configure a private bot and positive owner chat ID, then explicitly enroll Telegram here.",
        lastError: null,
      },
      {
        id: "browser",
        label: "Browser/app notifications",
        status: browserNotificationsAvailable ? "available" : "deferred",
        detail: browserNotificationsAvailable
          ? "Available for explicit enrollment on this browser. Ezra cannot see or change this browser's permission from the server."
          : "Deferred until the owner enables the browser-notification feature.",
        lastError: null,
      },
    ],
    guardrails: [
      {
        label: "Quiet hours",
        detail: "Noncritical interrupts wait for the next morning brief during quiet hours.",
      },
      {
        label: "Critical bypass",
        detail: "Fresh security, fraud, legal, or account-compromise mail can bypass quiet hours.",
      },
      {
        label: "Cooldowns",
        detail: "General nudges wait 90 minutes between alerts and use your sender cooldown; critical sender bursts wait 20 minutes and allow at most two events per 15 minutes.",
      },
      {
        label: "No silent browser alerts",
        detail: browserNotificationsAvailable
          ? "Only an explicit Settings action on this exact browser and origin can request notification permission."
          : "Browser notifications remain disabled by default.",
      },
    ],
    stats,
  };
}

export async function updateNotificationPolicy(input: NotificationPolicyUpdate) {
  const now = new Date();
  const parsed = notificationPolicyUpdateSchema(now).parse(input);
  await withNotificationStoreWrite(async tx => {
    const { snooze, ...values } = parsed;
    if (snooze !== undefined) {
      let until: string | null = null;
      if (snooze === "hour") until = new Date(now.getTime() + 3600000).toISOString();
      if (snooze === "tomorrow") {
        const settings = await tx.execute({ sql: "SELECT key,value FROM settings WHERE key IN ('timezone','quiet_end')", args: [] });
        const current = parseNotificationPolicySettings(Object.fromEntries(settings.rows.map(row => [String(row.key), row.value])), now);
        const timezone = values.timezone || current.timezone, end = values.quietEnd || current.quietEnd;
        const day = localAttentionDay(now, timezone);
        const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
        for (let i = 1; i <= 3000; i++) {
          const candidate = new Date(Math.floor(now.getTime() / 60000) * 60000 + i * 60000);
          if (localAttentionDay(candidate, timezone) !== day && formatter.format(candidate) >= end) { until = candidate.toISOString(); break; }
        }
        if (!until) throw new Error("Snooze unavailable");
      }
      values.snoozedUntil = until;
    }
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const key = settingNames[field as keyof typeof settingNames];
      const encoded = typeof value === "string" && field !== "snoozedUntil" ? value : JSON.stringify(value);
      await tx.execute({
        sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        args: [key, encoded, now.toISOString()],
      });
    }
    await tx.execute({
      sql: `INSERT INTO settings (key, value, updated_at) VALUES ('notification_policy_reviewed_at', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [now.toISOString(), now.toISOString()],
    });
  });
  return getNotificationPolicyCenter();
}

export async function notificationPreferenceForCategory(category: string | null | undefined) {
  if (!category) return null;
  const policies = await getNotificationCategoryPolicies();
  return policies.find((policy) =>
    policy.categories.some(candidate => matchesNotificationCategoryPreference(category, candidate)),
  ) || null;
}

export async function getNotificationCategoryPolicies(): Promise<NotificationCategoryPolicy[]> {
  const settings = parseNotificationPolicySettings({ [CATEGORY_SETTING]: await getSetting(CATEGORY_SETTING) });
  return settings.categoryPolicies;
}

function categoryPolicies(saved: Record<string, NotificationPreference>): NotificationCategoryPolicy[] {
  return CATEGORY_POLICIES.map((policy) => ({
    ...policy,
    preference: saved[policy.id] || DEFAULT_PREFERENCES[policy.id] || "digest",
  }));
}

async function notificationStats(): Promise<NotificationPolicyPage["stats"]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [notifications, digests] = await Promise.all([
    execute(
      `SELECT status, COUNT(*) AS count, MAX(COALESCE(sent_at, created_at)) AS latest
       FROM notifications
       WHERE kind = 'interrupt' AND created_at >= ?
       GROUP BY status`,
      [since],
    ),
    execute(
      `SELECT status, COUNT(*) AS count, MAX(COALESCE(sent_at, created_at)) AS latest
       FROM email_digests
       WHERE channel <> 'shared' AND created_at >= ?
       GROUP BY status`,
      [since],
    ),
  ]);
  const shared = await execute(`SELECT kind,status,COUNT(*) AS count,MAX(created_at) AS latest FROM (
    SELECT e.kind,e.created_at,CASE
      WHEN EXISTS (SELECT 1 FROM notification_deliveries d JOIN notification_attempts a ON a.delivery_id=d.id JOIN notification_receipts r ON r.attempt_id=a.id WHERE d.event_id=e.id AND r.kind IN ('displayed','clicked')) THEN 'displayed'
      WHEN EXISTS (SELECT 1 FROM notification_deliveries d JOIN notification_attempts a ON a.delivery_id=d.id WHERE d.event_id=e.id AND a.outcome='accepted') THEN 'accepted'
      WHEN EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.event_id=e.id AND d.state IN ('pending','claimed')) THEN 'pending'
      WHEN EXISTS (SELECT 1 FROM notification_deliveries d JOIN notification_attempts a ON a.delivery_id=d.id WHERE d.event_id=e.id AND a.outcome IN ('failed','unknown')) THEN 'failed'
      ELSE 'skipped' END AS status
    FROM notification_events e WHERE e.created_at>=? AND e.kind IN ('interrupt','brief','checkin')
  ) GROUP BY kind,status`, [since]);
  const interruptRows = shared.rows.filter(row => row.kind === "interrupt");
  const briefRows = shared.rows.filter(row => row.kind === "brief" || row.kind === "checkin");
  const sharedInterrupts = countMap(interruptRows), sharedBriefs = countMap(briefRows);
  const notificationCounts = countMap(notifications.rows);
  const digestCounts = countMap(digests.rows);
  return {
    windowDays: 7,
    interruptsSent: notificationCounts.sent || 0,
    interruptsSkipped: (notificationCounts.skipped || 0) + (sharedInterrupts.skipped || 0),
    interruptsFailed: (notificationCounts.failed || 0) + (sharedInterrupts.failed || 0),
      interruptsAccepted: sharedInterrupts.accepted || 0,
      interruptsDisplayed: sharedInterrupts.displayed || 0,
    digestsSent: digestCounts.sent || 0,
    digestsSkipped: (digestCounts.skipped || 0) + (sharedBriefs.skipped || 0),
    digestsFailed: (digestCounts.failed || 0) + (sharedBriefs.failed || 0),
      digestsAccepted: sharedBriefs.accepted || 0,
      digestsDisplayed: sharedBriefs.displayed || 0,
    lastNotificationAt: latestFromRows([...notifications.rows, ...interruptRows]),
    lastDigestAt: latestFromRows([...digests.rows, ...briefRows]),
  };
}

function countMap(rows: Awaited<ReturnType<typeof execute>>["rows"]) {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[String(row.status)] = (counts[String(row.status)] || 0) + Number(row.count || 0);
  return counts;
}

function latestFromRows(rows: Awaited<ReturnType<typeof execute>>["rows"]) {
  const values = rows.map((row) => row.latest ? String(row.latest) : "").filter(Boolean).sort();
  return values.at(-1) || null;
}
