import {
  approveOutgoingDraftSnapshot,
  cancelOutgoingDraft,
  getOutgoingDraft,
  getOutgoingDrafts,
  retireOutgoingAttachmentFiles,
  requestOutgoingDraftApproval,
  verifiedOutgoingAttachmentFiles,
} from "./composition";
import { audit, execute, newId, nowIso } from "./database";
import { providerAdapterFor } from "./provider-adapter";
import type {
  OutboxActionResult,
  OutboxItem,
  OutboxPage,
  OutgoingApprovalSnapshot,
  OutgoingDraft,
  OutgoingDraftStatus,
} from "./types";

const CANCELLABLE_STATUSES: OutgoingDraftStatus[] = [
  "draft",
  "awaiting_approval",
  "approved",
  "failed",
];

export async function getOutboxPage(input: { workspaceId?: string } = {}): Promise<OutboxPage> {
  const drafts = await getOutgoingDrafts({ workspaceId: input.workspaceId });
  const items = drafts.map(outboxItemFromDraft);
  return {
    generatedAt: nowIso(),
    counts: {
      total: items.length,
      draft: countStatus(items, "draft"),
      awaitingApproval: countStatus(items, "awaiting_approval"),
      approved: countStatus(items, "approved"),
      sending: countStatus(items, "sending"),
      sent: countStatus(items, "sent"),
      failed: countStatus(items, "failed"),
      sendUnknown: countStatus(items, "send_unknown"),
      cancelled: countStatus(items, "cancelled"),
      blocked: items.filter((item) => item.blockedReason && !["sent", "cancelled"].includes(item.status)).length,
      cancellable: items.filter((item) => item.canCancel).length,
    },
    items,
  };
}

export async function cancelOutboxItem(draftId: string): Promise<OutboxActionResult> {
  const draft = await cancelOutgoingDraft(draftId, "outbox");
  return {
    ok: true,
    message: "Outgoing draft cancelled.",
    item: outboxItemFromDraft(draft),
  };
}

export async function requestOutboxApproval(draftId: string): Promise<OutboxActionResult> {
  const draft = await requestOutgoingDraftApproval(draftId, "outbox");
  return {
    ok: true,
    message: "Exact review snapshot is ready.",
    item: outboxItemFromDraft(draft),
  };
}

export async function approveOutboxItem(input: {
  draftId: string;
  contentHash: string;
}): Promise<OutboxActionResult> {
  const draft = await approveOutgoingDraftSnapshot(input, "outbox");
  return {
    ok: true,
    message: draft.accountProvider === "gmail"
      ? "Outgoing draft approved and ready for Gmail send."
      : "Outgoing draft approved and ready for Hotmail send.",
    item: outboxItemFromDraft(draft),
  };
}

export async function requestOutboxSend(draftId: string): Promise<OutboxActionResult> {
  return executeOutgoingSend(draftId, { retry: false });
}

export async function retryOutboxSend(draftId: string): Promise<OutboxActionResult> {
  return executeOutgoingSend(draftId, { retry: true });
}

export function outboxItemFromDraft(draft: OutgoingDraft): OutboxItem {
  const recipientCount = draft.to.length + draft.cc.length + draft.bcc.length;
  const blockedReason = blockedReasonForDraft(draft);
  return {
    id: `outbox:${draft.id}`,
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
    recipientCount,
    subject: draft.subject,
    body: draft.body,
    attachments: draft.attachments,
    bodyPreview: preview(draft.body),
    status: draft.status,
    version: draft.version,
    contentHash: draft.contentHash,
    approvalSnapshot: draft.approvalSnapshot,
    providerMessageId: draft.providerMessageId,
    providerDraftId: draft.providerDraftId,
    lastError: draft.lastError,
    canSend: canSendApprovedDraft(draft),
    canCancel: CANCELLABLE_STATUSES.includes(draft.status),
    canRetry: canRetryDraft(draft),
    canReconcile: draft.status === "send_unknown" && draft.accountProvider === "microsoft" && Boolean(draft.providerDraftId),
    blockedReason,
    updatedAt: draft.updatedAt,
    createdAt: draft.createdAt,
  };
}

function blockedReasonForDraft(draft: OutgoingDraft) {
  if (draft.status === "sent" || draft.status === "cancelled") return null;
  if (draft.status === "sending") {
    return "Provider send is already in progress for this exact draft.";
  }
  if (draft.status === "draft") {
    return "Send is blocked until this draft goes through the Outbox exact-review approval flow.";
  }
  if (draft.status === "awaiting_approval") {
    return "Send is blocked until you approve the exact reviewed snapshot.";
  }
  if (draft.status === "approved") {
    if (draft.sendDisabledReason && draft.accountProvider === "microsoft") return draft.sendDisabledReason;
    return canSendApprovedDraft(draft)
      ? null
      : "Send is blocked because the approved snapshot no longer matches this draft. Review the exact draft again.";
  }
  if (draft.status === "failed") {
    return canRetryDraft(draft)
      ? null
      : "Retry is blocked because this failure is not retry-safe. Review the exact draft again before sending.";
  }
  if (draft.status === "send_unknown") {
    return "Microsoft did not confirm the final send. Check provider status before any retry.";
  }
  return draft.sendDisabledReason || "Outbox send execution is not enabled yet.";
}

async function executeOutgoingSend(
  draftId: string,
  options: { retry: boolean },
): Promise<OutboxActionResult> {
  const draft = await getOutgoingDraft(draftId);
  if (draft.status === "sent") {
    return {
      ok: true,
      message: "Outgoing draft was already marked sent.",
      item: outboxItemFromDraft(draft),
      providerMessageId: draft.providerMessageId,
    };
  }
  const item = outboxItemFromDraft(draft);
  if (options.retry ? !item.canRetry : !item.canSend) {
    return {
      ok: false,
      message: item.blockedReason || (options.retry ? "Retry is not available for this draft." : "Send is not available for this draft."),
      item,
    };
  }
  const snapshot = parseApprovalSnapshot(draft.approvalSnapshot);
  if (!snapshot) {
    return {
      ok: false,
      message: "Review this draft before provider send.",
      item,
    };
  }

  const attemptId = newId("outsend");
  const startedAt = nowIso();
  await execute(
    `INSERT INTO outgoing_message_attempts
      (id, draft_id, account_id, provider, status, content_hash, started_at, metadata)
     VALUES (?, ?, ?, ?, 'sending', ?, ?, ?)`,
    [
      attemptId,
      draft.id,
      draft.accountId,
      draft.accountProvider,
      draft.contentHash,
      startedAt,
      JSON.stringify({
        sourceType: draft.sourceType,
        sourceMessageId: draft.sourceMessageId,
        retry: options.retry,
        recipientCount: recipientCount(snapshot),
      }),
    ],
  );
  await execute(
    `UPDATE outgoing_drafts
     SET status = 'sending', last_error = NULL, updated_at = ?
     WHERE id = ?`,
    [startedAt, draft.id],
  );
  await audit("outgoing_draft.send_started", "outbox", "outgoing_draft", draft.id, {
    attemptId,
    contentHash: draft.contentHash,
    retry: options.retry,
  });

  try {
    const providerResult = await sendApprovedProviderDraft(draft, snapshot, attemptId);
    const providerMessageId = providerMessageIdFromResult(providerResult);
    const completedAt = nowIso();
    await execute(
      `UPDATE outgoing_message_attempts
       SET status = 'sent', provider_message_id = ?, completed_at = ?, metadata = ?
       WHERE id = ?`,
      [
        providerMessageId,
        completedAt,
        JSON.stringify({
          providerResult,
          sourceType: draft.sourceType,
          sourceMessageId: draft.sourceMessageId,
          retry: options.retry,
        }),
        attemptId,
      ],
    );
    await execute(
      `UPDATE outgoing_drafts
       SET status = 'sent', provider_message_id = ?, last_error = NULL, updated_at = ?
       WHERE id = ?`,
      [providerMessageId, completedAt, draft.id],
    );
    await audit("outgoing_draft.sent", "outbox", "outgoing_draft", draft.id, {
      attemptId,
      providerMessageId,
      contentHash: draft.contentHash,
    });
    await safelyAcknowledgeConfirmedReplySource(draft, completedAt);
    await retireOutgoingAttachmentFiles(draft.id);
    const sentDraft = await getOutgoingDraft(draft.id);
    return {
      ok: true,
      message: sentMessageFor(draft.accountProvider),
      item: outboxItemFromDraft(sentDraft),
      attemptId,
      providerMessageId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    const unknown = error instanceof Error && error.name === "MicrosoftSendUnknownError";
    const providerDraftId = unknown && error && typeof error === "object" && "providerDraftId" in error
      ? String((error as { providerDraftId: unknown }).providerDraftId)
      : draft.providerDraftId;
    await execute(
      `UPDATE outgoing_message_attempts
       SET status = ?, error = ?, provider_draft_id = COALESCE(?, provider_draft_id), completed_at = ?
       WHERE id = ?`,
      [unknown ? "send_unknown" : "failed", message, providerDraftId ?? null, completedAt, attemptId],
    );
    await execute(
      `UPDATE outgoing_drafts
       SET status = ?, provider_draft_id = COALESCE(?, provider_draft_id), last_error = ?, updated_at = ?
       WHERE id = ?`,
      [unknown ? "send_unknown" : "failed", providerDraftId ?? null, message, completedAt, draft.id],
    );
    await audit("outgoing_draft.send_failed", "outbox", "outgoing_draft", draft.id, {
      attemptId,
      error: message,
      contentHash: draft.contentHash,
    });
    const failedDraft = await getOutgoingDraft(draft.id);
    return {
      ok: false,
      message: `Could not send ${providerName(draft.accountProvider)} draft: ${message}`,
      item: outboxItemFromDraft(failedDraft),
      attemptId,
    };
  }
}

export async function reconcileOutboxSend(draftId: string): Promise<OutboxActionResult> {
  const draft = await getOutgoingDraft(draftId);
  if (draft.status !== "send_unknown" || draft.accountProvider !== "microsoft" || !draft.providerDraftId) {
    return { ok: false, message: "Provider reconciliation is not available for this draft.", item: outboxItemFromDraft(draft) };
  }
  const result = await providerAdapterFor("microsoft").reconcileThreadedReply(draft.accountEmail, draft.providerDraftId);
  if (result.status === "sent") {
    const completedAt = nowIso();
    await execute(`UPDATE outgoing_drafts SET status = 'sent', provider_message_id = ?, last_error = NULL, updated_at = ? WHERE id = ?`, [result.providerMessageId, completedAt, draft.id]);
    await execute(`UPDATE outgoing_message_attempts SET status = 'sent', provider_message_id = ?, completed_at = ? WHERE draft_id = ? AND status = 'send_unknown'`, [result.providerMessageId, completedAt, draft.id]);
    await audit("outgoing_draft.reconciled_sent", "outbox", "outgoing_draft", draft.id, { providerMessageId: result.providerMessageId });
    await safelyAcknowledgeConfirmedReplySource(draft, completedAt);
    await retireOutgoingAttachmentFiles(draft.id);
    const sent = await getOutgoingDraft(draft.id);
    return { ok: true, message: "Microsoft confirmed that the reply was sent.", item: outboxItemFromDraft(sent), providerMessageId: result.providerMessageId };
  }
  if (result.status === "draft") {
    await execute(`UPDATE outgoing_drafts SET status = 'failed', last_error = 'Microsoft confirmed the provider reply is still a draft. Retry is safe.', updated_at = ? WHERE id = ?`, [nowIso(), draft.id]);
    const retryable = await getOutgoingDraft(draft.id);
    return { ok: true, message: "Microsoft confirmed that the reply was not sent. Retry is now available.", item: outboxItemFromDraft(retryable) };
  }
  return { ok: false, message: "Microsoft still cannot confirm whether the reply sent. Do not retry yet.", item: outboxItemFromDraft(draft) };
}

function canSendApprovedDraft(draft: OutgoingDraft) {
  return providerCanSend(draft) &&
    draft.status === "approved" &&
    Boolean(validApprovalSnapshot(draft));
}

function canRetryDraft(draft: OutgoingDraft) {
  return providerCanSend(draft) &&
    draft.status === "failed" &&
    !draft.providerMessageId &&
    Boolean(validApprovalSnapshot(draft));
}

function providerCanSend(draft: OutgoingDraft) {
  return draft.accountProvider === "gmail" || (draft.accountProvider === "microsoft" && !draft.sendDisabledReason);
}

async function sendApprovedProviderDraft(
  draft: OutgoingDraft,
  snapshot: OutgoingApprovalSnapshot,
  attemptId: string,
) {
  const attachments = await verifiedOutgoingAttachmentFiles(draft.id);
  if (attachments.length !== snapshot.attachments.length || attachments.some((file, index) => file.sha256 !== snapshot.attachments[index]?.sha256)) {
    throw new Error("Attachments changed after approval. Review the exact draft again before sending.");
  }
  if (draft.accountProvider === "microsoft") {
    if (snapshot.fromEmail.toLowerCase() !== draft.accountEmail.toLowerCase()) {
      throw new Error("Hotmail send identity changed after approval. Review the exact draft again before sending.");
    }
    if (draft.sourceType === "reply" && draft.sourceMessageId && draft.replyMode) {
      const source = await sourceProviderMessage(draft.sourceMessageId);
      return providerAdapterFor("microsoft").sendThreadedReply(draft.accountEmail, {
        externalMessageId: source.externalMessageId,
        replyMode: draft.replyMode,
        to: snapshot.to,
        cc: snapshot.cc,
        bcc: snapshot.bcc,
        body: snapshot.body,
        attachments,
        providerDraftId: draft.providerDraftId ?? null,
        onDraftCreated: async (providerDraftId) => {
          await execute(`UPDATE outgoing_drafts SET provider_draft_id = ?, updated_at = ? WHERE id = ?`, [providerDraftId, nowIso(), draft.id]);
          await execute(`UPDATE outgoing_message_attempts SET provider_draft_id = ? WHERE id = ?`, [providerDraftId, attemptId]);
        },
      });
    }
    return providerAdapterFor("microsoft").sendOutgoing(draft.accountEmail, {
      from: snapshot.fromEmail,
      to: snapshot.to,
      cc: snapshot.cc,
      bcc: snapshot.bcc,
      subject: snapshot.subject,
      body: snapshot.body,
      attachments,
    });
  }
  const replyToMessageId = draft.sourceType === "reply" && draft.sourceMessageId
    ? (await sourceProviderMessage(draft.sourceMessageId)).externalMessageId
    : null;
  return providerAdapterFor("gmail").sendOutgoing(draft.accountEmail, {
    from: snapshot.fromEmail,
    to: snapshot.to,
    cc: snapshot.cc,
    bcc: snapshot.bcc,
    subject: snapshot.subject,
    body: snapshot.body,
    attachments,
    ...(replyToMessageId ? { replyToMessageId } : {}),
  });
}

async function sourceProviderMessage(messageId: string) {
  const result = await execute(`SELECT external_message_id FROM email_messages WHERE id = ?`, [messageId]);
  const row = result.rows[0];
  if (!row) throw new Error("The source message for this reply was not found.");
  return { externalMessageId: String(row.external_message_id) };
}

async function safelyAcknowledgeConfirmedReplySource(draft: OutgoingDraft, confirmedAt: string) {
  if (draft.sourceType !== "reply" || !draft.sourceMessageId) return;
  try {
    const result = await execute(
      `SELECT status, is_unread, gmail_labels FROM email_messages WHERE id = ?`,
      [draft.sourceMessageId],
    );
    const row = result.rows[0];
    if (!row) return;
    const labels = parseLabelArray(row.gmail_labels).filter((label) => label !== "UNREAD");
    const alreadyAcknowledged = String(row.status) === "cleared"
      && Number(row.is_unread || 0) === 0
      && labels.length === parseLabelArray(row.gmail_labels).length;
    if (alreadyAcknowledged) return;

    await execute(
      `UPDATE email_messages
       SET status = 'cleared', is_unread = 0, gmail_labels = ?, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(labels), confirmedAt, draft.sourceMessageId],
    );
    const actionId = newId("action");
    await execute(
      `INSERT INTO mail_actions
        (id, action, status, message_ids, success_count, failure_count, details,
         undo_data, undo_status, provider_metadata, created_at, executed_at)
       VALUES (?, 'done', 'executed', ?, 1, 0, ?, NULL, NULL, ?, ?, ?)`,
      [
        actionId,
        JSON.stringify([draft.sourceMessageId]),
        JSON.stringify({
          failures: [],
          changedIds: [draft.sourceMessageId],
          unchangedIds: [],
          reason: "confirmed_reply_sent",
          outgoingDraftId: draft.id,
        }),
        JSON.stringify({
          source: "confirmed_reply",
          outgoingDraftId: draft.id,
          providerMessageId: draft.providerMessageId,
        }),
        confirmedAt,
        confirmedAt,
      ],
    );
    await audit("mail.action", "outbox", "mail_action", actionId, {
      action: "done",
      successCount: 1,
      failureCount: 0,
      reason: "confirmed_reply_sent",
      outgoingDraftId: draft.id,
    });
  } catch (error) {
    try {
      await audit("outgoing_reply.source_acknowledge_failed", "outbox", "outgoing_draft", draft.id, {
        sourceMessageId: draft.sourceMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // A confirmed provider send must never be relabeled as failed because local reconciliation failed.
    }
  }
}

function parseLabelArray(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function validApprovalSnapshot(draft: OutgoingDraft) {
  const snapshot = parseApprovalSnapshot(draft.approvalSnapshot);
  if (!snapshot) return null;
  if (snapshot.contentHash !== draft.contentHash) return null;
  if (snapshot.draftId !== draft.id) return null;
  if (snapshot.accountId !== draft.accountId) return null;
  if (snapshot.accountProvider !== draft.accountProvider) return null;
  return snapshot;
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

function recipientCount(snapshot: OutgoingApprovalSnapshot) {
  return snapshot.to.length + snapshot.cc.length + snapshot.bcc.length;
}

function providerMessageIdFromResult(value: unknown): string | null {
  if (Array.isArray(value)) return providerMessageIdFromResult(value[0]);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["id", "messageId", "message_id", "gmailMessageId", "gmail_message_id", "providerMessageId", "provider_message_id"]) {
    if (typeof record[key] === "string" && record[key]) return String(record[key]);
  }
  for (const key of ["message", "result", "data"]) {
    const nested = providerMessageIdFromResult(record[key]);
    if (nested) return nested;
  }
  return null;
}

function sentMessageFor(provider: OutgoingDraft["accountProvider"]) {
  return provider === "microsoft"
    ? "Outgoing Hotmail draft accepted by Microsoft Graph and saved to Sent Items."
    : "Outgoing Gmail draft sent.";
}

function providerName(provider: OutgoingDraft["accountProvider"]) {
  return provider === "microsoft" ? "Hotmail" : "Gmail";
}

function countStatus(items: OutboxItem[], status: OutgoingDraftStatus) {
  return items.filter((item) => item.status === status).length;
}

function preview(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}
