import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAccountFreshness,
  markWorkspacePurposesReviewed,
  syncAccountNow,
  updateAccountSetup,
  updateAccountPurpose,
} from "@/lib/email/account-health";
import {
  configureEmailDatabaseForTests,
  ensureEmailDatabase,
  execute,
  getSetting,
  nowIso,
  setServiceState,
  setSetting,
} from "@/lib/email/database";
import { getMailMeta } from "@/lib/email/professional";
import { pollMailAccount } from "@/lib/email/service";

vi.mock("@/lib/email/service", () => ({
  pollMailAccount: vi.fn(async (accountId: string) => ({ accountId, provider: "gmail", ingested: 0, completedAt: nowIso() })),
}));

describe("account profiles and freshness", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./account-health-${randomUUID()}.sqlite`);
    vi.mocked(pollMailAccount).mockClear();
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, last_sync_at, created_at, updated_at)
       VALUES ('acct-gmail', 'gmail', 'owner@gmail.test', 'Gmail', 'connected', ?, ?, ?)`,
      [now, now, now],
    );
  });

  it("edits presentation purpose without changing account identity or routing", async () => {
    const updated = await updateAccountPurpose({ accountId: "acct-gmail", purposeLabel: "  Career and applications  " });
    expect(updated.items[0]).toMatchObject({
      accountId: "acct-gmail",
      accountEmail: "owner@gmail.test",
      purposeLabel: "Career and applications",
    });

    const meta = await getMailMeta();
    expect(meta.accounts[0]).toMatchObject({ id: "acct-gmail", email: "owner@gmail.test", purpose: "Career and applications" });
    expect(meta.workspaces.find((workspace) => workspace.id === "workspace:account:gmail:acct-gmail")?.purpose).toBe("Career and applications");
  });

  it("stores an account-scoped setup purpose and bounded initial sync range", async () => {
    const updated = await updateAccountSetup({
      accountId: "acct-gmail",
      purposeLabel: "Career and applications",
      syncRangeDays: 14,
    });

    expect(updated.items[0]).toMatchObject({
      accountId: "acct-gmail",
      purposeLabel: "Career and applications",
      syncRangeDays: 14,
    });
    await expect(execute(
      `SELECT purpose_label, sync_range_days FROM account_profile_settings WHERE account_id = 'acct-gmail'`,
    )).resolves.toMatchObject({ rows: [{ purpose_label: "Career and applications", sync_range_days: 14 }] });
  });

  it("migrates a legacy provider saved view only when its account selection is unambiguous", async () => {
    const now = nowIso();
    await execute(
      `INSERT INTO saved_views
        (id, workspace_id, label, description, definition_json, is_builtin, is_enabled, sort_order, created_at, updated_at)
       VALUES ('view-legacy-gmail', 'workspace:gmail', 'Follow up', '', '{"kind":"mail","sort":"newest","filters":{}}', 0, 1, 1000, ?, ?)`,
      [now, now],
    );
    const url = process.env.EZRA_EMAIL_DATABASE_URL!;
    configureEmailDatabaseForTests(url);
    await ensureEmailDatabase();

    const migrated = await execute(`SELECT workspace_id FROM saved_views WHERE id = 'view-legacy-gmail'`);
    expect(migrated.rows[0]?.workspace_id).toBe("workspace:account:gmail:acct-gmail");
  });

  it("shows poll/action timing and records explicit purpose review", async () => {
    const actionAt = new Date(Date.now() - 30_000).toISOString();
    await execute(
      `INSERT INTO outgoing_drafts
        (id, source_type, account_id, from_email, to_recipients, cc_recipients, bcc_recipients,
         subject, body, content_hash, version, status, created_at, updated_at)
       VALUES ('draft-health', 'new', 'acct-gmail', 'owner@gmail.test', '[]', '[]', '[]',
         'Test', 'Body', 'hash', 1, 'sent', ?, ?)`,
      [actionAt, actionAt],
    );
    await execute(
      `INSERT INTO outgoing_message_attempts
        (id, draft_id, account_id, provider, status, content_hash, started_at, completed_at)
       VALUES ('attempt-health', 'draft-health', 'acct-gmail', 'gmail', 'sent', 'hash', ?, ?)`,
      [actionAt, actionAt],
    );

    await setSetting("poll_minutes", "1");
    const page = await getAccountFreshness();
    expect(page.pollIntervalMinutes).toBe(1);
    expect(page.items[0].lastSuccessfulPollAt).toBeTruthy();
    expect(page.items[0].lastProviderActionAt).toBe(actionAt);
    expect(new Date(page.items[0].nextExpectedCheckAt!).getTime() - new Date(page.items[0].lastSuccessfulPollAt!).getTime()).toBe(60_000);
    expect(page.items[0].issues?.find((issue) => issue.feature === "mail")).toMatchObject({ status: "ok", reconnectRecommended: false });

    await markWorkspacePurposesReviewed();
    expect(await getSetting("workspace_purposes_reviewed_at")).toBeTruthy();
  });

  it("keeps mail sync available while reporting Calendar permission separately", async () => {
    await execute(
      `INSERT INTO calendar_sync_state
        (account_id, calendar_id, status, last_sync_at, last_error, updated_at)
       VALUES ('acct-gmail', 'primary', 'error', NULL, 'Reconnect Gmail from Settings to grant Google Calendar access.', ?)`,
      [nowIso()],
    );

    const page = await getAccountFreshness();
    expect(page.items[0].canSyncNow).toBe(true);
    expect(page.items[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: "mail", status: "ok" }),
      expect.objectContaining({
        feature: "calendar",
        status: "error",
        message: "Reconnect Gmail from Settings to grant Google Calendar access.",
      }),
    ]));
  });

  it("enforces the manual sync cooldown before calling providers", async () => {
    await setServiceState("manual_account_sync:acct-gmail", nowIso());
    await expect(syncAccountNow("acct-gmail")).rejects.toThrow("cooling down");
    expect(pollMailAccount).not.toHaveBeenCalled();
  });

  it("keeps an expired-credential recovery signal ahead of a later generic error", async () => {
    const lastSuccess = new Date(Date.now() - 120_000).toISOString();
    const credentialFailure = new Date(Date.now() - 60_000).toISOString();
    const genericFailure = new Date(Date.now() - 30_000).toISOString();
    await execute(
      `UPDATE email_accounts SET status = 'error', last_sync_at = ? WHERE id = 'acct-gmail'`,
      [lastSuccess],
    );
    await execute(
      `INSERT INTO audit_logs
        (id, action, actor, target_type, target_id, metadata, created_at)
       VALUES
        ('audit-credential', 'gmail.poll.failed', 'worker', 'account', 'acct-gmail', ?, ?),
        ('audit-generic', 'gmail.calendar.failed', 'worker', 'account', 'acct-gmail', ?, ?)`,
      [
        JSON.stringify({
          error: "Gmail authorization expired or was revoked. Reconnect Gmail from Settings > Accounts.",
          errorCode: "credentials_expired",
          reconnectRecommended: true,
        }),
        credentialFailure,
        JSON.stringify({
          error: "Gmail could not complete the provider request. Review Settings > Accounts and try again.",
          errorCode: "provider_error",
          reconnectRecommended: false,
        }),
        genericFailure,
      ],
    );

    const page = await getAccountFreshness();
    expect(page.items[0]).toMatchObject({
      status: "error",
      reconnectRecommended: true,
      lastError: "Gmail authorization expired or was revoked. Reconnect Gmail from Settings > Accounts.",
      recoveryMessage: "Gmail authorization expired or was revoked. Reconnect Gmail from Settings > Accounts.",
    });
  });
});
