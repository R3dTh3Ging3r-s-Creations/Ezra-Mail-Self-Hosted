import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listBriefMemory, reconcileBriefMemory } from "@/lib/email/brief-memory";
import { configureEmailDatabaseForTests, execute } from "@/lib/email/database";
import { reconcileExternalReplyEvidence } from "@/lib/email/sent-evidence";
import type { ProviderSentEvidence } from "@/lib/email/provider-adapter";
import type { AccountProvider, BriefCandidate, LivingBriefItem } from "@/lib/email/types";

const adapters = vi.hoisted(() => {
  const reads = { gmail: vi.fn(), microsoft: vi.fn() };
  return {
    reads,
    providerAdapterFor: vi.fn((provider: "gmail" | "microsoft") => ({ readSentEvidence: reads[provider] })),
  };
});

vi.mock("@/lib/email/provider-adapter", () => ({ providerAdapterFor: adapters.providerAdapterFor }));

describe("external reply evidence reconciliation", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./sent-evidence-${randomUUID()}.sqlite`);
    adapters.providerAdapterFor.mockClear();
    adapters.reads.gmail.mockReset().mockResolvedValue({ items: [], truncated: false });
    adapters.reads.microsoft.mockReset().mockResolvedValue({ items: [], truncated: false });
    await seedAccount("gmail-1", "gmail", "one@gmail.test");
    await seedAccount("gmail-2", "gmail", "two@gmail.test");
    await seedAccount("ms-1", "microsoft", "one@microsoft.test");
  });

  it("completes exact Gmail evidence with one bounded read and stores no mail content", async () => {
    const item = await seedOpen(replyCandidate({ title: "Quarterly review", summary: "Sensitive summary" }));
    adapters.reads.gmail.mockResolvedValue({ items: [{ ...sentEvidence(), subject: "Quarterly review", body: "do not persist" }], truncated: false });

    const result = await reconcileExternalReplyEvidence({ workspaceId: item.workspaceId, openReplies: [item], now: "2026-08-30T15:00:00.000Z" });

    expect(result).toEqual({
      completedSourceKeys: [item.sourceKey],
      accountHealth: [{ accountId: "gmail-1", provider: "gmail", status: "current", lastAttemptedAt: "2026-08-30T15:00:00.000Z", lastSuccessfulAt: "2026-08-30T15:00:00.000Z", errorCode: null, truncated: false }],
    });
    expect(adapters.providerAdapterFor).toHaveBeenCalledTimes(1);
    expect(adapters.providerAdapterFor).toHaveBeenCalledWith("gmail");
    expect(adapters.reads.gmail).toHaveBeenCalledTimes(1);
    expect(adapters.reads.gmail).toHaveBeenCalledWith("one@gmail.test", "gmail-1", { after: "2026-08-30T14:00:00.000Z", before: "2026-08-30T15:00:00.000Z", maxResults: 100 });
    expect((await listBriefMemory(item.workspaceId, "2026-08-30T15:01:00.000Z")).completedToday[0]).toMatchObject({ sourceKey: item.sourceKey, state: "completed", completedAt: "2026-08-30T14:10:00.000Z" });
    const evidence = await execute("SELECT * FROM reply_completion_evidence");
    expect(evidence.rows).toEqual([expect.objectContaining({ brief_item_id: item.id, source_key: item.sourceKey, account_id: "gmail-1", provider: "gmail", provider_message_id: "sent-1", provider_thread_id: "thread-1", provider_sent_at: "2026-08-30T14:10:00.000Z", observed_at: "2026-08-30T15:00:00.000Z" })]);
    const storedJson = String((await execute("SELECT completion_evidence_json FROM brief_item_memory WHERE id = ?", [item.id])).rows[0].completion_evidence_json);
    expect(JSON.parse(storedJson)).toEqual({ kind: "external_reply", evidenceId: expect.any(String) });
    expect(JSON.stringify({ result, evidence: evidence.rows, storedJson })).not.toContain("Quarterly review");
    expect(JSON.stringify({ result, evidence: evidence.rows, storedJson })).not.toContain("Sensitive summary");
    expect(JSON.stringify({ result, evidence: evidence.rows, storedJson })).not.toContain("do not persist");
  });

  it("completes Microsoft evidence and chooses earliest sent time then message ID", async () => {
    const item = await seedOpen(replyCandidate({ sourceKey: "mail:ms-1:conversation-1", sourceAccountId: "ms-1", provider: "microsoft", providerThreadId: "conversation-1" }), "workspace:account:microsoft:ms-1");
    adapters.reads.microsoft.mockResolvedValue({ items: [
      sentEvidence({ accountId: "ms-1", provider: "microsoft", providerMessageId: "sent-z", providerThreadId: "conversation-1", sentAt: "2026-08-30T14:05:00.000Z" }),
      sentEvidence({ accountId: "ms-1", provider: "microsoft", providerMessageId: "sent-later", providerThreadId: "conversation-1", sentAt: "2026-08-30T14:20:00.000Z" }),
      sentEvidence({ accountId: "ms-1", provider: "microsoft", providerMessageId: "sent-a", providerThreadId: "conversation-1", sentAt: "2026-08-30T14:05:00.000Z" }),
    ], truncated: false });

    const result = await reconcileExternalReplyEvidence({ workspaceId: item.workspaceId, openReplies: [item], now: "2026-08-30T15:00:00.000Z" });

    expect(result.completedSourceKeys).toEqual([item.sourceKey]);
    expect((await execute("SELECT provider_message_id FROM reply_completion_evidence")).rows[0].provider_message_id).toBe("sent-a");
    expect(adapters.reads.microsoft).toHaveBeenCalledTimes(1);
  });

  it("reads each account once and rejects wrong account, provider, thread, title-only, and non-later matches", async () => {
    const gmail = await seedOpen(replyCandidate({ title: "Same title" }), "workspace:all");
    const microsoft = await seedOpen(replyCandidate({ sourceKey: "mail:ms-1:conversation-1", sourceAccountId: "ms-1", provider: "microsoft", providerThreadId: "conversation-1", title: "Same title" }), "workspace:all");
    adapters.reads.gmail.mockResolvedValue({ items: [
      sentEvidence({ accountId: "gmail-2" }),
      sentEvidence({ provider: "microsoft" }),
      sentEvidence({ providerThreadId: "different-thread" }),
      sentEvidence({ providerMessageId: "same-time", sentAt: gmail.revisionAt }),
      sentEvidence({ providerMessageId: "before", sentAt: "2026-08-30T13:59:59.999Z" }),
      { ...sentEvidence({ providerMessageId: "title-only", providerThreadId: "other" }), title: "Same title" },
    ], truncated: false });

    const result = await reconcileExternalReplyEvidence({ workspaceId: "workspace:all", openReplies: [microsoft, gmail], now: "2026-08-30T15:00:00.000Z" });

    expect(result.completedSourceKeys).toEqual([]);
    expect(adapters.reads.gmail).toHaveBeenCalledTimes(1);
    expect(adapters.reads.microsoft).toHaveBeenCalledTimes(1);
    expect((await listBriefMemory("workspace:all", "2026-08-30T15:01:00.000Z")).items.map((row) => row.sourceKey).sort()).toEqual([gmail.sourceKey, microsoft.sourceKey].sort());
  });

  it("discards malformed, future, and outside-window rows and keeps empty-feed items open", async () => {
    const item = await seedOpen(replyCandidate({ revisionAt: "2026-08-01T12:00:00.000Z" }));
    adapters.reads.gmail.mockResolvedValue({ items: [
      sentEvidence({ providerMessageId: "outside", sentAt: "2026-08-16T15:00:01.999Z" }),
      sentEvidence({ providerMessageId: "future", sentAt: "2026-08-30T15:00:00.001Z" }),
      sentEvidence({ providerMessageId: "invalid", sentAt: "not-a-date" }),
      sentEvidence({ providerMessageId: "", sentAt: "2026-08-30T14:00:00.000Z" }),
      { ...sentEvidence({ providerMessageId: "missing-thread", sentAt: "2026-08-30T14:00:00.000Z" }), providerThreadId: null },
    ], truncated: false });

    const malformed = await reconcileExternalReplyEvidence({ workspaceId: item.workspaceId, openReplies: [item], now: "2026-08-30T15:00:00.000Z" });
    expect(malformed.completedSourceKeys).toEqual([]);
    expect(malformed.accountHealth[0]).toMatchObject({ status: "current", lastSuccessfulAt: "2026-08-30T15:00:00.000Z" });
    expect(adapters.reads.gmail).toHaveBeenCalledWith("one@gmail.test", "gmail-1", { after: "2026-08-16T15:00:02.000Z", before: "2026-08-30T15:00:00.000Z", maxResults: 100 });
    adapters.reads.gmail.mockResolvedValue({ items: [], truncated: false });
    expect((await reconcileExternalReplyEvidence({ workspaceId: item.workspaceId, openReplies: [item], now: "2026-08-30T15:01:00.000Z" })).completedSourceKeys).toEqual([]);
    expect((await listBriefMemory(item.workspaceId, "2026-08-30T15:02:00.000Z")).items).toHaveLength(1);
  });

  it("isolates errors by account, redacts them, and preserves a prior success", async () => {
    const gmail = await seedOpen(replyCandidate(), "workspace:all");
    const microsoft = await seedOpen(replyCandidate({ sourceKey: "mail:ms-1:conversation-1", sourceAccountId: "ms-1", provider: "microsoft", providerThreadId: "conversation-1" }), "workspace:all");
    await execute(`INSERT INTO sent_evidence_sync_state (account_id, provider, status, last_attempted_at, last_successful_at, last_error_code, truncated, created_at, updated_at) VALUES ('gmail-1', 'gmail', 'current', '2026-08-29T12:00:00.000Z', '2026-08-29T12:00:00.000Z', NULL, 0, '2026-08-29T12:00:00.000Z', '2026-08-29T12:00:00.000Z')`);
    adapters.reads.gmail.mockRejectedValue(new Error("secret mailbox token and raw provider text"));
    adapters.reads.microsoft.mockResolvedValue({ items: [sentEvidence({ accountId: "ms-1", provider: "microsoft", providerMessageId: "ms-sent", providerThreadId: "conversation-1" })], truncated: false });

    const result = await reconcileExternalReplyEvidence({ workspaceId: "workspace:all", openReplies: [gmail, microsoft], now: "2026-08-30T15:00:00.000Z" });

    expect(result.completedSourceKeys).toEqual([microsoft.sourceKey]);
    expect(result.accountHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: "gmail-1", status: "error", lastSuccessfulAt: "2026-08-29T12:00:00.000Z", errorCode: "provider_read_failed" }),
      expect.objectContaining({ accountId: "ms-1", status: "current", errorCode: null }),
    ]));
    const sync = await execute("SELECT * FROM sent_evidence_sync_state WHERE account_id = 'gmail-1'");
    expect(sync.rows[0]).toMatchObject({ status: "error", last_successful_at: "2026-08-29T12:00:00.000Z", last_error_code: "provider_read_failed", truncated: 0 });
    expect(JSON.stringify({ result, rows: sync.rows })).not.toContain("secret mailbox token");
    expect((await listBriefMemory("workspace:all", "2026-08-30T15:01:00.000Z")).items.map((row) => row.sourceKey)).toContain(gmail.sourceKey);
  });

  it("allows an exact match from a truncated page but leaves unmatched items open", async () => {
    const exact = await seedOpen(replyCandidate({ sourceKey: "mail:gmail-1:thread-1" }), "workspace:all");
    const unmatched = await seedOpen(replyCandidate({ sourceKey: "mail:gmail-1:thread-2", providerThreadId: "thread-2" }), "workspace:all");
    adapters.reads.gmail.mockResolvedValue({ items: [sentEvidence()], truncated: true });

    const result = await reconcileExternalReplyEvidence({ workspaceId: "workspace:all", openReplies: [unmatched, exact], now: "2026-08-30T15:00:00.000Z" });

    expect(result.completedSourceKeys).toEqual([exact.sourceKey]);
    expect(result.accountHealth[0]).toMatchObject({ status: "truncated", truncated: true, lastSuccessfulAt: "2026-08-30T15:00:00.000Z" });
    expect((await listBriefMemory("workspace:all", "2026-08-30T15:01:00.000Z")).items.map((row) => row.sourceKey)).toEqual([unmatched.sourceKey]);
  });

  it("uses the safe fourteen-day cutoff for old revisions and completes in-window evidence", async () => {
    const item = await seedOpen(replyCandidate({ revisionAt: "2026-07-01T12:00:00.000Z" }));
    adapters.reads.gmail.mockResolvedValue({ items: [sentEvidence({ sentAt: "2026-08-16T15:00:02.001Z" })], truncated: false });

    const result = await reconcileExternalReplyEvidence({ workspaceId: item.workspaceId, openReplies: [item], now: "2026-08-30T15:00:00.000Z" });

    expect(result.completedSourceKeys).toEqual([item.sourceKey]);
    expect(adapters.reads.gmail).toHaveBeenCalledWith("one@gmail.test", "gmail-1", expect.objectContaining({ after: "2026-08-16T15:00:02.000Z", before: "2026-08-30T15:00:00.000Z" }));
  });

  it("treats a malformed page as a redacted error without closing the item", async () => {
    const item = await seedOpen();
    adapters.reads.gmail.mockResolvedValue({ items: null, truncated: false });

    const result = await reconcileExternalReplyEvidence({ workspaceId: item.workspaceId, openReplies: [item], now: "2026-08-30T15:00:00.000Z" });

    expect(result.completedSourceKeys).toEqual([]);
    expect(result.accountHealth[0]).toMatchObject({ status: "error", errorCode: "malformed_provider_response", lastSuccessfulAt: null });
    expect((await listBriefMemory(item.workspaceId, "2026-08-30T15:01:00.000Z")).items).toHaveLength(1);
  });

  it("rejects an adapter page above the hard cap without using any returned match", async () => {
    const item = await seedOpen();
    adapters.reads.gmail.mockResolvedValue({
      items: Array.from({ length: 101 }, (_, index) => sentEvidence({ providerMessageId: `sent-${index}` })),
      truncated: false,
    });

    const result = await reconcileExternalReplyEvidence({ workspaceId: item.workspaceId, openReplies: [item], now: "2026-08-30T15:00:00.000Z" });

    expect(result.completedSourceKeys).toEqual([]);
    expect(result.accountHealth[0]).toMatchObject({ status: "error", errorCode: "malformed_provider_response" });
    expect((await execute("SELECT COUNT(*) AS count FROM reply_completion_evidence")).rows[0].count).toBe(0);
  });

  it("propagates local provenance failures without recording a provider-read error", async () => {
    const item = await seedOpen();
    adapters.reads.gmail.mockResolvedValue({ items: [sentEvidence()], truncated: false });
    await execute(`CREATE TRIGGER fail_reply_evidence BEFORE INSERT ON reply_completion_evidence BEGIN SELECT RAISE(ABORT, 'local store failed'); END`);

    await expect(reconcileExternalReplyEvidence({ workspaceId: item.workspaceId, openReplies: [item], now: "2026-08-30T15:00:00.000Z" })).rejects.toThrow("local store failed");

    expect((await execute("SELECT status, last_successful_at, last_error_code FROM sent_evidence_sync_state WHERE account_id = 'gmail-1'")).rows[0]).toMatchObject({
      status: "current",
      last_successful_at: "2026-08-30T15:00:00.000Z",
      last_error_code: null,
    });
  });

  it("rejects wrong-workspace, non-open, non-mail, and disabled-account inputs before reads", async () => {
    const item = await seedOpen(replyCandidate(), "workspace:all");
    await expect(reconcileExternalReplyEvidence({ workspaceId: "workspace:account:microsoft:ms-1", openReplies: [item], now: "2026-08-30T15:00:00.000Z" })).rejects.toThrow("Sent evidence item is outside the selected workspace");
    await expect(reconcileExternalReplyEvidence({ workspaceId: "workspace:all", openReplies: [{ ...item, state: "completed" }], now: "2026-08-30T15:00:00.000Z" })).rejects.toThrow("Sent evidence requires exact open mail replies");
    await expect(reconcileExternalReplyEvidence({ workspaceId: "workspace:all", openReplies: [{ ...item, sourceType: "calendar_event" }], now: "2026-08-30T15:00:00.000Z" })).rejects.toThrow("Sent evidence requires exact open mail replies");
    await execute("UPDATE email_accounts SET status = 'disabled' WHERE id = 'gmail-1'");
    await expect(reconcileExternalReplyEvidence({ workspaceId: "workspace:all", openReplies: [item], now: "2026-08-30T15:00:00.000Z" })).rejects.toThrow("Sent evidence item is outside the selected workspace");
    expect(adapters.providerAdapterFor).not.toHaveBeenCalled();
  });

  it("rejects a fabricated mail clone of a stored account-bound non-mail item before reads", async () => {
    const calendar = await seedOpen({
      ...replyCandidate(),
      sourceType: "calendar_event",
      sourceKey: "calendar:gmail-1:event-1",
      providerThreadId: "thread-1",
      role: "agenda",
      target: { view: "calendar", eventId: "event-1", date: "2026-08-30" },
    }, "workspace:all");

    await expect(reconcileExternalReplyEvidence({
      workspaceId: "workspace:all",
      openReplies: [{ ...calendar, sourceType: "mail_thread" }],
      now: "2026-08-30T15:00:00.000Z",
    })).rejects.toThrow("Sent evidence requires exact open workspace replies");
    expect(adapters.providerAdapterFor).not.toHaveBeenCalled();
  });

  it("is idempotent, protects unique provider messages, and reopens on later incoming evidence", async () => {
    const first = await seedOpen(replyCandidate({ sourceKey: "mail:gmail-1:a", providerThreadId: "thread-1" }), "workspace:all");
    const second = await seedOpen(replyCandidate({ sourceKey: "mail:gmail-1:b", providerThreadId: "thread-1" }), "workspace:all");
    adapters.reads.gmail.mockResolvedValue({ items: [sentEvidence()], truncated: false });

    const initial = await reconcileExternalReplyEvidence({ workspaceId: "workspace:all", openReplies: [second, first], now: "2026-08-30T15:00:00.000Z" });
    const repeated = await reconcileExternalReplyEvidence({ workspaceId: "workspace:all", openReplies: [second], now: "2026-08-30T15:01:00.000Z" });

    expect(initial.completedSourceKeys).toEqual([first.sourceKey]);
    expect(repeated.completedSourceKeys).toEqual([]);
    expect((await execute("SELECT COUNT(*) AS count FROM reply_completion_evidence")).rows[0].count).toBe(1);
    expect((await execute("SELECT state FROM brief_item_memory WHERE source_key = ?", [second.sourceKey])).rows[0].state).toBe("open");

    const reopened = await reconcileBriefMemory({ workspaceId: "workspace:all", now: "2026-08-30T16:00:00.000Z", candidates: [replyCandidate({ sourceKey: first.sourceKey, providerThreadId: "thread-1", revisionAt: "2026-08-30T14:30:00.000Z", title: "New incoming revision" })] });
    expect(reopened.current[0]).toMatchObject({ sourceKey: first.sourceKey, state: "open", revisionAt: "2026-08-30T14:30:00.000Z" });
  });
});

function replyCandidate(overrides: Partial<BriefCandidate> = {}): BriefCandidate {
  return { sourceType: "mail_thread", sourceKey: "mail:gmail-1:thread-1", sourceAccountId: "gmail-1", provider: "gmail", providerThreadId: "thread-1", revisionAt: "2026-08-30T14:00:00.000Z", occurredAt: "2026-08-30T13:50:00.000Z", role: "attention", title: "Reply to Casey", summary: "A reply is waiting.", target: { view: "mail", messageId: "message-1" }, ...overrides };
}

function sentEvidence(overrides: Partial<ProviderSentEvidence> = {}): ProviderSentEvidence {
  return { accountId: "gmail-1", provider: "gmail", providerMessageId: "sent-1", providerThreadId: "thread-1", sentAt: "2026-08-30T14:10:00.000Z", ...overrides };
}

async function seedOpen(candidate = replyCandidate(), workspaceId = "workspace:account:gmail:gmail-1"): Promise<LivingBriefItem> {
  const view = await reconcileBriefMemory({ workspaceId, candidates: [candidate], now: "2026-08-30T14:00:00.000Z" });
  return view.current.find((item) => item.sourceKey === candidate.sourceKey)!;
}

async function seedAccount(id: string, provider: AccountProvider, email: string) {
  await execute(`INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'connected', ?, ?)`, [id, provider, email, id, "2026-08-30T00:00:00.000Z", "2026-08-30T00:00:00.000Z"]);
}
