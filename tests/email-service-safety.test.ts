import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureEmailDatabaseForTests,
  ensureEmailDatabase,
  execute,
  getDashboardState,
  newId,
  nowIso,
  setSetting,
} from "@/lib/email/database";
import {
  createOrRecoverNotificationDecision,
  getNotificationDecision,
} from "@/lib/email/foreground-notifications";
import {
  getMessageDetail,
  forgetPreference,
  ingestMessage,
  notifyMessage,
  prepareReplyDraft,
  recordFeedback,
  saveContinuityCheckpoint,
  sendScheduledDigest,
  snoozeMessage,
} from "@/lib/email/service";

let memoryWorkspace: string | undefined;

function telegramTestCredential(): string {
  return ["123456789", "TEST_TOKEN_123"].join(":");
}

describe("email service safety", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:service-${crypto.randomUUID()}.sqlite`);
    await ensureEmailDatabase();
  });

  afterEach(async () => {
    delete process.env.EZRA_OPENCLAW_WORKSPACE;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_DEFAULT_CHAT_ID;
    vi.unstubAllGlobals();
    if (memoryWorkspace) await fs.rm(memoryWorkspace, { recursive: true, force: true });
    memoryWorkspace = undefined;
  });

  it("deduplicates a message before model inference or notification", async () => {
    const { accountId } = await seedMessage();
    const ingested = await ingestMessage({
      accountId,
      externalMessageId: "external",
      threadId: "thread",
      historyId: "history",
      senderName: "Sender",
      senderEmail: "sender@example.com",
      subject: "Duplicate",
      receivedAt: nowIso(),
      snippet: "Already stored.",
      bodyText: "Already stored.",
      gmailUrl: "#",
      isUnread: true,
      labels: ["INBOX", "UNREAD"],
      attachments: [],
    });
    expect(ingested).toBe(false);
  });

  it("reconciles provider-confirmed Pin and Flag state while ingesting an existing message", async () => {
    const { accountId, messageId } = await seedMessage();

    await expect(ingestMessage({
      accountId,
      externalMessageId: "external",
      threadId: "thread",
      historyId: "history-next",
      senderName: "Sender",
      senderEmail: "sender@example.com",
      subject: "Reconciled organization",
      receivedAt: nowIso(),
      snippet: "Provider state",
      gmailUrl: "#",
      isUnread: true,
      isPinned: true,
      isFlagged: true,
      labels: ["INBOX", "UNREAD", "STARRED", "IMPORTANT"],
      attachments: [],
    })).resolves.toBe(false);

    const state = await execute(
      `SELECT is_pinned, is_flagged, organization_confirmed_at, gmail_labels
       FROM email_messages WHERE id = ?`,
      [messageId],
    );
    expect(state.rows[0]).toMatchObject({
      is_pinned: 1,
      is_flagged: 1,
      organization_confirmed_at: expect.any(String),
    });
    expect(JSON.parse(String(state.rows[0].gmail_labels))).toEqual(expect.arrayContaining(["STARRED", "IMPORTANT"]));
  });

  it("rejects an organization snapshot observed before a newer confirmed action", async () => {
    const { accountId, messageId } = await seedMessage();
    const staleObservation = "2026-08-23T12:00:00.000Z";
    const confirmedAction = "2026-08-23T12:00:01.000Z";
    const freshObservation = "2026-08-23T12:00:02.000Z";
    await execute(
      `UPDATE email_messages
       SET is_pinned = 1, is_flagged = 1, organization_confirmed_at = ?
       WHERE id = ?`,
      [confirmedAction, messageId],
    );
    const envelope = {
      accountId,
      externalMessageId: "external",
      threadId: "thread",
      historyId: "history-next",
      senderName: "Sender",
      senderEmail: "sender@example.com",
      subject: "Organization race",
      receivedAt: nowIso(),
      snippet: "Provider state",
      gmailUrl: "#",
      isUnread: true,
      isPinned: false,
      isFlagged: false,
      labels: ["INBOX", "UNREAD"],
      attachments: [],
    };

    await ingestMessage(envelope, undefined, staleObservation);
    await expect(execute(
      `SELECT is_pinned, is_flagged, organization_confirmed_at FROM email_messages WHERE id = ?`,
      [messageId],
    )).resolves.toMatchObject({
      rows: [{ is_pinned: 1, is_flagged: 1, organization_confirmed_at: confirmedAction }],
    });

    await ingestMessage(envelope, undefined, freshObservation);
    await expect(execute(
      `SELECT is_pinned, is_flagged, organization_confirmed_at FROM email_messages WHERE id = ?`,
      [messageId],
    )).resolves.toMatchObject({
      rows: [{ is_pinned: 0, is_flagged: 0, organization_confirmed_at: freshObservation }],
    });
  });

  it.each(["sent", "pending"] as const)("does not create a second alert after a %s Telegram interrupt attempt", async (status) => {
    const { messageId } = await seedMessage();
    await createOrRecoverNotificationDecision({
      messageId,
      reason: "This message was already approved for interruption.",
    });
    await execute(
      `INSERT INTO notifications
        (id, message_id, channel, kind, status, created_at, sent_at)
       VALUES (?, ?, 'telegram', 'interrupt', ?, ?, ?)`,
      [newId("notice"), messageId, status, nowIso(), status === "sent" ? nowIso() : null],
    );
    await expect(notifyMessage(messageId)).resolves.toMatchObject({ skipped: true, status: "in_app" });
    const count = await execute(
      `SELECT COUNT(*) AS count FROM notifications WHERE message_id = ?`,
      [messageId],
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it("records private policy evidence without transport or legacy Telegram writes", async () => {
    const { messageId } = await seedMessage();
    await seedInterruptTriage(messageId, "account-security");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(notifyMessage(messageId)).resolves.toMatchObject({ ok: true, skipped: true, status: "in_app" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await getNotificationDecision(messageId)).toBeNull();
    expect((await execute("SELECT * FROM notification_policy_evidence WHERE message_id=?", [messageId])).rows).toHaveLength(1);
    await expect(notificationStatuses(messageId)).resolves.toEqual([]);
  });

  it("records digest history locally without sending when no device is explicitly enrolled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ models: [] }),
      })),
    );
    await setSetting("quiet_start", "23:59"); await setSetting("quiet_end", "23:59");
    const { messageId } = await seedMessage();
    await execute(
      `INSERT INTO triage_decisions
        (id, message_id, model, attention, urgency, confidence, category, summary, reason,
         recommendation, needs_reply, injection_flags, created_at)
       VALUES (?, ?, 'qwen3:8b-maxctx', 'digest', 55, 0.86, 'updates',
         'Useful but not urgent.', 'Good for a digest.', 'Review in the brief.', 0, '[]', ?)`,
      [newId("triage"), messageId, nowIso()],
    );

    await expect(
      sendScheduledDigest("Manual email brief", "2026-06-17T13:00:00.000Z"),
    ).resolves.toMatchObject({ count: 1, status: "skipped" });

    const dashboard = await getDashboardState({
      worker: "running",
      lastPollAt: null,
      lastPollError: null,
      ollama: true,
      telegramConfigured: false,
      telegramRunning: false,
      gogInstalled: true,
      gmailModifyAuthorized: true,
    });
    const digest = dashboard.digests.history[0];
    expect(digest.status).toBe("skipped");
    expect(digest.itemCount).toBe(1);
    expect(digest.error).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(digest.items[0].id).toBe(messageId);
    expect(dashboard.counts.digest).toBe(1);

    const message = await execute(`SELECT status FROM email_messages WHERE id = ?`, [messageId]);
    expect(String(message.rows[0].status)).toBe("triaged");
  }, 15_000);

  it("turns repeated explicit sender feedback into reviewable evidence", async () => {
    const { messageId } = await seedMessage();
    await recordFeedback(messageId, "interrupt");
    await recordFeedback(messageId, "interrupt");
    const result = await execute(
      `SELECT action, evidence_count FROM learned_preferences
       WHERE kind = 'sender' AND pattern = 'sender@example.com'`,
    );
    expect(String(result.rows[0].action)).toBe("interrupt");
    expect(Number(result.rows[0].evidence_count)).toBe(2);
  });

  it("removes forgotten preferences from the visible learning view", async () => {
    const { messageId } = await seedMessage();
    await recordFeedback(messageId, "interrupt");
    const preference = await execute(
      `SELECT id FROM learned_preferences WHERE pattern = 'sender@example.com'`,
    );
    await forgetPreference(String(preference.rows[0].id));

    const dashboard = await getDashboardState({
      worker: "running",
      lastPollAt: null,
      lastPollError: null,
      ollama: true,
      telegramConfigured: false,
      telegramRunning: false,
      gogInstalled: true,
      gmailModifyAuthorized: true,
    });

    expect(dashboard.preferences).toHaveLength(0);
  });

  it("immediately applies explicit attention corrections to the current inbox", async () => {
    const { messageId } = await seedMessage();
    await execute(
      `INSERT INTO triage_decisions
        (id, message_id, model, attention, urgency, confidence, category, summary, reason,
         recommendation, needs_reply, injection_flags, created_at)
       VALUES (?, ?, 'qwen3:8b-maxctx', 'interrupt', 90, 0.9, 'general', 'Summary',
         'Reason', 'Review', 0, '[]', ?)`,
      [newId("triage"), messageId, nowIso()],
    );

    await recordFeedback(messageId, "suppress");
    const dashboard = await getDashboardState({
      worker: "running",
      lastPollAt: null,
      lastPollError: null,
      ollama: true,
      telegramConfigured: false,
      telegramRunning: false,
      gogInstalled: true,
      gmailModifyAuthorized: true,
    });

    expect(dashboard.inbox.find((item) => item.id === messageId)?.attention).toBe("suppress");
    expect(dashboard.counts.interrupt).toBe(0);
    expect(dashboard.counts.suppress).toBe(1);
  });

  it("removes snoozed messages from visible queues and counts", async () => {
    const { messageId } = await seedMessage();
    await execute(
      `INSERT INTO triage_decisions
        (id, message_id, model, attention, urgency, confidence, category, summary, reason,
         recommendation, needs_reply, injection_flags, created_at)
       VALUES (?, ?, 'qwen3:8b-maxctx', 'interrupt', 90, 0.9, 'general', 'Summary',
         'Reason', 'Review', 0, '[]', ?)`,
      [newId("triage"), messageId, nowIso()],
    );

    await snoozeMessage(messageId, 60);
    const dashboard = await getDashboardState({
      worker: "running",
      lastPollAt: null,
      lastPollError: null,
      ollama: true,
      telegramConfigured: false,
      telegramRunning: false,
      gogInstalled: true,
      gmailModifyAuthorized: true,
    });

    expect(dashboard.inbox.some((item) => item.id === messageId)).toBe(false);
    expect(dashboard.counts.interrupt).toBe(0);
  });

  it("keeps protected suppressed mail out of the maintenance queue", async () => {
    const { messageId } = await seedMessage();
    await execute(`UPDATE email_messages SET is_unread = 1 WHERE id = ?`, [messageId]);
    await execute(
      `INSERT INTO triage_decisions
        (id, message_id, model, attention, urgency, confidence, category, summary, reason,
         recommendation, needs_reply, injection_flags, created_at)
       VALUES (?, ?, 'rules:v1', 'suppress', 10, 0.99, 'financial', 'Statement',
         'Protected financial mail', 'Review manually', 0, '[]', ?)`,
      [newId("triage"), messageId, nowIso()],
    );

    const dashboard = await getDashboardState({
      worker: "running",
      lastPollAt: null,
      lastPollError: null,
      ollama: true,
      telegramConfigured: false,
      telegramRunning: false,
      gogInstalled: true,
      gmailModifyAuthorized: true,
    });

    expect(dashboard.maintenance).toHaveLength(0);
  });

  it("builds message detail and evidence-based contact memory without persisting a full body", async () => {
    const { accountId, messageId } = await seedMessage();
    const earlier = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
         received_at, snippet, gmail_url, status, created_at, updated_at)
       VALUES (?, ?, 'external-2', 'thread-2', 'Sender', 'sender@example.com', 'Earlier subject',
         ?, 'Earlier snippet', '#', 'triaged', ?, ?)`,
      [newId("mail"), accountId, earlier, earlier, earlier],
    );
    await execute(
      `INSERT INTO triage_decisions
        (id, message_id, model, attention, urgency, confidence, category, summary, reason,
         recommendation, needs_reply, injection_flags, created_at)
       VALUES (?, ?, 'qwen3:8b-maxctx', 'interrupt', 88, 0.9, 'project-update',
         'A project update', 'A deadline is approaching', 'Reply today', 1, '[]', ?)`,
      [newId("triage"), messageId, nowIso()],
    );
    await execute(
      `INSERT INTO learned_preferences
        (id, account_id, kind, pattern, action, weight, evidence_count, enabled, created_at, updated_at)
       VALUES (?, ?, 'sender', 'sender@example.com', 'interrupt', 2, 2, 1, ?, ?)`,
      [newId("preference"), accountId, nowIso(), nowIso()],
    );

    const detail = await getMessageDetail(messageId);

    expect(detail.bodyText).toBe("Snippet");
    expect(detail.bodyIsExcerpt).toBe(true);
    expect(detail.content).toMatchObject({
      plainText: "Snippet",
      sanitizedHtml: null,
      source: "excerpt",
      truncated: false,
      remoteImageCount: 0,
    });
    expect(detail.content?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(detail.contactMemory.messageCount).toBe(2);
    expect(detail.contactMemory.categories.map((category) => category.label)).toEqual([
      "Relationship",
      "Patterns",
      "Preferences",
      "Recent history",
    ]);
    expect(detail.contactMemory.categories[2].summary).toMatch(/Always Alert|Interrupt/i);
  });

  it("uses a matching sanitized content cache without exposing raw provider HTML", async () => {
    const { messageId } = await seedMessage();
    await execute(
      `INSERT INTO message_content_cache
        (message_id, provider_revision, plain_text, sanitized_html, content_hash,
         remote_image_count, tracking_pixel_count, is_truncated, fetched_at)
       VALUES (?, 'history', 'Cached full message', '<p>Cached full message</p>', ?, 0, 0, 0, ?)`,
      [messageId, "a".repeat(64), nowIso()],
    );

    const detail = await getMessageDetail(messageId);

    expect(detail.bodyText).toBe("Cached full message");
    expect(detail.bodyIsExcerpt).toBe(false);
    expect(detail.content).toMatchObject({
      sanitizedHtml: "<p>Cached full message</p>",
      providerRevision: "history",
      source: "cache",
    });
  });

  it("uses a neutral initial draft when no reply or user facts are established", async () => {
    const { messageId } = await seedMessage();
    const prepared = await prepareReplyDraft(messageId);

    expect(prepared.content).toContain('I received your message regarding "Subject".');
    expect(prepared.content).toContain(
      "Could you please confirm whether any response or additional information is needed from me?",
    );
    expect(prepared.content).not.toMatch(/\bI (?:will|did|confirmed|completed)\b/i);
  });

  it("writes a bounded structured continuity checkpoint", async () => {
    memoryWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-memory-"));
    process.env.EZRA_OPENCLAW_WORKSPACE = memoryWorkspace;
    const result = await saveContinuityCheckpoint({
      summary: "Maintenance permission is still awaiting Google consent.",
      durablePreferences: ["Unread mail should represent messages that need attention."],
      decisions: ["Use sender-level maintenance rules only after explicit approval."],
      unresolved: ["Complete the Gmail modify authorization."],
      corrections: [],
      actionBoundaries: ["Do not change messages until the user chooses a sender."],
    });

    expect(result.saved).toBe(true);
    const files = await fs.readdir(path.join(memoryWorkspace, "memory"));
    expect(files.some((file) => file.endsWith("-continuity.md"))).toBe(true);
  });

  it("rejects credentials in continuity checkpoints", async () => {
    memoryWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-memory-"));
    process.env.EZRA_OPENCLAW_WORKSPACE = memoryWorkspace;
    await expect(
      saveContinuityCheckpoint({
        summary: ["api", "_key=do-not-store-this"].join(""),
        durablePreferences: [],
        decisions: [],
        unresolved: [],
        corrections: [],
        actionBoundaries: [],
      }),
    ).rejects.toThrow(/credentials/i);
  });
});

async function seedMessage(senderEmail = "sender@example.com") {
  const accountId = newId("acct");
  const messageId = newId("mail");
  const now = nowIso();
  await execute(
    `INSERT INTO email_accounts
      (id, provider, email, label, status, created_at, updated_at)
     VALUES (?, 'gmail', ?, 'Test', 'connected', ?, ?)`,
    [accountId, `${accountId}@example.test`, now, now],
  );
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, history_id, sender_name, sender_email,
       subject, received_at, snippet, gmail_url, is_unread, status, created_at, updated_at)
     VALUES (?, ?, 'external', 'thread', 'history', 'Sender', ?, 'Subject',
       ?, 'Snippet', '#', 1, 'triaged', ?, ?)`,
    [messageId, accountId, senderEmail, now, now, now],
  );
  return { accountId, messageId };
}

async function seedInterruptTriage(messageId: string, category: string) {
  await execute(
    `INSERT INTO triage_decisions
      (id, message_id, model, attention, urgency, confidence, category, summary, reason,
       recommendation, needs_reply, injection_flags, created_at)
     VALUES (?, ?, 'qwen3:8b-maxctx', 'interrupt', 95, 0.9, ?, 'Summary',
       'Reason', 'Review', 0, '[]', ?)`,
    [newId("triage"), messageId, category, nowIso()],
  );
}

async function notificationStatuses(messageId: string) {
  const result = await execute(
    `SELECT status FROM notifications WHERE message_id = ? ORDER BY created_at, id`,
    [messageId],
  );
  return result.rows.map((row) => String(row.status));
}

async function latestSkipReason(messageId: string) {
  const result = await execute(
    `SELECT metadata FROM audit_logs
     WHERE action = 'notification.skipped' AND target_id = ?
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [messageId],
  );
  const row = result.rows[0];
  return row ? String(JSON.parse(String(row.metadata)).reason) : null;
}

async function disableQuietHours() {
  await setSetting("quiet_start", "00:00");
  await setSetting("quiet_end", "00:00");
}
