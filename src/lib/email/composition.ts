import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { audit, execute, getServiceState, newId, nowIso } from "./database";
import { providerAdapterFor } from "./provider-adapter";
import { resolveReplyRecipients } from "./reply-recipients";
import type {
  AccountProvider,
  EmailRecipient,
  OutgoingApprovalSnapshot,
  OutgoingDraft,
  OutgoingAttachment,
  OutgoingDraftSourceType,
  OutgoingDraftStatus,
  ReplyMode,
} from "./types";
import { workspaceSqlFilter } from "./workspaces";

type Row = Awaited<ReturnType<typeof execute>>["rows"][number];

type RecipientGroups = {
  to: EmailRecipient[];
  cc: EmailRecipient[];
  bcc: EmailRecipient[];
};

export type CreateNewEmailDraftInput = RecipientGroups & {
  accountId: string;
  subject: string;
  body: string;
};

export type CreateForwardDraftInput = Partial<RecipientGroups> & {
  messageId: string;
  subject?: string;
  body?: string;
};

export type UpdateOutgoingDraftInput = Partial<RecipientGroups> & {
  draftId: string;
  subject?: string;
  body?: string;
};

export const OUTGOING_ATTACHMENT_LIMITS = {
  files: 10,
  perFileBytes: 10 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
} as const;

const outgoingAttachmentTypes = new Map([
  [".pdf", "application/pdf"], [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], [".csv", "text/csv"],
  [".txt", "text/plain"], [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
]);

export async function createNewEmailDraft(input: CreateNewEmailDraftInput, source = "cockpit") {
  const account = await getAccount(input.accountId);
  const recipients = normalizeRecipientGroups({
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
  });
  const subject = requiredText(input.subject, "Subject");
  const body = requiredText(input.body, "Message body");
  const draft = await insertOutgoingDraft({
    sourceType: "new",
    sourceMessageId: null,
    replyMode: null,
    legacyReplyDraftId: null,
    account,
    recipients,
    subject,
    body,
  });
  await audit("outgoing_draft.created", source, "outgoing_draft", draft.id, {
    sourceType: "new",
    accountId: account.id,
    recipientCount: recipientCount(recipients),
  });
  return draft;
}

export async function createForwardDraft(input: CreateForwardDraftInput, source = "cockpit") {
  const message = await getMessageForForward(input.messageId);
  const recipients = normalizeRecipientGroups({
    to: input.to || [],
    cc: input.cc || [],
    bcc: input.bcc || [],
  });
  const subject = cleanText(input.subject || forwardSubject(String(message.subject)), "Subject");
  const body = cleanText(input.body || defaultForwardBody(message), "Message body");
  const draft = await insertOutgoingDraft({
    sourceType: "forward",
    sourceMessageId: input.messageId,
    replyMode: null,
    legacyReplyDraftId: null,
    account: {
      id: String(message.account_id),
      email: String(message.account_email),
      label: String(message.account_label),
      provider: accountProvider(message.account_provider),
    },
    recipients,
    subject,
    body,
  });
  await audit("outgoing_draft.created", source, "outgoing_draft", draft.id, {
    sourceType: "forward",
    sourceMessageId: input.messageId,
    accountId: String(message.account_id),
    recipientCount: recipientCount(recipients),
  });
  return draft;
}

export async function createReplyOutgoingDraft(replyDraftId: string, source = "cockpit") {
  const result = await execute(
    `SELECT d.content, m.id AS message_id, m.subject, m.sender_name, m.sender_email,
      a.id AS account_id, a.email AS account_email, a.label AS account_label, a.provider AS account_provider
     FROM reply_drafts d
     JOIN email_messages m ON m.id = d.message_id
     JOIN email_accounts a ON a.id = m.account_id
     WHERE d.id = ?`,
    [replyDraftId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Reply draft was not found.");
  const draft = await insertOutgoingDraft({
    sourceType: "reply",
    sourceMessageId: String(row.message_id),
    replyMode: "sender",
    legacyReplyDraftId: replyDraftId,
    account: { id: String(row.account_id), email: String(row.account_email), label: String(row.account_label), provider: accountProvider(row.account_provider) },
    recipients: normalizeRecipientGroups({ to: [{ name: String(row.sender_name), email: String(row.sender_email) }], cc: [], bcc: [] }),
    subject: /^re:/i.test(String(row.subject)) ? String(row.subject) : `Re: ${String(row.subject)}`,
    body: requiredText(String(row.content), "Message body"),
  });
  await audit("outgoing_draft.created", source, "outgoing_draft", draft.id, { sourceType: "reply", sourceMessageId: String(row.message_id), accountId: String(row.account_id) });
  return draft;
}

export async function createReplyOutgoingDraftFromMessage(input: {
  messageId: string;
  replyMode: ReplyMode;
  body: string;
}, source = "cockpit") {
  const result = await execute(
    `SELECT m.id, m.external_message_id, m.subject, m.sender_name, m.sender_email,
      a.id AS account_id, a.email AS account_email, a.label AS account_label,
      a.provider AS account_provider
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id = ?`,
    [input.messageId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Email message was not found.");
  const provider = accountProvider(row.account_provider);
  const accountEmail = String(row.account_email);
  const metadata = process.env.NODE_ENV === "test" || accountEmail.endsWith(".test")
    ? {
        from: { name: String(row.sender_name), email: String(row.sender_email) },
        replyTo: [],
        to: [],
        cc: [],
        subject: String(row.subject),
      }
    : await providerAdapterFor(provider).getReplyMetadata(accountEmail, String(row.external_message_id));
  const recipients = resolveReplyRecipients(metadata, accountEmail, input.replyMode);
  const draft = await insertOutgoingDraft({
    sourceType: "reply",
    sourceMessageId: input.messageId,
    replyMode: input.replyMode,
    legacyReplyDraftId: null,
    account: { id: String(row.account_id), email: accountEmail, label: String(row.account_label), provider },
    recipients,
    subject: /^re:/i.test(metadata.subject) ? metadata.subject : `Re: ${metadata.subject}`,
    body: requiredText(input.body, "Message body"),
  });
  await audit("outgoing_draft.created", source, "outgoing_draft", draft.id, {
    sourceType: "reply",
    replyMode: input.replyMode,
    sourceMessageId: input.messageId,
    accountId: String(row.account_id),
    recipientCount: recipientCount(recipients),
  });
  return draft;
}

export async function updateOutgoingDraft(input: UpdateOutgoingDraftInput, source = "cockpit") {
  const current = await getOutgoingDraftRow(input.draftId);
  if (!current) throw new Error("Outgoing draft was not found.");
  const status = String(current.status) as OutgoingDraftStatus;
  if (status === "sent") throw new Error("Sent drafts cannot be edited.");
  if (status === "cancelled") throw new Error("Cancelled drafts cannot be edited.");
  const recipients = normalizeRecipientGroups({
    to: input.to || parseRecipients(current.to_recipients),
    cc: input.cc || parseRecipients(current.cc_recipients),
    bcc: input.bcc || parseRecipients(current.bcc_recipients),
  });
  const subject = input.subject === undefined
    ? String(current.subject)
    : requiredText(input.subject, "Subject");
  const body = input.body === undefined
    ? String(current.body)
    : requiredText(input.body, "Message body");
  const now = nowIso();
  const contentHash = outgoingDraftHash({
    sourceType: String(current.source_type) as OutgoingDraftSourceType,
    sourceMessageId: current.source_message_id ? String(current.source_message_id) : null,
    replyMode: current.reply_mode === "all" ? "all" : current.reply_mode === "sender" ? "sender" : null,
    fromEmail: String(current.from_email),
    recipients,
    subject,
    body,
    attachments: await listOutgoingDraftAttachments(input.draftId),
  });
  await execute(
    `UPDATE outgoing_drafts
     SET to_recipients = ?, cc_recipients = ?, bcc_recipients = ?,
       subject = ?, body = ?, content_hash = ?, version = version + 1,
       status = 'draft', approval_snapshot = NULL, last_error = NULL, updated_at = ?
     WHERE id = ?`,
    [
      JSON.stringify(recipients.to),
      JSON.stringify(recipients.cc),
      JSON.stringify(recipients.bcc),
      subject,
      body,
      contentHash,
      now,
      input.draftId,
    ],
  );
  await audit("outgoing_draft.updated", source, "outgoing_draft", input.draftId, {
    recipientCount: recipientCount(recipients),
  });
  return getOutgoingDraft(input.draftId);
}

export async function cancelOutgoingDraft(draftId: string, source = "cockpit") {
  const current = await getOutgoingDraftRow(draftId);
  if (!current) throw new Error("Outgoing draft was not found.");
  if (String(current.status) === "sent") throw new Error("Sent drafts cannot be cancelled locally.");
  if (String(current.status) !== "cancelled") {
    await execute(
      `UPDATE outgoing_drafts SET status = 'cancelled', updated_at = ? WHERE id = ?`,
      [nowIso(), draftId],
    );
    await audit("outgoing_draft.cancelled", source, "outgoing_draft", draftId);
    await retireOutgoingAttachmentFiles(draftId);
  }
  return getOutgoingDraft(draftId);
}

export async function requestOutgoingDraftApproval(draftId: string, source = "outbox") {
  const draft = await getOutgoingDraft(draftId);
  if (draft.status === "sent") throw new Error("Sent drafts cannot be reviewed for approval.");
  if (draft.status === "cancelled") throw new Error("Cancelled drafts cannot be reviewed for approval.");
  const snapshot = approvalSnapshotForDraft(draft);
  const now = nowIso();
  await execute(
    `UPDATE outgoing_drafts
     SET status = 'awaiting_approval', approval_snapshot = ?, last_error = NULL, updated_at = ?
     WHERE id = ?`,
    [JSON.stringify(snapshot), now, draftId],
  );
  await audit("outgoing_draft.approval_requested", source, "outgoing_draft", draftId, {
    contentHash: snapshot.contentHash,
    version: snapshot.version,
    recipientCount: recipientCount({ to: snapshot.to, cc: snapshot.cc, bcc: snapshot.bcc }),
  });
  return getOutgoingDraft(draftId);
}

export async function approveOutgoingDraftSnapshot(input: {
  draftId: string;
  contentHash: string;
}, source = "outbox") {
  const draft = await getOutgoingDraft(input.draftId);
  if (draft.status === "sent") throw new Error("Draft has already been sent.");
  if (draft.status === "cancelled") throw new Error("Cancelled drafts cannot be approved.");
  const snapshot = parseApprovalSnapshot(draft.approvalSnapshot);
  if (!snapshot) throw new Error("Review this draft before approving it.");
  if (snapshot.contentHash !== input.contentHash || draft.contentHash !== input.contentHash) {
    throw new Error("Draft content changed after review. Review the exact message again before approving.");
  }
  if (draft.status !== "approved") {
    await execute(
      `UPDATE outgoing_drafts SET status = 'approved', updated_at = ? WHERE id = ?`,
      [nowIso(), input.draftId],
    );
    await audit("outgoing_draft.approved", source, "outgoing_draft", input.draftId, {
      contentHash: input.contentHash,
      version: snapshot.version,
    });
  }
  return getOutgoingDraft(input.draftId);
}

export async function getOutgoingDraft(draftId: string) {
  const result = await execute(
    `SELECT d.*, a.label AS account_label, a.email AS account_email, a.provider AS account_provider
     FROM outgoing_drafts d
     JOIN email_accounts a ON a.id = d.account_id
     WHERE d.id = ?`,
    [draftId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Outgoing draft was not found.");
  return outgoingDraftFromRow(row);
}

export async function getOutgoingDrafts(input: { workspaceId?: string } = {}) {
  const workspace = workspaceSqlFilter(input.workspaceId, "d");
  const result = await execute(
    `SELECT d.*, a.label AS account_label, a.email AS account_email, a.provider AS account_provider
     FROM outgoing_drafts d
     JOIN email_accounts a ON a.id = d.account_id
     WHERE ${workspace.sql}
     ORDER BY d.updated_at DESC
     LIMIT 100`,
    workspace.args,
  );
  return Promise.all(result.rows.map(outgoingDraftFromRow));
}

export async function addOutgoingDraftAttachment(draftId: string, file: { name: string; type?: string; size?: number; arrayBuffer(): Promise<ArrayBuffer> }) {
  const current = await getOutgoingDraftRow(draftId);
  if (!current) throw new Error("Outgoing draft was not found.");
  if (["sent", "cancelled", "sending"].includes(String(current.status))) throw new Error("Attachments cannot be changed for this draft status.");
  const existing = await listOutgoingDraftAttachments(draftId);
  if (existing.length >= OUTGOING_ATTACHMENT_LIMITS.files) throw new Error(`A draft can have at most ${OUTGOING_ATTACHMENT_LIMITS.files} attachments.`);
  if (Number(file.size || 0) > OUTGOING_ATTACHMENT_LIMITS.perFileBytes) throw new Error("Each attachment must be 10 MB or smaller.");
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!bytes.length) throw new Error("The attachment is empty.");
  if (bytes.length > OUTGOING_ATTACHMENT_LIMITS.perFileBytes) throw new Error("Each attachment must be 10 MB or smaller.");
  if (existing.reduce((total, item) => total + item.size, 0) + bytes.length > OUTGOING_ATTACHMENT_LIMITS.totalBytes) throw new Error("Attachments must total 20 MB or less.");
  const name = safeAttachmentName(file.name);
  const extension = path.extname(name).toLowerCase();
  const mimeType = outgoingAttachmentTypes.get(extension);
  if (!mimeType) throw new Error("Supported attachment types are PDF, DOCX, XLSX, CSV, TXT, PNG, and JPEG.");
  validateOutgoingAttachmentSignature(bytes, extension);
  const id = newId("outattach");
  const storageName = `${id}${extension}`;
  const directory = outgoingAttachmentDirectory(draftId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, storageName), bytes, { mode: 0o600, flag: "wx" });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const now = nowIso();
  try {
    await execute(
      `INSERT INTO outgoing_draft_attachments
        (id, draft_id, filename, mime_type, byte_size, sha256, storage_name, available, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, draftId, name, mimeType, bytes.length, sha256, storageName, now, now],
    );
    await refreshDraftAfterAttachmentChange(draftId);
  } catch (error) {
    await fs.rm(path.join(directory, storageName), { force: true });
    await execute(`DELETE FROM outgoing_draft_attachments WHERE id = ?`, [id]).catch(() => undefined);
    throw error;
  }
  await audit("outgoing_draft.attachment_added", "outbox", "outgoing_draft", draftId, { attachmentId: id, name, size: bytes.length, sha256 });
  return getOutgoingDraft(draftId);
}

export async function removeOutgoingDraftAttachment(draftId: string, attachmentId: string) {
  const current = await getOutgoingDraftRow(draftId);
  if (!current) throw new Error("Outgoing draft was not found.");
  if (["sent", "cancelled", "sending"].includes(String(current.status))) throw new Error("Attachments cannot be changed for this draft status.");
  const result = await execute(`SELECT * FROM outgoing_draft_attachments WHERE id = ? AND draft_id = ? AND removed_at IS NULL`, [attachmentId, draftId]);
  const row = result.rows[0];
  if (!row) throw new Error("Attachment was not found on this draft.");
  await fs.rm(path.join(outgoingAttachmentDirectory(draftId), String(row.storage_name)), { force: true });
  await execute(`UPDATE outgoing_draft_attachments SET available = 0, removed_at = ?, updated_at = ? WHERE id = ?`, [nowIso(), nowIso(), attachmentId]);
  await refreshDraftAfterAttachmentChange(draftId);
  await audit("outgoing_draft.attachment_removed", "outbox", "outgoing_draft", draftId, { attachmentId, name: String(row.filename) });
  return getOutgoingDraft(draftId);
}

export async function listOutgoingDraftAttachments(draftId: string): Promise<OutgoingAttachment[]> {
  const result = await execute(`SELECT * FROM outgoing_draft_attachments WHERE draft_id = ? AND removed_at IS NULL ORDER BY created_at, id`, [draftId]);
  return result.rows.map((row) => ({ id: String(row.id), name: String(row.filename), mimeType: String(row.mime_type), size: Number(row.byte_size), sha256: String(row.sha256), available: Number(row.available) === 1 }));
}

export async function verifiedOutgoingAttachmentFiles(draftId: string) {
  const result = await execute(`SELECT * FROM outgoing_draft_attachments WHERE draft_id = ? AND removed_at IS NULL ORDER BY created_at, id`, [draftId]);
  const files = [];
  for (const row of result.rows) {
    if (Number(row.available) !== 1) throw new Error(`Attachment "${String(row.filename)}" is no longer available. Remove it and review the draft again.`);
    const filePath = path.join(outgoingAttachmentDirectory(draftId), String(row.storage_name));
    const bytes = await fs.readFile(filePath).catch(() => null);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== String(row.sha256)) throw new Error(`Attachment "${String(row.filename)}" changed after review. Remove it and add it again.`);
    files.push({ id: String(row.id), name: String(row.filename), mimeType: String(row.mime_type), size: Number(row.byte_size), sha256: String(row.sha256), path: filePath, bytes });
  }
  return files;
}

export async function retireOutgoingAttachmentFiles(draftId: string) {
  const result = await execute(`SELECT storage_name FROM outgoing_draft_attachments WHERE draft_id = ? AND removed_at IS NULL AND available = 1`, [draftId]);
  for (const row of result.rows) await fs.rm(path.join(outgoingAttachmentDirectory(draftId), String(row.storage_name)), { force: true });
  await execute(`UPDATE outgoing_draft_attachments SET available = 0, updated_at = ? WHERE draft_id = ? AND removed_at IS NULL`, [nowIso(), draftId]);
}

function normalizeRecipientGroups(groups: RecipientGroups): RecipientGroups {
  const seen = new Set<string>();
  return {
    to: normalizeRecipients(groups.to, seen),
    cc: normalizeRecipients(groups.cc || [], seen),
    bcc: normalizeRecipients(groups.bcc || [], seen),
  };
}

function normalizeRecipients(recipients: EmailRecipient[], seen: Set<string>) {
  if (!Array.isArray(recipients)) throw new Error("Recipients must be a list.");
  return recipients.map((recipient) => {
    const email = String(recipient.email || "").trim().toLowerCase();
    if (!isValidEmail(email)) throw new Error(`Invalid recipient email: ${recipient.email || "(blank)"}`);
    if (seen.has(email)) throw new Error(`Duplicate recipient: ${email}`);
    seen.add(email);
    const name = recipient.name === undefined || recipient.name === null
      ? null
      : String(recipient.name).trim() || null;
    return { email, name };
  });
}

function parseRecipients(value: unknown): EmailRecipient[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        email: String(item?.email || "").trim().toLowerCase(),
        name: item?.name === undefined || item?.name === null ? null : String(item.name),
      }))
      .filter((item) => isValidEmail(item.email));
  } catch {
    return [];
  }
}

function requiredText(value: string, label: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed) throw new Error(`${label} cannot be empty.`);
  if (trimmed.length > 20_000) throw new Error(`${label} is too long.`);
  return trimmed;
}

function cleanText(value: string, label: string) {
  const trimmed = String(value || "").trim();
  if (trimmed.length > 20_000) throw new Error(`${label} is too long.`);
  return trimmed;
}

function isValidEmail(value: string) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

async function getAccount(accountId: string) {
  const result = await execute(
    `SELECT id, email, label, provider, status FROM email_accounts WHERE id = ?`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Sending account was not found.");
  if (String(row.status) === "disabled") throw new Error("Sending account is disabled.");
  return {
    id: String(row.id),
    email: String(row.email),
    label: String(row.label),
    provider: accountProvider(row.provider),
  };
}

async function getMessageForForward(messageId: string) {
  const result = await execute(
    `SELECT m.*, a.email AS account_email, a.label AS account_label, a.provider AS account_provider
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id = ?`,
    [messageId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Email message was not found.");
  return row;
}

async function getOutgoingDraftRow(draftId: string) {
  const result = await execute(`SELECT * FROM outgoing_drafts WHERE id = ?`, [draftId]);
  return result.rows[0] || null;
}

async function insertOutgoingDraft(input: {
  sourceType: OutgoingDraftSourceType;
  sourceMessageId: string | null;
  replyMode: ReplyMode | null;
  legacyReplyDraftId: string | null;
  account: { id: string; email: string; label: string; provider: AccountProvider };
  recipients: RecipientGroups;
  subject: string;
  body: string;
}) {
  if (!input.recipients.to.length) throw new Error("At least one To recipient is required.");
  const now = nowIso();
  const id = newId("outdraft");
  const contentHash = outgoingDraftHash({
    sourceType: input.sourceType,
    sourceMessageId: input.sourceMessageId,
    replyMode: input.replyMode,
    fromEmail: input.account.email,
    recipients: input.recipients,
    subject: input.subject,
    body: input.body,
  });
  await execute(
    `INSERT INTO outgoing_drafts
      (id, source_type, source_message_id, account_id, from_email,
       reply_mode, legacy_reply_draft_id,
       to_recipients, cc_recipients, bcc_recipients, subject, body,
       content_hash, version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?)`,
    [
      id,
      input.sourceType,
      input.sourceMessageId,
      input.account.id,
      input.account.email,
      input.replyMode,
      input.legacyReplyDraftId,
      JSON.stringify(input.recipients.to),
      JSON.stringify(input.recipients.cc),
      JSON.stringify(input.recipients.bcc),
      input.subject,
      input.body,
      contentHash,
      now,
      now,
    ],
  );
  return getOutgoingDraft(id);
}

async function outgoingDraftFromRow(row: Row): Promise<OutgoingDraft> {
  const provider = accountProvider(row.account_provider);
  return {
    id: String(row.id),
    sourceType: String(row.source_type) as OutgoingDraftSourceType,
    sourceMessageId: row.source_message_id ? String(row.source_message_id) : null,
    replyMode: row.reply_mode === "all" ? "all" : row.reply_mode === "sender" ? "sender" : null,
    legacyReplyDraftId: row.legacy_reply_draft_id ? String(row.legacy_reply_draft_id) : null,
    accountId: String(row.account_id),
    accountLabel: String(row.account_label),
    accountEmail: String(row.account_email),
    accountProvider: provider,
    fromEmail: String(row.from_email),
    to: parseRecipients(row.to_recipients),
    cc: parseRecipients(row.cc_recipients),
    bcc: parseRecipients(row.bcc_recipients),
    subject: String(row.subject),
    body: String(row.body),
    attachments: await listOutgoingDraftAttachments(String(row.id)),
    contentHash: String(row.content_hash),
    version: Number(row.version || 1),
    status: String(row.status) as OutgoingDraftStatus,
    approvalSnapshot: row.approval_snapshot ? String(row.approval_snapshot) : null,
    providerMessageId: row.provider_message_id ? String(row.provider_message_id) : null,
    providerDraftId: row.provider_draft_id ? String(row.provider_draft_id) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    sendDisabledReason: await sendDisabledReason(provider, String(row.account_email)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function outgoingDraftHash(input: {
  sourceType?: OutgoingDraftSourceType;
  sourceMessageId?: string | null;
  replyMode?: ReplyMode | null;
  fromEmail: string;
  recipients: RecipientGroups;
  subject: string;
  body: string;
  attachments?: OutgoingAttachment[];
}) {
  return createHash("sha256")
    .update(JSON.stringify({
      fromEmail: input.fromEmail.toLowerCase(),
      sourceType: input.sourceType || null,
      sourceMessageId: input.sourceMessageId || null,
      replyMode: input.replyMode || null,
      to: input.recipients.to,
      cc: input.recipients.cc,
      bcc: input.recipients.bcc,
      subject: input.subject,
      body: input.body,
      attachments: (input.attachments || []).map((item) => ({ name: item.name, mimeType: item.mimeType, size: item.size, sha256: item.sha256 })),
    }))
    .digest("hex");
}

function approvalSnapshotForDraft(draft: OutgoingDraft): OutgoingApprovalSnapshot {
  return {
    draftId: draft.id,
    sourceType: draft.sourceType,
    sourceMessageId: draft.sourceMessageId,
    replyMode: draft.replyMode,
    accountId: draft.accountId,
    accountLabel: draft.accountLabel,
    accountEmail: draft.accountEmail,
    accountProvider: draft.accountProvider,
    fromEmail: draft.fromEmail,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    attachments: draft.attachments,
    contentHash: draft.contentHash,
    version: draft.version,
    requestedAt: nowIso(),
  };
}

async function refreshDraftAfterAttachmentChange(draftId: string) {
  const row = await getOutgoingDraftRow(draftId);
  if (!row) throw new Error("Outgoing draft was not found.");
  const attachments = await listOutgoingDraftAttachments(draftId);
  const contentHash = outgoingDraftHash({
    sourceType: String(row.source_type) as OutgoingDraftSourceType,
    sourceMessageId: row.source_message_id ? String(row.source_message_id) : null,
    replyMode: row.reply_mode === "all" ? "all" : row.reply_mode === "sender" ? "sender" : null,
    fromEmail: String(row.from_email),
    recipients: { to: parseRecipients(row.to_recipients), cc: parseRecipients(row.cc_recipients), bcc: parseRecipients(row.bcc_recipients) },
    subject: String(row.subject), body: String(row.body), attachments,
  });
  await execute(`UPDATE outgoing_drafts SET content_hash = ?, version = version + 1, status = 'draft', approval_snapshot = NULL, last_error = NULL, updated_at = ? WHERE id = ?`, [contentHash, nowIso(), draftId]);
}

function outgoingAttachmentDirectory(draftId: string) {
  return path.join(process.cwd(), "data", "attachments", "outgoing", draftId.replace(/[^a-zA-Z0-9_-]/g, "_"));
}

function safeAttachmentName(value: string) {
  const name = path.basename(String(value || "attachment")).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim();
  return (name || "attachment").slice(0, 180);
}

function validateOutgoingAttachmentSignature(bytes: Buffer, extension: string) {
  if (extension === ".pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("The file content does not match its PDF extension.");
  if ((extension === ".docx" || extension === ".xlsx") && !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error(`The file content does not match its ${extension} extension.`);
  if (extension === ".png" && !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error("The file content does not match its PNG extension.");
  if ((extension === ".jpg" || extension === ".jpeg") && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9)) throw new Error("The file content does not match its JPEG extension.");
}

function parseApprovalSnapshot(value: string | null): OutgoingApprovalSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as OutgoingApprovalSnapshot;
    if (!parsed || typeof parsed !== "object" || !parsed.contentHash) return null;
    return { ...parsed, attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [] };
  } catch {
    return null;
  }
}

function forwardSubject(subject: string) {
  return /^\s*(fwd?|fw):/i.test(subject) ? subject.trim() : `Fwd: ${subject.trim() || "(no subject)"}`;
}

function defaultForwardBody(row: Row) {
  return [
    "",
    "",
    "---------- Forwarded message ----------",
    `From: ${String(row.sender_name)} <${String(row.sender_email)}>`,
    `Date: ${formatDate(String(row.received_at))}`,
    `Subject: ${String(row.subject)}`,
    "",
    String(row.snippet || ""),
  ].join("\n");
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toUTCString();
}

function recipientCount(groups: RecipientGroups) {
  return groups.to.length + groups.cc.length + groups.bcc.length;
}

async function sendDisabledReason(provider: AccountProvider, accountEmail: string) {
  if (provider === "microsoft") {
    const access = await getServiceState(`microsoft_access:${accountEmail.toLowerCase()}`);
    const scopeValue = await getServiceState(`microsoft_scopes:${accountEmail.toLowerCase()}`);
    let scopes: string[] = [];
    try { scopes = scopeValue ? (JSON.parse(scopeValue) as string[]) : []; } catch { scopes = []; }
    if ((access !== "send" && access !== "full") || !scopes.some((scope) => scope.toLowerCase() === "mail.send")) {
      return "Reconnect Hotmail with Enable replies and keep Calendar to grant Microsoft Mail.Send access before this exact draft can be sent.";
    }
    return null;
  }
  return "New and forwarded Gmail mail sends only after the Outbox exact-review approval flow.";
}

function accountProvider(value: unknown): AccountProvider {
  return value === "microsoft" ? "microsoft" : "gmail";
}
