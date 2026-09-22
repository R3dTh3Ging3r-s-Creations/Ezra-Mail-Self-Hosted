import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureEmailDatabaseForTests,
  execute,
  getSetting,
} from "@/lib/email/database";
import {
  getNotificationPolicyCenter,
  notificationPreferenceForCategory,
  updateNotificationPolicy,
} from "@/lib/email/notification-center";

describe("Notification Policy Center", () => {
  beforeEach(() => {
    configureEmailDatabaseForTests(`file:./notification-center-${randomUUID()}.sqlite`);
    vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "false");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("loads editable defaults and channel/status guardrails", async () => {
    const policy = await getNotificationPolicyCenter();
    expect(policy.timezone).toBe("America/Chicago");
    expect(policy.digestTimes).toEqual(["08:30", "16:30"]);
    expect(policy.quietStart).toBe("22:00");
    expect(policy.quietEnd).toBe("07:30");
    expect(policy.channels.map((channel) => channel.id)).toEqual(["in_app", "telegram", "browser"]);
    expect(policy.channels.find((channel) => channel.id === "browser")).toMatchObject({
      status: "deferred",
      lastError: null,
    });
    expect(policy.categoryPolicies.find((item) => item.id === "security")).toMatchObject({
      preference: "interrupt",
      quietHoursBypass: true,
    });
    expect(policy.categoryPolicies.find((item) => item.id === "promotions")).toMatchObject({
      preference: "quiet",
    });
  });
  it("exposes browser enrollment availability without claiming per-browser permission", async () => {
    vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "true");
    const policy = await getNotificationPolicyCenter();
    expect(policy.channels.find((channel) => channel.id === "browser")).toMatchObject({
      status: "available",
      lastError: null,
    });
    expect(policy.channels.find((channel) => channel.id === "browser")?.detail).toMatch(/this browser/i);
  });
  it("persists quiet hours, digest times, timezone, and category preferences", async () => {
    const updated = await updateNotificationPolicy({
      timezone: "America/New_York",
      digestTimes: ["09:15", "17:45"],
      quietStart: "21:30",
      quietEnd: "06:45",
      categoryPreferences: {
        jobs: "digest",
        promotions: "quiet",
        personal: "interrupt",
      },
    });
    expect(updated).toMatchObject({
      timezone: "America/New_York",
      digestTimes: ["09:15", "17:45"],
      quietStart: "21:30",
      quietEnd: "06:45",
    });
    expect(await getSetting("timezone")).toBe("America/New_York");
    expect(await getSetting("quiet_start")).toBe("21:30");
    expect(await getSetting("quiet_end")).toBe("06:45");
    expect(JSON.parse(String(await getSetting("digest_times")))).toEqual(["09:15", "17:45"]);
    expect(updated.categoryPolicies.find((item) => item.id === "jobs")?.preference).toBe("digest");
    expect(updated.categoryPolicies.find((item) => item.id === "personal")?.preference).toBe("interrupt");
  });
  it("matches future notification policy by normalized category labels", async () => {
    await updateNotificationPolicy({
      categoryPreferences: {
        jobs: "digest",
        promotions: "quiet",
      },
    });
    expect(await notificationPreferenceForCategory("Job Application / Interview Request")).toMatchObject({
      id: "jobs",
      preference: "digest",
    });
    expect(await notificationPreferenceForCategory("Marketing/Promotional")).toMatchObject({
      id: "promotions",
      preference: "quiet",
    });
  });
  it("summarizes recent notification and digest health", async () => {
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct', 'gmail', 'owner@gmail.test', 'Gmail', 'connected', '2026-07-02T09:00:00.000Z', '2026-07-02T09:00:00.000Z')`,
    );
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
         received_at, snippet, gmail_url, is_unread, status, created_at, updated_at)
       VALUES ('mail-1', 'acct', 'ext-1', 'thread-1', 'Sender', 'sender@example.test', 'Important',
        '2026-07-02T10:00:00.000Z', 'snippet', 'https://mail.example.test', 1, 'triaged',
        '2026-07-02T10:00:00.000Z', '2026-07-02T10:00:00.000Z')`,
    );
    await execute(
      `INSERT INTO notifications
        (id, message_id, channel, kind, status, sent_at, error, created_at)
       VALUES
        ('notice-sent', 'mail-1', 'telegram', 'interrupt', 'sent', ?, NULL, ?),
        ('notice-skipped', 'mail-1', 'telegram', 'interrupt', 'skipped', NULL, 'quiet', ?)`,
      [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
    );
    await execute(
      `INSERT INTO email_digests
        (id, label, channel, status, item_count, scheduled_for, error, created_at, sent_at)
       VALUES
        ('digest-sent', 'Morning', 'telegram', 'sent', 1, NULL, NULL, ?, ?),
        ('digest-failed', 'Afternoon', 'telegram', 'failed', 1, NULL, 'Telegram failed', ?, NULL)`,
      [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
    );
    const policy = await getNotificationPolicyCenter();
    expect(policy.stats).toMatchObject({
      windowDays: 7,
      interruptsSent: 1,
      interruptsSkipped: 1,
      interruptsFailed: 0,
      digestsSent: 1,
      digestsFailed: 1,
    });
    expect(policy.stats.lastNotificationAt).toBeTruthy();
    expect(policy.stats.lastDigestAt).toBeTruthy();
  });
  it("rejects invalid schedule input before saving", async () => {
    await expect(updateNotificationPolicy({ quietStart: "25:00" })).rejects.toThrow("quiet start");
    await expect(updateNotificationPolicy({ timezone: "Mars/Base" })).rejects.toThrow("valid IANA timezone");
  });
});

describe("validated attention settings", () => {
  beforeEach(() => configureEmailDatabaseForTests(`file:./attention-settings-${randomUUID()}.sqlite`));
  it("loads conservative defaults and persists all attention controls", async () => {
    expect(await getNotificationPolicyCenter()).toMatchObject({
      dailyInterruptBudget: 3,
      burstWindowSeconds: 60,
      senderCooldownMinutes: 360,
      snoozedUntil: null,
      calmCheckinEnabled: false,
      calmCheckinTime: "12:30",
    });
    const next = {
      dailyInterruptBudget: 20,
      burstWindowSeconds: 300,
      senderCooldownMinutes: 1440,
      snoozedUntil: new Date(Date.now() + 60_000).toISOString(),
      calmCheckinEnabled: true,
      calmCheckinTime: "23:59"
    };
    expect(await updateNotificationPolicy(next)).toMatchObject(next);
    expect(await updateNotificationPolicy({
      dailyInterruptBudget: 0,
      burstWindowSeconds: 0,
      senderCooldownMinutes: 20,
      snoozedUntil: null
    })).toMatchObject({
      dailyInterruptBudget: 0,
      burstWindowSeconds: 0,
      senderCooldownMinutes: 20,
      snoozedUntil: null
    });
  });
  it.each([
    { dailyInterruptBudget: -1 }, { dailyInterruptBudget: 21 }, { dailyInterruptBudget: 1.1 },
    { burstWindowSeconds: 301 }, { burstWindowSeconds: -1 }, { senderCooldownMinutes: 19 },
    { senderCooldownMinutes: 1441 }, { senderCooldownMinutes: NaN }, { calmCheckinEnabled: "true" },
    { calmCheckinTime: "24:00" }, { snoozedUntil: "invalid" }, { snoozedUntil: "2000-01-01T00:00:00Z" },
    { snoozedUntil: "2099-01-01T00:00:00Z" }, { unknown: true }, { categoryPreferences: { unknown: "quiet" } },
    { categoryPreferences: { security: "loud" } }, { digestTimes: [] }, { digestTimes: ["bad"] },
  ])("rejects invalid values atomically: %j", async (invalid) => {
    await expect(updateNotificationPolicy({
      quietStart: "21:00",
      ...invalid
    } as never)).rejects.toThrow();
    expect(await getSetting("quiet_start")).not.toBe("21:00");
    expect(await getSetting("notification_policy_reviewed_at")).toBeNull();
  });
  it("rolls back every setting when a later SQL write fails", async () => {
    await execute(`CREATE TRIGGER refuse_attention BEFORE INSERT ON settings
      WHEN NEW.key = 'notification_daily_interrupt_budget'
      BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END`);
    await expect(updateNotificationPolicy({
      quietStart: "21:00",
      dailyInterruptBudget: 4
    })).rejects.toThrow();
    expect(await getSetting("quiet_start")).not.toBe("21:00");
    expect(await getSetting("notification_policy_reviewed_at")).toBeNull();
  });
});

it("Telegram configuration alone is not delivery readiness",async()=>{configureEmailDatabaseForTests(`file:./notification-center-${randomUUID()}.sqlite`);vi.stubEnv("TELEGRAM_BOT_TOKEN","123456:synthetic");vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID","123456789");try {const policy=await getNotificationPolicyCenter();expect(policy.channels.find(c=>c.id==="telegram")).toMatchObject({status:"needs_setup"});expect(policy.channels.find(c=>c.id==="telegram")?.detail).toMatch(/enrollment/i);}finally{vi.unstubAllEnvs();}});
