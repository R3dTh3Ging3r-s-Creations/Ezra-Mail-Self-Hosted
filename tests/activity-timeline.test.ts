import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  configureEmailDatabaseForTests,
  execute,
  saveTriageDecision,
} from "@/lib/email/database";
import { getActivityTimeline, getMailActionDetail } from "@/lib/email/activity";

describe("Activity Timeline", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./activity-${randomUUID()}.sqlite`);
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, last_sync_at, created_at, updated_at)
       VALUES
        ('acct-gmail', 'gmail', 'owner@gmail.test', 'Gmail', 'connected', '2026-07-02T10:06:00.000Z', '2026-07-02T09:00:00.000Z', '2026-07-02T10:06:00.000Z'),
        ('acct-hotmail', 'microsoft', 'owner@hotmail.test', 'Hotmail', 'connected', '2026-07-02T10:10:00.000Z', '2026-07-02T09:00:00.000Z', '2026-07-02T10:10:00.000Z')`,
    );
  });

  it("returns workspace-scoped chronological events from existing audit tables", async () => {
    await seedMessage({
      id: "gmail-target",
      accountId: "acct-gmail",
      senderName: "Jennifer Ortiz",
      senderEmail: "jennifer@target.test",
      subject: "Target Application Follow Up",
      createdAt: "2026-07-02T10:00:00.000Z",
    });
    await saveTriageDecision("gmail-target", "test-model", {
      attention: "interrupt",
      urgency: 94,
      confidence: 0.91,
      category: "job application",
      summary: "Recruiter asks Eric to schedule a Target interview.",
      reason: "Job follow-up.",
      recommendation: "Schedule interview.",
      needsReply: true,
      deadline: null,
      draftReply: null,
      injectionFlags: [],
      criticalReason: null,
    });
    await seedMessage({
      id: "hotmail-book",
      accountId: "acct-hotmail",
      senderName: "Editor",
      senderEmail: "editor@example.test",
      subject: "Book submission response",
      createdAt: "2026-07-02T10:09:00.000Z",
    });
    await execute(
      `INSERT INTO mail_actions
        (id, action, status, message_ids, success_count, failure_count, details, created_at, executed_at)
       VALUES ('action-ack', 'done', 'executed', ?, 1, 0, ?, '2026-07-02T10:04:00.000Z', '2026-07-02T10:05:00.000Z')`,
      [JSON.stringify(["gmail-target"]), JSON.stringify({ changedIds: ["gmail-target"], unchangedIds: [], failures: [] })],
    );
    await execute(
      `INSERT INTO feedback_events
        (id, message_id, event_type, value, source, created_at)
       VALUES ('feedback-care', 'gmail-target', 'care', 'interrupt', 'message-pane', '2026-07-02T10:03:00.000Z')`,
    );
    await execute(
      `INSERT INTO learned_preferences
        (id, account_id, kind, pattern, action, weight, evidence_count, enabled, created_at, updated_at)
       VALUES ('learn-job-topic', 'acct-gmail', 'topic', 'job application interview request', 'interrupt', 2, 2, 1, '2026-07-02T10:03:30.000Z', '2026-07-02T10:04:30.000Z')`,
    );
    await execute(
      `INSERT INTO notifications
        (id, message_id, channel, kind, status, sent_at, error, created_at)
       VALUES ('notify-target', 'gmail-target', 'telegram', 'interrupt', 'sent', '2026-07-02T10:02:00.000Z', NULL, '2026-07-02T10:01:30.000Z')`,
    );
    await execute(
      `INSERT INTO account_integrations
        (account_id, feature, provider, access, status, last_connected_at, last_error, updated_at)
       VALUES ('acct-gmail', 'calendar', 'gmail', 'write', 'connected', '2026-07-02T10:07:00.000Z', NULL, '2026-07-02T10:07:00.000Z')`,
    );
    await execute(
      `INSERT INTO calendar_sync_state
        (account_id, calendar_id, status, last_sync_at, last_error, updated_at)
       VALUES ('acct-gmail', 'primary', 'connected', '2026-07-02T10:08:00.000Z', NULL, '2026-07-02T10:08:00.000Z')`,
    );
    await seedOutgoingDraft({
      id: "outdraft-gmail",
      accountId: "acct-gmail",
      subject: "Interview availability",
      status: "sent",
      createdAt: "2026-07-02T10:05:00.000Z",
    });
    await seedOutgoingAudit({
      id: "audit-outgoing-created",
      draftId: "outdraft-gmail",
      action: "outgoing_draft.created",
      createdAt: "2026-07-02T10:05:10.000Z",
    });
    await seedOutgoingAudit({
      id: "audit-outgoing-sent",
      draftId: "outdraft-gmail",
      action: "outgoing_draft.sent",
      createdAt: "2026-07-02T10:11:00.000Z",
      metadata: { attemptId: "outsend-gmail", providerMessageId: "gmail-message-id" },
    });
    await seedOutgoingDraft({
      id: "outdraft-hotmail",
      accountId: "acct-hotmail",
      subject: "Book submission follow-up",
      status: "failed",
      createdAt: "2026-07-02T10:12:00.000Z",
      lastError: "Microsoft Graph throttled the send.",
    });
    await seedOutgoingAudit({
      id: "audit-hotmail-failed",
      draftId: "outdraft-hotmail",
      action: "outgoing_draft.send_failed",
      createdAt: "2026-07-02T10:13:00.000Z",
      metadata: { attemptId: "outsend-hotmail", error: "Microsoft Graph throttled the send.", retry: true },
    });

    const gmail = await getActivityTimeline({ workspaceId: "workspace:gmail", limit: 100 });
    const ids = gmail.items.map((item) => item.id);

    expect(ids).toEqual(expect.arrayContaining([
      expect.stringContaining("message:gmail-target"),
      expect.stringContaining("classification:"),
      "action:action-ack",
      "feedback:feedback-care",
      "learned:learn-job-topic",
      "notification:notify-target",
      expect.stringContaining("mail-sync:acct-gmail"),
      expect.stringContaining("integration:acct-gmail:calendar"),
      expect.stringContaining("calendar-sync:acct-gmail:primary"),
      "outgoing:audit-outgoing-created",
      "outgoing:audit-outgoing-sent",
    ]));
    expect(ids.join(" ")).not.toContain("hotmail-book");
    expect(gmail.items.every((item) => item.accountProvider === "gmail")).toBe(true);
    expect(gmail.items.map((item) => item.occurredAt)).toEqual(
      [...gmail.items.map((item) => item.occurredAt)].sort().reverse(),
    );

    const searched = await getActivityTimeline({ workspaceId: "workspace:gmail", q: "target", limit: 100 });
    expect(searched.items.map((item) => item.id)).toEqual(expect.arrayContaining([
      expect.stringContaining("classification:"),
      "notification:notify-target",
    ]));

    const actionsOnly = await getActivityTimeline({ workspaceId: "workspace:gmail", kind: "mail_action", limit: 100 });
    expect(actionsOnly.items).toHaveLength(1);
    expect(actionsOnly.items[0]).toMatchObject({ kind: "mail_action", actionId: "action-ack" });
    await expect(getMailActionDetail("action-ack")).resolves.toMatchObject({
      actionId: "action-ack",
      action: "done",
      changedCount: 1,
      unchangedCount: 0,
      failedCount: 0,
      outcomes: [expect.objectContaining({ id: "gmail-target", status: "changed", accountLabel: "Gmail", provider: "gmail" })],
    });

    const outgoingOnly = await getActivityTimeline({ workspaceId: "workspace:gmail", kind: "outgoing_mail", limit: 100 });
    expect(outgoingOnly.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "outgoing:audit-outgoing-sent",
        kind: "outgoing_mail",
        severity: "success",
        title: "Gmail draft sent",
        target: { view: "outbox", draftId: "outdraft-gmail" },
        metadata: expect.objectContaining({ providerMessageId: "gmail-message-id" }),
      }),
    ]));

    const hotmail = await getActivityTimeline({ workspaceId: "workspace:all", provider: "microsoft", limit: 100 });
    expect(hotmail.items.map((item) => item.messageId)).toContain("hotmail-book");
    expect(hotmail.items.map((item) => item.id)).toContain("outgoing:audit-hotmail-failed");
    expect(hotmail.items.find((item) => item.id === "outgoing:audit-hotmail-failed")).toMatchObject({
      kind: "outgoing_mail",
      severity: "error",
      title: "Hotmail send failed",
      detail: "Microsoft Graph throttled the send.",
      target: { view: "outbox", draftId: "outdraft-hotmail" },
    });
    expect(hotmail.items.every((item) => item.accountProvider === "microsoft")).toBe(true);
  });
});

async function seedMessage(input: {
  id: string;
  accountId: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  createdAt: string;
}) {
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
       received_at, snippet, gmail_url, has_attachments, gmail_labels, is_unread,
       ingest_source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Snippet', '#', 0, ?, 1, 'live', 'triaged', ?, ?)`,
    [
      input.id,
      input.accountId,
      `external-${input.id}`,
      `thread-${input.id}`,
      input.senderName,
      input.senderEmail,
      input.subject,
      input.createdAt,
      JSON.stringify(["INBOX", "UNREAD"]),
      input.createdAt,
      input.createdAt,
    ],
  );
}

async function seedOutgoingDraft(input: {
  id: string;
  accountId: string;
  subject: string;
  status: string;
  createdAt: string;
  lastError?: string | null;
}) {
  await execute(
    `INSERT INTO outgoing_drafts
      (id, source_type, source_message_id, account_id, from_email,
       to_recipients, cc_recipients, bcc_recipients, subject, body,
       content_hash, version, status, approval_snapshot, provider_message_id,
       last_error, created_at, updated_at)
     VALUES (?, 'new', NULL, ?, ?, ?, '[]', '[]', ?, 'Exact body',
       'hash', 1, ?, NULL, NULL, ?, ?, ?)`,
    [
      input.id,
      input.accountId,
      input.accountId === "acct-hotmail" ? "owner@hotmail.test" : "owner@gmail.test",
      JSON.stringify([{ email: "taylor@example.test", name: "Taylor" }]),
      input.subject,
      input.status,
      input.lastError || null,
      input.createdAt,
      input.createdAt,
    ],
  );
}

async function seedOutgoingAudit(input: {
  id: string;
  draftId: string;
  action: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}) {
  await execute(
    `INSERT INTO audit_logs
      (id, action, actor, target_type, target_id, metadata, created_at)
     VALUES (?, ?, 'outbox', 'outgoing_draft', ?, ?, ?)`,
    [input.id, input.action, input.draftId, JSON.stringify(input.metadata || {}), input.createdAt],
  );
}
