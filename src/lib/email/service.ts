import crypto from "node:crypto";
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  audit,
  ensureEmailDatabase,
  execute,
  getDashboardState,
  getSetting,
  newId,
  nowIso,
  saveTriageDecision,
  setSetting,
  upsertAccount,
} from "./database";
import { cacheMessageAttachments, extractAttachmentText, validateAttachment } from "./attachments";
import { markCalendarIntegrationConnected } from "./calendar";
import {
  completeGmailAuthorization,
  downloadGmailAttachment,
  getGmailAuthorizationCapabilities,
  getGmailMessage,
  getGmailUnsubscribeMetadata,
  isGogInstalled,
  listAuthorizedGmailAccounts,
  markGmailMessagesRead,
  moveGmailMessagesToSpam,
  searchGmailMessagePage,
} from "./gmail";
import { draftWithActiveModel, triageWithActiveModel } from "./model";
import { messageContentFromPlainText, sanitizeMessageHtml } from "./message-content";
import { modelDefinitions } from "./models";
import {
  type BriefDeliveryMode,
} from "./notification-policy";
import { createManualNotificationBrief } from "./notification-schedule";
import { decideMessageNotification } from "./notification-governor";
import { describeProviderError } from "./provider-errors";
import { providerAdapterFor } from "./provider-adapter";
import { assertProviderAccountIdentity, recordVerifiedProviderAccount } from "./provider-account-connection";
import { polishReply, type PolishReplyResult } from "./reply-polish";
import {
  completeMicrosoftDeviceAuthorization,
  getMicrosoftProfile,
  markMicrosoftMessagesRead,
  type MicrosoftAccessMode,
  storeMicrosoftRefreshToken,
} from "./microsoft";
import { attentionForUrgency, detectPromptInjection } from "./policy";
import { getWritingSettings, type WritingTone } from "./writing-settings";
import {
  getTelegramStatus,
  startTelegramPolling,
} from "./telegram";
import type {
  ContinuityCheckpoint,
  DashboardState,
  DraftPreparation,
  ReplyDraftPreparation,
  ReplyMode,
  EmailEnvelope,
  InboxItem,
  MaintenanceAction,
  MessageDetail,
  ModelId,
  TriageResult,
} from "./types";
import { resolveReplyRecipients } from "./reply-recipients";
import { clearUpdateStatusCache, getUpdateStatus } from "./updates";

const PROTECTED_MAINTENANCE_CATEGORIES = new Set([
  "financial",
  "finance",
  "account-security",
  "account-compromise",
  "fraud",
  "legal",
  "medical",
  "health",
  "receipt",
  "transaction",
  "transactional",
  "job",
  "career",
  "personal",
  "authentication",
  "account-verification",
]);

export async function getEmailDashboard(): Promise<DashboardState> {
  await restoreExpiredSnoozes();
  const [ollama, gog, gmailCapabilities, updates] = await Promise.all([
    isOllamaAvailable(),
    isGogInstalled(),
    getGmailAuthorizationCapabilities(),
    getUpdateStatus(),
  ]);
  const telegram = getTelegramStatus();
  const lastHeartbeat = await getServiceValue("worker_heartbeat");
  const heartbeatAge = lastHeartbeat ? Date.now() - new Date(lastHeartbeat).getTime() : Infinity;
  return getDashboardState(
    {
      worker: heartbeatAge < 180_000 ? "running" : "stopped",
      lastPollAt: await getServiceValue("last_poll_at"),
      lastPollError: await getServiceValue("last_poll_error"),
      ollama,
      telegramConfigured: telegram.configured,
      telegramRunning: telegram.running,
      gogInstalled: gog,
      gmailModifyAuthorized: gmailCapabilities.modify,
    },
    updates,
  );
}

export async function getMessageDetail(messageId: string): Promise<MessageDetail> {
  const result = await execute(
    `SELECT m.*, a.label AS account_label, a.provider AS account_provider, a.email AS account_email,
      COALESCE(t.user_corrected_attention, t.attention) AS attention,
      t.urgency, t.confidence, t.category, t.summary, t.reason,
      t.recommendation, t.needs_reply, t.deadline, t.injection_flags, t.model,
      (SELECT sent_at FROM notifications n WHERE n.message_id = m.id AND n.status = 'sent'
       ORDER BY n.created_at DESC LIMIT 1) AS notified_at
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     LEFT JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE m.id = ?`,
    [messageId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Email message was not found.");

  const message = inboxItemFromRow(row);
  const accountEmail = String(row.account_email);
  const accountProvider = String(row.account_provider || "gmail");
  const storedRevision = row.history_id ? String(row.history_id) : String(row.updated_at || "");
  const cached = await execute(
    `SELECT * FROM message_content_cache WHERE message_id = ? AND provider_revision = ?`,
    [messageId, storedRevision],
  );
  const cachedRow = cached.rows[0];
  let content = cachedRow ? messageContentFromCache(cachedRow) : messageContentFromPlainText(message.snippet);
  let contentSource: NonNullable<MessageDetail["content"]>["source"] = cachedRow ? "cache" : "excerpt";
  let fetchedAt = cachedRow?.fetched_at ? String(cachedRow.fetched_at) : null;
  let providerRevision = cachedRow ? storedRevision : null;
  let bodyText = content.plainText || message.snippet;
  let bodyIsExcerpt = !cachedRow;
  let attachments: EmailEnvelope["attachments"] = [];

  if (!cachedRow && process.env.NODE_ENV !== "test" && !accountEmail.endsWith(".test")) {
    try {
      const fullMessage = await providerAdapterFor(accountProvider as import("./types").AccountProvider)
        .readMessage(accountEmail, message.accountId, message.externalMessageId);
      if (fullMessage) {
        const fullText = fullMessage.bodyText || fullMessage.snippet || message.snippet;
        content = fullMessage.bodyHtml ? sanitizeMessageHtml(fullMessage.bodyHtml) : messageContentFromPlainText(fullText);
        bodyText = content.plainText || fullText;
        bodyIsExcerpt = !fullMessage.bodyText && !fullMessage.bodyHtml;
        contentSource = bodyIsExcerpt ? "excerpt" : "provider";
        providerRevision = fullMessage.providerRevision || storedRevision;
        fetchedAt = nowIso();
        attachments = fullMessage.attachments;
        if (!bodyIsExcerpt) await storeMessageContent(messageId, providerRevision, content, fetchedAt);
      }
    } catch {
      bodyText = message.snippet;
    }
  }
  if (attachments.length) await cacheMessageAttachments(message.id, attachments);

  return {
    message,
    bodyText: sanitizeDisplayText(bodyText),
    bodyIsExcerpt,
    content: {
      ...content,
      plainText: sanitizeDisplayText(content.plainText || bodyText),
      providerRevision,
      fetchedAt,
      source: contentSource,
    },
    attachments,
    contactMemory: await buildContactMemory(message.accountId, message.senderName, message.senderEmail),
  };
}

function messageContentFromCache(row: Record<string, unknown>) {
  return {
    plainText: String(row.plain_text || ""),
    sanitizedHtml: row.sanitized_html ? String(row.sanitized_html) : null,
    contentHash: String(row.content_hash || ""),
    remoteImageCount: Number(row.remote_image_count || 0),
    trackingPixelCount: Number(row.tracking_pixel_count || 0),
    truncated: Boolean(row.is_truncated),
  };
}

async function storeMessageContent(
  messageId: string,
  providerRevision: string,
  content: ReturnType<typeof sanitizeMessageHtml>,
  fetchedAt: string,
) {
  await execute(
    `INSERT INTO message_content_cache
      (message_id, provider_revision, plain_text, sanitized_html, content_hash,
       remote_image_count, tracking_pixel_count, is_truncated, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       provider_revision = excluded.provider_revision,
       plain_text = excluded.plain_text,
       sanitized_html = excluded.sanitized_html,
       content_hash = excluded.content_hash,
       remote_image_count = excluded.remote_image_count,
       tracking_pixel_count = excluded.tracking_pixel_count,
       is_truncated = excluded.is_truncated,
       fetched_at = excluded.fetched_at`,
    [
      messageId,
      providerRevision,
      content.plainText,
      content.sanitizedHtml,
      content.contentHash,
      content.remoteImageCount,
      content.trackingPixelCount,
      content.truncated ? 1 : 0,
      fetchedAt,
    ],
  );
}

export async function pollGmail() {
  await ensureEmailDatabase();
  const authorizedAccounts = await listAuthorizedGmailAccounts();
  const disabledAccounts = await execute(
    `SELECT email FROM email_accounts WHERE provider = 'gmail' AND status = 'disabled'`,
  );
  const disabledEmails = new Set(disabledAccounts.rows.map((row) => String(row.email).toLowerCase()));
  const accounts = authorizedAccounts.filter((email) => !disabledEmails.has(email.toLowerCase()));

  let ingested = 0;
  const errors: string[] = [];
  for (const email of accounts) {
    const accountId = await upsertAccount({ email, label: email, provider: "gmail", status: "connected" });
    try {
      const syncRangeDays = await accountSyncRangeDays(accountId);
      const organizationObservedAt = nowIso();
      const inbox = await providerAdapterFor("gmail").readInbox(email, accountId, { syncRangeDays });
      for (const message of inbox.messages) {
        if (await ingestMessage(message, inbox.attachmentAccountEmail || undefined, organizationObservedAt)) ingested += 1;
      }
      await execute(
        `UPDATE email_accounts SET last_sync_at = ?, status = 'connected', updated_at = ? WHERE id = ?`,
        [nowIso(), nowIso(), accountId],
      );
    } catch (error) {
      const issue = describeProviderError("gmail", error);
      await execute(
        `UPDATE email_accounts SET status = 'error', updated_at = ? WHERE id = ?`,
        [nowIso(), accountId],
      );
      await audit("gmail.poll.failed", "worker", "account", accountId, {
        error: issue.message,
        errorCode: issue.code,
        reconnectRecommended: issue.reconnectRecommended,
      });
      errors.push(`${email}: ${issue.message}`);
    }
  }

  const microsoft = await pollMicrosoftAccounts();
  ingested += microsoft.ingested;
  errors.push(...microsoft.errors);
  const totalAccounts = accounts.length + microsoft.accounts;
  if (!totalAccounts) {
    await setService("last_poll_error", "No authorized mail account was found.");
    return { accounts: 0, gmailAccounts: 0, microsoftAccounts: 0, ingested: 0 };
  }
  await setService("last_poll_at", nowIso());
  await setService("last_poll_error", errors.join("; "));
  return {
    accounts: totalAccounts,
    gmailAccounts: accounts.length,
    microsoftAccounts: microsoft.accounts,
    ingested,
    errors,
  };
}

export async function pollMailAccount(accountId: string) {
  await ensureEmailDatabase();
  const result = await execute(
    `SELECT a.id, a.provider, a.email, a.status, p.sync_range_days
     FROM email_accounts a LEFT JOIN account_profile_settings p ON p.account_id = a.id
     WHERE a.id = ? AND a.status <> 'disabled'`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Connected mail account was not found.");
  const provider = String(row.provider) as "gmail" | "microsoft";
  const email = String(row.email);
  let ingested = 0;
  try {
    const organizationObservedAt = nowIso();
    const inbox = await providerAdapterFor(provider).readInbox(email, accountId, {
      syncRangeDays: accountSyncRangeDaysFromValue(row.sync_range_days),
    });
    for (const message of inbox.messages) {
      if (await ingestMessage(message, inbox.attachmentAccountEmail || undefined, organizationObservedAt)) ingested += 1;
    }
    const completedAt = nowIso();
    await execute(
      `UPDATE email_accounts SET last_sync_at = ?, status = 'connected', updated_at = ? WHERE id = ?`,
      [completedAt, completedAt, accountId],
    );
    await audit(`${provider}.poll.succeeded`, "user", "account", accountId, { ingested, manual: true });
    return { accountId, provider, ingested, completedAt };
  } catch (error) {
    const issue = describeProviderError(provider, error);
    const message = issue.message;
    await execute(`UPDATE email_accounts SET status = 'error', updated_at = ? WHERE id = ?`, [nowIso(), accountId]);
    await setService("last_poll_error", `${email}: ${message}`);
    await audit(`${provider}.poll.failed`, "user", "account", accountId, {
      error: message,
      errorCode: issue.code,
      reconnectRecommended: issue.reconnectRecommended,
      manual: true,
    });
    throw new Error(message);
  }
}

async function pollMicrosoftAccounts() {
  const accounts = await execute(
    `SELECT a.id, a.email, p.sync_range_days FROM email_accounts a
     LEFT JOIN account_profile_settings p ON p.account_id = a.id
     WHERE a.provider = 'microsoft' AND a.status <> 'disabled'
     ORDER BY a.label`,
  );
  let ingested = 0;
  const errors: string[] = [];
  for (const row of accounts.rows) {
    const accountId = String(row.id);
    const email = String(row.email);
    try {
      const organizationObservedAt = nowIso();
      const inbox = await providerAdapterFor("microsoft").readInbox(email, accountId, {
        syncRangeDays: accountSyncRangeDaysFromValue(row.sync_range_days),
      });
      for (const message of inbox.messages) {
        if (await ingestMessage(message, inbox.attachmentAccountEmail || undefined, organizationObservedAt)) ingested += 1;
      }
      await execute(
        `UPDATE email_accounts SET last_sync_at = ?, status = 'connected', updated_at = ? WHERE id = ?`,
        [nowIso(), nowIso(), accountId],
      );
    } catch (error) {
      const issue = describeProviderError("microsoft", error);
      const message = issue.message;
      errors.push(`${email}: ${message}`);
      await execute(
        `UPDATE email_accounts SET status = 'error', updated_at = ? WHERE id = ?`,
        [nowIso(), accountId],
      );
      await audit("microsoft.poll.failed", "worker", "account", accountId, {
        error: message,
        errorCode: issue.code,
        reconnectRecommended: issue.reconnectRecommended,
      });
    }
  }
  return { accounts: accounts.rows.length, ingested, errors };
}

function accountSyncRangeDaysFromValue(value: unknown) {
  const days = Number(value);
  return [2, 7, 14, 30].includes(days) ? days : 2;
}

async function accountSyncRangeDays(accountId: string) {
  const result = await execute(`SELECT sync_range_days FROM account_profile_settings WHERE account_id = ?`, [accountId]);
  return accountSyncRangeDaysFromValue(result.rows[0]?.sync_range_days);
}

export async function syncAuthorizedGmailAccounts(source = "cockpit") {
  await ensureEmailDatabase();
  const accounts = await listAuthorizedGmailAccounts();
  const disabled = await execute(
    `SELECT email FROM email_accounts WHERE provider = 'gmail' AND status = 'disabled'`,
  );
  const disabledEmails = new Set(disabled.rows.map((row) => String(row.email).toLowerCase()));
  let synchronized = 0;
  for (const email of accounts) {
    if (disabledEmails.has(email.toLowerCase())) continue;
    await upsertAccount({ email, label: email, status: "connected" });
    synchronized += 1;
  }
  await audit("gmail.accounts.synced", source, "account", "all", {
    accounts: synchronized,
    disabledAccountsSkipped: accounts.length - synchronized,
  });
  return { accounts: synchronized };
}

export async function startGmailAccountConnection(input: {
  email: string;
  access: "readonly" | "maintenance" | "calendar";
}) {
  await ensureEmailDatabase();
  const result = await providerAdapterFor("gmail").startAuthorization(input);
  if (result.provider !== "gmail") throw new Error("Gmail authorization could not start.");
  await audit("gmail.auth.started", "cockpit", "account", input.email, {
    access: input.access,
    mode: result.mode,
    processId: result.mode === "browser" ? result.processId : null,
  });
  return {
    status: "started" as const,
    email: input.email,
    access: input.access,
    mode: result.mode,
    processId: result.mode === "browser" ? result.processId : null,
    authUrl: result.mode === "remote" ? result.authUrl : null,
    message: result.mode === "remote" ? result.message : null,
  };
}

export async function completeGmailAccountConnection(input: {
  email: string;
  access: "readonly" | "maintenance" | "calendar";
  authUrl: string;
}) {
  await ensureEmailDatabase();
  if (!(await isGogInstalled())) {
    throw new Error("The local Gmail bridge is not installed or GOG_PATH is not configured.");
  }
  const result = await completeGmailAuthorization(input);
  const account = await recordVerifiedProviderAccount({
    email: input.email,
    label: input.email,
    provider: "gmail",
    access: input.access,
    credentialBackend: "gog-keyring",
  });
  if (input.access === "calendar") {
    await markCalendarIntegrationConnected(account.accountId, "gmail");
  }
  await audit("gmail.auth.connected", "cockpit", "account", input.email, {
    access: input.access,
  });
  return result;
}

export async function startMicrosoftAccountConnection(input: {
  email: string;
  access: MicrosoftAccessMode;
}) {
  await ensureEmailDatabase();
  const challenge = await providerAdapterFor("microsoft").startAuthorization(input);
  if (challenge.provider !== "microsoft") throw new Error("Microsoft authorization could not start.");
  const connectionId = newId("msauth");
  const expiresAt = new Date(Date.now() + challenge.expiresIn * 1000).toISOString();
  await setService(
    `microsoft_auth:${connectionId}`,
    JSON.stringify({
      email: input.email,
      access: input.access,
      deviceCode: challenge.deviceCode,
      expiresAt,
      interval: challenge.interval,
    }),
  );
  await audit("microsoft.auth.started", "cockpit", "account", input.email, {
    access: input.access,
    connectionId,
  });
  return {
    connectionId,
    userCode: challenge.userCode,
    verificationUri: challenge.verificationUri,
    verificationUriComplete: challenge.verificationUriComplete,
    expiresAt,
    message: challenge.message,
    interval: challenge.interval,
  };
}

export async function completeMicrosoftAccountConnection(connectionId: string) {
  await ensureEmailDatabase();
  const value = await getServiceValue(`microsoft_auth:${connectionId}`);
  const state = parseMicrosoftAuthState(value);
  if (!state) throw new Error("Microsoft sign-in session was not found. Start again.");
  if (new Date(state.expiresAt).getTime() <= Date.now()) {
    throw new Error("Microsoft sign-in expired. Start again from Accounts.");
  }

  const token = await completeMicrosoftDeviceAuthorization(state.deviceCode);
  if (token.status === "pending") return token;

  const profile = await getMicrosoftProfile(token.accessToken);
  const verifiedEmail = profile.email.trim();
  const normalizedEmail = verifiedEmail.toLowerCase();
  const expectedEmail = state.email.trim().toLowerCase();
  const verifiedAddresses = [normalizedEmail, profile.userPrincipalName?.trim().toLowerCase()].filter(Boolean);
  if (!normalizedEmail || !verifiedAddresses.includes(expectedEmail)) {
    // Discard the consumed challenge without storing tokens or touching either account.
    await setService(`microsoft_auth:${connectionId}`, JSON.stringify({ status: "rejected" }));
    throw new Error(!normalizedEmail
      ? "Microsoft could not verify your mailbox address. Start again from account setup."
      : `You signed in with a different Microsoft account (${verifiedEmail}). Ezra expected ${state.email.trim()}. No Ezra account was changed. Start again and choose the intended account, or use a private browser window. If you use an email alias, enter the primary mailbox address or work sign-in name.`);
  }
  const existingIdentity = await execute(
    "SELECT email FROM email_accounts WHERE LOWER(email) = ? LIMIT 2", [normalizedEmail],
  );
  if (existingIdentity.rows.length > 1) {
    await setService(`microsoft_auth:${connectionId}`, JSON.stringify({ status: "rejected" }));
    throw new Error("More than one existing account matches this Microsoft mailbox. No Ezra account was changed. Review the existing accounts before reconnecting.");
  }
  const email = existingIdentity.rows[0] ? String(existingIdentity.rows[0].email) : verifiedEmail;
  await assertProviderAccountIdentity({ provider: "microsoft", email });
  const credential = await storeMicrosoftRefreshToken(email, token.refreshToken);
  await setService(`microsoft_access:${email.toLowerCase()}`, String(state.access));
  await setService(`microsoft_scopes:${email.toLowerCase()}`, JSON.stringify(token.scopes || []));
  const account = await recordVerifiedProviderAccount({
    email,
    label: profile.displayName ? `${profile.displayName} (${email})` : email,
    provider: "microsoft",
    access: state.access,
    credentialBackend: credential.backend,
  });
  if (state.access === "calendar" || state.access === "full") {
    await markCalendarIntegrationConnected(account.accountId, "microsoft");
  }
  await setService(
    `microsoft_auth:${connectionId}`,
    JSON.stringify({
      email,
      access: state.access,
      status: "connected",
      connectedAt: nowIso(),
    }),
  );
  await audit("microsoft.auth.connected", "cockpit", "account", email, {
    access: state.access,
    connectionId,
  });
  return { status: "connected" as const, email };
}

export async function startUnreadBacklogReview(source = "cockpit") {
  await ensureEmailDatabase();
  const accounts = await listAuthorizedGmailAccounts();
  if (!accounts.length) throw new Error("No authorized Gmail account was found.");
  const query = process.env.GMAIL_BACKLOG_QUERY || "in:inbox is:unread";
  const now = nowIso();
  for (const email of accounts) {
    const accountId = await upsertAccount({ email, label: email, status: "connected" });
    const existing = await execute(
      `SELECT status FROM mailbox_sweeps WHERE account_id = ?`,
      [accountId],
    );
    if (String(existing.rows[0]?.status || "") === "completed") {
      await execute(
        `UPDATE mailbox_sweeps SET status = 'running', query = ?, page_token = NULL,
          exhausted = 0, pages_scanned = 0, discovered_count = 0,
          rule_handled_count = 0, model_handled_count = 0, last_run_at = NULL,
          error = NULL, started_at = ?, completed_at = NULL, updated_at = ?
         WHERE account_id = ?`,
        [query, now, now, accountId],
      );
    } else {
      await execute(
        `INSERT INTO mailbox_sweeps
          (account_id, status, query, started_at, updated_at)
         VALUES (?, 'running', ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
          status = 'running', query = excluded.query, error = NULL,
          completed_at = NULL, updated_at = excluded.updated_at`,
        [accountId, query, now, now],
      );
    }
    await audit("mailbox.sweep.started", source, "account", accountId, { query });
  }
  await setService("backlog_wake_requested", "1");
  return { status: "running", accounts: accounts.length, query };
}

export async function pauseUnreadBacklogReview(source = "cockpit") {
  const result = await execute(
    `UPDATE mailbox_sweeps SET status = 'paused', updated_at = ? WHERE status = 'running'`,
    [nowIso()],
  );
  await audit("mailbox.sweep.paused", source, "mailbox", "all", {
    accounts: result.rowsAffected,
  });
  return { status: "paused", accounts: result.rowsAffected };
}

export async function processUnreadBacklogBatch() {
  await ensureEmailDatabase();
  const sweepResult = await execute(
    `SELECT s.*, a.email
     FROM mailbox_sweeps s
     JOIN email_accounts a ON a.id = s.account_id
     WHERE s.status = 'running'
     ORDER BY COALESCE(s.last_run_at, s.started_at), s.account_id
     LIMIT 1`,
  );
  const sweep = sweepResult.rows[0];
  if (!sweep) return { status: "idle", discovered: 0, ruleHandled: 0, modelHandled: 0 };

  const accountId = String(sweep.account_id);
  const accountEmail = String(sweep.email);
  const modelBudget = boundedConfig(process.env.GMAIL_BACKLOG_MODEL_BUDGET, 3, 0, 10);
  const batchSize = boundedConfig(process.env.GMAIL_BACKLOG_BATCH, 25, 5, 100);
  const reclassified = await prefilterQueuedBacklogMessages(accountId);
  const queuedBefore = await countBacklogQueue(accountId);

  try {
    if (queuedBefore > 0) {
      const modelHandled = await analyzeQueuedBacklogMessages(
        accountId,
        accountEmail,
        modelBudget,
      );
      await finishBacklogCycle(accountId, {
        modelHandled,
        ruleHandled: reclassified,
      });
      return {
        status: "running",
        discovered: 0,
        ruleHandled: reclassified,
        modelHandled,
        queued: await countBacklogQueue(accountId),
      };
    }

    if (Number(sweep.exhausted) === 1) {
      await completeBacklogSweep(accountId);
      return { status: "completed", discovered: 0, ruleHandled: 0, modelHandled: 0 };
    }

    const page = await searchGmailMessagePage(accountEmail, {
      query: String(sweep.query),
      maxResults: batchSize,
      pageToken: sweep.page_token ? String(sweep.page_token) : null,
    });
    let discovered = 0;
    let ruleHandled = 0;
    for (const message of page.messages) {
      message.accountId = accountId;
      const existing = await execute(
        `SELECT id FROM email_messages WHERE account_id = ? AND external_message_id = ?`,
        [accountId, message.externalMessageId],
      );
      if (existing.rows.length) continue;

      const preferences = await preferencesForMessage({
        accountId,
        senderEmail: message.senderEmail,
        subject: message.subject,
        snippet: message.snippet,
      });
      const learnedAction = preferences[0]?.action ? String(preferences[0].action) : null;
      const ruleResult = prefilterBacklogMessage(message, learnedAction);
      const messageId = await insertBacklogMetadata(
        message,
        ruleResult ? "triaged" : "backlog_queued",
      );
      discovered += 1;
      if (ruleResult) {
        await saveTriageDecision(messageId, "rules:v1", ruleResult);
        await applyApprovedMaintenanceRule(messageId, accountEmail, ruleResult);
        await audit("email.backlog.rule_handled", "worker", "message", messageId, {
          attention: ruleResult.attention,
          category: ruleResult.category,
        });
        ruleHandled += 1;
      }
    }

    await execute(
      `UPDATE mailbox_sweeps SET page_token = ?, exhausted = ?, pages_scanned = pages_scanned + 1,
        discovered_count = discovered_count + ?, rule_handled_count = rule_handled_count + ?,
        last_run_at = ?, updated_at = ?, error = NULL
       WHERE account_id = ?`,
      [
        page.nextPageToken,
        page.nextPageToken ? 0 : 1,
        discovered,
        ruleHandled,
        nowIso(),
        nowIso(),
        accountId,
      ],
    );

    const modelHandled = await analyzeQueuedBacklogMessages(
      accountId,
      accountEmail,
      modelBudget,
    );
    await finishBacklogCycle(accountId, { modelHandled });
    const queued = await countBacklogQueue(accountId);
    if (!page.nextPageToken && queued === 0) await completeBacklogSweep(accountId);

    await audit("mailbox.sweep.batch", "worker", "account", accountId, {
      discovered,
      ruleHandled,
      modelHandled,
      queued,
      hasNextPage: Boolean(page.nextPageToken),
    });
    return {
      status: !page.nextPageToken && queued === 0 ? "completed" : "running",
      discovered,
      ruleHandled,
      modelHandled,
      queued,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await execute(
      `UPDATE mailbox_sweeps SET status = 'error', error = ?, last_run_at = ?, updated_at = ?
       WHERE account_id = ?`,
      [message, nowIso(), nowIso(), accountId],
    );
    await audit("mailbox.sweep.failed", "worker", "account", accountId, { error: message });
    throw error;
  }
}

export async function reanalyzeAllMessages() {
  const rows = await execute(
    `SELECT m.id, m.account_id, m.external_message_id, m.sender_name, m.sender_email, m.subject,
      m.received_at, m.snippet, ea.email AS account_email
     FROM email_messages m
     JOIN email_accounts ea ON ea.id = m.account_id
     ORDER BY m.received_at DESC`,
  );
  let analyzed = 0;
  for (const row of rows.rows) {
    const messageId = String(row.id);
    const accountEmail = String(row.account_email);
    const fullText = accountEmail.endsWith(".test")
      ? String(row.snippet)
      : JSON.stringify(
          await getGmailMessage(accountEmail, String(row.external_message_id)).catch(() => null),
        ).slice(0, 80_000);
    const preferences = await preferencesForMessage({
      accountId: String(row.account_id),
      senderEmail: String(row.sender_email),
      subject: String(row.subject),
      snippet: String(row.snippet),
    });
    const next = await triageWithActiveModel(
      {
        senderName: String(row.sender_name),
        senderEmail: String(row.sender_email),
        subject: String(row.subject),
        receivedAt: String(row.received_at),
        snippet: String(row.snippet),
        bodyText: fullText,
        learnedPreferences: preferences.map(
          (item) => learnedPreferenceDescription(item),
        ),
      },
      messageId,
    );
    const finalPreferences = await preferencesForMessage({
      accountId: String(row.account_id),
      senderEmail: String(row.sender_email),
      subject: String(row.subject),
      snippet: String(row.snippet),
      category: next.result.category,
    });
    const result = applyLearnedPreferences(next.result, finalPreferences);
    await saveTriageDecision(messageId, next.model, result);
    await notifyMessage(messageId);
    analyzed += 1;
  }
  return { analyzed };
}

export async function ingestMessage(message: EmailEnvelope, accountEmail?: string, organizationObservedAtInput?: string) {
  const organization = providerOrganizationState(message);
  const organizationObservedAt = validIsoTimestamp(organizationObservedAtInput) || nowIso();
  const existing = await execute(
    `SELECT id FROM email_messages WHERE account_id = ? AND external_message_id = ?`,
    [message.accountId, message.externalMessageId],
  );
  if (existing.rows.length) {
    await execute(
      `UPDATE email_messages
       SET is_unread = ?,
         gmail_labels = ?,
         is_pinned = CASE
           WHEN COALESCE(organization_confirmed_at, '') >= ? THEN is_pinned
           ELSE ?
         END,
         is_flagged = CASE
           WHEN COALESCE(organization_confirmed_at, '') >= ? THEN is_flagged
           ELSE ?
         END,
         organization_confirmed_at = CASE
           WHEN COALESCE(organization_confirmed_at, '') >= ? THEN organization_confirmed_at
           ELSE ?
         END,
         status = CASE
           WHEN ? = 0 AND status IN ('new', 'triaged', 'backlog_queued') THEN 'read'
           ELSE status
         END,
         updated_at = ?
       WHERE id = ?`,
      [
        message.isUnread ? 1 : 0,
        JSON.stringify(message.labels || []),
        organizationObservedAt,
        organization.isPinned ? 1 : 0,
        organizationObservedAt,
        organization.isFlagged ? 1 : 0,
        organizationObservedAt,
        organizationObservedAt,
        message.isUnread ? 1 : 0,
        nowIso(),
        existing.rows[0].id,
      ],
    );
    return false;
  }

  if (accountEmail && !message.bodyText) {
    const sanitized = await getGmailMessage(accountEmail, message.externalMessageId).catch(
      () => null,
    );
    if (sanitized) message.bodyText = JSON.stringify(sanitized).slice(0, 80_000);
  }

  const messageId = newId("mail");
  const now = nowIso();
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, history_id, sender_name, sender_email,
       subject, received_at, snippet, gmail_url, has_attachments, gmail_labels, is_unread, is_pinned, is_flagged,
       organization_confirmed_at, ingest_source,
       status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', 'new', ?, ?)`,
    [
      messageId,
      message.accountId,
      message.externalMessageId,
      message.threadId,
      message.historyId || null,
      message.senderName,
      message.senderEmail,
      message.subject,
      message.receivedAt,
      message.snippet,
      message.gmailUrl,
      message.attachments.length ? 1 : 0,
      JSON.stringify(message.labels || []),
      message.isUnread ? 1 : 0,
      organization.isPinned ? 1 : 0,
      organization.isFlagged ? 1 : 0,
      organizationObservedAt,
      now,
      now,
    ],
  );

  const attachmentText = await extractSafeAttachments(message, accountEmail).catch(() => "");
  const preferences = await preferencesForMessage({
    accountId: message.accountId,
    senderEmail: message.senderEmail,
    subject: message.subject,
    snippet: message.snippet,
  });
  const analyzed = await triageWithActiveModel(
    {
      senderName: message.senderName,
      senderEmail: message.senderEmail,
      subject: message.subject,
      receivedAt: message.receivedAt,
      snippet: message.snippet,
      bodyText: message.bodyText,
      attachmentText,
      learnedPreferences: preferences.map(
        (item) => learnedPreferenceDescription(item),
      ),
    },
    messageId,
  );
  const finalPreferences = await preferencesForMessage({
    accountId: message.accountId,
    senderEmail: message.senderEmail,
    subject: message.subject,
    snippet: message.snippet,
    category: analyzed.result.category,
  });
  const result = applyLearnedPreferences(analyzed.result, finalPreferences);
  await saveTriageDecision(messageId, analyzed.model, result);
  await execute(`UPDATE email_messages SET status = 'triaged', updated_at = ? WHERE id = ?`, [
    nowIso(),
    messageId,
  ]);

  if (result.draftReply) await saveNewDraft(messageId, result.draftReply, "model");
  await notifyMessage(messageId);
  await applyApprovedMaintenanceRule(messageId, accountEmail, result);
  await audit("email.ingested", "worker", "message", messageId, {
    attention: result.attention,
    model: analyzed.model,
  });
  return true;
}

export function prefilterBacklogMessage(
  message: Pick<
    EmailEnvelope,
    "senderName" | "senderEmail" | "subject" | "snippet" | "receivedAt"
  >,
  learnedAction: string | null = null,
): TriageResult | null {
  const text = [
    message.senderName,
    message.senderEmail,
    message.subject,
    message.snippet,
  ]
    .join("\n")
    .toLowerCase();
  if (learnedAction === "interrupt" || learnedAction === "digest") return null;
  if (
    /(security|password|sign[- ]?in|unauthorized|verify|fraud|legal|subpoena|past due|payment|invoice|receipt|appointment|interview|deadline|action required|respond by|please confirm|rsvp)/i.test(
      text,
    ) ||
    detectPromptInjection(text).length
  ) {
    return null;
  }

  const automatedSender =
    /(no[-_.]?reply|do[-_.]?not[-_.]?reply|newsletter|marketing|promotion|recommendation|offers?|deals?)/i.test(
      message.senderEmail,
    );
  const bulkInfrastructure =
    /(ccsend\.com|@eml\.|@mg\.|@email\.|@messages\.|@offers\.)/i.test(
      message.senderEmail,
    );
  const protectedContext =
    /(schwab|bank|credit|equifax|experian|trade confirmation|investment|brokerage)/i.test(
      text,
    );
  if (protectedContext) return null;
  const lowSignalMatches = [
    /newsletter/i,
    /weekly (ad|digest|roundup)/i,
    /sale|coupon|discount|save \d+%|offer expires/i,
    /wishlist|recommend(ed|ations?)|because you/i,
    /new arrivals|shop now|Father'?s Day|clearance/i,
    /now supports|is now (on|available)|product update/i,
    /visited your profile/i,
    /\$\d+|per month|\/mo\b|no payments/i,
    /unsubscribe/i,
  ].filter((pattern) => pattern.test(text)).length;
  const strongPromotion =
    /(huge savings|biggest sale|deal of the week|buy \d+, get \d+|only \$|charge more|towards your trade|full .* kit|visited your profile)/i.test(
      text,
    );
  if (
    learnedAction !== "suppress" &&
    !(
      strongPromotion ||
      lowSignalMatches >= 2 ||
      (automatedSender || bulkInfrastructure) && lowSignalMatches
    )
  ) {
    return null;
  }

  const reason =
    learnedAction === "suppress"
      ? "A reviewable sender preference already marks this mail as low priority."
      : "Transparent bulk-mail rules matched an automated sender and promotional or subscription language.";
  return {
    attention: "suppress",
    urgency: learnedAction === "suppress" ? 8 : 12,
    confidence: learnedAction === "suppress" ? 0.99 : 0.94,
    category: learnedAction === "suppress" ? "learned-low-priority" : "bulk-mail",
    summary: (message.snippet || message.subject).slice(0, 500),
    reason,
    recommendation:
      "Keep out of alerts and include this sender in the future cleanup review before any mark-read or unsubscribe rule is enabled.",
    needsReply: false,
    deadline: null,
    draftReply: null,
    injectionFlags: [],
    criticalReason: null,
  };
}

export async function applyMaintenanceAction(input: {
  accountId: string;
  senderEmail: string;
  action: MaintenanceAction;
  remember: boolean;
  source?: string;
}) {
  const source = input.source || "cockpit";
  const account = await execute(
    `SELECT email, provider FROM email_accounts WHERE id = ? AND status = 'connected'`,
    [input.accountId],
  );
  if (!account.rows[0]) throw new Error("Connected mail account was not found.");
  const accountEmail = String(account.rows[0].email);
  const accountProvider = String(account.rows[0].provider || "gmail") as import("./types").AccountProvider;
  if (accountProvider === "gmail" && !accountEmail.endsWith(".test")) {
    const capabilities = await getGmailAuthorizationCapabilities();
    if (!capabilities.modify) {
      throw new Error(
        "Gmail maintenance permission is not authorized yet. Reconnect Gmail with modify access.",
      );
    }
  }
  if (accountProvider === "microsoft" && input.action === "unsubscribe") {
    throw new Error("Hotmail/Outlook unsubscribe is not implemented yet.");
  }
  const messages = await execute(
    `SELECT m.id, m.external_message_id, m.status, m.is_unread, m.gmail_labels
     FROM email_messages m
     JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE m.account_id = ? AND lower(m.sender_email) = lower(?) AND m.is_unread = 1
       AND COALESCE(t.user_corrected_attention, t.attention) = 'suppress'
       AND m.status NOT IN ('snoozed', 'maintained', 'spammed', 'read', 'cleared', 'digested')
       AND m.gmail_labels NOT LIKE '%"SPAM"%'
       AND m.gmail_labels NOT LIKE '%"TRASH"%'
       AND m.gmail_labels NOT LIKE '%"SENT"%'
       AND lower(COALESCE(t.category, '')) NOT IN (
         'financial', 'finance', 'account-security', 'account-compromise', 'fraud', 'legal',
         'medical', 'health', 'receipt', 'transaction', 'transactional', 'job', 'career',
         'personal', 'authentication', 'account-verification'
       )
     ORDER BY received_at DESC LIMIT 500`,
    [input.accountId, input.senderEmail],
  );
  if (!messages.rows.length) {
    throw new Error("No approved low-priority unread messages remain for this sender.");
  }
  const externalIds = messages.rows.map((row) => String(row.external_message_id));
  const localIds = messages.rows.map((row) => String(row.id));
  const undoData = messages.rows.map((row) => ({
    id: String(row.id),
    externalMessageId: String(row.external_message_id),
    threadId: String(row.thread_id),
    status: String(row.status),
    isUnread: Number(row.is_unread) === 1,
    labels: parseStringArray(row.gmail_labels),
  }));
  const actionId = newId("maint");
  const now = nowIso();
  await execute(
    `INSERT INTO maintenance_actions
      (id, account_id, sender_email, action, status, message_count, details, created_at)
     VALUES (?, ?, ?, ?, 'executing', ?, '{}', ?)`,
    [
      actionId,
      input.accountId,
      input.senderEmail.toLowerCase(),
      input.action,
      externalIds.length,
      now,
    ],
  );
  try {
    let details: Record<string, unknown> = {};
    if (accountEmail.endsWith(".test")) {
      details = { modified: externalIds.length, test: true };
    } else if (input.action === "unsubscribe") {
      const metadata = await getGmailUnsubscribeMetadata(accountEmail, externalIds[0]);
      if (!metadata.oneClickUrl) {
        throw new Error(
          "This sender does not provide a standards-based one-click unsubscribe endpoint.",
        );
      }
      await postOneClickUnsubscribe(metadata.oneClickUrl);
      await markGmailMessagesRead(accountEmail, externalIds);
      details = { unsubscribed: true, host: new URL(metadata.oneClickUrl).hostname };
    } else {
      details = await providerAdapterFor(accountProvider).applyMaintenance(
        accountEmail,
        input.action,
        externalIds,
      );
    }

    await markLocalMessagesMaintained(localIds, input.action);
    if (input.remember && input.action !== "unsubscribe") {
      await saveMaintenanceRule(
        input.accountId,
        input.senderEmail,
        input.action,
      );
    }
    if (input.remember && input.action === "unsubscribe") {
      await saveMaintenanceRule(
        input.accountId,
        input.senderEmail,
        "mark_read",
      );
    }
    await execute(
      `UPDATE maintenance_actions SET status = 'executed', details = ?, undo_data = ?,
        undo_status = ?, provider_metadata = ?, executed_at = ?
       WHERE id = ?`,
      [
        JSON.stringify(details),
        input.action === "unsubscribe" ? null : JSON.stringify(undoData),
        input.action === "unsubscribe" ? null : "available",
        JSON.stringify(details),
        nowIso(),
        actionId,
      ],
    );
    await audit(`${accountProvider}.maintenance.executed`, source, "sender", input.senderEmail, {
      action: input.action,
      messageCount: externalIds.length,
      remember: input.remember,
    });
    return { actionId, action: input.action, messageCount: externalIds.length, details };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await execute(
      `UPDATE maintenance_actions SET status = 'failed', error = ? WHERE id = ?`,
      [message, actionId],
    );
    await audit(`${accountProvider}.maintenance.failed`, source, "sender", input.senderEmail, {
      action: input.action,
      error: message,
    });
    throw error;
  }
}

export async function undoMaintenanceAction(actionId: string, source = "cockpit") {
  const result = await execute(
    `SELECT ma.*, a.email AS account_email, a.provider AS account_provider
     FROM maintenance_actions ma
     JOIN email_accounts a ON a.id = ma.account_id
     WHERE ma.id = ?`,
    [actionId],
  );
  const row = result.rows[0];
  if (!row || String(row.status) !== "executed" || String(row.undo_status) !== "available") {
    throw new Error("This cleanup action is not available to undo.");
  }
  const action = String(row.action) as MaintenanceAction;
  if (action === "unsubscribe") throw new Error("Unsubscribe cannot be undone.");
  const snapshots = parseJsonRecords(row.undo_data);
  const externalIds = snapshots.map((item) => String(item.externalMessageId));
  const accountEmail = String(row.account_email);
  const accountProvider = String(row.account_provider || "gmail") as import("./types").AccountProvider;
  if (!accountEmail.endsWith(".test")) {
    await providerAdapterFor(accountProvider).undoMaintenance(accountEmail, action, externalIds);
  }
  for (const snapshot of snapshots) {
    await execute(
      `UPDATE email_messages SET status = ?, is_unread = ?, gmail_labels = ?, updated_at = ?
       WHERE id = ?`,
      [
        String(snapshot.status || "triaged"),
        snapshot.isUnread ? 1 : 0,
        JSON.stringify(Array.isArray(snapshot.labels) ? snapshot.labels : []),
        nowIso(),
        String(snapshot.id),
      ],
    );
  }
  await execute(
    `UPDATE maintenance_actions SET undo_status = 'undone' WHERE id = ?`,
    [actionId],
  );
  await execute(
    `DELETE FROM maintenance_rules
     WHERE account_id = ? AND lower(sender_email) = lower(?) AND action = ?`,
    [row.account_id, row.sender_email, action],
  );
  await audit(`${accountProvider}.maintenance.undone`, source, "maintenance_action", actionId, {
    action,
    messageCount: snapshots.length,
  });
  return { actionId, action, messageCount: snapshots.length };
}

export async function applyMaintenanceBatch(input: {
  targets: Array<{ accountId: string; senderEmail: string }>;
  action: MaintenanceAction;
  remember: boolean;
  source?: string;
}) {
  const results: Array<{
    accountId: string;
    senderEmail: string;
    ok: boolean;
    messageCount: number;
    error: string | null;
  }> = [];
  for (const target of input.targets) {
    try {
      const result = await applyMaintenanceAction({
        accountId: target.accountId,
        senderEmail: target.senderEmail,
        action: input.action,
        remember: input.remember,
        source: input.source || "cockpit",
      });
      results.push({
        accountId: target.accountId,
        senderEmail: target.senderEmail,
        ok: true,
        messageCount: result.messageCount,
        error: null,
      });
    } catch (error) {
      results.push({
        accountId: target.accountId,
        senderEmail: target.senderEmail,
        ok: false,
        messageCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const successCount = results.filter((result) => result.ok).length;
  const failureCount = results.length - successCount;
  if (!successCount && results[0]?.error) throw new Error(results[0].error);
  await audit("gmail.maintenance.batch", input.source || "cockpit", "sender", "multiple", {
    action: input.action,
    targets: input.targets.length,
    successCount,
    failureCount,
  });
  return {
    action: input.action,
    targetCount: input.targets.length,
    successCount,
    failureCount,
    messageCount: results.reduce((sum, result) => sum + result.messageCount, 0),
    results,
  };
}

export async function notifyMessage(messageId: string) {
  return decideMessageNotification(messageId);
}

export async function sendScheduledDigest(
  _label: string,
  _scheduledFor?: string | null,
  _mode: BriefDeliveryMode = "manual",
) {
  return createManualNotificationBrief();
}

export async function addMessageContext(messageId: string, content: string, source = "cockpit") {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Context cannot be empty.");
  await execute(
    `INSERT INTO context_notes (id, message_id, content, source, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [newId("context"), messageId, trimmed, source, nowIso()],
  );
  await recordEvent(messageId, null, "context_added", trimmed, source);
  await audit("email.context.added", source, "message", messageId);
}

export async function createReplyDraft(messageId: string, context = "", source = "cockpit") {
  const prepared = await prepareReplyDraft(messageId, context);
  return saveReplyDraft(messageId, prepared.content, context, source);
}

export async function prepareReplyDraft(
  messageId: string,
  context = "",
  previousDraft = "",
  replyMode: ReplyMode = "sender",
): Promise<DraftPreparation | ReplyDraftPreparation> {
  const message = await getMessageForDraft(messageId);
  if (!message) throw new Error("Email message was not found.");
  const metadata = process.env.NODE_ENV === "test" || message.accountEmail.endsWith(".test")
    ? {
        from: { name: message.senderName, email: message.senderEmail },
        replyTo: [],
        to: [],
        cc: [],
        subject: message.subject,
      }
    : await providerAdapterFor(message.accountProvider === "microsoft" ? "microsoft" : "gmail")
      .getReplyMetadata(message.accountEmail, message.externalMessageId);
  const recipients = resolveReplyRecipients(metadata, message.accountEmail, replyMode);
  await setService(
    "interactive_model_until",
    new Date(Date.now() + 2 * 60_000).toISOString(),
  );
  try {
    const notes = await contextForMessage(messageId);
    const full = await fetchFullMessageText(message).catch(() => message.snippet);
    const memory = await buildContactMemory(message.accountId, message.senderName, message.senderEmail);
    const currentDirection = context.trim();
    const appliedContext = [
      ...notes,
      ...(currentDirection ? [currentDirection] : []),
    ];
    const trustedContext = appliedContext.join("\n\n");
    const priorDraft = previousDraft.trim();
    let content =
      !message.needsReply && !trustedContext && !priorDraft
        ? safeNeutralReply(message.senderName, message.subject)
        : await draftWithActiveModel({
            senderName: message.senderName,
            subject: message.subject,
            messageText: full,
            messageAssessment: [
              `Needs reply: ${message.needsReply ? "yes" : "no"}`,
              message.triageSummary ? `Summary: ${message.triageSummary}` : "",
              message.triageRecommendation
                ? `Recommendation: ${message.triageRecommendation}`
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
            context: trustedContext,
            contactMemory: [
              memory.summary,
              ...memory.categories.map((category) => `${category.label}: ${category.summary}`),
            ].join("\n"),
            previousDraft: priorDraft || undefined,
          }, messageId);
    if (!trustedContext && hasUnsupportedUserClaim(content)) {
      content = safeNeutralReply(message.senderName, message.subject);
    }
    return {
      messageId,
      content,
      contactMemorySummary: memory.summary,
      appliedContext,
      replyMode,
      accountId: message.accountId,
      accountLabel: message.accountLabel,
      accountEmail: message.accountEmail,
      accountProvider: message.accountProvider === "microsoft" ? "microsoft" : "gmail",
      ...recipients,
    };
  } finally {
    await setService("interactive_model_until", nowIso());
  }
}

export async function polishReplyDraft(input: {
  messageId: string;
  body: string;
  mode: WritingTone;
  direction?: string;
}): Promise<PolishReplyResult> {
  const message = await getMessageForDraft(input.messageId);
  if (!message) throw new Error("Email message was not found.");
  const settings = await getWritingSettings(message.accountId);
  const [messageText, memory] = await Promise.all([
    fetchFullMessageText(message).catch(() => message.snippet),
    buildContactMemory(message.accountId, message.senderName, message.senderEmail),
  ]);
  await setService("interactive_model_until", new Date(Date.now() + 2 * 60_000).toISOString());
  try {
    return await polishReply(
      { ...input, threadId: message.threadId },
      async (request) => draftWithActiveModel({
        senderName: message.senderName,
        subject: message.subject,
        messageText: messageText.slice(0, 24_000),
        messageAssessment: [
          "This is a style-only polish request for an owner-written reply.",
          request.instruction,
          `Preferred reply length: ${settings.preferredLength}.`,
          "Preserve every name, recipient, date, amount, URL, fact, and commitment exactly.",
          "Return only the proposed reply body.",
        ].join("\n"),
        context: [
          request.direction,
          `Approved contact memory: ${memory.summary}`,
          settings.signatureEnabled && settings.signature
            ? `The account signature is handled separately and must not be added: ${settings.signature}`
            : "Do not add a signature.",
        ].filter(Boolean).join("\n"),
        contactMemory: memory.categories.map((category) => `${category.label}: ${category.summary}`).join("\n"),
        previousDraft: request.original,
      }, input.messageId),
    );
  } finally {
    await setService("interactive_model_until", nowIso());
  }
}

export async function isInteractiveModelBusy() {
  const until = await getServiceValue("interactive_model_until");
  return Boolean(until && new Date(until).getTime() > Date.now());
}

function safeNeutralReply(senderName: string, subject: string) {
  const greeting = senderName ? `Hello ${senderName},` : "Hello,";
  return `${greeting}\n\nI received your message regarding "${subject}". Could you please confirm whether any response or additional information is needed from me?\n\nThank you.`;
}

function hasUnsupportedUserClaim(content: string) {
  return /\bI\s+(?:am|was|did|didn't|have|haven't|will|won't|can|can't|cannot|recently|already|plan|intend|agree|accept|decline|confirm(?:ed)?|completed?|changed?|enabled?|logged|sent|attached|scheduled)\b/i.test(
    content,
  );
}

export async function saveReplyDraft(
  messageId: string,
  content: string,
  context = "",
  source = "cockpit",
) {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Draft cannot be empty.");
  if (context.trim()) await addMessageContext(messageId, context, source);
  const draft = await saveNewDraft(messageId, trimmed, source);
  await audit("email.draft.saved", source, "draft", draft.id, { messageId });
  return draft;
}

export async function updateReplyDraft(draftId: string, content: string, source = "cockpit") {
  const current = await execute(`SELECT * FROM reply_drafts WHERE id = ?`, [draftId]);
  if (!current.rows[0]) throw new Error("Draft was not found.");
  const row = current.rows[0];
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Draft cannot be empty.");
  await execute(
    `UPDATE send_approvals SET status = 'invalidated'
     WHERE draft_id = ? AND status IN ('pending', 'approved')`,
    [draftId],
  );
  await execute(`UPDATE reply_drafts SET status = 'cancelled', updated_at = ? WHERE id = ?`, [
    nowIso(),
    draftId,
  ]);
  const next = await saveNewDraft(String(row.message_id), trimmed, source);
  await recordEvent(String(row.message_id), next.id, "draft_edited", trimmed, source);
  return next;
}

export async function requestSendApproval(draftId: string, source = "cockpit") {
  const draft = await getDraftRow(draftId);
  if (!draft) throw new Error("Draft was not found.");
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const approvalId = newId("approval");
  await execute(
    `UPDATE send_approvals SET status = 'invalidated'
     WHERE draft_id = ? AND status = 'pending'`,
    [draftId],
  );
  await execute(
    `INSERT INTO send_approvals
      (id, draft_id, draft_hash, status, expires_at, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
    [approvalId, draftId, String(draft.content_hash), expiresAt, nowIso()],
  );
  await execute(
    `UPDATE reply_drafts SET status = 'awaiting_approval', updated_at = ? WHERE id = ?`,
    [nowIso(), draftId],
  );
  await audit("email.send.requested", source, "draft", draftId, { expiresAt });
  return { approvalId, draftId, expiresAt };
}

export async function approveAndSendDraft(draftId: string, source = "cockpit") {
  const result = await execute(
    `SELECT d.*, a.id AS approval_id, a.draft_hash, a.expires_at, a.status AS approval_status,
      m.external_message_id, m.sender_email, m.subject, ea.email AS account_email,
      ea.provider AS account_provider
     FROM reply_drafts d
     JOIN email_messages m ON m.id = d.message_id
     JOIN email_accounts ea ON ea.id = m.account_id
     JOIN send_approvals a ON a.id = (
       SELECT id FROM send_approvals sa WHERE sa.draft_id = d.id ORDER BY sa.created_at DESC LIMIT 1
     )
     WHERE d.id = ?`,
    [draftId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Draft or approval was not found.");
  if (String(row.approval_status) !== "pending") throw new Error("Approval is not pending.");
  if (new Date(String(row.expires_at)).getTime() < Date.now()) {
    await execute(`UPDATE send_approvals SET status = 'expired' WHERE id = ?`, [row.approval_id]);
    throw new Error("Approval expired. Review the draft again.");
  }
  const currentHash = hashDraft(String(row.content));
  if (currentHash !== String(row.draft_hash) || currentHash !== String(row.content_hash)) {
    await execute(`UPDATE send_approvals SET status = 'invalidated' WHERE id = ?`, [
      row.approval_id,
    ]);
    throw new Error("Draft changed after approval was requested.");
  }
  if (String(row.account_provider || "gmail") !== "gmail") {
    throw new Error("Hotmail/Outlook send is disabled until Outlook sending support is explicit.");
  }

  await execute(
    `UPDATE send_approvals SET status = 'approved', approved_at = ? WHERE id = ?`,
    [nowIso(), row.approval_id],
  );
  try {
    const accountEmail = String(row.account_email);
    const subject = String(row.subject);
    const sendResult = await providerAdapterFor("gmail").sendOutgoing(accountEmail, {
      from: accountEmail,
      to: [{ email: String(row.sender_email), name: null }],
      cc: [],
      bcc: [],
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      body: String(row.content),
      attachments: [],
      replyToMessageId: String(row.external_message_id),
    });
    await execute(`UPDATE send_approvals SET status = 'executed' WHERE id = ?`, [row.approval_id]);
    await execute(`UPDATE reply_drafts SET status = 'sent', updated_at = ? WHERE id = ?`, [
      nowIso(),
      draftId,
    ]);
    await recordEvent(String(row.message_id), draftId, "draft_sent", String(row.content), source);
    await audit("email.sent", source, "draft", draftId);
    return sendResult;
  } catch (error) {
    await execute(`UPDATE send_approvals SET status = 'failed' WHERE id = ?`, [row.approval_id]);
    await audit("email.send.failed", source, "draft", draftId, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function cancelDraft(draftId: string, source = "cockpit") {
  const draft = await getDraftRow(draftId);
  if (!draft) throw new Error("Draft was not found.");
  await execute(`UPDATE reply_drafts SET status = 'cancelled', updated_at = ? WHERE id = ?`, [
    nowIso(),
    draftId,
  ]);
  await execute(
    `UPDATE send_approvals SET status = 'cancelled' WHERE draft_id = ? AND status = 'pending'`,
    [draftId],
  );
  await recordEvent(String(draft.message_id), draftId, "draft_cancelled", "", source);
}

export async function recordFeedback(
  messageId: string,
  action: string,
  source = "cockpit",
) {
  const message = await execute(
    `SELECT account_id, sender_email FROM email_messages WHERE id = ?`,
    [messageId],
  );
  if (!message.rows[0]) throw new Error("Email message was not found.");
  const accountId = String(message.rows[0].account_id);
  const sender = String(message.rows[0].sender_email).toLowerCase();
  if (!["interrupt", "digest", "suppress"].includes(action)) {
    throw new Error("Unsupported feedback action.");
  }
  const now = nowIso();
  await execute(
    `UPDATE learned_preferences SET enabled = 0, updated_at = ?
     WHERE kind = 'sender'
       AND account_id = ?
       AND lower(pattern) = lower(?)
       AND action <> ?`,
    [now, accountId, sender, action],
  );
  await execute(
    `INSERT INTO learned_preferences
      (id, account_id, kind, pattern, action, weight, evidence_count, enabled, created_at, updated_at)
     VALUES (?, ?, 'sender', ?, ?, 1, 1, 1, ?, ?)
     ON CONFLICT(kind, account_id, pattern, action) DO UPDATE SET
       weight = MIN(5, learned_preferences.weight + 0.5),
       evidence_count = learned_preferences.evidence_count + 1,
       enabled = 1,
       updated_at = excluded.updated_at`,
    [newId("pref"), accountId, sender, action, now, now],
  );
  await execute(
    `UPDATE triage_decisions SET user_corrected_attention = ?
     WHERE id = (SELECT id FROM triage_decisions WHERE message_id = ? ORDER BY created_at DESC LIMIT 1)`,
    [action, messageId],
  );
  await recordEvent(messageId, null, "attention_corrected", action, source);
}

export async function forgetPreference(preferenceId: string, source = "cockpit") {
  await execute(`UPDATE learned_preferences SET enabled = 0, updated_at = ? WHERE id = ?`, [
    nowIso(),
    preferenceId,
  ]);
  await audit("preference.forgotten", source, "preference", preferenceId);
}

export async function switchModel(model: ModelId, source = "cockpit") {
  if (!modelDefinitions.some((definition) => definition.id === model)) {
    throw new Error("Unsupported model.");
  }
  const updates = await getUpdateStatus(true);
  if (!updates.models.find((candidate) => candidate.id === model)?.installed) {
    throw new Error("That model is not installed yet.");
  }
  await setSetting("active_model", model);
  await audit("model.switched", source, "model", model);
  return model;
}

export async function refreshUpdates() {
  clearUpdateStatusCache();
  return getUpdateStatus(true);
}

export async function startModelBenchmark() {
  const status = await getServiceValue("benchmark_status");
  if (status === "running") return { status: "running" as const };
  await setService("benchmark_status", "running");
  await setService("benchmark_started_at", nowIso());
  await setService("benchmark_progress", "Starting benchmark");
  await setService("benchmark_error", "");
  const logPath = path.join(process.cwd(), "data", "model-benchmark.log");
  const command = `npm.cmd run benchmark:models >> "${logPath}" 2>&1`;
  const child = spawn("cmd.exe", ["/d", "/s", "/c", command], {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  await audit("model.benchmark_started", "cockpit", "benchmark", "all");
  return { status: "running" as const };
}

export async function startModelUpdate(model: ModelId) {
  const definition = modelDefinitions.find((candidate) => candidate.id === model);
  if (!definition) throw new Error("Unsupported model.");
  const current = await getServiceValue(`model_update:${model}`);
  if (current?.startsWith("running|")) return { status: "running" as const };
  await setService(`model_update:${model}`, `running|Pulling ${definition.baseModel}`);
  clearUpdateStatusCache();
  const logPath = path.join(
    process.cwd(),
    "data",
    `model-update-${model.replace(/[^a-z0-9]+/gi, "-")}.log`,
  );
  const command = `npm.cmd run model:update -- "${model}" >> "${logPath}" 2>&1`;
  const child = spawn("cmd.exe", ["/d", "/s", "/c", command], {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  await audit("model.update_started", "cockpit", "model", model);
  return { status: "running" as const };
}

export async function snoozeMessage(messageId: string, minutes: number, source = "cockpit") {
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  await setService(`snooze:${messageId}`, until);
  await execute(`UPDATE email_messages SET status = 'snoozed', updated_at = ? WHERE id = ?`, [
    nowIso(),
    messageId,
  ]);
  await audit("email.snoozed", source, "message", messageId, { until });
  return { messageId, until };
}

export async function markMessageRead(messageId: string, source = "cockpit") {
  const result = await execute(
    `SELECT m.external_message_id, m.gmail_labels, ea.email AS account_email, ea.provider AS account_provider
     FROM email_messages m
     JOIN email_accounts ea ON ea.id = m.account_id
     WHERE m.id = ?`,
    [messageId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Email message was not found.");
  const accountEmail = String(row.account_email);
  const accountProvider = String(row.account_provider || "gmail") as import("./types").AccountProvider;
  if (!accountEmail.endsWith(".test")) {
    await providerAdapterFor(accountProvider).markRead(accountEmail, [String(row.external_message_id)]);
  }
  const labels = parseStringArray(row.gmail_labels).filter((label) => label !== "UNREAD");
  await execute(
    `UPDATE email_messages SET is_unread = 0, status = 'read', gmail_labels = ?, updated_at = ?
     WHERE id = ?`,
    [JSON.stringify(labels), nowIso(), messageId],
  );
  await recordEvent(messageId, null, "message_marked_read", "", source);
  await audit("email.marked_read", source, "message", messageId);
  return { messageId };
}

export async function clearMessageFromQueue(messageId: string, source = "cockpit") {
  const result = await execute(`SELECT id FROM email_messages WHERE id = ?`, [messageId]);
  if (!result.rows[0]) throw new Error("Email message was not found.");
  await execute(`UPDATE email_messages SET status = 'cleared', updated_at = ? WHERE id = ?`, [
    nowIso(),
    messageId,
  ]);
  await recordEvent(messageId, null, "message_cleared", "", source);
  await audit("email.cleared_from_queue", source, "message", messageId);
  return { messageId };
}

export async function seedSafeDemo() {
  const accountId = await upsertAccount({
    email: "demo@local.test",
    label: "Local demonstration",
    status: "needs_setup",
  });
  const samples: EmailEnvelope[] = [
    {
      accountId,
      externalMessageId: "demo-security",
      threadId: "demo-security",
      senderName: "Google Security",
      senderEmail: "security@example.test",
      subject: "New sign-in needs your review",
      receivedAt: new Date(Date.now() - 18 * 60_000).toISOString(),
      snippet: "A new sign-in was detected. Review the activity if this was not you.",
      bodyText: "A new sign-in was detected. Review the activity if this was not you.",
      gmailUrl: "#",
      isUnread: true,
      labels: ["INBOX", "UNREAD"],
      attachments: [],
    },
    {
      accountId,
      externalMessageId: "demo-project",
      threadId: "demo-project",
      senderName: "Morgan Lee",
      senderEmail: "morgan@example.test",
      subject: "Project schedule confirmation",
      receivedAt: new Date(Date.now() - 75 * 60_000).toISOString(),
      snippet: "Could you confirm whether Friday still works for the first review?",
      bodyText: "Could you confirm whether Friday still works for the first review?",
      gmailUrl: "#",
      isUnread: true,
      labels: ["INBOX", "UNREAD"],
      attachments: [],
    },
    {
      accountId,
      externalMessageId: "demo-newsletter",
      threadId: "demo-newsletter",
      senderName: "Weekly Product News",
      senderEmail: "news@example.test",
      subject: "This week's product roundup",
      receivedAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
      snippet: "A weekly digest of product announcements and promotions.",
      bodyText: "A weekly digest of product announcements and promotions. Unsubscribe at any time.",
      gmailUrl: "#",
      isUnread: true,
      labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
      attachments: [],
    },
  ];
  let ingested = 0;
  for (const sample of samples) {
    if (await ingestMessage(sample)) ingested += 1;
  }
  return { ingested };
}

export async function consolidatePreferences() {
  const rows = await execute(
    `SELECT account_id, kind, pattern, action, evidence_count FROM learned_preferences
     WHERE enabled = 1 AND evidence_count >= 2 ORDER BY evidence_count DESC`,
  );
  const workspace =
    process.env.EZRA_OPENCLAW_WORKSPACE || "D:\\Ezra-Mail-Agent";
  await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const lines = rows.rows.map(
    (row) =>
      `- ${String(row.action)} ${String(row.kind)} ${String(row.pattern)} (${Number(row.evidence_count)} confirmations)`,
  );
  await fs.writeFile(
    path.join(workspace, "memory", `${date}.md`),
    `# Email learning ${date}\n\n${lines.length ? lines.join("\n") : "No durable preferences ready for promotion."}\n`,
    "utf8",
  );
  return { promoted: lines.length };
}

export async function saveContinuityCheckpoint(
  input: ContinuityCheckpoint,
  source = "mcp",
) {
  const checkpoint = normalizeContinuityCheckpoint(input);
  const workspace = process.env.EZRA_OPENCLAW_WORKSPACE || "D:\\Ezra-Mail-Agent";
  const memoryDirectory = path.join(workspace, "memory");
  await fs.mkdir(memoryDirectory, { recursive: true });
  const timestamp = nowIso();
  const date = timestamp.slice(0, 10);
  const target = path.join(memoryDirectory, `${date}-continuity.md`);
  const sections = [
    ["Durable preferences", checkpoint.durablePreferences],
    ["Decisions", checkpoint.decisions],
    ["Unresolved work", checkpoint.unresolved],
    ["Corrections", checkpoint.corrections],
    ["Action boundaries", checkpoint.actionBoundaries],
  ] as const;
  const block = [
    `## Checkpoint ${timestamp}`,
    "",
    checkpoint.summary,
    "",
    ...sections.flatMap(([heading, values]) =>
      values.length ? [`### ${heading}`, "", ...values.map((value) => `- ${value}`), ""] : [],
    ),
  ]
    .join("\n")
    .trim();
  const existing = await fs.readFile(target, "utf8").catch(() => "");
  if (existing.includes(block)) return { saved: false, path: target, reason: "duplicate" };
  const prefix = existing.trim() ? "\n\n" : `# Ezra continuity ${date}\n\n`;
  await fs.appendFile(target, `${prefix}${block}\n`, "utf8");
  await audit("memory.continuity.saved", source, "memory", date, {
    sections: sections.reduce((sum, [, values]) => sum + values.length, 0),
  });
  return { saved: true, path: target };
}

export async function ensureTelegramStarted() {
  if (process.env.TELEGRAM_POLLING_ENABLED === "false") return;
  if (getTelegramStatus().configured) await startTelegramPolling();
}

function normalizeContinuityCheckpoint(
  input: ContinuityCheckpoint,
): ContinuityCheckpoint {
  const normalize = (value: string, maxLength: number) =>
    value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  const normalizeList = (values: string[]) =>
    values
      .map((value) => normalize(value, 400))
      .filter(Boolean)
      .slice(0, 12);
  const checkpoint = {
    summary: normalize(input.summary, 1200),
    durablePreferences: normalizeList(input.durablePreferences),
    decisions: normalizeList(input.decisions),
    unresolved: normalizeList(input.unresolved),
    corrections: normalizeList(input.corrections),
    actionBoundaries: normalizeList(input.actionBoundaries),
  };
  const content = JSON.stringify(checkpoint);
  if (!checkpoint.summary) throw new Error("A continuity checkpoint summary is required.");
  if (
    /\b(password|passcode|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization)\b\s*[:=]\s*\S+/i.test(
      content,
    ) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i.test(content)
  ) {
    throw new Error("Continuity checkpoints cannot contain credentials or authentication secrets.");
  }
  return checkpoint;
}

async function insertBacklogMetadata(message: EmailEnvelope, status: string) {
  const messageId = newId("mail");
  const now = nowIso();
  const organization = providerOrganizationState(message);
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, history_id, sender_name, sender_email,
       subject, received_at, snippet, gmail_url, has_attachments, gmail_labels, is_unread, is_pinned, is_flagged,
       organization_confirmed_at, ingest_source,
       status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?, ?)`,
    [
      messageId,
      message.accountId,
      message.externalMessageId,
      message.threadId,
      message.historyId || null,
      message.senderName,
      message.senderEmail,
      message.subject,
      message.receivedAt,
      message.snippet,
      message.gmailUrl,
      message.attachments.length ? 1 : 0,
      JSON.stringify(message.labels || []),
      message.isUnread ? 1 : 0,
      organization.isPinned ? 1 : 0,
      organization.isFlagged ? 1 : 0,
      now,
      status,
      now,
      now,
    ],
  );
  return messageId;
}

export function providerOrganizationState(message: Pick<EmailEnvelope, "isPinned" | "isFlagged" | "labels">) {
  const labels = new Set(message.labels || []);
  return {
    isPinned: message.isPinned ?? labels.has("STARRED"),
    isFlagged: message.isFlagged ?? (labels.has("IMPORTANT") || labels.has("MS_FOLLOW_UP")),
  };
}

function validIsoTimestamp(value?: string) {
  if (!value) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

async function prefilterQueuedBacklogMessages(accountId: string) {
  const queued = await execute(
    `SELECT m.*, a.email AS account_email
     FROM email_messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE m.account_id = ? AND m.status = 'backlog_queued'
     ORDER BY m.received_at DESC
     LIMIT 250`,
    [accountId],
  );
  let handled = 0;
  for (const row of queued.rows) {
    const preferences = await preferencesForMessage({
      accountId,
      senderEmail: String(row.sender_email),
      subject: String(row.subject),
      snippet: String(row.snippet),
    });
    const learnedAction = preferences[0]?.action ? String(preferences[0].action) : null;
    const result = prefilterBacklogMessage(
      {
        senderName: String(row.sender_name),
        senderEmail: String(row.sender_email),
        subject: String(row.subject),
        snippet: String(row.snippet),
        receivedAt: String(row.received_at),
      },
      learnedAction,
    );
    if (!result) continue;
    const messageId = String(row.id);
    await saveTriageDecision(messageId, "rules:v1", result);
    await applyApprovedMaintenanceRule(messageId, String(row.account_email), result);
    await execute(
      `UPDATE email_messages SET status = 'triaged', updated_at = ? WHERE id = ?`,
      [nowIso(), messageId],
    );
    await audit("email.backlog.rule_handled", "worker", "message", messageId, {
      attention: result.attention,
      category: result.category,
      reclassified: true,
    });
    handled += 1;
  }
  return handled;
}

async function analyzeQueuedBacklogMessages(
  accountId: string,
  accountEmail: string,
  budget: number,
) {
  if (budget <= 0) return 0;
  const queued = await execute(
    `SELECT * FROM email_messages
     WHERE account_id = ? AND status = 'backlog_queued'
     ORDER BY received_at DESC
     LIMIT ?`,
    [accountId, budget],
  );
  let handled = 0;
  for (const row of queued.rows) {
    const messageId = String(row.id);
    const fullText = await getGmailMessage(accountEmail, String(row.external_message_id))
      .then((payload) => JSON.stringify(payload).slice(0, 80_000))
      .catch(() => String(row.snippet));
    const preferences = await preferencesForMessage({
      accountId,
      senderEmail: String(row.sender_email),
      subject: String(row.subject),
      snippet: String(row.snippet),
    });
    const analyzed = await triageWithActiveModel(
      {
        senderName: String(row.sender_name),
        senderEmail: String(row.sender_email),
        subject: String(row.subject),
        receivedAt: String(row.received_at),
        snippet: String(row.snippet),
        bodyText: fullText,
        learnedPreferences: preferences.map(
          (item) => learnedPreferenceDescription(item),
        ),
      },
      messageId,
    );
    const finalPreferences = await preferencesForMessage({
      accountId,
      senderEmail: String(row.sender_email),
      subject: String(row.subject),
      snippet: String(row.snippet),
      category: analyzed.result.category,
    });
    const result = applyLearnedPreferences(analyzed.result, finalPreferences);
    await saveTriageDecision(messageId, analyzed.model, result);
    await execute(
      `UPDATE email_messages SET status = 'triaged', updated_at = ? WHERE id = ?`,
      [nowIso(), messageId],
    );
    if (result.draftReply) await saveNewDraft(messageId, result.draftReply, "backlog");
    await applyApprovedMaintenanceRule(messageId, accountEmail, result);
    await audit("email.backlog.model_handled", "worker", "message", messageId, {
      attention: result.attention,
      model: analyzed.model,
    });
    handled += 1;
  }
  return handled;
}

async function countBacklogQueue(accountId: string) {
  const result = await execute(
    `SELECT COUNT(*) AS count FROM email_messages
     WHERE account_id = ? AND status = 'backlog_queued'`,
    [accountId],
  );
  return Number(result.rows[0]?.count || 0);
}

async function finishBacklogCycle(
  accountId: string,
  counts: { modelHandled?: number; ruleHandled?: number } = {},
) {
  await execute(
    `UPDATE mailbox_sweeps SET model_handled_count = model_handled_count + ?,
      rule_handled_count = rule_handled_count + ?,
      last_run_at = ?, updated_at = ?, error = NULL
     WHERE account_id = ?`,
    [
      counts.modelHandled || 0,
      counts.ruleHandled || 0,
      nowIso(),
      nowIso(),
      accountId,
    ],
  );
  const sweep = await execute(
    `SELECT exhausted FROM mailbox_sweeps WHERE account_id = ?`,
    [accountId],
  );
  if (Number(sweep.rows[0]?.exhausted) === 1 && (await countBacklogQueue(accountId)) === 0) {
    await completeBacklogSweep(accountId);
  }
}

async function completeBacklogSweep(accountId: string) {
  await execute(
    `UPDATE mailbox_sweeps SET status = 'completed', completed_at = ?,
      last_run_at = ?, updated_at = ?, error = NULL
     WHERE account_id = ?`,
    [nowIso(), nowIso(), nowIso(), accountId],
  );
  await audit("mailbox.sweep.completed", "worker", "account", accountId);
}

async function applyApprovedMaintenanceRule(
  messageId: string,
  accountEmail: string | undefined,
  result: TriageResult,
) {
  if (
    !accountEmail ||
    result.attention !== "suppress" ||
    PROTECTED_MAINTENANCE_CATEGORIES.has(result.category.toLowerCase())
  ) {
    return;
  }
  const message = await execute(
    `SELECT account_id, external_message_id, sender_email, is_unread
     FROM email_messages WHERE id = ?`,
    [messageId],
  );
  const row = message.rows[0];
  if (!row || Number(row.is_unread) !== 1) return;
  const rules = await execute(
    `SELECT id, action FROM maintenance_rules
     WHERE account_id = ? AND lower(sender_email) = lower(?) AND enabled = 1
     ORDER BY approved_at DESC`,
    [row.account_id, row.sender_email],
  );
  const rule = rules.rows.find((candidate) =>
    ["mark_read", "spam"].includes(String(candidate.action)),
  );
  if (!rule) return;
  try {
    const externalId = String(row.external_message_id);
    const action = String(rule.action) as MaintenanceAction;
    if (action === "spam") {
      await moveGmailMessagesToSpam(accountEmail, [externalId]);
    } else {
      await markGmailMessagesRead(accountEmail, [externalId]);
    }
    await markLocalMessagesMaintained([messageId], action);
    await execute(
      `UPDATE maintenance_rules SET last_run_at = ?, updated_at = ? WHERE id = ?`,
      [nowIso(), nowIso(), rule.id],
    );
    await audit("gmail.maintenance.rule_applied", "worker", "message", messageId, {
      action,
      senderEmail: String(row.sender_email),
    });
  } catch (error) {
    await audit("gmail.maintenance.rule_failed", "worker", "message", messageId, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function saveMaintenanceRule(
  accountId: string,
  senderEmail: string,
  action: Exclude<MaintenanceAction, "unsubscribe">,
) {
  const now = nowIso();
  await execute(
    `UPDATE maintenance_rules SET enabled = 0, updated_at = ?
     WHERE account_id = ? AND lower(sender_email) = lower(?) AND action <> ?`,
    [now, accountId, senderEmail, action],
  );
  await execute(
    `INSERT INTO maintenance_rules
      (id, account_id, sender_email, action, enabled, approved_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(account_id, sender_email, action) DO UPDATE SET
      enabled = 1, approved_at = excluded.approved_at, updated_at = excluded.updated_at`,
    [
      newId("rule"),
      accountId,
      senderEmail.toLowerCase(),
      action,
      now,
      now,
      now,
    ],
  );
}

async function markLocalMessagesMaintained(
  messageIds: string[],
  action: MaintenanceAction,
) {
  for (const messageId of messageIds) {
    const row = await execute(`SELECT gmail_labels FROM email_messages WHERE id = ?`, [messageId]);
    const labels = parseStringArray(row.rows[0]?.gmail_labels)
      .filter((label) => !["UNREAD", ...(action === "spam" ? ["INBOX"] : [])].includes(label));
    if (action === "spam" && !labels.includes("SPAM")) labels.push("SPAM");
    await execute(
      `UPDATE email_messages SET is_unread = 0, status = ?, gmail_labels = ?, updated_at = ?
       WHERE id = ?`,
      [
        action === "spam" ? "spammed" : "maintained",
        JSON.stringify(labels),
        nowIso(),
        messageId,
      ],
    );
  }
}

async function postOneClickUnsubscribe(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new Error("One-click unsubscribe endpoint must use HTTPS.");
  }
  if (!url.hostname || url.username || url.password || isPrivateHostname(url.hostname)) {
    throw new Error("Unsafe unsubscribe endpoint.");
  }
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("Unsafe unsubscribe endpoint address.");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`One-click unsubscribe returned ${response.status}.`);
  }
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

function isPrivateAddress(address: string) {
  const version = net.isIP(address);
  if (version === 4) {
    const parts = address.split(".").map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      parts[0] === 0 ||
      parts[0] >= 224
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isPrivateAddress(normalized.slice("::ffff:".length));
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd")
    );
  }
  return true;
}

async function extractSafeAttachments(message: EmailEnvelope, accountEmail?: string) {
  if (!accountEmail || !message.attachments.length) return "";
  const extracted: string[] = [];
  for (const attachment of message.attachments.slice(0, 5)) {
    const validation = validateAttachment(attachment.name, attachment.size);
    if (!validation.allowed) {
      extracted.push(`[${attachment.name}: blocked - ${validation.reason}]`);
      continue;
    }
    const downloaded = await downloadGmailAttachment({
      account: accountEmail,
      messageId: message.externalMessageId,
      attachmentId: attachment.id,
      name: attachment.name,
    });
    try {
      const text = await extractAttachmentText(downloaded.path, attachment.name);
      extracted.push(`[${attachment.name}]\n${text}`);
    } finally {
      await fs.rm(downloaded.directory, { recursive: true, force: true });
    }
  }
  return extracted.join("\n\n").slice(0, 100_000);
}

async function notifyRowsToItems(rows: Awaited<ReturnType<typeof execute>>["rows"]) {
  return rows.map((row) => row.id);
}

function inboxItemFromRow(
  row: Awaited<ReturnType<typeof execute>>["rows"][number],
): InboxItem {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    accountLabel: String(row.account_label),
    accountProvider: row.account_provider
      ? (String(row.account_provider) as InboxItem["accountProvider"])
      : undefined,
    externalMessageId: String(row.external_message_id),
    threadId: String(row.thread_id),
    senderName: String(row.sender_name),
    senderEmail: String(row.sender_email),
    subject: String(row.subject),
    receivedAt: String(row.received_at),
    snippet: String(row.snippet),
    gmailUrl: String(row.gmail_url),
    hasAttachments: Number(row.has_attachments) === 1,
    isUnread: Number(row.is_unread || 0) === 1,
    isPinned: Number(row.is_pinned || 0) === 1,
    isFlagged: Number(row.is_flagged || 0) === 1,
    organizationConfirmedAt: row.organization_confirmed_at ? String(row.organization_confirmed_at) : null,
    mailboxLabels: parseStringArray(row.gmail_labels),
    status: String(row.status),
    attention: row.attention ? (String(row.attention) as InboxItem["attention"]) : null,
    urgency: row.urgency === null || row.urgency === undefined ? null : Number(row.urgency),
    confidence:
      row.confidence === null || row.confidence === undefined
        ? null
        : Number(row.confidence),
    category: row.category ? String(row.category) : null,
    summary: row.summary ? String(row.summary) : null,
    reason: row.reason ? String(row.reason) : null,
    recommendation: row.recommendation ? String(row.recommendation) : null,
    needsReply: Number(row.needs_reply || 0) === 1,
    deadline: row.deadline ? String(row.deadline) : null,
    injectionFlags: parseStringArray(row.injection_flags),
    model: row.model ? String(row.model) : null,
    notifiedAt: row.notified_at ? String(row.notified_at) : null,
  };
}

async function buildContactMemory(accountId: string, senderName: string, senderEmail: string) {
  const [statsResult, categoryResult, recentResult, preferenceResult, draftResult] =
    await Promise.all([
      execute(
        `SELECT COUNT(*) AS message_count, MIN(m.received_at) AS first_seen_at,
          MAX(m.received_at) AS last_seen_at,
          SUM(CASE WHEN t.attention = 'interrupt' THEN 1 ELSE 0 END) AS interrupt_count,
          SUM(CASE WHEN t.needs_reply = 1 THEN 1 ELSE 0 END) AS reply_count
         FROM email_messages m
         LEFT JOIN triage_decisions t ON t.id = (
           SELECT id FROM triage_decisions td WHERE td.message_id = m.id
           ORDER BY td.created_at DESC LIMIT 1
         )
         WHERE m.account_id = ? AND lower(m.sender_email) = lower(?)`,
        [accountId, senderEmail],
      ),
      execute(
        `SELECT COALESCE(t.category, 'uncategorized') AS category, COUNT(*) AS count
         FROM email_messages m
         LEFT JOIN triage_decisions t ON t.id = (
           SELECT id FROM triage_decisions td WHERE td.message_id = m.id
           ORDER BY td.created_at DESC LIMIT 1
         )
         WHERE m.account_id = ? AND lower(m.sender_email) = lower(?)
         GROUP BY COALESCE(t.category, 'uncategorized')
         ORDER BY count DESC, category
         LIMIT 4`,
        [accountId, senderEmail],
      ),
      execute(
        `SELECT m.received_at, m.subject, t.summary
         FROM email_messages m
         LEFT JOIN triage_decisions t ON t.id = (
           SELECT id FROM triage_decisions td WHERE td.message_id = m.id
           ORDER BY td.created_at DESC LIMIT 1
         )
         WHERE m.account_id = ? AND lower(m.sender_email) = lower(?)
         ORDER BY m.received_at DESC
         LIMIT 4`,
        [accountId, senderEmail],
      ),
      execute(
        `SELECT action, weight, evidence_count
         FROM learned_preferences
         WHERE enabled = 1 AND kind = 'sender' AND account_id = ? AND lower(pattern) = lower(?)
         ORDER BY weight DESC`,
        [accountId, senderEmail],
      ),
      execute(
        `SELECT
          COUNT(*) AS draft_count,
         SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END) AS sent_count
         FROM reply_drafts d
         JOIN email_messages m ON m.id = d.message_id
         WHERE m.account_id = ? AND lower(m.sender_email) = lower(?)`,
        [accountId, senderEmail],
      ),
    ]);

  const stats = statsResult.rows[0];
  const drafts = draftResult.rows[0];
  const messageCount = Number(stats?.message_count || 0);
  const interruptCount = Number(stats?.interrupt_count || 0);
  const replyCount = Number(stats?.reply_count || 0);
  const draftCount = Number(drafts?.draft_count || 0);
  const sentCount = Number(drafts?.sent_count || 0);
  const firstSeenAt = String(stats?.first_seen_at || "");
  const lastSeenAt = String(stats?.last_seen_at || "");
  const topicSummary = categoryResult.rows
    .map((row) => `${humanizeCategory(String(row.category))} (${Number(row.count)})`)
    .join(", ");
  const preferenceSummary = preferenceResult.rows.length
    ? preferenceResult.rows
        .map(
          (row) =>
            `${humanizeCategory(String(row.action))} after ${Number(row.evidence_count)} signal${
              Number(row.evidence_count) === 1 ? "" : "s"
            }`,
        )
        .join("; ")
    : "No durable handling preference has been learned for this contact yet.";
  const recentSummary = recentResult.rows
    .map((row) => {
      const summary = row.summary ? ` - ${String(row.summary)}` : "";
      return `${formatMemoryDate(String(row.received_at))}: ${String(row.subject)}${summary}`;
    })
    .join("\n");

  return {
    summary:
      messageCount === 1
        ? `This is Ezra's first recorded message from ${senderName}.`
        : `Ezra has reviewed ${messageCount} messages from ${senderName} since ${formatMemoryDate(
            firstSeenAt,
          )}. ${interruptCount} required priority attention and ${replyCount} appeared to need a reply.`,
    messageCount,
    firstSeenAt,
    lastSeenAt,
    categories: [
      {
        label: "Relationship" as const,
        summary: `${messageCount} recorded message${messageCount === 1 ? "" : "s"} between ${formatMemoryDate(
          firstSeenAt,
        )} and ${formatMemoryDate(lastSeenAt)}. ${draftCount} reply draft${
          draftCount === 1 ? "" : "s"
        } created; ${sentCount} recorded as sent.`,
      },
      {
        label: "Patterns" as const,
        summary: topicSummary || "Ezra has not established a recurring topic pattern yet.",
      },
      {
        label: "Preferences" as const,
        summary: preferenceSummary,
      },
      {
        label: "Recent history" as const,
        summary: recentSummary || "No prior local history is available.",
      },
    ],
  };
}

function sanitizeDisplayText(value: string) {
  return value
    .replace(/\u0000/g, "")
    .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi, "")
    .replace(/<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi, "")
    .replace(/^\s*Source:\s*[a-z0-9_-]+\s*---\s*/i, "")
    .trim()
    .slice(0, 80_000);
}

function parseStringArray(value: unknown): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonRecords(value: unknown): Array<Record<string, unknown>> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      : [];
  } catch {
    return [];
  }
}

function humanizeCategory(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatMemoryDate(value: string) {
  if (!value) return "an unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  }).format(date);
}

async function getInboxItem(messageId: string): Promise<InboxItem | null> {
  const dashboard = await getEmailDashboard();
  return dashboard.inbox.find((item) => item.id === messageId) || null;
}

async function getMessageForDraft(messageId: string) {
  const result = await execute(
    `SELECT m.*, ea.email AS account_email, ea.label AS account_label, ea.provider AS account_provider,
      t.summary AS triage_summary, t.recommendation AS triage_recommendation,
      t.needs_reply AS triage_needs_reply
     FROM email_messages m
     JOIN email_accounts ea ON ea.id = m.account_id
     LEFT JOIN triage_decisions t ON t.id = (
       SELECT id FROM triage_decisions td WHERE td.message_id = m.id
       ORDER BY td.created_at DESC LIMIT 1
     )
     WHERE m.id = ?`,
    [messageId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    accountProvider: String(row.account_provider || "gmail"),
    externalMessageId: String(row.external_message_id),
    threadId: String(row.thread_id),
    senderName: String(row.sender_name),
    senderEmail: String(row.sender_email),
    subject: String(row.subject),
    snippet: String(row.snippet),
    accountEmail: String(row.account_email),
    accountLabel: String(row.account_label),
    triageSummary: row.triage_summary ? String(row.triage_summary) : "",
    triageRecommendation: row.triage_recommendation
      ? String(row.triage_recommendation)
      : "",
    needsReply: Number(row.triage_needs_reply || 0) === 1,
  };
}

async function fetchFullMessageText(message: NonNullable<Awaited<ReturnType<typeof getMessageForDraft>>>) {
  if (message.accountEmail.endsWith(".test")) return message.snippet;
  const envelope = await providerAdapterFor(message.accountProvider === "microsoft" ? "microsoft" : "gmail")
    .readMessage(message.accountEmail, message.accountId, message.externalMessageId);
  return sanitizeDisplayText(envelope?.bodyText || envelope?.snippet || message.snippet).slice(
    0,
    100_000,
  );
}

async function contextForMessage(messageId: string) {
  const result = await execute(
    `SELECT content FROM context_notes WHERE message_id = ? ORDER BY created_at`,
    [messageId],
  );
  return result.rows.map((row) => String(row.content));
}

async function saveNewDraft(messageId: string, content: string, source: string) {
  const versions = await execute(
    `SELECT COALESCE(MAX(version), 0) AS version FROM reply_drafts WHERE message_id = ?`,
    [messageId],
  );
  const version = Number(versions.rows[0]?.version || 0) + 1;
  const id = newId("draft");
  const now = nowIso();
  await execute(
    `INSERT INTO reply_drafts
      (id, message_id, content, content_hash, version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [id, messageId, content, hashDraft(content), version, now, now],
  );
  await recordEvent(messageId, id, "draft_created", content, source);
  return { id, messageId, content, version, status: "draft" as const, updatedAt: now };
}

async function getDraftRow(draftId: string) {
  const result = await execute(`SELECT * FROM reply_drafts WHERE id = ?`, [draftId]);
  return result.rows[0] || null;
}

async function preferencesForMessage(input: {
  accountId: string;
  senderEmail: string;
  subject?: string;
  snippet?: string;
  category?: string | null;
}) {
  const result = await execute(
    `SELECT * FROM learned_preferences
     WHERE enabled = 1
       AND kind IN ('sender', 'topic')
       AND account_id = ?
     ORDER BY weight DESC, evidence_count DESC, updated_at DESC`,
    [input.accountId],
  );
  const normalizedCategory = input.category ? normalizeTopicLabel(input.category) : "";
  const text = `${input.subject || ""} ${input.snippet || ""}`;
  return result.rows
    .filter((row) => {
      const kind = String(row.kind);
      const pattern = String(row.pattern || "");
      if (kind === "sender") return String(input.senderEmail).toLowerCase() === pattern.toLowerCase();
      if (kind === "topic") return topicPreferenceMatches(pattern, normalizedCategory, text);
      return false;
    })
    .sort((left, right) => {
      const specificity = (kind: string) => kind === "sender" ? 0 : 1;
      return specificity(String(left.kind)) - specificity(String(right.kind)) ||
        Number(right.weight || 0) - Number(left.weight || 0) ||
        Number(right.evidence_count || 0) - Number(left.evidence_count || 0);
    });
}

function applyLearnedPreferences(
  result: TriageResult,
  preferences: Awaited<ReturnType<typeof preferencesForMessage>>,
) {
  const preference = preferences[0];
  if (!preference) return result;
  const action = String(preference.action);
  const urgency = action === "interrupt" ? 95 : action === "digest" ? 62 : 10;
  const kind = String(preference.kind) === "topic" ? "topic" : "sender";
  return {
    ...result,
    urgency,
    attention: attentionForUrgency(urgency),
    reason: `${result.reason} A learned ${kind} preference set this to ${action}.`,
  };
}

function learnedPreferenceDescription(row: Awaited<ReturnType<typeof preferencesForMessage>>[number]) {
  const kind = String(row.kind) === "topic" ? "topic" : "sender";
  return `${String(row.action)} ${kind} ${String(row.pattern)} (${Number(row.evidence_count || 0)} observations)`;
}

function topicPreferenceMatches(pattern: string, normalizedCategory: string, text: string) {
  const normalizedPattern = normalizeTopicLabel(pattern);
  if (!normalizedPattern) return false;
  if (normalizedCategory && normalizedCategory === normalizedPattern) return true;
  const textTokens = new Set(topicTokens(text));
  const patternTokens = topicTokens(normalizedPattern);
  if (!patternTokens.length) return false;
  const matches = patternTokens.filter((token) => textTokens.has(token)).length;
  return matches >= Math.min(2, patternTokens.length);
}

function normalizeTopicLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|and|or|for|from|with|your|you|my|our|their|this|that|re|fw|fwd)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function topicTokens(value: string) {
  return normalizeTopicLabel(value)
    .split(" ")
    .filter((token) => token.length >= 3);
}

async function recordEvent(
  messageId: string | null,
  draftId: string | null,
  eventType: string,
  value: string,
  source: string,
) {
  await execute(
    `INSERT INTO feedback_events
      (id, message_id, draft_id, event_type, value, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId("feedback"), messageId, draftId, eventType, value, source, nowIso()],
  );
}

async function isOllamaAvailable() {
  try {
    const response = await fetch(
      `${process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"}/api/tags`,
      { signal: AbortSignal.timeout(2500) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function setService(key: string, value: string) {
  await execute(
    `INSERT INTO service_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, nowIso()],
  );
}

async function getServiceValue(key: string) {
  const result = await execute(`SELECT value FROM service_state WHERE key = ?`, [key]);
  return result.rows[0]?.value ? String(result.rows[0].value) : null;
}

function parseMicrosoftAuthState(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as {
      email?: string;
      access?: MicrosoftAccessMode;
      deviceCode?: string;
      expiresAt?: string;
      interval?: number;
    };
    if (
      !parsed.email ||
      !parsed.deviceCode ||
      !parsed.expiresAt ||
      !["readonly", "maintenance", "calendar", "send", "full"].includes(String(parsed.access))
    ) {
      return null;
    }
    return {
      email: parsed.email,
      access: String(parsed.access) as MicrosoftAccessMode,
      deviceCode: parsed.deviceCode,
      expiresAt: parsed.expiresAt,
      interval: Number(parsed.interval || 5),
    };
  } catch {
    return null;
  }
}

async function restoreExpiredSnoozes() {
  const now = nowIso();
  await execute(
    `UPDATE email_messages
     SET status = 'triaged', updated_at = ?
     WHERE status = 'snoozed'
       AND EXISTS (
         SELECT 1 FROM service_state s
         WHERE s.key = 'snooze:' || email_messages.id
           AND s.value <= ?
       )`,
    [now, now],
  );
  await execute(
    `DELETE FROM service_state WHERE key LIKE 'snooze:%' AND value <= ?`,
    [now],
  );
}

function hashDraft(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function boundedConfig(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}
