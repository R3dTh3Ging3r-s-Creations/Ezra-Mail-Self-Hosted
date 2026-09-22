import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActionCenter } from "@/lib/email/action-center";
import { getActivityTimeline } from "@/lib/email/activity";
import { createForwardDraft, createNewEmailDraft } from "@/lib/email/composition";
import { getContactSuggestions } from "@/lib/email/contacts";
import { configureEmailDatabaseForTests, execute, nowIso } from "@/lib/email/database";
import {
  approveOutboxItem,
  getOutboxPage,
  requestOutboxApproval,
  requestOutboxSend,
  retryOutboxSend,
} from "@/lib/email/outbox";

const sendGmailOutgoingMock = vi.hoisted(() => vi.fn());
const sendMicrosoftOutgoingMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/email/gmail", () => ({
  sendGmailOutgoing: sendGmailOutgoingMock,
}));

vi.mock("@/lib/email/microsoft", () => ({
  sendMicrosoftOutgoing: sendMicrosoftOutgoingMock,
}));

describe("v0.5 closeout stress and user-flow coverage", () => {
  beforeEach(() => {
    configureEmailDatabaseForTests(`file:./v05-closeout-${randomUUID()}.sqlite`);
    sendGmailOutgoingMock.mockReset();
    sendGmailOutgoingMock.mockResolvedValue({ id: "gmail-provider-message-1" });
    sendMicrosoftOutgoingMock.mockReset();
    sendMicrosoftOutgoingMock.mockResolvedValue({
      accepted: true,
      provider: "microsoft",
      providerMessageId: null,
    });
  });

  it("runs the closeout user script with account-locked drafts, approvals, sends, failures, and audit trails", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await grantMicrosoftSend("owner@hotmail.test");
    await seedMessage({
      id: "hotmail-target-followup",
      accountId: "acct-hotmail",
      senderName: "Jennifer Ortiz",
      senderEmail: "jennifer.ortiz@target.test",
      subject: "Target Application Follow Up",
      snippet: "Please schedule your interview through this link.",
    });
    await seedMessage({
      id: "gmail-mentor",
      accountId: "acct-gmail",
      senderName: "Mentor Person",
      senderEmail: "mentor@example.test",
      subject: "Interview prep",
      snippet: "Happy to review your interview notes.",
    });

    const gmailContacts = await getContactSuggestions({ workspaceId: "workspace:gmail", q: "mentor" });
    const hotmailContacts = await getContactSuggestions({ workspaceId: "workspace:microsoft", q: "target" });
    const noHotmailLeak = await getContactSuggestions({ workspaceId: "workspace:microsoft", q: "mentor" });

    expect(gmailContacts.items[0]).toMatchObject({
      accountId: "acct-gmail",
      email: "mentor@example.test",
      source: "sender",
    });
    expect(hotmailContacts.items[0]).toMatchObject({
      accountId: "acct-hotmail",
      email: "jennifer.ortiz@target.test",
      source: "sender",
    });
    expect(noHotmailLeak.items).toEqual([]);

    const forward = await createForwardDraft({
      messageId: "hotmail-target-followup",
      to: [{ name: "Mentor Person", email: "mentor@example.test" }],
    }, "closeout-user-test");
    const gmailDraft = await createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ name: "Mentor Person", email: "mentor@example.test" }],
      cc: [{ email: "copy@example.test" }],
      bcc: [],
      subject: "Interview availability",
      body: "Hi Mentor,\n\nFriday morning works for me.",
    }, "closeout-user-test");
    const hotmailDraft = await createNewEmailDraft({
      accountId: "acct-hotmail",
      to: [{ name: "Jennifer Ortiz", email: "jennifer.ortiz@target.test" }],
      cc: [],
      bcc: [],
      subject: "Target interview follow-up",
      body: "Hi Jennifer,\n\nThank you for following up. I will schedule the interview today.",
    }, "closeout-user-test");

    expect(forward).toMatchObject({
      sourceType: "forward",
      accountId: "acct-hotmail",
      accountProvider: "microsoft",
      fromEmail: "owner@hotmail.test",
      status: "draft",
    });
    expect(forward.body).toContain("---------- Forwarded message ----------");
    const prematureForwardSend = await requestOutboxSend(forward.id);
    expect(prematureForwardSend).toMatchObject({ ok: false });
    expect(prematureForwardSend.message).toContain("exact-review approval flow");

    const gmailReview = await requestOutboxApproval(gmailDraft.id);
    const gmailSnapshot = JSON.parse(String(gmailReview.item?.approvalSnapshot || "{}"));
    await approveOutboxItem({ draftId: gmailDraft.id, contentHash: gmailSnapshot.contentHash });
    const gmailSend = await requestOutboxSend(gmailDraft.id);

    sendMicrosoftOutgoingMock.mockRejectedValueOnce(new Error("Microsoft Graph accepted state was not confirmed"));
    const hotmailReview = await requestOutboxApproval(hotmailDraft.id);
    const hotmailSnapshot = JSON.parse(String(hotmailReview.item?.approvalSnapshot || "{}"));
    await approveOutboxItem({ draftId: hotmailDraft.id, contentHash: hotmailSnapshot.contentHash });
    const hotmailSend = await requestOutboxSend(hotmailDraft.id);

    expect(gmailSend).toMatchObject({
      ok: true,
      message: "Outgoing Gmail draft sent.",
      providerMessageId: "gmail-provider-message-1",
      item: expect.objectContaining({ accountProvider: "gmail", status: "sent" }),
    });
    expect(hotmailSend).toMatchObject({
      ok: false,
      message: expect.stringContaining("Microsoft Graph accepted state was not confirmed"),
      item: expect.objectContaining({
        accountProvider: "microsoft",
        status: "failed",
        canRetry: true,
      }),
    });
    expect(sendGmailOutgoingMock).toHaveBeenCalledWith(expect.objectContaining({
      account: "owner@gmail.test",
      from: "owner@gmail.test",
      subject: "Interview availability",
      body: "Hi Mentor,\n\nFriday morning works for me.",
    }));
    expect(sendMicrosoftOutgoingMock).toHaveBeenCalledWith("owner@hotmail.test", expect.objectContaining({
      subject: "Target interview follow-up",
      body: "Hi Jennifer,\n\nThank you for following up. I will schedule the interview today.",
    }));

    const outboxAll = await getOutboxPage({ workspaceId: "workspace:all" });
    const outboxGmail = await getOutboxPage({ workspaceId: "workspace:gmail" });
    const outboxHotmail = await getOutboxPage({ workspaceId: "workspace:microsoft" });

    expect(outboxAll.counts).toMatchObject({ total: 3, draft: 1, sent: 1, failed: 1 });
    expect(outboxGmail.items).toEqual([
      expect.objectContaining({ draftId: gmailDraft.id, accountProvider: "gmail", status: "sent" }),
    ]);
    expect(outboxHotmail.items.map((item) => item.draftId).sort()).toEqual([forward.id, hotmailDraft.id].sort());
    expect(outboxHotmail.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ draftId: forward.id, accountProvider: "microsoft", status: "draft" }),
      expect.objectContaining({ draftId: hotmailDraft.id, accountProvider: "microsoft", status: "failed" }),
    ]));

    const center = await getActionCenter({ workspaceId: "workspace:microsoft" });
    const approvals = center.sections.find((section) => section.id === "approvals")?.items || [];
    const repairs = center.sections.find((section) => section.id === "repairs")?.items || [];

    expect(approvals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "outgoing_draft",
        title: "Fwd: Target Application Follow Up",
        target: { view: "outbox", draftId: forward.id },
      }),
    ]));
    expect(repairs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "outgoing_draft",
        title: "Target interview follow-up",
        detail: expect.stringContaining("Microsoft Graph accepted state was not confirmed"),
        target: { view: "outbox", draftId: hotmailDraft.id },
      }),
    ]));

    const timeline = await getActivityTimeline({ workspaceId: "workspace:all", kind: "outgoing_mail", limit: 100 });
    expect(timeline.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "outgoing_mail",
        severity: "success",
        title: "Gmail draft sent",
        target: { view: "outbox", draftId: gmailDraft.id },
      }),
      expect.objectContaining({
        kind: "outgoing_mail",
        severity: "error",
        title: "Hotmail send failed",
        detail: "Microsoft Graph accepted state was not confirmed",
        target: { view: "outbox", draftId: hotmailDraft.id },
      }),
    ]));
  }, 30_000);

  it("keeps contacts, many drafts, duplicate approvals, provider timeouts, and retries stable under load", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await grantMicrosoftSend("owner@hotmail.test");
    await seedBulkMessages("acct-gmail", "gmail-hiring", 1_100, "2026-07-03T16:00:00.000Z");
    await seedBulkMessages("acct-hotmail", "hotmail-editor", 1_100, "2026-07-03T17:00:00.000Z");

    const gmailSuggestion = await getContactSuggestions({
      workspaceId: "workspace:gmail",
      q: "gmail-hiring-1099",
      limit: 5,
    });
    const hotmailSuggestion = await getContactSuggestions({
      workspaceId: "workspace:microsoft",
      q: "hotmail-editor-1099",
      limit: 5,
    });
    const noCrossAccountSuggestion = await getContactSuggestions({
      workspaceId: "workspace:microsoft",
      q: "gmail-hiring-1099",
      limit: 5,
    });

    expect(gmailSuggestion.items[0]).toMatchObject({
      accountId: "acct-gmail",
      email: "gmail-hiring-1099@example.test",
    });
    expect(hotmailSuggestion.items[0]).toMatchObject({
      accountId: "acct-hotmail",
      email: "hotmail-editor-1099@example.test",
    });
    expect(noCrossAccountSuggestion.items).toEqual([]);

    const draftIds: string[] = [];
    for (let index = 0; index < 80; index += 1) {
      const accountId = index % 2 === 0 ? "acct-gmail" : "acct-hotmail";
      const prefix = accountId === "acct-gmail" ? "Gmail" : "Hotmail";
      const draft = await createNewEmailDraft({
        accountId,
        to: [{ email: `recipient-${index}@example.test` }],
        cc: [],
        bcc: [],
        subject: `${prefix} load draft ${index}`,
        body: `Exact body for ${prefix} load draft ${index}.`,
      }, "closeout-stress");
      draftIds.push(draft.id);
    }

    const allOutbox = await getOutboxPage({ workspaceId: "workspace:all" });
    const gmailOutbox = await getOutboxPage({ workspaceId: "workspace:gmail" });
    const hotmailOutbox = await getOutboxPage({ workspaceId: "workspace:microsoft" });

    expect(allOutbox.counts).toMatchObject({ total: 80, draft: 80, cancellable: 80 });
    expect(gmailOutbox.items.every((item) => item.accountProvider === "gmail")).toBe(true);
    expect(gmailOutbox.items).toHaveLength(40);
    expect(hotmailOutbox.items.every((item) => item.accountProvider === "microsoft")).toBe(true);
    expect(hotmailOutbox.items).toHaveLength(40);

    const review = await requestOutboxApproval(draftIds[0]);
    const snapshot = JSON.parse(String(review.item?.approvalSnapshot || "{}"));
    const approved = await approveOutboxItem({ draftId: draftIds[0], contentHash: snapshot.contentHash });
    const approvedAgain = await approveOutboxItem({ draftId: draftIds[0], contentHash: snapshot.contentHash });

    expect(approved).toMatchObject({ ok: true, item: expect.objectContaining({ status: "approved" }) });
    expect(approvedAgain).toMatchObject({ ok: true, item: expect.objectContaining({ status: "approved" }) });

    sendGmailOutgoingMock.mockRejectedValueOnce(new Error("Gmail provider timed out before confirming send"));
    const failed = await requestOutboxSend(draftIds[0]);
    sendGmailOutgoingMock.mockResolvedValueOnce({ message: { id: "gmail-retry-message" } });
    const retried = await retryOutboxSend(draftIds[0]);
    const sentAgain = await requestOutboxSend(draftIds[0]);

    expect(failed).toMatchObject({
      ok: false,
      item: expect.objectContaining({
        status: "failed",
        canRetry: true,
        lastError: "Gmail provider timed out before confirming send",
      }),
    });
    expect(retried).toMatchObject({
      ok: true,
      providerMessageId: "gmail-retry-message",
      item: expect.objectContaining({ status: "sent" }),
    });
    expect(sentAgain).toMatchObject({
      ok: true,
      message: "Outgoing draft was already marked sent.",
      providerMessageId: "gmail-retry-message",
    });
    expect(sendGmailOutgoingMock).toHaveBeenCalledTimes(2);

    const attempts = await execute(
      `SELECT status, error, provider_message_id FROM outgoing_message_attempts
       WHERE draft_id = ? ORDER BY started_at`,
      [draftIds[0]],
    );
    expect(attempts.rows.map((row) => String(row.status))).toEqual(["failed", "sent"]);
    expect(String(attempts.rows[0].error)).toContain("timed out");
    expect(String(attempts.rows[1].provider_message_id)).toBe("gmail-retry-message");
  }, 30_000);
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

async function grantMicrosoftSend(email: string) {
  const now = nowIso();
  await execute(`INSERT INTO service_state (key, value, updated_at) VALUES (?, 'full', ?)`, [`microsoft_access:${email}`, now]);
  await execute(`INSERT INTO service_state (key, value, updated_at) VALUES (?, ?, ?)`, [`microsoft_scopes:${email}`, JSON.stringify(["Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"]), now]);
}

async function seedMessage(input: {
  id: string;
  accountId: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  snippet: string;
}) {
  const now = nowIso();
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, sender_name, sender_email,
       subject, received_at, snippet, gmail_url, has_attachments, gmail_labels,
       is_unread, ingest_source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '#', 0, '["INBOX"]', 1, 'live', 'triaged', ?, ?)`,
    [
      input.id,
      input.accountId,
      `external-${input.id}`,
      `thread-${input.id}`,
      input.senderName,
      input.senderEmail,
      input.subject,
      now,
      input.snippet,
      now,
      now,
    ],
  );
}

async function seedBulkMessages(
  accountId: string,
  prefix: string,
  count: number,
  baseReceivedAt: string,
) {
  const base = new Date(baseReceivedAt).getTime();
  const chunkSize = 50;
  for (let start = 0; start < count; start += chunkSize) {
    const chunkCount = Math.min(chunkSize, count - start);
    const placeholders = Array.from({ length: chunkCount }, () => "(?,?,?,?,?,?,?,?,?,'#',0,?,1,'live','triaged',?,?)").join(",");
    const values: Array<string> = [];
    for (let offset = 0; offset < chunkCount; offset += 1) {
      const index = start + offset;
      const id = `${prefix}-${index}`;
      const receivedAt = new Date(base - index * 60_000).toISOString();
      values.push(
        id,
        accountId,
        `external-${id}`,
        `thread-${id}`,
        `${prefix} Contact ${index}`,
        `${prefix}-${index}@example.test`,
        `${prefix} Subject ${index}`,
        receivedAt,
        `${prefix} snippet ${index}`,
        JSON.stringify(["INBOX"]),
        receivedAt,
        receivedAt,
      );
    }
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, sender_name, sender_email,
         subject, received_at, snippet, gmail_url, has_attachments, gmail_labels,
         is_unread, ingest_source, status, created_at, updated_at)
       VALUES ${placeholders}`,
      values,
    );
  }
}
