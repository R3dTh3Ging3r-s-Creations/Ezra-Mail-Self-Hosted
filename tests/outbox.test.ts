import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActionCenter } from "@/lib/email/action-center";
import { getActivityTimeline } from "@/lib/email/activity";
import { createNewEmailDraft, createReplyOutgoingDraftFromMessage } from "@/lib/email/composition";
import { configureEmailDatabaseForTests, execute, nowIso } from "@/lib/email/database";
import {
  approveOutboxItem,
  cancelOutboxItem,
  getOutboxPage,
  requestOutboxApproval,
  requestOutboxSend,
  retryOutboxSend,
} from "@/lib/email/outbox";

const sendGmailOutgoingMock = vi.hoisted(() => vi.fn());
const sendMicrosoftOutgoingMock = vi.hoisted(() => vi.fn());
const sendMicrosoftReplyMock = vi.hoisted(() => vi.fn());
const reconcileMicrosoftReplyMock = vi.hoisted(() => vi.fn());
const adapterCalls = vi.hoisted(() => {
  const gmail = {
    sendOutgoing: vi.fn(),
    sendThreadedReply: vi.fn(),
    reconcileThreadedReply: vi.fn(),
  };
  const microsoft = {
    sendOutgoing: vi.fn(),
    sendThreadedReply: vi.fn(),
    reconcileThreadedReply: vi.fn(),
  };
  return { gmail, microsoft, providerAdapterFor: vi.fn((provider: string) => provider === "microsoft" ? microsoft : gmail) };
});

vi.mock("@/lib/email/gmail", () => ({
  sendGmailOutgoing: sendGmailOutgoingMock,
}));

vi.mock("@/lib/email/microsoft", () => ({
  sendMicrosoftOutgoing: sendMicrosoftOutgoingMock,
  sendMicrosoftReply: sendMicrosoftReplyMock,
  reconcileMicrosoftReply: reconcileMicrosoftReplyMock,
}));

vi.mock("@/lib/email/provider-adapter", () => adapterCalls);

describe("Outbox / Send Safety Queue", () => {
  beforeEach(() => {
    configureEmailDatabaseForTests(`file:./outbox-${randomUUID()}.sqlite`);
    sendGmailOutgoingMock.mockReset();
    sendGmailOutgoingMock.mockResolvedValue({ id: "gmail-provider-message-1" });
    sendMicrosoftOutgoingMock.mockReset();
    sendMicrosoftOutgoingMock.mockResolvedValue({ accepted: true, provider: "microsoft", providerMessageId: null });
    sendMicrosoftReplyMock.mockReset();
    sendMicrosoftReplyMock.mockResolvedValue({ accepted: true, provider: "microsoft", providerMessageId: "reply-provider-1", providerDraftId: "reply-provider-1" });
    reconcileMicrosoftReplyMock.mockReset();
    adapterCalls.gmail.sendOutgoing.mockReset();
    adapterCalls.gmail.sendOutgoing.mockImplementation(async (email, input) => sendGmailOutgoingMock({ account: email, ...input }));
    adapterCalls.gmail.sendThreadedReply.mockReset();
    adapterCalls.gmail.sendThreadedReply.mockImplementation(async (email, input) => sendGmailOutgoingMock({
      account: email,
      from: email,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: "Re: message",
      body: input.body,
      attachments: input.attachments,
      replyToMessageId: input.externalMessageId,
    }));
    adapterCalls.gmail.reconcileThreadedReply.mockReset();
    adapterCalls.microsoft.sendOutgoing.mockReset();
    adapterCalls.microsoft.sendOutgoing.mockImplementation(async (email, input) => sendMicrosoftOutgoingMock(email, {
      to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, body: input.body, attachments: input.attachments,
    }));
    adapterCalls.microsoft.sendThreadedReply.mockReset();
    adapterCalls.microsoft.sendThreadedReply.mockImplementation(async (email, input) => sendMicrosoftReplyMock(email, input));
    adapterCalls.microsoft.reconcileThreadedReply.mockReset();
    adapterCalls.microsoft.reconcileThreadedReply.mockImplementation(async (email, providerDraftId) => reconcileMicrosoftReplyMock(email, providerDraftId));
  });

  it("returns exact outgoing draft details, workspace counts, and send blocking state", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    const gmailDraft = await createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ email: "contact@example.test" }],
      cc: [{ email: "copy@example.test" }],
      bcc: [],
      subject: "Gmail exact draft",
      body: "This is the exact body that should eventually require approval.",
    });
    await createNewEmailDraft({
      accountId: "acct-hotmail",
      to: [{ email: "professional@example.test" }],
      cc: [],
      bcc: [],
      subject: "Hotmail exact draft",
      body: "Hotmail body",
    });

    const all = await getOutboxPage({ workspaceId: "workspace:all" });
    const gmail = await getOutboxPage({ workspaceId: "workspace:gmail" });
    const hotmail = await getOutboxPage({ workspaceId: "workspace:microsoft" });
    const item = all.items.find((candidate) => candidate.draftId === gmailDraft.id);

    expect(all.counts).toMatchObject({ total: 2, draft: 2, blocked: 2, cancellable: 2 });
    expect(gmail.items).toHaveLength(1);
    expect(gmail.items[0]).toMatchObject({ accountProvider: "gmail", subject: "Gmail exact draft" });
    expect(hotmail.items).toHaveLength(1);
    expect(hotmail.items[0]).toMatchObject({ accountProvider: "microsoft", subject: "Hotmail exact draft" });
    expect(item).toMatchObject({
      id: `outbox:${gmailDraft.id}`,
      draftId: gmailDraft.id,
      fromEmail: "owner@gmail.test",
      recipientCount: 2,
      body: "This is the exact body that should eventually require approval.",
      canSend: false,
      canCancel: true,
      canRetry: false,
    });
    expect(item?.blockedReason).toContain("exact-review approval flow");
  });

  it("cancels draft items idempotently and removes them from cancellable counts", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    const draft = await createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ email: "contact@example.test" }],
      cc: [],
      bcc: [],
      subject: "Cancel me",
      body: "Do not send.",
    });

    const cancelled = await cancelOutboxItem(draft.id);
    const cancelledAgain = await cancelOutboxItem(draft.id);
    const page = await getOutboxPage({ workspaceId: "workspace:gmail" });

    expect(cancelled).toMatchObject({ ok: true, message: "Outgoing draft cancelled." });
    expect(cancelled.item?.status).toBe("cancelled");
    expect(cancelledAgain.item?.status).toBe("cancelled");
    expect(page.counts).toMatchObject({ total: 1, cancelled: 1, cancellable: 0, blocked: 0 });
    expect(page.items[0]).toMatchObject({ canCancel: false, blockedReason: null });
  });

  it("blocks send before approval and blocks retry when no exact approval snapshot exists", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    const draft = await createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ email: "contact@example.test" }],
      cc: [],
      bcc: [],
      subject: "Blocked send",
      body: "Not ready to send.",
    });

    const send = await requestOutboxSend(draft.id);
    await execute(`UPDATE outgoing_drafts SET status = 'failed', last_error = 'provider timeout' WHERE id = ?`, [draft.id]);
    const retry = await retryOutboxSend(draft.id);

    expect(send).toMatchObject({ ok: false });
    expect(send.message).toContain("exact-review approval flow");
    expect(retry).toMatchObject({ ok: false });
    expect(retry.message).toContain("not retry-safe");
    expect(sendGmailOutgoingMock).not.toHaveBeenCalled();
  });

  it("stores, approves, and sends an exact Gmail review snapshot", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    const draft = await createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ name: "Taylor", email: "taylor@example.test" }],
      cc: [{ email: "copy@example.test" }],
      bcc: [{ email: "quiet@example.test" }],
      subject: "Approval snapshot",
      body: "Approve this exact text.",
    });

    const review = await requestOutboxApproval(draft.id);
    const snapshot = JSON.parse(String(review.item?.approvalSnapshot || "{}"));
    const approved = await approveOutboxItem({ draftId: draft.id, contentHash: snapshot.contentHash });
    const page = await getOutboxPage({ workspaceId: "workspace:gmail" });
    const send = await requestOutboxSend(draft.id);
    const attempts = await execute(`SELECT * FROM outgoing_message_attempts WHERE draft_id = ?`, [draft.id]);

    expect(review).toMatchObject({ ok: true, message: "Exact review snapshot is ready." });
    expect(review.item).toMatchObject({
      status: "awaiting_approval",
      approvalSnapshot: expect.any(String),
      canSend: false,
    });
    expect(snapshot).toMatchObject({
      draftId: draft.id,
      fromEmail: "owner@gmail.test",
      subject: "Approval snapshot",
      body: "Approve this exact text.",
      contentHash: draft.contentHash,
      version: 1,
    });
    expect(approved).toMatchObject({ ok: true });
    expect(approved.item).toMatchObject({
      status: "approved",
      canSend: true,
      blockedReason: null,
    });
    expect(page.counts).toMatchObject({ approved: 1, awaitingApproval: 0, blocked: 0 });
    expect(send).toMatchObject({
      ok: true,
      message: "Outgoing Gmail draft sent.",
      providerMessageId: "gmail-provider-message-1",
    });
    expect(send.item).toMatchObject({
      status: "sent",
      providerMessageId: "gmail-provider-message-1",
      canSend: false,
      blockedReason: null,
    });
    expect(sendGmailOutgoingMock).toHaveBeenCalledWith({
      attachments: [],
      account: "owner@gmail.test",
      from: "owner@gmail.test",
      to: [{ name: "Taylor", email: "taylor@example.test" }],
      cc: [{ email: "copy@example.test", name: null }],
      bcc: [{ email: "quiet@example.test", name: null }],
      subject: "Approval snapshot",
      body: "Approve this exact text.",
    });
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]).toMatchObject({
      status: "sent",
      provider_message_id: "gmail-provider-message-1",
      error: null,
    });
  });

  it("records provider failures and lets a valid Gmail approval snapshot retry", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    const draft = await createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ email: "contact@example.test" }],
      cc: [],
      bcc: [],
      subject: "Retry after failure",
      body: "Try this exact text.",
    });
    const review = await requestOutboxApproval(draft.id);
    const snapshot = JSON.parse(String(review.item?.approvalSnapshot || "{}"));
    await approveOutboxItem({ draftId: draft.id, contentHash: snapshot.contentHash });
    sendGmailOutgoingMock.mockRejectedValueOnce(new Error("Gmail send scope missing"));

    const failed = await requestOutboxSend(draft.id);
    sendGmailOutgoingMock.mockResolvedValueOnce({ message: { id: "gmail-provider-message-2" } });
    const retry = await retryOutboxSend(draft.id);
    const attempts = await execute(
      `SELECT status, error, provider_message_id FROM outgoing_message_attempts WHERE draft_id = ? ORDER BY started_at`,
      [draft.id],
    );

    expect(failed).toMatchObject({
      ok: false,
      message: expect.stringContaining("Gmail send scope missing"),
      item: expect.objectContaining({
        status: "failed",
        canRetry: true,
        lastError: "Gmail send scope missing",
      }),
    });
    expect(retry).toMatchObject({
      ok: true,
      providerMessageId: "gmail-provider-message-2",
      item: expect.objectContaining({
        status: "sent",
        providerMessageId: "gmail-provider-message-2",
      }),
    });
    expect(attempts.rows.map((row) => String(row.status))).toEqual(["failed", "sent"]);
    expect(String(attempts.rows[0].error)).toContain("Gmail send scope missing");
  });

  it("routes approved outbound sends and reconciliation through the owning provider adapter", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await grantMicrosoftSend("owner@hotmail.test");
    const gmailDraft = await createNewEmailDraft({
      accountId: "acct-gmail", to: [{ email: "recipient@example.test" }], cc: [], bcc: [], subject: "Gmail", body: "Body",
    });
    const microsoftDraft = await createNewEmailDraft({
      accountId: "acct-hotmail", to: [{ email: "recipient@example.test" }], cc: [], bcc: [], subject: "Microsoft", body: "Body",
    });
    for (const draft of [gmailDraft, microsoftDraft]) {
      const review = await requestOutboxApproval(draft.id);
      const snapshot = JSON.parse(String(review.item?.approvalSnapshot || "{}"));
      await approveOutboxItem({ draftId: draft.id, contentHash: snapshot.contentHash });
      await requestOutboxSend(draft.id);
    }

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("gmail");
    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("microsoft");
    expect(adapterCalls.gmail.sendOutgoing).toHaveBeenCalledWith("owner@gmail.test", expect.objectContaining({ subject: "Gmail" }));
    expect(adapterCalls.microsoft.sendOutgoing).toHaveBeenCalledWith("owner@hotmail.test", expect.objectContaining({ subject: "Microsoft" }));
  });

  it("sends a Gmail reply through the source provider message thread", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedMessage("reply-source", "acct-gmail", "sender@example.test", "Thread me");
    const draft = await createReplyOutgoingDraftFromMessage({ messageId: "reply-source", replyMode: "sender", body: "Exact reply." });
    const review = await requestOutboxApproval(draft.id);
    const snapshot = JSON.parse(String(review.item?.approvalSnapshot || "{}"));
    await approveOutboxItem({ draftId: draft.id, contentHash: snapshot.contentHash });
    await requestOutboxSend(draft.id);
    const source = await execute(`SELECT status, is_unread, gmail_labels FROM email_messages WHERE id = 'reply-source'`);
    const acknowledgement = await execute(`SELECT action, status, success_count, details, undo_status FROM mail_actions WHERE message_ids = '["reply-source"]'`);
    const activity = await getActivityTimeline({ workspaceId: "workspace:gmail", limit: 100 });

    expect(sendGmailOutgoingMock).toHaveBeenCalledWith(expect.objectContaining({
      account: "owner@gmail.test",
      to: [{ email: "sender@example.test", name: "Sender" }],
      body: "Exact reply.",
      replyToMessageId: "external-reply-source",
    }));
    expect(source.rows[0]).toMatchObject({ status: "cleared", is_unread: 0 });
    expect(String(source.rows[0].gmail_labels)).not.toContain("UNREAD");
    expect(acknowledgement.rows).toHaveLength(1);
    expect(acknowledgement.rows[0]).toMatchObject({ action: "done", status: "executed", success_count: 1, undo_status: null });
    expect(JSON.parse(String(acknowledgement.rows[0].details))).toMatchObject({
      changedIds: ["reply-source"],
      reason: "confirmed_reply_sent",
      outgoingDraftId: draft.id,
    });
    expect(activity.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "mail_action", messageId: "reply-source", status: "executed" }),
    ]));
  });

  it("blocks blind retry after an uncertain Microsoft reply and reconciles provider state", async () => {
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await grantMicrosoftSend("owner@hotmail.test");
    await seedMessage("reply-source-ms", "acct-hotmail", "sender@example.test", "Thread me");
    const draft = await createReplyOutgoingDraftFromMessage({ messageId: "reply-source-ms", replyMode: "all", body: "Exact reply." });
    const review = await requestOutboxApproval(draft.id);
    const snapshot = JSON.parse(String(review.item?.approvalSnapshot || "{}"));
    await approveOutboxItem({ draftId: draft.id, contentHash: snapshot.contentHash });
    const uncertain = Object.assign(new Error("Microsoft did not confirm send."), { name: "MicrosoftSendUnknownError", providerDraftId: "immutable-draft-1" });
    sendMicrosoftReplyMock.mockRejectedValueOnce(uncertain);

    const send = await requestOutboxSend(draft.id);
    expect(send.item).toMatchObject({ status: "send_unknown", canRetry: false, canReconcile: true, providerDraftId: "immutable-draft-1" });
    const beforeReconcile = await execute(`SELECT status, is_unread FROM email_messages WHERE id = 'reply-source-ms'`);
    expect(beforeReconcile.rows[0]).toMatchObject({ status: "triaged", is_unread: 1 });
    reconcileMicrosoftReplyMock.mockResolvedValueOnce({ status: "sent", providerMessageId: "immutable-draft-1" });
    const { reconcileOutboxSend } = await import("@/lib/email/outbox");
    const reconciled = await reconcileOutboxSend(draft.id);
    const afterReconcile = await execute(`SELECT status, is_unread FROM email_messages WHERE id = 'reply-source-ms'`);
    expect(reconciled).toMatchObject({ ok: true, item: expect.objectContaining({ status: "sent" }) });
    expect(adapterCalls.microsoft.reconcileThreadedReply).toHaveBeenCalledWith("owner@hotmail.test", "immutable-draft-1");
    expect(afterReconcile.rows[0]).toMatchObject({ status: "cleared", is_unread: 0 });
  });

  it("sends approved Hotmail drafts only through the Microsoft account", async () => {
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await grantMicrosoftSend("owner@hotmail.test");
    const draft = await createNewEmailDraft({
      accountId: "acct-hotmail",
      to: [{ email: "contact@example.test" }],
      cc: [],
      bcc: [],
      subject: "Hotmail approval",
      body: "Do not send through Gmail.",
    });

    const review = await requestOutboxApproval(draft.id);
    const snapshot = JSON.parse(String(review.item?.approvalSnapshot || "{}"));
    const approved = await approveOutboxItem({ draftId: draft.id, contentHash: snapshot.contentHash });
    const send = await requestOutboxSend(draft.id);
    const attempts = await execute(`SELECT * FROM outgoing_message_attempts WHERE draft_id = ?`, [draft.id]);

    expect(approved.item).toMatchObject({
      status: "approved",
      accountProvider: "microsoft",
      canSend: true,
      blockedReason: null,
    });
    expect(send).toMatchObject({
      ok: true,
      message: "Outgoing Hotmail draft accepted by Microsoft Graph and saved to Sent Items.",
      providerMessageId: null,
      item: expect.objectContaining({
        status: "sent",
        accountProvider: "microsoft",
        providerMessageId: null,
      }),
    });
    expect(sendMicrosoftOutgoingMock).toHaveBeenCalledWith("owner@hotmail.test", {
      attachments: [],
      to: [{ email: "contact@example.test", name: null }],
      cc: [],
      bcc: [],
      subject: "Hotmail approval",
      body: "Do not send through Gmail.",
    });
    expect(sendGmailOutgoingMock).not.toHaveBeenCalled();
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]).toMatchObject({
      provider: "microsoft",
      status: "sent",
      provider_message_id: null,
    });
  });

  it("surfaces outgoing drafts in Action Center approvals and failed drafts in repairs", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    const draft = await createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ email: "contact@example.test" }],
      cc: [],
      bcc: [],
      subject: "Action Center outgoing",
      body: "Review from Action Center.",
    });
    const failed = await createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ email: "failed@example.test" }],
      cc: [],
      bcc: [],
      subject: "Failed outgoing",
      body: "Failure body",
    });
    await execute(`UPDATE outgoing_drafts SET status = 'failed', last_error = 'provider timeout' WHERE id = ?`, [failed.id]);

    const center = await getActionCenter({ workspaceId: "workspace:gmail" });
    const approvals = center.sections.find((section) => section.id === "approvals")?.items || [];
    const repairs = center.sections.find((section) => section.id === "repairs")?.items || [];

    expect(approvals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `outbox:${draft.id}`,
        type: "outgoing_draft",
        target: { view: "outbox", draftId: draft.id },
      }),
    ]));
    expect(repairs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `outbox:${failed.id}`,
        type: "outgoing_draft",
        priority: "repair",
        target: { view: "outbox", draftId: failed.id },
      }),
    ]));
  });
});

async function seedAccount(id: string, provider: "gmail" | "microsoft", email: string, label: string) {
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

async function seedMessage(id: string, accountId: string, senderEmail: string, subject: string) {
  const now = nowIso();
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
       received_at, snippet, gmail_url, has_attachments, gmail_labels, is_unread,
       ingest_source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Sender', ?, ?, ?, 'Please reply.', '#', 0, '["INBOX"]', 1,
       'live', 'triaged', ?, ?)`,
    [id, accountId, `external-${id}`, `thread-${id}`, senderEmail, subject, now, now, now],
  );
}
