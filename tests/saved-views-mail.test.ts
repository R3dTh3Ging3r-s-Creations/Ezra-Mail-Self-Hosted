import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  configureEmailDatabaseForTests,
  execute,
  nowIso,
  saveTriageDecision,
} from "@/lib/email/database";
import { getMailPage } from "@/lib/email/professional";
import { createSavedView } from "@/lib/email/saved-views";
import type { AttentionLevel } from "@/lib/email/types";

describe("Saved Views applied to Mail queries", () => {
  beforeEach(() => {
    configureEmailDatabaseForTests(`file:./saved-views-mail-${randomUUID()}.sqlite`);
  });

  it("filters built-in lanes by selected workspace without blending accounts", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await seedMessage({
      id: "gmail-job",
      accountId: "acct-gmail",
      senderName: "Target Recruiter",
      senderEmail: "recruiter@target.test",
      subject: "Interview request for your application",
      category: "job application",
      attention: "interrupt",
      needsReply: true,
    });
    await seedMessage({
      id: "hotmail-job",
      accountId: "acct-hotmail",
      senderName: "Editor Recruiter",
      senderEmail: "editor@example.test",
      subject: "Application interview follow-up",
      category: "job application",
      attention: "interrupt",
      needsReply: true,
    });
    await seedMessage({
      id: "gmail-security",
      accountId: "acct-gmail",
      senderName: "Microsoft account team",
      senderEmail: "security@example.test",
      subject: "New sign-in detected",
      category: "account-security",
      attention: "interrupt",
    });

    const gmailJob = await getMailPage({ workspaceId: "workspace:gmail", viewId: "builtin:job-search", limit: 20 });
    const hotmailJob = await getMailPage({ workspaceId: "workspace:microsoft", viewId: "builtin:job-search", limit: 20 });
    const allJob = await getMailPage({ workspaceId: "workspace:all", viewId: "builtin:job-search", limit: 20 });
    const gmailSecurity = await getMailPage({ workspaceId: "workspace:gmail", viewId: "builtin:security", limit: 20 });

    expect(gmailJob.items.map((item) => item.id)).toEqual(["gmail-job"]);
    expect(hotmailJob.items.map((item) => item.id)).toEqual(["hotmail-job"]);
    expect(allJob.items.map((item) => item.id).sort()).toEqual(["gmail-job", "hotmail-job"].sort());
    expect(gmailSecurity.items.map((item) => item.id)).toEqual(["gmail-security"]);
  });

  it("applies custom lane filters for needs-reply, deadline, attachments, and workspace ownership", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await seedMessage({
      id: "hotmail-submission",
      accountId: "acct-hotmail",
      senderName: "Publisher",
      senderEmail: "publisher@example.test",
      subject: "Submission response with contract attached",
      category: "submission",
      attention: "interrupt",
      needsReply: true,
      deadline: "2026-07-10",
      hasAttachments: true,
    });
    await seedMessage({
      id: "hotmail-submission-no-file",
      accountId: "acct-hotmail",
      senderName: "Editor",
      senderEmail: "editor@example.test",
      subject: "Submission note",
      category: "submission",
      attention: "interrupt",
      needsReply: true,
      deadline: "2026-07-10",
    });
    const custom = await createSavedView({
      workspaceId: "workspace:microsoft",
      label: "Submission files needing reply",
      definition: {
        kind: "mail",
        filters: {
          folder: "inbox",
          category: "submission",
          needsReply: true,
          hasDeadline: true,
          attachments: true,
          handled: "active",
        },
      },
    });

    const hotmail = await getMailPage({ workspaceId: "workspace:microsoft", viewId: custom.id, limit: 20 });

    expect(hotmail.items.map((item) => item.id)).toEqual(["hotmail-submission"]);
    await expect(getMailPage({ workspaceId: "workspace:gmail", viewId: custom.id, limit: 20 }))
      .rejects.toThrow("Saved view was not found in this workspace");
  });

  it("uses saved-view handled state without API defaults forcing Inbox-only results", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedMessage({
      id: "gmail-handled-archive",
      accountId: "acct-gmail",
      senderName: "Mentor",
      senderEmail: "mentor@example.test",
      subject: "Handled archive note",
      category: "personal",
      attention: "digest",
      isUnread: false,
      status: "read",
      labels: ["ARCHIVE"],
    });
    await seedMessage({
      id: "gmail-active-inbox",
      accountId: "acct-gmail",
      senderName: "Recruiter",
      senderEmail: "recruiter@example.test",
      subject: "Active inbox note",
      category: "job application",
      attention: "interrupt",
      labels: ["INBOX", "UNREAD"],
    });

    const handled = await getMailPage({ workspaceId: "workspace:gmail", viewId: "builtin:recently-handled", limit: 20 });

    expect(handled.items.map((item) => item.id)).toEqual(["gmail-handled-archive"]);
  });
});

async function seedAccount(
  id: string,
  provider: "gmail" | "microsoft",
  email: string,
  label: string,
) {
  const now = nowIso();
  await execute(
    `INSERT INTO email_accounts
      (id, provider, email, label, status, last_sync_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'connected', ?, ?, ?)`,
    [id, provider, email, label, now, now, now],
  );
}

async function seedMessage(input: {
  id: string;
  accountId: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  category: string;
  attention: AttentionLevel;
  needsReply?: boolean;
  deadline?: string | null;
  hasAttachments?: boolean;
  isUnread?: boolean;
  status?: string;
  labels?: string[];
}) {
  const now = nowIso();
  const labels = input.labels || ["INBOX", "UNREAD"];
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, sender_name, sender_email,
       subject, received_at, snippet, gmail_url, has_attachments, gmail_labels,
       is_unread, ingest_source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '#', ?, ?, ?, 'live', ?, ?, ?)`,
    [
      input.id,
      input.accountId,
      `external-${input.id}`,
      `thread-${input.id}`,
      input.senderName,
      input.senderEmail,
      input.subject,
      now,
      `${input.subject} snippet`,
      input.hasAttachments ? 1 : 0,
      JSON.stringify(labels),
      input.isUnread === false ? 0 : 1,
      input.status || "triaged",
      now,
      now,
    ],
  );
  await saveTriageDecision(input.id, "test-model", {
    attention: input.attention,
    urgency: input.attention === "interrupt" ? 90 : 45,
    confidence: 0.92,
    category: input.category,
    summary: `${input.subject} summary`,
    reason: "Seeded saved-view test message.",
    recommendation: "Review.",
    needsReply: Boolean(input.needsReply),
    deadline: input.deadline || null,
    draftReply: null,
    injectionFlags: [],
    criticalReason: null,
  });
}
