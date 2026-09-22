import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapterCalls = vi.hoisted(() => ({
  adapter: {
    getReplyMetadata: vi.fn(async () => ({
      from: { name: "Sender", email: "sender@example.test" },
      replyTo: [{ name: "Reply", email: "reply@example.test" }],
      to: [],
      cc: [],
      subject: "Provider subject",
    })),
  },
  providerAdapterFor: vi.fn(),
}));
const directProviderCalls = vi.hoisted(() => ({
  getMicrosoftReplyMetadata: vi.fn(async () => ({
    from: { name: "Sender", email: "sender@example.test" }, replyTo: [], to: [], cc: [], subject: "Direct subject",
  })),
}));

adapterCalls.providerAdapterFor.mockImplementation(() => adapterCalls.adapter);
vi.mock("@/lib/email/provider-adapter", () => adapterCalls);
vi.mock("@/lib/email/microsoft", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/email/microsoft")>(),
  getMicrosoftReplyMetadata: directProviderCalls.getMicrosoftReplyMetadata,
}));
import {
  cancelOutgoingDraft,
  addOutgoingDraftAttachment,
  createForwardDraft,
  createNewEmailDraft,
  createReplyOutgoingDraftFromMessage,
  getOutgoingDrafts,
  removeOutgoingDraftAttachment,
  requestOutgoingDraftApproval,
  updateOutgoingDraft,
} from "@/lib/email/composition";
import { configureEmailDatabaseForTests, execute, nowIso } from "@/lib/email/database";

const originalNodeEnv = process.env.NODE_ENV;

describe("v0.5 outgoing composition foundation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterCalls.providerAdapterFor.mockImplementation(() => adapterCalls.adapter);
    configureEmailDatabaseForTests(`file:./composition-${randomUUID()}.sqlite`);
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", originalNodeEnv);
  });

  it("stores a new-email draft with exact account identity, recipients, subject, and body", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");

    const draft = await createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ name: "Taylor", email: "Taylor@Example.test" }],
      cc: [{ email: "copy@example.test" }],
      bcc: [],
      subject: "Interview availability",
      body: "Hi Taylor,\n\nFriday morning works for me.",
    });

    expect(draft).toMatchObject({
      sourceType: "new",
      sourceMessageId: null,
      accountId: "acct-gmail",
      accountProvider: "gmail",
      accountEmail: "owner@gmail.test",
      fromEmail: "owner@gmail.test",
      subject: "Interview availability",
      body: "Hi Taylor,\n\nFriday morning works for me.",
      version: 1,
      status: "draft",
    });
    expect(draft.to).toEqual([{ email: "taylor@example.test", name: "Taylor" }]);
    expect(draft.cc).toEqual([{ email: "copy@example.test", name: null }]);
    expect(draft.contentHash).toHaveLength(64);
    expect(draft.sendDisabledReason).toContain("Outbox exact-review");
  });

  it("creates forward drafts from the source message account without cross-account fallback", async () => {
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await seedMessage({
      id: "hotmail-message",
      accountId: "acct-hotmail",
      senderName: "Recruiter",
      senderEmail: "recruiter@example.test",
      subject: "Target Application Follow Up",
      snippet: "Please schedule your interview.",
    });

    const draft = await createForwardDraft({
      messageId: "hotmail-message",
      to: [{ email: "mentor@example.test" }],
    });

    expect(draft).toMatchObject({
      sourceType: "forward",
      sourceMessageId: "hotmail-message",
      accountId: "acct-hotmail",
      accountProvider: "microsoft",
      accountEmail: "owner@hotmail.test",
      fromEmail: "owner@hotmail.test",
      subject: "Fwd: Target Application Follow Up",
      status: "draft",
    });
    expect(draft.body).toContain("---------- Forwarded message ----------");
    expect(draft.body).toContain("Recruiter <recruiter@example.test>");
    expect(draft.sendDisabledReason).toContain("Microsoft Mail.Send access");
  });

  it("rejects invalid and duplicate recipients before saving local drafts", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");

    await expect(createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ email: "not-an-email" }],
      cc: [],
      bcc: [],
      subject: "Hello",
      body: "Body",
    })).rejects.toThrow("Invalid recipient email");

    await expect(createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ email: "same@example.test" }],
      cc: [{ email: "same@example.test" }],
      bcc: [],
      subject: "Hello",
      body: "Body",
    })).rejects.toThrow("Duplicate recipient");
  });

  it("lists outgoing drafts by Gmail, Hotmail, and All accounts workspaces", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ email: "gmail-contact@example.test" }],
      cc: [],
      bcc: [],
      subject: "Gmail draft",
      body: "Gmail body",
    });
    await createNewEmailDraft({
      accountId: "acct-hotmail",
      to: [{ email: "hotmail-contact@example.test" }],
      cc: [],
      bcc: [],
      subject: "Hotmail draft",
      body: "Hotmail body",
    });

    const gmail = await getOutgoingDrafts({ workspaceId: "workspace:gmail" });
    const hotmail = await getOutgoingDrafts({ workspaceId: "workspace:microsoft" });
    const all = await getOutgoingDrafts({ workspaceId: "workspace:all" });

    expect(gmail.map((draft) => draft.accountProvider)).toEqual(["gmail"]);
    expect(hotmail.map((draft) => draft.accountProvider)).toEqual(["microsoft"]);
    expect(all).toHaveLength(2);
  });

  it("updates and cancels local outgoing drafts without changing sending identity", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    const draft = await createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ email: "first@example.test" }],
      cc: [],
      bcc: [],
      subject: "Original",
      body: "Original body",
    });

    const updated = await updateOutgoingDraft({
      draftId: draft.id,
      to: [{ email: "second@example.test" }],
      subject: "Updated",
      body: "Updated body",
    });
    expect(updated).toMatchObject({
      id: draft.id,
      accountId: "acct-gmail",
      fromEmail: "owner@gmail.test",
      subject: "Updated",
      body: "Updated body",
      version: 2,
      status: "draft",
    });
    expect(updated.to).toEqual([{ email: "second@example.test", name: null }]);
    expect(updated.contentHash).not.toBe(draft.contentHash);

    const cancelled = await cancelOutgoingDraft(draft.id);
    expect(cancelled.status).toBe("cancelled");
    await expect(updateOutgoingDraft({ draftId: draft.id, body: "Nope" })).rejects.toThrow("Cancelled drafts cannot be edited");
  });

  it("hashes outgoing attachments into exact review and invalidates approval when they change", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    const draft = await createNewEmailDraft({ accountId: "acct-gmail", to: [{ email: "contact@example.test" }], cc: [], bcc: [], subject: "Files", body: "See attachment." });
    const bytes = new TextEncoder().encode("safe attachment text");
    const withAttachment = await addOutgoingDraftAttachment(draft.id, { name: "notes.txt", type: "text/plain", arrayBuffer: async () => bytes.buffer });
    expect(withAttachment.attachments).toEqual([expect.objectContaining({ name: "notes.txt", size: bytes.length, available: true })]);
    expect(withAttachment.version).toBe(2);
    expect(withAttachment.contentHash).not.toBe(draft.contentHash);

    const reviewed = await requestOutgoingDraftApproval(draft.id);
    expect(JSON.parse(String(reviewed.approvalSnapshot))).toMatchObject({ attachments: [expect.objectContaining({ name: "notes.txt" })] });
    const removed = await removeOutgoingDraftAttachment(draft.id, withAttachment.attachments[0].id);
    expect(removed).toMatchObject({ status: "draft", version: 3, approvalSnapshot: null, attachments: [] });
  });

  it("gets a non-test account's reply metadata through its owning provider adapter", async () => {
    Reflect.set(process.env, "NODE_ENV", "development");
    await seedAccount("acct-metadata", "microsoft", "owner@outlook.example", "Outlook");
    await seedMessage({
      id: "metadata-source", accountId: "acct-metadata", senderName: "Stored Sender", senderEmail: "stored@example.test",
      subject: "Stored subject", snippet: "Stored snippet",
    });

    const draft = await createReplyOutgoingDraftFromMessage({
      messageId: "metadata-source", replyMode: "sender", body: "Exact reply.",
    });

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("microsoft");
    expect(adapterCalls.adapter.getReplyMetadata).toHaveBeenCalledWith("owner@outlook.example", "external-metadata-source");
    expect(directProviderCalls.getMicrosoftReplyMetadata).not.toHaveBeenCalled();
    expect(draft).toMatchObject({ subject: "Re: Provider subject", to: [{ email: "reply@example.test", name: "Reply" }] });
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
      (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
       received_at, snippet, gmail_url, has_attachments, gmail_labels, is_unread, ingest_source,
       status, created_at, updated_at)
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
