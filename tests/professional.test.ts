import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapterCalls = vi.hoisted(() => {
  const adapter = {
    applyWorkspaceAction: vi.fn(async () => ({ modified: 1 })),
    undoWorkspaceAction: vi.fn(async () => ({ modified: 1 })),
    applyOrganizationState: vi.fn(async () => ({ modified: 1 })),
  };
  return {
    adapter,
    providerAdapterFor: vi.fn((provider: string) => ({
      ...adapter,
      organizationCapabilities: () => provider === "gmail"
        ? {
          pin: { state: "supported", mapping: "gmail_star" },
          flag: { state: "supported", mapping: "gmail_important" },
        }
        : {
          pin: { state: "unavailable", reason: "Ezra cannot safely map Pin for this Microsoft account yet." },
          flag: { state: "supported", mapping: "microsoft_follow_up" },
        },
      folderMappings: () => provider === "microsoft"
        ? { inbox: "INBOX", sent: "SENT", spam: "JUNK", trash: "DELETED" }
        : { inbox: "INBOX", sent: "SENT", spam: "SPAM", trash: "TRASH" },
    })),
  };
});

const gmailCalls = vi.hoisted(() => ({
  searchGmailMessagePage: vi.fn(),
}));

vi.mock("@/lib/email/provider-adapter", () => adapterCalls);
vi.mock("@/lib/email/gmail", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/email/gmail")>(),
  searchGmailMessagePage: gmailCalls.searchGmailMessagePage,
}));
import {
  configureEmailDatabaseForTests,
  execute,
  nowIso,
  saveTriageDecision,
  setSetting,
  setServiceState,
} from "@/lib/email/database";
import {
  applyProfessionalMailAction,
  deleteRule,
  getProfessionalMessageDetail,
  getMailPage,
  getRules,
  searchProviderMail,
  getMailTodaySnapshot as getTodayBrief,
  updateRule,
} from "@/lib/email/professional";
import { ingestMessage } from "@/lib/email/service";
import { normalizeMicrosoftMessage } from "@/lib/email/microsoft";
import { recordFeedback } from "@/lib/email/service";
import type { AttentionLevel } from "@/lib/email/types";

describe("professional mail workspace", () => {
  afterEach(() => { vi.useRealTimers(); });
  beforeEach(async () => {
    adapterCalls.adapter.applyOrganizationState.mockReset().mockResolvedValue({ modified: 1 });
    gmailCalls.searchGmailMessagePage.mockReset().mockResolvedValue({ messages: [], nextPageToken: null });
    configureEmailDatabaseForTests(`file:./professional-${randomUUID()}.sqlite`);
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-test', 'gmail', 'owner@local.test', 'Personal', 'connected', ?, ?)`,
      [nowIso(), nowIso()],
    );
    await seedProviderAccess("acct-test", "gmail", "maintenance");
  });

  it("builds an 8-12 topic brief, deduplicates threads, and excludes special folders", async () => {
    for (let index = 0; index < 14; index += 1) {
      await seedMessage({
        id: `topic-${index}`,
        threadId: index < 2 ? "shared-thread" : `thread-${index}`,
        labels: ["INBOX", "UNREAD"],
        attention: index < 4 ? "interrupt" : "digest",
        urgency: 90 - index,
        category: "project-update",
        receivedAt: minutesAgo(index + 1),
        needsReply: index >= 4 && index < 7,
      });
    }
    await seedMessage({ id: "spam-priority", labels: ["SPAM", "UNREAD"], attention: "interrupt", urgency: 99, category: "account-security" });
    await seedMessage({ id: "trash-priority", labels: ["TRASH", "UNREAD"], attention: "interrupt", urgency: 99, category: "legal" });
    await seedMessage({ id: "sent-priority", labels: ["SENT"], attention: "interrupt", urgency: 99, category: "project-update" });

    const brief = await getTodayBrief();

    expect(brief.topics.length).toBeGreaterThanOrEqual(8);
    expect(brief.topics.length).toBeLessThanOrEqual(12);
    expect(brief.topics.map((topic) => topic.id)).not.toEqual(
      expect.arrayContaining(["spam-priority", "trash-priority", "sent-priority"]),
    );
    expect(brief.topics.filter((topic) => ["topic-0", "topic-1"].includes(topic.id))).toHaveLength(1);
  });

  it("returns exact reply candidates without writing the legacy date-only brief tables", async () => {
    const receivedAt = "2026-08-30T14:00:00.000Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-30T15:00:00.000Z"));
    await seedMessage({
      id: "reply-candidate",
      threadId: "provider-thread-1",
      subject: "Quarterly review",
      summary: "A reply is still needed.",
      attention: "digest",
      urgency: 88,
      needsReply: true,
      receivedAt,
    });

    const snapshot = await getTodayBrief({ workspaceId: "workspace:account:gmail:acct-test" });
    const legacyBriefs = await execute("SELECT COUNT(*) AS count FROM daily_briefs");
    const legacyTopics = await execute("SELECT COUNT(*) AS count FROM brief_topics");

    expect(snapshot.replyCandidates).toEqual([
      expect.objectContaining({
        sourceType: "mail_thread",
        sourceKey: "mail:acct-test:provider-thread-1",
        sourceAccountId: "acct-test",
        provider: "gmail",
        providerThreadId: "provider-thread-1",
        revisionAt: receivedAt,
        occurredAt: receivedAt,
        role: "attention",
        title: "Quarterly review",
        summary: "A reply is still needed.",
        target: { view: "mail", messageId: "reply-candidate" },
      }),
    ]);
    expect(snapshot.briefCandidates).toEqual(expect.arrayContaining(snapshot.replyCandidates));
    expect(Number(legacyBriefs.rows[0]?.count || 0)).toBe(0);
    expect(Number(legacyTopics.rows[0]?.count || 0)).toBe(0);
  });

  it("uses the configured timezone for the authoritative mail snapshot day", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-30T06:30:00.000Z"));
      await setSetting("timezone", "America/Los_Angeles");

      const snapshot = await getTodayBrief({ workspaceId: "workspace:account:gmail:acct-test" });

      expect(snapshot.date).toBe("2026-08-29");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps protected messages out of cleanup and never recommends spam", async () => {
    await seedMessage({ id: "promo-1", senderEmail: "offers@example.com", category: "bulk-mail", attention: "suppress", urgency: 8 });
    await seedMessage({ id: "promo-2", senderEmail: "offers@example.com", category: "bulk-mail", attention: "suppress", urgency: 8 });
    await seedMessage({ id: "receipt", senderEmail: "billing@example.com", category: "receipt", attention: "suppress", urgency: 8, subject: "Your receipt" });
    await seedMessage({ id: "security", senderEmail: "security@example.com", category: "general", attention: "suppress", urgency: 8, subject: "New sign-in needs your review" });

    const brief = await getTodayBrief();

    expect(brief.cleanup).toHaveLength(1);
    expect(brief.cleanup[0].senderEmail).toBe("offers@example.com");
    expect(brief.cleanup[0].recommendation).toBe("quiet");
  });

  it("searches AI summaries with FTS, groups threads, and paginates without duplication", async () => {
    for (let index = 0; index < 13; index += 1) {
      await seedMessage({
        id: `search-${index}`,
        threadId: index < 2 ? "search-thread" : `search-thread-${index}`,
        category: "planning",
        summary: `Zebra launch planning item ${index}`,
        receivedAt: minutesAgo(index),
      });
    }

    const first = await getMailPage({ folder: "all", search: "zebra launch", limit: 10 });
    const second = await getMailPage({ folder: "all", search: "zebra launch", limit: 10, cursor: first.nextCursor });

    expect(first.items).toHaveLength(10);
    expect(first.items.find((item) => ["search-0", "search-1"].includes(item.id))?.threadCount).toBe(2);
    expect(first.nextCursor).toBeTruthy();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(12);
  });

  it("limits Today drilldowns to exact message identities inside the active workspace", async () => {
    await seedMicrosoftAccount();
    for (let index = 1; index <= 4; index += 1) {
      await seedMessage({
        id: `exact-action-${index}`,
        labels: ["INBOX", "UNREAD"],
        attention: "interrupt",
        urgency: 90 - index,
      });
    }
    await seedMessage({
      id: "exact-hotmail",
      accountId: "acct-hotmail",
      labels: ["INBOX", "UNREAD"],
      attention: "interrupt",
      urgency: 99,
    });

    const page = await getMailPage({
      workspaceId: "workspace:gmail",
      folder: "inbox",
      handled: "active",
      priority: "interrupt",
      messageIds: ["exact-action-1", "exact-action-2", "exact-action-3", "exact-action-1", "exact-hotmail"],
      limit: 40,
    });

    expect(page.items.map((item) => item.id).sort()).toEqual(["exact-action-1", "exact-action-2", "exact-action-3"]);
    expect(page.total).toBe(3);
  });

  it("records and undoes reversible acknowledge actions", async () => {
    await seedMessage({ id: "done-me", labels: ["INBOX", "UNREAD"], attention: "digest" });

    const action = await applyProfessionalMailAction({ action: "done", messageIds: ["done-me"] });
    const changed = await execute(`SELECT status, is_unread FROM email_messages WHERE id = 'done-me'`);
    const undone = await applyProfessionalMailAction({ action: "undo", actionId: action.actionId });
    const restored = await execute(`SELECT status, is_unread FROM email_messages WHERE id = 'done-me'`);

    expect(action).toMatchObject({ successCount: 1, reversible: true });
    expect(changed.rows[0]).toMatchObject({ status: "cleared", is_unread: 0 });
    expect(undone.successCount).toBe(1);
    expect(restored.rows[0]).toMatchObject({ status: "triaged", is_unread: 1 });
  });

  it("removes mark-read mail from active Today topics and attention counts", async () => {
    await seedMessage({ id: "read-today", labels: ["INBOX", "UNREAD"], attention: "interrupt", urgency: 92 });

    const before = await getTodayBrief();
    const action = await applyProfessionalMailAction({ action: "mark_read", messageIds: ["read-today"] });
    const after = await getTodayBrief();
    const changed = await execute(`SELECT status, is_unread FROM email_messages WHERE id = 'read-today'`);

    expect(before.topics.map((topic) => topic.id)).toContain("read-today");
    expect(before.mailActivity.stillNeedsAttention).toBe(1);
    expect(action).toMatchObject({ successCount: 1, changedIds: ["read-today"] });
    expect(changed.rows[0]).toMatchObject({ status: "read", is_unread: 0 });
    expect(after.topics.map((topic) => topic.id)).not.toContain("read-today");
    expect(after.mailActivity.stillNeedsAttention).toBe(0);
  });

  it("treats already-acknowledged messages as idempotent instead of failed", async () => {
    await seedMessage({ id: "already-done", labels: ["INBOX"], status: "cleared", isUnread: false });

    const action = await applyProfessionalMailAction({ action: "done", messageIds: ["already-done"] });
    const changed = await execute(`SELECT status, is_unread FROM email_messages WHERE id = 'already-done'`);

    expect(action).toMatchObject({
      successCount: 0,
      failureCount: 0,
      reversible: false,
      unchangedIds: ["already-done"],
    });
    expect(changed.rows[0]).toMatchObject({ status: "cleared", is_unread: 0 });
  });

  it("moves deleted mail to Trash and restores it on undo", async () => {
    await seedMessage({ id: "delete-me", labels: ["INBOX", "UNREAD"], attention: "digest" });

    const action = await applyProfessionalMailAction({ action: "delete", messageIds: ["delete-me"] });
    const changed = await execute(`SELECT status, is_unread, gmail_labels FROM email_messages WHERE id = 'delete-me'`);
    const undone = await applyProfessionalMailAction({ action: "undo", actionId: action.actionId });
    const restored = await execute(`SELECT status, is_unread, gmail_labels FROM email_messages WHERE id = 'delete-me'`);

    expect(action).toMatchObject({ successCount: 1, reversible: true });
    expect(changed.rows[0]).toMatchObject({ status: "deleted", is_unread: 0 });
    expect(JSON.parse(String(changed.rows[0].gmail_labels))).toEqual(expect.arrayContaining(["TRASH"]));
    expect(JSON.parse(String(changed.rows[0].gmail_labels))).not.toEqual(expect.arrayContaining(["INBOX", "UNREAD"]));
    expect(undone.successCount).toBe(1);
    expect(restored.rows[0]).toMatchObject({ status: "triaged", is_unread: 1 });
    expect(JSON.parse(String(restored.rows[0].gmail_labels))).toEqual(expect.arrayContaining(["INBOX", "UNREAD"]));
  });

  it("reconciles Gmail Pin only after its provider succeeds and reports unsupported Microsoft mail", async () => {
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-provider-gmail', 'gmail', 'owner@gmail.example', 'Gmail', 'connected', ?, ?),
              ('acct-provider-outlook', 'microsoft', 'owner@outlook.example', 'Outlook', 'connected', ?, ?)` ,
      [nowIso(), nowIso(), nowIso(), nowIso()],
    );
    await seedProviderAccess("acct-provider-gmail", "gmail", "maintenance");
    await seedProviderAccess("acct-provider-outlook", "microsoft", "maintenance");
    await seedMessage({ id: "gmail-pin", accountId: "acct-provider-gmail" });
    await seedMessage({ id: "outlook-pin", accountId: "acct-provider-outlook" });
    await execute(
      `UPDATE email_messages
       SET is_flagged = 1, organization_confirmed_at = '2000-01-01T00:00:00.000Z'
       WHERE id = 'gmail-pin'`,
    );

    const action = await applyProfessionalMailAction({ action: "pin", messageIds: ["gmail-pin", "outlook-pin"] });
    const state = await execute(
      `SELECT id, is_pinned, is_flagged, organization_confirmed_at FROM email_messages
       WHERE id IN ('gmail-pin', 'outlook-pin') ORDER BY id`,
    );
    const undone = await applyProfessionalMailAction({ action: "undo", actionId: action.actionId });
    const restored = await execute(
      `SELECT id, is_pinned, is_flagged, organization_confirmed_at FROM email_messages
       WHERE id IN ('gmail-pin', 'outlook-pin') ORDER BY id`,
    );

    expect(adapterCalls.adapter.applyOrganizationState).toHaveBeenCalledWith(
      "owner@gmail.example",
      "pin",
      true,
      ["external-gmail-pin"],
    );
    expect(action).toMatchObject({ successCount: 1, failureCount: 1, changedIds: ["gmail-pin"] });
    expect(action.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "outlook-pin", provider: "microsoft", code: "provider_error" }),
    ]));
    expect(undone).toMatchObject({ successCount: 1, failureCount: 0 });
    expect(adapterCalls.adapter.applyOrganizationState).toHaveBeenLastCalledWith(
      "owner@gmail.example",
      "pin",
      false,
      ["external-gmail-pin"],
    );
    expect(state.rows).toEqual([
      expect.objectContaining({ id: "gmail-pin", is_pinned: 1, is_flagged: 1, organization_confirmed_at: expect.any(String) }),
      expect.objectContaining({ id: "outlook-pin", is_pinned: 0, is_flagged: 0, organization_confirmed_at: null }),
    ]);
    expect(restored.rows).toEqual([
      expect.objectContaining({ id: "gmail-pin", is_pinned: 0, is_flagged: 1, organization_confirmed_at: expect.any(String) }),
      expect.objectContaining({ id: "outlook-pin", is_pinned: 0, is_flagged: 0, organization_confirmed_at: null }),
    ]);
    expect(restored.rows[0].organization_confirmed_at).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("reconciles supported Flag state independently for Gmail and Microsoft accounts", async () => {
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-flag-gmail', 'gmail', 'owner@gmail.example', 'Gmail', 'connected', ?, ?),
              ('acct-flag-outlook', 'microsoft', 'owner@outlook.example', 'Outlook', 'connected', ?, ?)` ,
      [nowIso(), nowIso(), nowIso(), nowIso()],
    );
    await seedProviderAccess("acct-flag-gmail", "gmail", "maintenance");
    await seedProviderAccess("acct-flag-outlook", "microsoft", "maintenance");
    await seedMessage({ id: "gmail-flag", accountId: "acct-flag-gmail" });
    await seedMessage({ id: "outlook-flag", accountId: "acct-flag-outlook" });

    const action = await applyProfessionalMailAction({ action: "flag", messageIds: ["gmail-flag", "outlook-flag"] });
    const state = await execute(
      `SELECT id, is_flagged, organization_confirmed_at FROM email_messages
       WHERE id IN ('gmail-flag', 'outlook-flag') ORDER BY id`,
    );

    expect(adapterCalls.adapter.applyOrganizationState).toHaveBeenCalledWith(
      "owner@gmail.example", "flag", true, ["external-gmail-flag"],
    );
    expect(adapterCalls.adapter.applyOrganizationState).toHaveBeenCalledWith(
      "owner@outlook.example", "flag", true, ["external-outlook-flag"],
    );
    expect(action).toMatchObject({ successCount: 2, failureCount: 0, changedIds: ["gmail-flag", "outlook-flag"] });
    expect(state.rows).toEqual([
      expect.objectContaining({ id: "gmail-flag", is_flagged: 1, organization_confirmed_at: expect.any(String) }),
      expect.objectContaining({ id: "outlook-flag", is_flagged: 1, organization_confirmed_at: expect.any(String) }),
    ]);
  });

  it("blocks organization Undo when the account no longer has write access", async () => {
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-undo-readonly', 'gmail', 'undo@gmail.example', 'Undo Gmail', 'connected', ?, ?)`,
      [nowIso(), nowIso()],
    );
    await seedProviderAccess("acct-undo-readonly", "gmail", "maintenance");
    await seedMessage({ id: "undo-readonly", accountId: "acct-undo-readonly" });
    const action = await applyProfessionalMailAction({ action: "pin", messageIds: ["undo-readonly"] });
    adapterCalls.adapter.applyOrganizationState.mockClear();
    await execute(
      `UPDATE provider_account_credentials SET access = 'readonly', updated_at = ?
       WHERE account_id = 'acct-undo-readonly'`,
      [nowIso()],
    );

    const undone = await applyProfessionalMailAction({ action: "undo", actionId: action.actionId });
    const state = await execute(
      `SELECT is_pinned, organization_confirmed_at FROM email_messages WHERE id = 'undo-readonly'`,
    );

    expect(adapterCalls.adapter.applyOrganizationState).not.toHaveBeenCalled();
    expect(undone).toMatchObject({ successCount: 0, failureCount: 1 });
    expect(undone.failures).toEqual([
      expect.objectContaining({ id: "undo-readonly", provider: "gmail" }),
    ]);
    expect(state.rows[0]).toMatchObject({ is_pinned: 1, organization_confirmed_at: expect.any(String) });
  });

  it("preserves provider organization state in Gmail search rows and detail", async () => {
    gmailCalls.searchGmailMessagePage.mockResolvedValueOnce({
      nextPageToken: null,
      messages: [{
        accountId: "ignored-by-account-scoped-search",
        externalMessageId: "provider-search-starred",
        threadId: "provider-search-thread",
        historyId: "history-search",
        senderName: "Provider Search",
        senderEmail: "search@example.com",
        subject: "Starred provider result",
        receivedAt: "2026-08-23T12:00:00.000Z",
        snippet: "Provider result",
        bodyText: "Provider result body",
        gmailUrl: "https://mail.google.com/mail/u/0/#all/provider-search-starred",
        isUnread: true,
        labels: ["INBOX", "UNREAD", "STARRED", "IMPORTANT"],
        attachments: [],
      }],
    });

    const result = await searchProviderMail({ query: "starred result", accountId: "acct-test" });
    const stored = await execute(
      `SELECT is_pinned, is_flagged, organization_confirmed_at
       FROM email_messages WHERE external_message_id = 'provider-search-starred'`,
    );
    const detail = await getProfessionalMessageDetail(result.items[0].id);

    expect(result.items[0]).toMatchObject({ isPinned: true, isFlagged: true });
    expect(stored.rows[0]).toMatchObject({
      is_pinned: 1,
      is_flagged: 1,
      organization_confirmed_at: expect.any(String),
    });
    expect(detail.detail.message).toMatchObject({ isPinned: true, isFlagged: true });
  });

  it("reports organization capability per account and blocks readonly writes before the provider", async () => {
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-readonly', 'gmail', 'readonly@gmail.example', 'Readonly Gmail', 'connected', ?, ?)` ,
      [nowIso(), nowIso()],
    );
    await seedProviderAccess("acct-readonly", "gmail", "readonly");
    await seedMessage({ id: "readonly-pin", accountId: "acct-readonly" });

    const page = await getMailPage({ folder: "all", account: "acct-readonly", limit: 10 });
    const detail = await getProfessionalMessageDetail("readonly-pin");
    adapterCalls.adapter.applyOrganizationState.mockClear();
    const action = await applyProfessionalMailAction({ action: "pin", messageIds: ["readonly-pin"] });

    expect(page.items[0]?.organizationCapabilities).toEqual({
      pin: { state: "reconnect_required", reason: expect.stringContaining("Reconnect Gmail") },
      flag: { state: "reconnect_required", reason: expect.stringContaining("Reconnect Gmail") },
    });
    expect(detail.capabilities.organization).toEqual(page.items[0]?.organizationCapabilities);
    expect(action).toMatchObject({ successCount: 0, failureCount: 1, changedIds: [] });
    expect(adapterCalls.adapter.applyOrganizationState).not.toHaveBeenCalled();
  });

  it("records Microsoft Flag partial success per message when a later provider mutation fails", async () => {
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-partial-ms', 'microsoft', 'partial@outlook.example', 'Partial Outlook', 'connected', ?, ?)` ,
      [nowIso(), nowIso()],
    );
    await seedProviderAccess("acct-partial-ms", "microsoft", "maintenance");
    await seedMessage({ id: "flag-first", accountId: "acct-partial-ms" });
    await seedMessage({ id: "flag-second", accountId: "acct-partial-ms" });
    adapterCalls.adapter.applyOrganizationState
      .mockResolvedValueOnce({ modified: 1 })
      .mockRejectedValueOnce(new Error("Second Graph PATCH failed."));

    const action = await applyProfessionalMailAction({
      action: "flag",
      messageIds: ["flag-first", "flag-second"],
    });
    const state = await execute(
      `SELECT id, is_flagged FROM email_messages
       WHERE id IN ('flag-first', 'flag-second') ORDER BY id`,
    );

    expect(adapterCalls.adapter.applyOrganizationState).toHaveBeenNthCalledWith(
      1,
      "partial@outlook.example",
      "flag",
      true,
      ["external-flag-first"],
    );
    expect(adapterCalls.adapter.applyOrganizationState).toHaveBeenNthCalledWith(
      2,
      "partial@outlook.example",
      "flag",
      true,
      ["external-flag-second"],
    );
    expect(action).toMatchObject({
      successCount: 1,
      failureCount: 1,
      changedIds: ["flag-first"],
    });
    expect(action.failures).toEqual([
      expect.objectContaining({ id: "flag-second", provider: "microsoft" }),
    ]);
    expect(state.rows).toEqual([
      expect.objectContaining({ id: "flag-first", is_flagged: 1 }),
      expect.objectContaining({ id: "flag-second", is_flagged: 0 }),
    ]);
  });

  it("moves mail to Trash and records lower-priority learning when delete-and-teach is used", async () => {
    await seedMessage({ id: "teach-delete", senderEmail: "offers@example.com", labels: ["INBOX", "UNREAD"], attention: "digest" });

    const action = await applyProfessionalMailAction({ action: "delete_and_teach", messageIds: ["teach-delete"] });
    const changed = await execute(`SELECT status, gmail_labels FROM email_messages WHERE id = 'teach-delete'`);
    const preference = await execute(
      `SELECT action, evidence_count FROM learned_preferences WHERE kind = 'sender' AND pattern = 'offers@example.com' AND enabled = 1`,
    );

    expect(action).toMatchObject({ successCount: 1, reversible: true });
    expect(changed.rows[0]).toMatchObject({ status: "deleted" });
    expect(JSON.parse(String(changed.rows[0].gmail_labels))).toEqual(expect.arrayContaining(["TRASH"]));
    expect(preference.rows[0]).toMatchObject({ action: "suppress", evidence_count: 1 });
  });

  it("reports Today mail activity by local day, attention, category, and poll state", async () => {
    const receivedAt = minutesAgo(5);
    await setServiceState("last_poll_at", receivedAt);
    await seedMessage({ id: "today-urgent", labels: ["INBOX", "UNREAD"], attention: "interrupt", category: "deadline", receivedAt });
    await seedMessage({ id: "today-quiet", labels: ["INBOX", "UNREAD"], attention: "suppress", category: "bulk-mail", receivedAt });
    await seedMessage({ id: "today-digest", labels: ["INBOX"], attention: "digest", category: "project-update", receivedAt });
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
         received_at, snippet, gmail_url, has_attachments, gmail_labels, is_unread, ingest_source,
         status, created_at, updated_at)
       VALUES ('today-new', 'acct-test', 'external-today-new', 'thread-today-new', 'New Sender',
         'new@example.com', 'Unprocessed', ?, 'Snippet', '#', 0, ?, 1, 'live', 'new', ?, ?)`,
      [receivedAt, JSON.stringify(["INBOX", "UNREAD"]), receivedAt, receivedAt],
    );

    const brief = await getTodayBrief();

    expect(brief.mailActivity).toMatchObject({
      receivedToday: 4,
      handledToday: 3,
      unhandledToday: 1,
      stillNeedsAttention: 1,
      lastPollAt: receivedAt,
    });
    expect(brief.mailActivity.attentionCounts).toMatchObject({
      interrupt: 1,
      digest: 1,
      suppress: 1,
      unknown: 1,
    });
    expect(brief.mailActivity.categoryCounts).toEqual(
      expect.arrayContaining([
        { category: "bulk-mail", count: 1 },
        { category: "deadline", count: 1 },
        { category: "project-update", count: 1 },
        { category: "uncategorized", count: 1 },
      ]),
    );
  });

  it("reconciles provider-read state without reviving cleared or deleted mail", async () => {
    await seedMessage({ id: "sync-read", labels: ["INBOX", "UNREAD"], attention: "interrupt", status: "triaged" });
    await seedMessage({ id: "sync-cleared", labels: ["INBOX"], attention: "interrupt", status: "cleared", isUnread: false });
    await seedMessage({ id: "sync-deleted", labels: ["TRASH"], attention: "interrupt", status: "deleted", isUnread: false });

    for (const id of ["sync-read", "sync-cleared", "sync-deleted"]) {
      await ingestMessage({
        accountId: "acct-test",
        externalMessageId: `external-${id}`,
        threadId: `thread-${id}`,
        senderName: "Provider Sender",
        senderEmail: `${id}@example.com`,
        subject: `Provider ${id}`,
        receivedAt: minutesAgo(1),
        snippet: "Provider state",
        gmailUrl: "#",
        labels: id === "sync-deleted" ? ["TRASH"] : ["INBOX"],
        isUnread: false,
        attachments: [],
      });
    }

    const rows = await execute(
      `SELECT id, status, is_unread FROM email_messages
       WHERE id IN ('sync-read', 'sync-cleared', 'sync-deleted')
       ORDER BY id`,
    );

    expect(rows.rows).toEqual([
      expect.objectContaining({ id: "sync-cleared", status: "cleared", is_unread: 0 }),
      expect.objectContaining({ id: "sync-deleted", status: "deleted", is_unread: 0 }),
      expect.objectContaining({ id: "sync-read", status: "read", is_unread: 0 }),
    ]);
  });

  it("filters Inbox by Gmail tabs, treating Primary as uncategorized inbox mail", async () => {
    await seedMessage({ id: "primary-mail", labels: ["INBOX", "UNREAD"], attention: "digest" });
    await seedMessage({ id: "promo-mail", labels: ["INBOX", "CATEGORY_PROMOTIONS", "UNREAD"], attention: "suppress" });
    await seedMessage({ id: "updates-mail", labels: ["INBOX", "CATEGORY_UPDATES", "UNREAD"], attention: "digest" });

    const primary = await getMailPage({ folder: "inbox", inboxCategory: "primary", limit: 10 });
    const promotions = await getMailPage({ folder: "inbox", inboxCategory: "promotions", limit: 10 });
    const updates = await getMailPage({ folder: "inbox", inboxCategory: "updates", limit: 10 });

    expect(primary.items.map((item) => item.id)).toEqual(["primary-mail"]);
    expect(promotions.items.map((item) => item.id)).toEqual(["promo-mail"]);
    expect(updates.items.map((item) => item.id)).toEqual(["updates-mail"]);
  });

  it("keeps Today activity scoped to the selected account workspace", async () => {
    await seedMicrosoftAccount();
    const receivedAt = minutesAgo(4);
    await seedMessage({ id: "gmail-workspace-today", accountId: "acct-test", attention: "interrupt", receivedAt });
    await seedMessage({ id: "hotmail-workspace-today", accountId: "acct-hotmail", attention: "digest", receivedAt });

    const gmail = await getTodayBrief({ workspaceId: "workspace:gmail" });
    const hotmail = await getTodayBrief({ workspaceId: "workspace:microsoft" });
    const all = await getTodayBrief({ workspaceId: "workspace:all" });

    expect(gmail.mailActivity.receivedToday).toBe(1);
    expect(gmail.mailActivity.attentionCounts.interrupt).toBe(1);
    expect(hotmail.mailActivity.receivedToday).toBe(1);
    expect(hotmail.mailActivity.attentionCounts.digest).toBe(1);
    expect(all.mailActivity.receivedToday).toBe(2);
  });

  it("shows handled mail in One More Glance without reviving active or destructive mail", async () => {
    await seedMessage({
      id: "glance-read",
      labels: ["INBOX"],
      status: "read",
      isUnread: false,
      attention: "digest",
      category: "job-application",
      summary: "A recruiter update that was already read.",
    });
    await seedMessage({
      id: "glance-cleared",
      labels: ["INBOX"],
      status: "cleared",
      isUnread: false,
      attention: "interrupt",
      category: "account-security",
      summary: "A priority item the user already acknowledged.",
    });
    await seedMessage({
      id: "glance-active",
      labels: ["INBOX", "UNREAD"],
      status: "triaged",
      attention: "interrupt",
      urgency: 94,
    });
    await seedMessage({
      id: "glance-cleanup",
      labels: ["INBOX", "UNREAD"],
      status: "triaged",
      attention: "suppress",
      category: "bulk-mail",
    });
    await seedMessage({
      id: "glance-trash",
      labels: ["TRASH"],
      status: "deleted",
      isUnread: false,
      attention: "digest",
    });
    await seedMessage({
      id: "glance-thread-old",
      threadId: "glance-thread",
      labels: ["INBOX"],
      status: "read",
      isUnread: false,
      receivedAt: minutesAgo(9),
      attention: "digest",
    });
    await seedMessage({
      id: "glance-thread-latest",
      threadId: "glance-thread",
      labels: ["INBOX"],
      status: "read",
      isUnread: false,
      receivedAt: minutesAgo(3),
      attention: "digest",
    });

    const brief = await getTodayBrief();
    const glanceIds = brief.oneMoreGlance.map((item) => item.id);

    expect(glanceIds).toEqual(expect.arrayContaining(["glance-read", "glance-cleared", "glance-thread-latest"]));
    expect(glanceIds).not.toEqual(
      expect.arrayContaining(["glance-active", "glance-cleanup", "glance-trash", "glance-thread-old"]),
    );
    expect(brief.topics.map((topic) => topic.id)).toContain("glance-active");
    expect(brief.oneMoreGlance.find((item) => item.id === "glance-read")).toMatchObject({
      reasonLabel: "Marked read",
      category: "job-application",
    });
    expect(brief.oneMoreGlance.find((item) => item.id === "glance-cleared")).toMatchObject({
      reasonLabel: "Acknowledged earlier",
    });
  });

  it("keeps One More Glance scoped to the selected account workspace", async () => {
    await seedMicrosoftAccount();
    await seedMessage({
      id: "gmail-glance",
      accountId: "acct-test",
      labels: ["INBOX"],
      status: "read",
      isUnread: false,
      receivedAt: minutesAgo(4),
    });
    await seedMessage({
      id: "hotmail-glance",
      accountId: "acct-hotmail",
      labels: ["INBOX"],
      status: "read",
      isUnread: false,
      receivedAt: minutesAgo(3),
    });

    const gmail = await getTodayBrief({ workspaceId: "workspace:gmail" });
    const hotmail = await getTodayBrief({ workspaceId: "workspace:microsoft" });
    const all = await getTodayBrief({ workspaceId: "workspace:all" });

    expect(gmail.oneMoreGlance.map((item) => item.id)).toEqual(["gmail-glance"]);
    expect(hotmail.oneMoreGlance.map((item) => item.id)).toEqual(["hotmail-glance"]);
    expect(all.oneMoreGlance.map((item) => item.id)).toEqual(["hotmail-glance", "gmail-glance"]);
  });

  it("builds a workspace-scoped Today history drawer from messages and actions", async () => {
    await seedMicrosoftAccount();
    const createdAt = nowIso();
    await seedMessage({
      id: "history-received",
      labels: ["INBOX"],
      status: "read",
      isUnread: false,
      attention: "digest",
      category: "job-application",
    });
    await seedMessage({
      id: "history-quiet",
      labels: ["INBOX"],
      status: "maintained",
      isUnread: false,
      attention: "suppress",
      category: "bulk-mail",
    });
    await seedMessage({
      id: "history-active",
      labels: ["INBOX", "UNREAD"],
      status: "triaged",
      attention: "interrupt",
      urgency: 91,
      category: "account-security",
    });
    await seedMessage({
      id: "history-done",
      labels: ["INBOX", "UNREAD"],
      status: "triaged",
      attention: "digest",
    });
    await seedMessage({
      id: "history-hotmail",
      accountId: "acct-hotmail",
      labels: ["INBOX"],
      status: "read",
      isUnread: false,
      attention: "digest",
    });
    await applyProfessionalMailAction({ action: "done", messageIds: ["history-done"] });
    await execute(
      `INSERT INTO mail_actions
        (id, action, status, message_ids, success_count, failure_count, details, created_at, executed_at)
       VALUES ('history-failed-action', 'mark_read', 'failed', ?, 0, 1, ?, ?, ?)`,
      [
        JSON.stringify(["history-received"]),
        JSON.stringify({
          failures: [{ id: "history-received", error: "Provider timeout" }],
          changedIds: [],
          unchangedIds: [],
        }),
        createdAt,
        createdAt,
      ],
    );

    const gmail = await getTodayBrief({ workspaceId: "workspace:gmail" });
    const hotmail = await getTodayBrief({ workspaceId: "workspace:microsoft" });
    const section = (brief: Awaited<ReturnType<typeof getTodayBrief>>, kind: string) =>
      brief.history.sections.find((item) => item.kind === kind);

    expect(section(gmail, "received")?.count).toBe(4);
    expect(section(gmail, "received")?.items.map((item) => item.messageId)).not.toContain("history-hotmail");
    expect(section(gmail, "quieted")?.items.map((item) => item.messageId)).toContain("history-quiet");
    expect(section(gmail, "still_needs_action")?.items.map((item) => item.messageId)).toContain("history-active");
    expect(section(gmail, "still_needs_action")?.items.map((item) => item.messageId)).not.toContain("history-done");
    expect(section(gmail, "handled")?.items).toEqual([
      expect.objectContaining({ action: "done", title: "Acknowledged mail", successCount: 1 }),
    ]);
    expect(section(gmail, "failed")?.items).toEqual([
      expect.objectContaining({ action: "mark_read", title: "Problem with Acknowledged mail", failureCount: 1 }),
    ]);
    expect(section(hotmail, "received")?.items.map((item) => item.messageId)).toEqual(["history-hotmail"]);
    expect(section(hotmail, "handled")?.count).toBe(0);
    expect(section(hotmail, "failed")?.count).toBe(0);
  });

  it("keeps Mail results scoped to the selected account workspace", async () => {
    await seedMicrosoftAccount();
    await seedMessage({ id: "gmail-workspace-mail", accountId: "acct-test", subject: "Gmail lane" });
    await seedMessage({ id: "hotmail-workspace-mail", accountId: "acct-hotmail", subject: "Hotmail lane" });

    const gmail = await getMailPage({ folder: "inbox", workspaceId: "workspace:gmail", limit: 10 });
    const hotmail = await getMailPage({ folder: "inbox", workspaceId: "workspace:microsoft", limit: 10 });
    const all = await getMailPage({ folder: "inbox", workspaceId: "workspace:all", limit: 10 });

    expect(gmail.items.map((item) => item.id)).toEqual(["gmail-workspace-mail"]);
    expect(hotmail.items.map((item) => item.id)).toEqual(["hotmail-workspace-mail"]);
    expect(all.items.map((item) => item.id)).toEqual(["hotmail-workspace-mail", "gmail-workspace-mail"]);
  });

  it("uses the owning provider's declared spam folder mapping in Mail", async () => {
    await seedMicrosoftAccount();
    await seedMessage({ id: "gmail-spam", accountId: "acct-test", labels: ["SPAM"] });
    await seedMessage({ id: "hotmail-junk", accountId: "acct-hotmail", labels: ["JUNK"] });

    const page = await getMailPage({ folder: "spam", workspaceId: "workspace:all", limit: 10 });

    expect(page.items.map((item) => item.id)).toEqual(["hotmail-junk", "gmail-spam"]);
  });

  it("allows Microsoft workspace mail to use reversible delete actions", async () => {
    await seedMicrosoftAccount();
    await seedMessage({ id: "hotmail-delete", accountId: "acct-hotmail", labels: ["INBOX", "UNREAD"], attention: "digest" });

    const action = await applyProfessionalMailAction({ action: "delete", messageIds: ["hotmail-delete"] });
    const changed = await execute(`SELECT status, is_unread, gmail_labels FROM email_messages WHERE id = 'hotmail-delete'`);
    const undone = await applyProfessionalMailAction({ action: "undo", actionId: action.actionId });
    const restored = await execute(`SELECT status, is_unread, gmail_labels FROM email_messages WHERE id = 'hotmail-delete'`);

    expect(action).toMatchObject({ successCount: 1, reversible: true });
    expect(changed.rows[0]).toMatchObject({ status: "deleted", is_unread: 0 });
    expect(JSON.parse(String(changed.rows[0].gmail_labels))).toEqual(expect.arrayContaining(["TRASH"]));
    expect(undone.successCount).toBe(1);
    expect(restored.rows[0]).toMatchObject({ status: "triaged", is_unread: 1 });
    expect(JSON.parse(String(restored.rows[0].gmail_labels))).toEqual(expect.arrayContaining(["INBOX", "UNREAD"]));
  });

  it("routes a non-test Microsoft workspace delete and undo through its provider adapter", async () => {
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-adapter-outlook', 'microsoft', 'owner@outlook.example', 'Outlook', 'connected', ?, ?)`,
      [nowIso(), nowIso()],
    );
    await seedMessage({
      id: "hotmail-adapter-delete",
      accountId: "acct-adapter-outlook",
      labels: ["INBOX", "UNREAD"],
      attention: "digest",
    });

    const action = await applyProfessionalMailAction({ action: "delete", messageIds: ["hotmail-adapter-delete"] });
    await applyProfessionalMailAction({ action: "undo", actionId: action.actionId });

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("microsoft");
    expect(adapterCalls.adapter.applyWorkspaceAction).toHaveBeenCalledWith(
      "owner@outlook.example",
      "trash",
      ["external-hotmail-adapter-delete"],
    );
    expect(adapterCalls.adapter.undoWorkspaceAction).toHaveBeenCalledWith(
      "owner@outlook.example",
      "trash",
      ["external-hotmail-adapter-delete"],
      ["external-hotmail-adapter-delete"],
    );
  });

  it("allows Microsoft quiet actions without using Gmail permissions", async () => {
    await seedMicrosoftAccount();
    await seedMessage({
      id: "hotmail-quiet",
      accountId: "acct-hotmail",
      senderEmail: "newsletter@example.com",
      labels: ["INBOX", "UNREAD"],
      attention: "suppress",
      category: "bulk-mail",
    });

    const action = await applyProfessionalMailAction({ action: "quiet", messageIds: ["hotmail-quiet"] });
    const changed = await execute(`SELECT status, is_unread FROM email_messages WHERE id = 'hotmail-quiet'`);
    const rule = await execute(
      `SELECT action FROM maintenance_rules WHERE account_id = 'acct-hotmail' AND sender_email = 'newsletter@example.com'`,
    );

    expect(action.successCount).toBe(1);
    expect(changed.rows[0]).toMatchObject({ status: "maintained", is_unread: 0 });
    expect(rule.rows[0]).toMatchObject({ action: "mark_read" });
  });

  it("lets cleanup suggestions be corrected as useful or priority mail", async () => {
    await seedMessage({
      id: "cleanup-correction",
      senderEmail: "jobs@example.com",
      labels: ["INBOX", "UNREAD"],
      attention: "suppress",
      category: "bulk-mail",
    });

    const keep = await applyProfessionalMailAction({ action: "keep", messageIds: ["cleanup-correction"] });
    let corrected = await execute(
      `SELECT user_corrected_attention FROM triage_decisions WHERE message_id = 'cleanup-correction'`,
    );
    let preference = await execute(
      `SELECT action FROM learned_preferences WHERE account_id = 'acct-test' AND pattern = 'jobs@example.com' AND enabled = 1`,
    );

    expect(keep).toMatchObject({ successCount: 1, reversible: true });
    expect(corrected.rows[0]).toMatchObject({ user_corrected_attention: "digest" });
    expect(preference.rows[0]).toMatchObject({ action: "digest" });

    const raise = await applyProfessionalMailAction({ action: "raise_priority", messageIds: ["cleanup-correction"] });
    corrected = await execute(
      `SELECT user_corrected_attention FROM triage_decisions WHERE message_id = 'cleanup-correction'`,
    );
    preference = await execute(
      `SELECT action FROM learned_preferences WHERE account_id = 'acct-test' AND pattern = 'jobs@example.com' AND enabled = 1`,
    );

    expect(raise).toMatchObject({ successCount: 1, reversible: true });
    expect(corrected.rows[0]).toMatchObject({ user_corrected_attention: "interrupt" });
    expect(preference.rows[0]).toMatchObject({ action: "interrupt" });
  });

  it("teaches Ezra to care more about a sender", async () => {
    await seedMessage({
      id: "care-sender",
      senderEmail: "recruiter@target.test",
      attention: "suppress",
      category: "job-application",
    });

    const action = await applyProfessionalMailAction({
      action: "teach_care",
      messageIds: ["care-sender"],
      care: "more",
      scopes: ["sender"],
    });
    const preference = await execute(
      `SELECT kind, pattern, action, evidence_count
       FROM learned_preferences
       WHERE account_id = 'acct-test' AND kind = 'sender' AND pattern = 'recruiter@target.test'`,
    );
    const correction = await execute(
      `SELECT user_corrected_attention FROM triage_decisions WHERE message_id = 'care-sender'`,
    );

    expect(action).toMatchObject({ successCount: 1, failureCount: 0, reversible: false });
    expect(action.savedPreferences).toEqual([
      expect.objectContaining({ kind: "sender", pattern: "recruiter@target.test", action: "interrupt" }),
    ]);
    expect(preference.rows[0]).toMatchObject({ kind: "sender", action: "interrupt", evidence_count: 1 });
    expect(correction.rows[0]).toMatchObject({ user_corrected_attention: "interrupt" });
  });

  it("teaches Ezra to care more about an editable topic", async () => {
    await seedMessage({
      id: "care-topic",
      senderEmail: "jennifer@target.test",
      attention: "digest",
      category: "job-application",
      subject: "Target Application Follow Up",
    });

    const action = await applyProfessionalMailAction({
      action: "teach_care",
      messageIds: ["care-topic"],
      care: "more",
      scopes: ["topic"],
      topicLabel: "Job Application / Interview Request",
    });
    const preference = await execute(
      `SELECT kind, pattern, action
       FROM learned_preferences
       WHERE account_id = 'acct-test' AND kind = 'topic'`,
    );

    expect(action.savedPreferences).toEqual([
      expect.objectContaining({
        kind: "topic",
        pattern: "job application interview request",
        action: "interrupt",
      }),
    ]);
    expect(preference.rows[0]).toMatchObject({
      kind: "topic",
      pattern: "job application interview request",
      action: "interrupt",
    });
  });

  it("uses topic care traces for future similar mail without crossing accounts", async () => {
    await seedMicrosoftAccount();
    await seedMessage({
      id: "topic-source",
      senderEmail: "jobs@company.test",
      attention: "digest",
      category: "job-application",
      subject: "Interview request",
    });
    await applyProfessionalMailAction({
      action: "teach_care",
      messageIds: ["topic-source"],
      care: "less",
      scopes: ["topic"],
      topicLabel: "Job Application / Interview Request",
    });
    await seedMessage({
      id: "same-topic",
      senderEmail: "other-recruiter@example.test",
      attention: "interrupt",
      category: "job application interview request",
      subject: "Interview scheduling request",
    });
    await seedMessage({
      id: "hotmail-topic",
      accountId: "acct-hotmail",
      senderEmail: "other-recruiter@example.test",
      attention: "interrupt",
      category: "job application interview request",
      subject: "Interview scheduling request",
    });

    const sameAccount = await getProfessionalMessageDetail("same-topic");
    const hotmail = await getProfessionalMessageDetail("hotmail-topic");

    expect(sameAccount.detail.careTrace?.matchingPreferences).toEqual([
      expect.objectContaining({ kind: "topic", pattern: "job application interview request", action: "suppress" }),
    ]);
    expect(hotmail.detail.careTrace?.matchingPreferences).toEqual([]);
  });

  it("applies current care correction across the message thread", async () => {
    await seedMessage({ id: "thread-care-1", threadId: "care-thread", attention: "digest" });
    await seedMessage({ id: "thread-care-2", threadId: "care-thread", attention: "digest" });

    await applyProfessionalMailAction({
      action: "teach_care",
      messageIds: ["thread-care-1"],
      care: "less",
      scopes: ["message"],
    });
    const corrections = await execute(
      `SELECT message_id, user_corrected_attention
       FROM triage_decisions
       WHERE message_id IN ('thread-care-1', 'thread-care-2')
       ORDER BY message_id`,
    );

    expect(corrections.rows).toEqual([
      expect.objectContaining({ message_id: "thread-care-1", user_corrected_attention: "suppress" }),
      expect.objectContaining({ message_id: "thread-care-2", user_corrected_attention: "suppress" }),
    ]);
  });

  it("scopes learned sender preferences per account", async () => {
    await seedMicrosoftAccount();
    await seedMessage({ id: "gmail-learning", accountId: "acct-test", senderEmail: "same@example.com" });
    await seedMessage({ id: "hotmail-learning", accountId: "acct-hotmail", senderEmail: "same@example.com" });

    await recordFeedback("gmail-learning", "suppress");
    await recordFeedback("hotmail-learning", "interrupt");

    const rows = await execute(
      `SELECT account_id, action, evidence_count
       FROM learned_preferences
       WHERE kind = 'sender' AND pattern = 'same@example.com'
       ORDER BY account_id`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((row) => [row.account_id, row.action])).toEqual([
      ["acct-hotmail", "interrupt"],
      ["acct-test", "suppress"],
    ]);
  });

  it("manages cleanup, sender, and topic learning rules by workspace", async () => {
    await seedMicrosoftAccount();
    const now = nowIso();
    await execute(
      `INSERT INTO maintenance_rules
        (id, account_id, sender_email, action, enabled, approved_at, created_at, updated_at)
       VALUES ('rule-gmail-cleanup', 'acct-test', 'newsletter@example.com', 'mark_read', 1, ?, ?, ?)`,
      [now, now, now],
    );
    await execute(
      `INSERT INTO learned_preferences
        (id, account_id, kind, pattern, action, weight, evidence_count, enabled, created_at, updated_at)
       VALUES
        ('pref-gmail-sender', 'acct-test', 'sender', 'recruiter@example.com', 'interrupt', 2, 3, 1, ?, ?),
        ('pref-gmail-topic', 'acct-test', 'topic', 'job application interview request', 'interrupt', 2, 2, 1, ?, ?),
        ('pref-hotmail-topic', 'acct-hotmail', 'topic', 'book submission', 'interrupt', 2, 4, 1, ?, ?)`,
      [now, now, now, now, now, now],
    );

    const gmailRules = await getRules({ workspaceId: "workspace:gmail" });
    expect(gmailRules.map((rule) => rule.id)).toEqual(
      expect.arrayContaining(["rule-gmail-cleanup", "pref-gmail-sender", "pref-gmail-topic"]),
    );
    expect(gmailRules.map((rule) => rule.id)).not.toContain("pref-hotmail-topic");
    expect(gmailRules.find((rule) => rule.id === "pref-gmail-topic")).toMatchObject({
      source: "priority",
      kind: "topic",
      target: "job application interview request",
      accountLabel: "Personal",
      accountProvider: "gmail",
      evidenceCount: 2,
    });

    const disabledRules = await updateRule({
      id: "pref-gmail-topic",
      source: "priority",
      enabled: false,
      workspaceId: "workspace:gmail",
    });
    expect(disabledRules.find((rule) => rule.id === "pref-gmail-topic")).toMatchObject({ enabled: false });

    const editedRules = await updateRule({
      id: "pref-gmail-sender",
      source: "priority",
      action: "digest",
      workspaceId: "workspace:gmail",
    });
    expect(editedRules.find((rule) => rule.id === "pref-gmail-sender")).toMatchObject({ action: "digest", accountId: "acct-test", target: "recruiter@example.com" });

    const removedRules = await deleteRule({
      id: "rule-gmail-cleanup",
      source: "cleanup",
      workspaceId: "workspace:gmail",
    });
    expect(removedRules.map((rule) => rule.id)).not.toContain("rule-gmail-cleanup");

    const hotmailRules = await getRules({ workspaceId: "workspace:microsoft" });
    expect(hotmailRules.map((rule) => rule.id)).toEqual(["pref-hotmail-topic"]);
    expect(hotmailRules[0]).toMatchObject({ accountProvider: "microsoft", kind: "topic" });
  });

  it("normalizes Microsoft read-only messages into the shared inbox shape", () => {
    const envelope = normalizeMicrosoftMessage("acct-hotmail", {
      id: "graph-1",
      conversationId: "conversation-1",
      subject: "Submission response",
      receivedDateTime: "2026-06-28T15:30:00.000Z",
      bodyPreview: "Thanks for the submission.",
      body: { contentType: "html", content: "<p>Thanks &amp; good luck.</p>" },
      from: { emailAddress: { name: "Editor", address: "editor@example.com" } },
      isRead: false,
      webLink: "https://outlook.live.com/mail/0/id/graph-1",
      hasAttachments: true,
      categories: ["Submissions"],
    });

    expect(envelope).toMatchObject({
      accountId: "acct-hotmail",
      externalMessageId: "graph-1",
      threadId: "conversation-1",
      senderName: "Editor",
      senderEmail: "editor@example.com",
      subject: "Submission response",
      isUnread: true,
      gmailUrl: "https://outlook.live.com/mail/0/id/graph-1",
    });
    expect(envelope.bodyText).toBe("Thanks & good luck.");
    expect(envelope.labels).toEqual(expect.arrayContaining(["INBOX", "UNREAD", "MS_CATEGORY:Submissions"]));
    expect(envelope.attachments).toHaveLength(1);
  });
});

async function seedMessage(input: {
  id: string;
  accountId?: string;
  threadId?: string;
  senderEmail?: string;
  subject?: string;
  labels?: string[];
  attention?: AttentionLevel;
  urgency?: number;
  category?: string;
  summary?: string;
  receivedAt?: string;
  needsReply?: boolean;
  status?: string;
  isUnread?: boolean;
}) {
  const receivedAt = input.receivedAt || minutesAgo(1);
  const labels = input.labels || ["INBOX", "UNREAD"];
  const isUnread = input.isUnread ?? labels.includes("UNREAD");
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
       received_at, snippet, gmail_url, has_attachments, gmail_labels, is_unread, ingest_source,
       status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Example Sender', ?, ?, ?, 'Message snippet', '#', 0, ?, ?,
       'live', ?, ?, ?)`,
    [
      input.id,
      input.accountId || "acct-test",
      `external-${input.id}`,
      input.threadId || `thread-${input.id}`,
      input.senderEmail || `${input.id}@example.com`,
      input.subject || `Subject ${input.id}`,
      receivedAt,
      JSON.stringify(labels),
      isUnread ? 1 : 0,
      input.status || "triaged",
      receivedAt,
      receivedAt,
    ],
  );
  await saveTriageDecision(input.id, "test-model", {
    attention: input.attention || "digest",
    urgency: input.urgency ?? 55,
    confidence: 0.95,
    category: input.category || "general",
    summary: input.summary || `Summary ${input.id}`,
    reason: "Test reason",
    recommendation: "Review",
    needsReply: input.needsReply || false,
    deadline: null,
    draftReply: null,
    injectionFlags: [],
    criticalReason: null,
  });
}

async function seedMicrosoftAccount() {
  await execute(
    `INSERT INTO email_accounts
      (id, provider, email, label, status, created_at, updated_at)
     VALUES ('acct-hotmail', 'microsoft', 'owner@hotmail.test', 'Hotmail', 'connected', ?, ?)`,
    [nowIso(), nowIso()],
  );
}

async function seedProviderAccess(accountId: string, provider: "gmail" | "microsoft", access: string) {
  const now = nowIso();
  await execute(
    `INSERT INTO provider_account_credentials
      (account_id, provider, credential_backend, credential_reference, access, verified_at, updated_at)
     VALUES (?, ?, 'test', 'provider-managed', ?, ?, ?)`,
    [accountId, provider, access, now, now],
  );
}

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}
