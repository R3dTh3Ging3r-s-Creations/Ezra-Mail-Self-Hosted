import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureEmailDatabaseForTests,
  execute,
  nowIso,
  setSetting,
} from "@/lib/email/database";
import { getOnboardingChecklist } from "@/lib/email/onboarding";
import { updateNotificationPolicy } from "@/lib/email/notification-center";

vi.mock("@/lib/email/gmail", () => ({
  getGmailAuthorizationCapabilities: vi.fn(async () => ({ modify: true })),
}));

describe("onboarding checklist", () => {
  beforeEach(() => {
    configureEmailDatabaseForTests(`file:./onboarding-${randomUUID()}.sqlite`);
    process.env.TELEGRAM_BOT_TOKEN = "";
    process.env.TELEGRAM_DEFAULT_CHAT_ID = "";
  });

  it("reports honest setup state without treating unverified backups as complete", async () => {
    const empty = await getOnboardingChecklist({ workspaceId: "workspace:gmail" });
    expect(empty.items.find((item) => item.id === "gmail")).toMatchObject({ status: "not_started" });
    expect(empty.items.find((item) => item.id === "notification_policy")).toMatchObject({ status: "needs_attention" });
    expect(empty.items.find((item) => item.id === "backup_restore")).toMatchObject({ status: "needs_attention", statusLabel: "Setup needed" });
    expect(empty.summary.planned).toBe(0);
  });

  it("marks managed backup and restore readiness complete only with both evidence records", async () => {
    const now = nowIso();
    await setSetting("last_managed_backup_at", now);
    await setSetting("last_restore_rehearsal_at", now);
    const checklist = await getOnboardingChecklist();
    expect(checklist.items.find((item) => item.id === "backup_restore")).toMatchObject({ status: "complete", statusLabel: "Protected" });
  });

  it("derives completion from accounts, permissions, review markers, and action history", async () => {
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, last_sync_at, created_at, updated_at)
       VALUES ('acct-gmail', 'gmail', 'owner@gmail.test', 'Gmail', 'connected', ?, ?, ?)`,
      [now, now, now],
    );
    await execute(
      `INSERT INTO account_integrations
        (account_id, feature, provider, access, status, last_connected_at, updated_at)
       VALUES ('acct-gmail', 'calendar', 'gmail', 'write', 'connected', ?, ?)`,
      [now, now],
    );
    await execute(
      `INSERT INTO calendar_sync_state
        (account_id, calendar_id, status, last_sync_at, last_error, range_from, range_to, updated_at)
       VALUES ('acct-gmail', 'primary', 'connected', ?, NULL, ?, ?, ?)`,
      [now, "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", now],
    );
    await execute(
      `INSERT INTO mail_actions
        (id, action, status, message_ids, success_count, failure_count, details, created_at, executed_at)
       VALUES ('action-first', 'mark_read', 'completed', '[]', 1, 0, '{}', ?, ?)`,
      [now, now],
    );
    await setSetting("notification_policy_reviewed_at", now);
    await setSetting("workspace_purposes_reviewed_at", now);

    const checklist = await getOnboardingChecklist();
    expect(checklist.items.find((item) => item.id === "gmail")).toMatchObject({ status: "complete" });
    expect(checklist.items.find((item) => item.id === "calendars")).toMatchObject({ status: "complete" });
    expect(checklist.items.find((item) => item.id === "send")).toMatchObject({ status: "complete" });
    expect(checklist.items.find((item) => item.id === "notification_policy")).toMatchObject({ status: "complete" });
    expect(checklist.items.find((item) => item.id === "workspace_purposes")).toMatchObject({ status: "complete" });
    expect(checklist.items.find((item) => item.id === "first_approved_action")).toMatchObject({ status: "complete" });
  });

  it("counts a successful executed mailbox action as core readiness", async () => {
    const now = nowIso();
    await execute(
      `INSERT INTO mail_actions
        (id, action, status, message_ids, success_count, failure_count, details, created_at, executed_at)
       VALUES ('action-executed', 'mark_read', 'executed', '[]', 1, 0, '{}', ?, ?)`,
      [now, now],
    );

    const checklist = await getOnboardingChecklist();

    expect(checklist.items.find((item) => item.id === "first_approved_action"))
      .toMatchObject({ status: "complete", statusLabel: "Completed" });
  });

  it("does not count a partial action that changed no mailbox targets", async () => {
    const now = nowIso();
    await execute(
      `INSERT INTO mail_actions
        (id, action, status, message_ids, success_count, failure_count, details, created_at, executed_at)
       VALUES ('action-empty-partial', 'mark_read', 'partial', '[]', 0, 1, '{}', ?, ?)`,
      [now, now],
    );

    const checklist = await getOnboardingChecklist();

    expect(checklist.items.find((item) => item.id === "first_approved_action"))
      .toMatchObject({ status: "not_started", statusLabel: "Not tried yet" });
  });

  it("does not mark notification policy reviewed when validation fails", async () => {
    await expect(updateNotificationPolicy({ timezone: "Not/A-Timezone" })).rejects.toThrow();
    const checklist = await getOnboardingChecklist();
    expect(checklist.items.find((item) => item.id === "notification_policy")).toMatchObject({ status: "needs_attention" });
  });
});
