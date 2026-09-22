import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getActionCenter } from "@/lib/email/action-center";
import {
  configureEmailDatabaseForTests,
  execute,
  nowIso,
  saveTriageDecision,
} from "@/lib/email/database";
import type { AttentionLevel } from "@/lib/email/types";

describe("Action Center", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./action-center-${randomUUID()}.sqlite`);
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
  });

  it("summarizes approvals, cleanup, and repairs in the selected workspace", async () => {
    await seedMessage({ id: "reply-source", accountId: "acct-gmail", subject: "Reply me", attention: "interrupt" });
    await seedReplyDraft("draft-reply", "reply-source", "awaiting_approval");
    await seedOutgoingDraft("outdraft-review", "acct-gmail", "Review outgoing", "awaiting_approval");
    await seedOutgoingDraft("outdraft-failed", "acct-gmail", "Failed outgoing", "failed", "Provider timeout");
    await seedCalendarDraft("calendar-draft", "acct-gmail", "Interview prep");
    await seedMessage({ id: "cleanup-1", accountId: "acct-gmail", senderEmail: "sale@example.com", attention: "suppress", category: "bulk-mail" });
    await seedMessage({ id: "cleanup-2", accountId: "acct-gmail", senderEmail: "sale@example.com", attention: "suppress", category: "bulk-mail" });
    await seedMessage({ id: "failed-message", accountId: "acct-gmail", attention: "digest" });
    await seedMessage({ id: "hotmail-reply", accountId: "acct-hotmail", subject: "Hotmail lane", attention: "digest" });
    await seedReplyDraft("draft-hotmail", "hotmail-reply", "draft");
    await execute(
      `INSERT INTO mail_actions
        (id, action, status, message_ids, success_count, failure_count, details, created_at, executed_at)
       VALUES ('failed-action', 'mark_read', 'failed', ?, 0, 1, ?, ?, ?)`,
      [
        JSON.stringify(["failed-message"]),
        JSON.stringify({ failures: [{ id: "failed-message", error: "Provider timeout" }] }),
        nowIso(),
        nowIso(),
      ],
    );
    await execute(
      `INSERT INTO account_integrations
        (account_id, feature, provider, access, status, last_error, updated_at)
       VALUES ('acct-gmail', 'calendar', 'gmail', 'none', 'error', 'Calendar API disabled', ?)`,
      [nowIso()],
    );

    const gmail = await getActionCenter({ workspaceId: "workspace:gmail" });
    const hotmail = await getActionCenter({ workspaceId: "workspace:microsoft" });

    expect(gmail.counts).toMatchObject({ approvals: 3, cleanup: 1, repairs: 3, total: 7 });
    expect(section(gmail, "approvals")?.items.map((item) => item.type)).toEqual(
      expect.arrayContaining(["reply_draft", "outgoing_draft", "calendar_draft"]),
    );
    expect(section(gmail, "approvals")?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "outgoing_draft",
        title: "Review outgoing",
        detail: "Exact review snapshot is waiting for approval.",
        target: { view: "outbox", draftId: "outdraft-review" },
      }),
    ]));
    expect(section(gmail, "cleanup")?.items).toEqual([
      expect.objectContaining({
        type: "cleanup_suggestion",
        title: "Example Sender",
        count: 2,
        target: expect.objectContaining({ view: "today" }),
      }),
    ]);
    expect(section(gmail, "repairs")?.items.map((item) => item.type)).toEqual(
      expect.arrayContaining(["permission_issue", "outgoing_draft", "failed_action"]),
    );
    expect(section(gmail, "repairs")?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "failed_action", target: { view: "mail", messageId: "failed-message" } }),
        expect.objectContaining({
          type: "outgoing_draft",
          title: "Failed outgoing",
          detail: "Send failed: Provider timeout. Open Outbox to retry or review.",
          target: { view: "outbox", draftId: "outdraft-failed" },
        }),
        expect.objectContaining({ type: "permission_issue", target: { view: "settings", accountId: "acct-gmail" } }),
      ]),
    );

    expect(hotmail.counts).toMatchObject({ approvals: 1, cleanup: 0, repairs: 0, total: 1 });
    expect(section(hotmail, "approvals")?.items).toEqual([
      expect.objectContaining({ type: "reply_draft", accountId: "acct-hotmail", title: "Hotmail lane" }),
    ]);
  });

  it("can omit cleanup when a caller already owns the single cleanup read", async () => {
    await seedMessage({ id: "cleanup-once-1", accountId: "acct-gmail", senderEmail: "sale@example.com", attention: "suppress", category: "bulk-mail" });
    await seedMessage({ id: "cleanup-once-2", accountId: "acct-gmail", senderEmail: "sale@example.com", attention: "suppress", category: "bulk-mail" });

    const page = await getActionCenter({
      workspaceId: "workspace:account:gmail:acct-gmail",
      includeCleanup: false,
    });

    expect(page.counts.cleanup).toBe(0);
    expect(section(page, "cleanup")).toMatchObject({ count: 0, items: [] });
  });
});

function section(page: Awaited<ReturnType<typeof getActionCenter>>, id: string) {
  return page.sections.find((item) => item.id === id);
}

async function seedAccount(
  id: string,
  provider: "gmail" | "microsoft",
  email: string,
  label: string,
) {
  await execute(
    `INSERT INTO email_accounts
      (id, provider, email, label, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'connected', ?, ?)`,
    [id, provider, email, label, nowIso(), nowIso()],
  );
}

async function seedMessage(input: {
  id: string;
  accountId: string;
  senderEmail?: string;
  subject?: string;
  attention: AttentionLevel;
  category?: string;
}) {
  const timestamp = nowIso();
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
       received_at, snippet, gmail_url, has_attachments, gmail_labels, is_unread, ingest_source,
       status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Example Sender', ?, ?, ?, 'Snippet', '#', 0, ?, 1, 'live',
       'triaged', ?, ?)`,
    [
      input.id,
      input.accountId,
      `external-${input.id}`,
      `thread-${input.id}`,
      input.senderEmail || `${input.id}@example.com`,
      input.subject || `Subject ${input.id}`,
      timestamp,
      JSON.stringify(["INBOX", "UNREAD"]),
      timestamp,
      timestamp,
    ],
  );
  await saveTriageDecision(input.id, "test-model", {
    attention: input.attention,
    urgency: 42,
    confidence: 0.9,
    category: input.category || "general",
    summary: `Summary ${input.id}`,
    reason: "Test reason",
    recommendation: "Review",
    needsReply: false,
    deadline: null,
    draftReply: null,
    injectionFlags: [],
    criticalReason: null,
  });
}

async function seedReplyDraft(id: string, messageId: string, status: "draft" | "awaiting_approval") {
  await execute(
    `INSERT INTO reply_drafts
      (id, message_id, content, content_hash, version, status, created_at, updated_at)
     VALUES (?, ?, 'Draft body', 'hash', 1, ?, ?, ?)`,
    [id, messageId, status, nowIso(), nowIso()],
  );
}

async function seedOutgoingDraft(
  id: string,
  accountId: string,
  subject: string,
  status: "draft" | "awaiting_approval" | "approved" | "failed",
  lastError: string | null = null,
) {
  const timestamp = nowIso();
  await execute(
    `INSERT INTO outgoing_drafts
      (id, source_type, source_message_id, account_id, from_email,
       to_recipients, cc_recipients, bcc_recipients, subject, body,
       content_hash, version, status, approval_snapshot, provider_message_id,
       last_error, created_at, updated_at)
     VALUES (?, 'new', NULL, ?, ?, ?, '[]', '[]', ?, 'Outgoing body',
       'hash', 1, ?, NULL, NULL, ?, ?, ?)`,
    [
      id,
      accountId,
      accountId === "acct-hotmail" ? "owner@hotmail.test" : "owner@gmail.test",
      JSON.stringify([{ email: "contact@example.test" }]),
      subject,
      status,
      lastError,
      timestamp,
      timestamp,
    ],
  );
}

async function seedCalendarDraft(id: string, accountId: string, title: string) {
  const startsAt = "2026-07-04T14:00:00.000Z";
  const endsAt = "2026-07-04T15:00:00.000Z";
  await execute(
    `INSERT INTO calendar_drafts
      (id, account_id, calendar_id, title, description, location, starts_at, ends_at,
       is_all_day, timezone, attendees, reminder_minutes, is_busy, privacy, send_updates,
       status, created_at, updated_at)
     VALUES (?, ?, 'primary', ?, '', '', ?, ?, 0, 'America/Chicago', '[]', NULL, 1,
       'default', 0, 'draft', ?, ?)`,
    [id, accountId, title, startsAt, endsAt, nowIso(), nowIso()],
  );
}
