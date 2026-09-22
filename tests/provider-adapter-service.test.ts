import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapterCalls = vi.hoisted(() => {
  const adapter = {
    applyMaintenance: vi.fn(async () => ({ modified: 1, adapter: true })),
    undoMaintenance: vi.fn(async () => ({ modified: 1, adapter: true })),
    markRead: vi.fn(async () => ({ modified: 1, adapter: true })),
    readInbox: vi.fn(async () => ({ messages: [], attachmentAccountEmail: null })),
    readMessage: vi.fn(async (_email: string, accountId: string, messageId: string) => ({
      accountId,
      externalMessageId: messageId,
      threadId: "thread",
      senderName: "Sender",
      senderEmail: "sender@example.test",
      subject: "Provider subject",
      receivedAt: "2026-08-12T00:00:00.000Z",
      snippet: "Provider snippet",
      bodyText: "Provider body",
      gmailUrl: "#",
      isUnread: true,
      labels: [],
      attachments: [],
      providerRevision: "provider-revision",
    })),
    downloadAttachment: vi.fn(async () => Buffer.from("safe attachment")),
    sendOutgoing: vi.fn(async () => ({ id: "adapter-sent" })),
    getReplyMetadata: vi.fn(async () => ({
      from: { email: "sender@example.test", name: "Sender" },
      replyTo: [],
      to: [],
      cc: [],
      subject: "Provider subject",
    })),
  };
  return { adapter, providerAdapterFor: vi.fn(() => adapter) };
});

const directProviderCalls = vi.hoisted(() => ({
  listAuthorizedGmailAccounts: vi.fn(async () => ["background@gmail.test"]),
  sendGmailReply: vi.fn(async () => ({ id: "direct-sent" })),
  markMicrosoftMessagesRead: vi.fn(async () => ({ modified: 1, direct: true })),
  markMicrosoftMessagesUnread: vi.fn(async () => ({ modified: 1, direct: true })),
}));

vi.mock("@/lib/email/provider-adapter", () => adapterCalls);
vi.mock("@/lib/email/gmail", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/email/gmail")>(),
  listAuthorizedGmailAccounts: directProviderCalls.listAuthorizedGmailAccounts,
  sendGmailReply: directProviderCalls.sendGmailReply,
}));
vi.mock("@/lib/email/microsoft", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/email/microsoft")>(),
  markMicrosoftMessagesRead: directProviderCalls.markMicrosoftMessagesRead,
  markMicrosoftMessagesUnread: directProviderCalls.markMicrosoftMessagesUnread,
}));

import { configureEmailDatabaseForTests, execute, nowIso } from "@/lib/email/database";
import { downloadIncomingAttachment, inspectIncomingAttachmentPreview, readIncomingAttachmentPreview } from "@/lib/email/attachments";
import { applyMaintenanceAction, approveAndSendDraft, getMessageDetail, markMessageRead, pollGmail, pollMailAccount, prepareReplyDraft, requestSendApproval, undoMaintenanceAction } from "@/lib/email/service";

const originalNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined) {
  if (value === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
  else Reflect.set(process.env, "NODE_ENV", value);
}

describe("provider adapter service integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureEmailDatabaseForTests(`file:./provider-adapter-service-${randomUUID()}.sqlite`);
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
  });

  it("routes a connected account's maintenance action through its adapter", async () => {
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-microsoft', 'microsoft', 'owner@outlook.example', 'Outlook', 'connected', ?, ?)`,
      [now, now],
    );
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
         received_at, snippet, gmail_url, gmail_labels, is_unread, status, created_at, updated_at)
       VALUES ('mail-microsoft', 'acct-microsoft', 'graph-message', 'thread', 'Sender',
         'sender@example.test', 'Subject', ?, 'Snippet', '#', '[]', 1, 'triaged', ?, ?)`,
      [now, now, now],
    );
    await execute(
      `INSERT INTO triage_decisions
        (id, message_id, model, attention, urgency, confidence, category, summary, reason,
         recommendation, needs_reply, injection_flags, created_at)
       VALUES ('triage-microsoft', 'mail-microsoft', 'test', 'suppress', 10, 0.9,
         'bulk-mail', 'Summary', 'Reason', 'Recommendation', 0, '[]', ?)`,
      [now],
    );

    await applyMaintenanceAction({
      accountId: "acct-microsoft",
      senderEmail: "sender@example.test",
      action: "mark_read",
      remember: false,
    });

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("microsoft");
    expect(adapterCalls.adapter.applyMaintenance).toHaveBeenCalledWith(
      "owner@outlook.example",
      "mark_read",
      ["graph-message"],
    );
  });

  it("routes an approved maintenance undo through the owning account adapter", async () => {
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-undo', 'microsoft', 'owner@outlook.example', 'Outlook', 'connected', ?, ?)`,
      [now, now],
    );
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
         received_at, snippet, gmail_url, gmail_labels, is_unread, status, created_at, updated_at)
       VALUES ('mail-undo', 'acct-undo', 'graph-undo', 'thread', 'Sender',
         'undo@example.test', 'Subject', ?, 'Snippet', '#', '[]', 1, 'triaged', ?, ?)`,
      [now, now, now],
    );
    await execute(
      `INSERT INTO triage_decisions
        (id, message_id, model, attention, urgency, confidence, category, summary, reason,
         recommendation, needs_reply, injection_flags, created_at)
       VALUES ('triage-undo', 'mail-undo', 'test', 'suppress', 10, 0.9,
         'bulk-mail', 'Summary', 'Reason', 'Recommendation', 0, '[]', ?)`,
      [now],
    );
    const action = await applyMaintenanceAction({
      accountId: "acct-undo",
      senderEmail: "undo@example.test",
      action: "mark_read",
      remember: false,
    });
    vi.clearAllMocks();

    await undoMaintenanceAction(action.actionId);

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("microsoft");
    expect(adapterCalls.adapter.undoMaintenance).toHaveBeenCalledWith(
      "owner@outlook.example",
      "mark_read",
      ["graph-undo"],
    );
  });

  it("routes a Microsoft message read through the owning account adapter", async () => {
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-read', 'microsoft', 'owner@outlook.example', 'Outlook', 'connected', ?, ?)`,
      [now, now],
    );
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
         received_at, snippet, gmail_url, gmail_labels, is_unread, status, created_at, updated_at)
       VALUES ('mail-read', 'acct-read', 'graph-read', 'thread', 'Sender',
         'sender@example.test', 'Subject', ?, 'Snippet', '#', '[]', 1, 'triaged', ?, ?)`,
      [now, now, now],
    );

    await markMessageRead("mail-read");

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("microsoft");
    expect(adapterCalls.adapter.markRead).toHaveBeenCalledWith("owner@outlook.example", ["graph-read"]);
    await expect(execute(`SELECT is_unread, status FROM email_messages WHERE id = 'mail-read'`))
      .resolves.toMatchObject({ rows: [{ is_unread: 0, status: "read" }] });
  });

  it("routes a manual account sync through the owning provider adapter", async () => {
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-sync', 'microsoft', 'owner@outlook.example', 'Outlook', 'connected', ?, ?)`,
      [now, now],
    );

    await expect(pollMailAccount("acct-sync")).resolves.toMatchObject({
      accountId: "acct-sync",
      provider: "microsoft",
      ingested: 0,
    });

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("microsoft");
    expect(adapterCalls.adapter.readInbox).toHaveBeenCalledWith("owner@outlook.example", "acct-sync", { syncRangeDays: 2 });
  });

  it("routes background account polling through each owning provider adapter", async () => {
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-background-microsoft', 'microsoft', 'owner@outlook.example', 'Outlook', 'connected', ?, ?)`,
      [now, now],
    );

    await expect(pollGmail()).resolves.toMatchObject({
      accounts: 2,
      gmailAccounts: 1,
      microsoftAccounts: 1,
      ingested: 0,
      errors: [],
    });

    expect(adapterCalls.adapter.readInbox).toHaveBeenCalledWith(
      "background@gmail.test",
      expect.any(String),
      { syncRangeDays: 2 },
    );
    expect(adapterCalls.adapter.readInbox).toHaveBeenCalledWith(
      "owner@outlook.example",
      "acct-background-microsoft",
      { syncRangeDays: 2 },
    );
  });

  it("routes the legacy exact-approved Gmail reply through the owning provider adapter", async () => {
    const now = nowIso();
    const content = "Exact approved reply.";
    const contentHash = createHash("sha256").update(content).digest("hex");
    await execute(
      `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-legacy-send', 'gmail', 'owner@gmail.test', 'Gmail', 'connected', ?, ?)`,
      [now, now],
    );
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
         received_at, snippet, gmail_url, gmail_labels, is_unread, status, created_at, updated_at)
       VALUES ('mail-legacy-send', 'acct-legacy-send', 'gmail-source', 'thread', 'Sender',
         'sender@example.test', 'Subject', ?, 'Snippet', '#', '[]', 1, 'triaged', ?, ?)`,
      [now, now, now],
    );
    await execute(
      `INSERT INTO reply_drafts (id, message_id, content, content_hash, version, status, created_at, updated_at)
       VALUES ('draft-legacy-send', 'mail-legacy-send', ?, ?, 1, 'draft', ?, ?)`,
      [content, contentHash, now, now],
    );

    await requestSendApproval("draft-legacy-send");
    await approveAndSendDraft("draft-legacy-send");

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("gmail");
    expect(adapterCalls.adapter.sendOutgoing).toHaveBeenCalledWith("owner@gmail.test", {
      from: "owner@gmail.test",
      to: [{ email: "sender@example.test", name: null }],
      cc: [],
      bcc: [],
      subject: "Re: Subject",
      body: content,
      attachments: [],
      replyToMessageId: "gmail-source",
    });
    expect(directProviderCalls.sendGmailReply).not.toHaveBeenCalled();
  });

  it("routes uncached Microsoft message detail through the owning provider adapter", async () => {
    setNodeEnv("development");
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-detail', 'microsoft', 'owner@outlook.example', 'Outlook', 'connected', ?, ?)`,
      [now, now],
    );
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, history_id, sender_name, sender_email, subject,
         received_at, snippet, gmail_url, gmail_labels, is_unread, status, created_at, updated_at)
       VALUES ('mail-detail', 'acct-detail', 'graph-detail', 'thread', 'provider-revision', 'Sender',
         'sender@example.test', 'Stored subject', ?, 'Stored snippet', '#', '[]', 1, 'triaged', ?, ?)`,
      [now, now, now],
    );

    await expect(getMessageDetail("mail-detail")).resolves.toMatchObject({
      bodyText: "Provider body",
      content: { source: "provider", providerRevision: "provider-revision" },
    });

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("microsoft");
    expect(adapterCalls.adapter.readMessage).toHaveBeenCalledWith(
      "owner@outlook.example",
      "acct-detail",
      "graph-detail",
    );
  });

  it("routes an incoming attachment download through the owning provider adapter", async () => {
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-attachment', 'microsoft', 'owner@outlook.example', 'Outlook', 'connected', ?, ?)`,
      [now, now],
    );
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
         received_at, snippet, gmail_url, gmail_labels, is_unread, status, created_at, updated_at)
       VALUES ('mail-attachment', 'acct-attachment', 'graph-attachment', 'thread', 'Sender',
         'sender@example.test', 'Subject', ?, 'Snippet', '#', '[]', 1, 'triaged', ?, ?)`,
      [now, now, now],
    );
    await execute(
      `INSERT INTO message_attachments
        (id, message_id, provider_attachment_id, filename, mime_type, byte_size, is_inline, created_at, updated_at)
       VALUES ('attachment-row', 'mail-attachment', 'graph-file', 'report.pdf', 'application/pdf', 15, 0, ?, ?)`,
      [now, now],
    );

    await expect(downloadIncomingAttachment("mail-attachment", "graph-file"))
      .resolves.toMatchObject({ name: "report.pdf", risky: false, bytes: Buffer.from("safe attachment") });

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("microsoft");
    expect(adapterCalls.adapter.downloadAttachment).toHaveBeenCalledWith(
      "owner@outlook.example",
      "graph-attachment",
      "graph-file",
      "report.pdf",
    );
  });

  it("inspects preview metadata before fetching bytes and verifies the fetched PDF", async () => {
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-preview', 'microsoft', 'owner@outlook.example', 'Outlook', 'connected', ?, ?)` ,
      [now, now],
    );
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
         received_at, snippet, gmail_url, gmail_labels, is_unread, status, created_at, updated_at)
       VALUES ('mail-preview', 'acct-preview', 'graph-preview', 'thread', 'Sender',
         'sender@example.test', 'Subject', ?, 'Snippet', '#', '[]', 1, 'triaged', ?, ?)` ,
      [now, now, now],
    );
    await execute(
      `INSERT INTO message_attachments
        (id, message_id, provider_attachment_id, filename, mime_type, byte_size, is_inline, created_at, updated_at)
       VALUES ('preview-row', 'mail-preview', 'preview-file', 'report.pdf', 'application/pdf', 15, 0, ?, ?)` ,
      [now, now],
    );

    await expect(inspectIncomingAttachmentPreview("mail-preview", "preview-file"))
      .resolves.toEqual({ status: "available", kind: "pdf", name: "report.pdf", mimeType: "application/pdf", size: 15 });
    expect(adapterCalls.adapter.downloadAttachment).not.toHaveBeenCalled();

    adapterCalls.adapter.downloadAttachment.mockResolvedValueOnce(Buffer.from("%PDF-1.7\nSafe preview"));
    await expect(readIncomingAttachmentPreview("mail-preview", "preview-file"))
      .resolves.toMatchObject({ kind: "pdf", name: "report.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.7\nSafe preview") });
  });

  it("routes provider reply metadata and draft context through the owning adapter", async () => {
    setNodeEnv("development");
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-reply', 'microsoft', 'owner@outlook.example', 'Outlook', 'connected', ?, ?)`,
      [now, now],
    );
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
         received_at, snippet, gmail_url, gmail_labels, is_unread, status, created_at, updated_at)
       VALUES ('mail-reply', 'acct-reply', 'graph-reply', 'thread', 'Sender',
         'sender@example.test', 'Stored subject', ?, 'Stored snippet', '#', '[]', 1, 'triaged', ?, ?)`,
      [now, now, now],
    );

    await expect(prepareReplyDraft("mail-reply")).resolves.toMatchObject({
      accountProvider: "microsoft",
      to: [{ email: "sender@example.test" }],
    });

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("microsoft");
    expect(adapterCalls.adapter.getReplyMetadata).toHaveBeenCalledWith("owner@outlook.example", "graph-reply");
    expect(adapterCalls.adapter.readMessage).toHaveBeenCalledWith(
      "owner@outlook.example",
      "acct-reply",
      "graph-reply",
    );
  });
});
