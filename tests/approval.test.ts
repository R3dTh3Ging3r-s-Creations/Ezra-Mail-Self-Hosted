import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  configureEmailDatabaseForTests,
  ensureEmailDatabase,
  execute,
  newId,
  nowIso,
} from "@/lib/email/database";
import {
  approveAndSendDraft,
  cancelDraft,
  requestSendApproval,
  updateReplyDraft,
} from "@/lib/email/service";

describe("exact draft approval", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:approval-${crypto.randomUUID()}.sqlite`);
    await ensureEmailDatabase();
  });

  it("invalidates pending approval when a draft is edited", async () => {
    const { draftId } = await seedDraft();
    await requestSendApproval(draftId);
    await updateReplyDraft(draftId, "A changed reply.");
    const result = await execute(
      `SELECT status FROM send_approvals WHERE draft_id = ? ORDER BY created_at DESC LIMIT 1`,
      [draftId],
    );
    expect(String(result.rows[0].status)).toBe("invalidated");
  });

  it("refuses to send when content no longer matches the approved hash", async () => {
    const { draftId } = await seedDraft();
    await requestSendApproval(draftId);
    await execute(`UPDATE reply_drafts SET content = 'Tampered content' WHERE id = ?`, [draftId]);
    await expect(approveAndSendDraft(draftId)).rejects.toThrow(
      "Draft changed after approval was requested.",
    );
  });

  it("refuses to send without a pending approval", async () => {
    const { draftId } = await seedDraft();
    await expect(approveAndSendDraft(draftId)).rejects.toThrow(
      "Draft or approval was not found.",
    );
  });

  it("expires stale approvals before any send attempt", async () => {
    const { draftId } = await seedDraft();
    const { approvalId } = await requestSendApproval(draftId);
    await execute(`UPDATE send_approvals SET expires_at = ? WHERE id = ?`, [
      new Date(Date.now() - 60_000).toISOString(),
      approvalId,
    ]);
    await expect(approveAndSendDraft(draftId)).rejects.toThrow(
      "Approval expired. Review the draft again.",
    );
    const result = await execute(`SELECT status FROM send_approvals WHERE id = ?`, [approvalId]);
    expect(String(result.rows[0].status)).toBe("expired");
  });

  it("cancels both the draft and its pending approval", async () => {
    const { draftId } = await seedDraft();
    await requestSendApproval(draftId);
    await cancelDraft(draftId);
    const draft = await execute(`SELECT status FROM reply_drafts WHERE id = ?`, [draftId]);
    const approval = await execute(
      `SELECT status FROM send_approvals WHERE draft_id = ? ORDER BY created_at DESC LIMIT 1`,
      [draftId],
    );
    expect(String(draft.rows[0].status)).toBe("cancelled");
    expect(String(approval.rows[0].status)).toBe("cancelled");
  });
});

async function seedDraft() {
  const accountId = newId("acct");
  const messageId = newId("mail");
  const draftId = newId("draft");
  const now = nowIso();
  const content = "Thanks for the note.";
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  await execute(
    `INSERT INTO email_accounts
      (id, provider, email, label, status, created_at, updated_at)
     VALUES (?, 'gmail', 'test@example.com', 'Test', 'connected', ?, ?)`,
    [accountId, now, now],
  );
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
       received_at, snippet, gmail_url, status, created_at, updated_at)
     VALUES (?, ?, 'external', 'thread', 'Sender', 'sender@example.com', 'Subject',
       ?, 'Snippet', '#', 'triaged', ?, ?)`,
    [messageId, accountId, now, now, now],
  );
  await execute(
    `INSERT INTO reply_drafts
      (id, message_id, content, content_hash, version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 'draft', ?, ?)`,
    [draftId, messageId, content, hash, now, now],
  );
  return { draftId };
}
