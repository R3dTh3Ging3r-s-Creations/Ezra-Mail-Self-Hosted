import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { listBriefMemory, markBriefItemCompletedWithEvidence, reconcileBriefMemory, resolveBriefWorkspace, updateBriefItemMemory } from "@/lib/email/brief-memory";
import { configureEmailDatabaseForTests, execute } from "@/lib/email/database";
import type { BriefCandidate } from "@/lib/email/types";

describe("brief memory", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./brief-memory-${randomUUID()}.sqlite`);
    await seedAccount("gmail-1", "gmail");
    await seedAccount("gmail-2", "gmail");
    await seedAccount("ms-1", "microsoft");
  });

  it("resolves account, legacy provider, and All accounts workspaces to their active account scopes", async () => {
    await expect(resolveBriefWorkspace("workspace:account:gmail:gmail-1")).resolves.toEqual({ id: "workspace:account:gmail:gmail-1", accountIds: ["gmail-1"] });
    await expect(resolveBriefWorkspace("workspace:gmail")).resolves.toEqual({ id: "workspace:gmail", accountIds: ["gmail-1", "gmail-2"] });
    await expect(resolveBriefWorkspace("workspace:all")).resolves.toEqual({ id: "workspace:all", accountIds: ["gmail-1", "gmail-2", "ms-1"] });
  });

  it("keeps local actions isolated to the selected workspace and reopens only on newer source evidence", async () => {
    const workspaceId = "workspace:account:gmail:gmail-1";
    const first = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [replyCandidate({ sourceKey: "mail:gmail-1:thread-1", revisionAt: "2026-08-29T12:00:00.000Z" })] });
    expect(first.carryovers).toHaveLength(1);
    await updateBriefItemMemory({ workspaceId, itemId: first.carryovers[0].id, action: "complete", now: "2026-08-30T14:05:00.000Z" });
    expect((await listBriefMemory("workspace:account:microsoft:ms-1")).items).toHaveLength(0);
    expect((await listBriefMemory(workspaceId, "2026-08-30T18:00:00.000Z")).completedToday).toHaveLength(1);
    expect((await listBriefMemory(workspaceId, "2026-08-31T06:00:00.000Z")).completedToday).toHaveLength(0);
    const unchanged = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:30:00.000Z", candidates: [replyCandidate({ sourceKey: "mail:gmail-1:thread-1", revisionAt: "2026-08-29T12:00:00.000Z" })] });
    expect(unchanged.current).toHaveLength(0);
    const reopened = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T15:00:00.000Z", candidates: [replyCandidate({ sourceKey: "mail:gmail-1:thread-1", revisionAt: "2026-08-30T14:30:00.000Z" })] });
    expect(reopened.current[0].state).toBe("open");
  });

  it("retains FYI classification across missing-source days and enriches legacy snapshots without reopening decisions", async () => {
    const workspaceId = "workspace:account:gmail:gmail-1";
    const first = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [replyCandidate()] });
    await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:01:00.000Z", candidates: [replyCandidate({ topicKind: "fyi" })] });
    const next = await reconcileBriefMemory({ workspaceId, now: "2026-08-31T14:00:00.000Z", candidates: [] });
    expect(next.items[0]).toMatchObject({ id: first.items[0].id, topicKind: "fyi", state: "open" });
    await updateBriefItemMemory({ workspaceId, itemId: first.items[0].id, action: "complete", now: "2026-08-31T14:05:00.000Z" });
    const closed = await reconcileBriefMemory({ workspaceId, now: "2026-08-31T14:10:00.000Z", candidates: [replyCandidate({ topicKind: "deadline" })] });
    expect(closed.items).toHaveLength(0);
    expect(closed.completedToday[0]).toMatchObject({ topicKind: "deadline", state: "completed" });
  });

  it("normalizes the bounded display snapshot and keeps repeated local actions idempotent", async () => {
    const workspaceId = "workspace:account:gmail:gmail-1";
    const first = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [replyCandidate({ title: `  ${"T".repeat(305)}  `, summary: `  ${"S".repeat(705)}  ` })] });
    expect(first.carryovers[0]).toMatchObject({ title: "T".repeat(300), summary: "S".repeat(700) });
    const completed = await updateBriefItemMemory({ workspaceId, itemId: first.carryovers[0].id, action: "complete", now: "2026-08-30T14:05:00.000Z" });
    const completedAgain = await updateBriefItemMemory({ workspaceId, itemId: first.carryovers[0].id, action: "complete", now: "2026-08-30T14:10:00.000Z" });
    expect(completedAgain).toMatchObject({ state: "completed", completedAt: completed.completedAt });
    await expect(reconcileBriefMemory({ workspaceId, now: "2026-08-30T15:00:00.000Z", candidates: [replyCandidate({ title: "   ", summary: "" })] })).rejects.toThrow("Brief item title is required");
  });

  it("shows completed and dismissed memory only on its configured local day", async () => {
    const workspaceId = "workspace:account:gmail:gmail-1";
    const first = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T05:00:00.000Z", candidates: [replyCandidate()] });
    await updateBriefItemMemory({ workspaceId, itemId: first.carryovers[0].id, action: "dismiss", now: "2026-08-30T05:30:00.000Z" });
    expect((await listBriefMemory(workspaceId, "2026-08-30T23:00:00.000Z")).completedToday).toHaveLength(1);
    expect((await listBriefMemory(workspaceId, "2026-08-31T06:00:00.000Z")).completedToday).toHaveLength(0);
  });

  it("uses the latest terminal action day after an item is brought back", async () => {
    const workspaceId = "workspace:account:gmail:gmail-1";
    const first = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [replyCandidate()] });
    await updateBriefItemMemory({ workspaceId, itemId: first.items[0].id, action: "complete", now: "2026-08-30T14:05:00.000Z" });
    await updateBriefItemMemory({ workspaceId, itemId: first.items[0].id, action: "bring_back", now: "2026-08-31T14:00:00.000Z" });
    await updateBriefItemMemory({ workspaceId, itemId: first.items[0].id, action: "dismiss", now: "2026-08-31T14:05:00.000Z" });
    expect((await listBriefMemory(workspaceId, "2026-08-31T18:00:00.000Z")).completedToday).toEqual([
      expect.objectContaining({ id: first.items[0].id, state: "dismissed", dismissedAt: "2026-08-31T14:05:00.000Z" }),
    ]);
  });

  it("rejects a candidate whose account is outside the selected workspace", async () => {
    await expect(reconcileBriefMemory({ workspaceId: "workspace:account:gmail:gmail-1", candidates: [replyCandidate({ sourceAccountId: "ms-1", provider: "microsoft" })] })).rejects.toThrow("Brief source account is outside the selected workspace");
  });

  it("keeps a terminal item closed when delayed source evidence predates its terminal action", async () => {
    const workspaceId = "workspace:account:gmail:gmail-1";
    const first = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T18:00:00.000Z", candidates: [replyCandidate({ revisionAt: "2026-08-30T18:00:00.000Z" })] });
    await updateBriefItemMemory({ workspaceId, itemId: first.carryovers[0].id, action: "complete", now: "2026-08-30T20:00:00.000Z" });
    const replay = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T21:00:00.000Z", candidates: [replyCandidate({ revisionAt: "2026-08-30T19:00:00.000Z", title: "Delayed title", target: { view: "mail", messageId: "delayed-message" } })] });
    expect(replay.current).toHaveLength(0);
    expect((await listBriefMemory(workspaceId, "2026-08-30T22:00:00.000Z")).completedToday[0]).toMatchObject({ title: "Reply to Casey", target: { view: "mail", messageId: "message-1" }, revisionAt: "2026-08-30T18:00:00.000Z" });
  });

  it("rejects invalid source identities, targets, and timestamps before writing", async () => {
    const workspaceId = "workspace:account:gmail:gmail-1";
    await expect(reconcileBriefMemory({ workspaceId, now: "not-a-date", candidates: [replyCandidate()] })).rejects.toThrow("Brief timestamp is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [replyCandidate({ sourceAccountId: null })] })).rejects.toThrow("Brief mail thread source is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [replyCandidate({ target: { view: "mail" } as never })] })).rejects.toThrow("Brief item target is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [replyCandidate({ target: { view: "mail", messageId: " " } })] })).rejects.toThrow("Brief item target is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [replyCandidate({ target: { view: "unknown" } as never })] })).rejects.toThrow("Brief item target is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [replyCandidate({ target: { view: "today", messageId: " " } })] })).rejects.toThrow("Brief item target is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [replyCandidate({ target: { view: "drafts" } })] })).rejects.toThrow("Brief item target is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [replyCandidate({ target: { view: "outbox", draftId: " " } })] })).rejects.toThrow("Brief item target is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [replyCandidate({ target: { view: "calendar", eventId: " ", date: "2026-08-30" } })] })).rejects.toThrow("Brief item target is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [replyCandidate({ target: { view: "calendar", eventId: "event-1", date: "2026-02-31" } })] })).rejects.toThrow("Brief item target is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [replyCandidate({ target: { view: "settings", accountId: " " } })] })).rejects.toThrow("Brief item target is invalid");
  });

  it("requires an exact event and local date only for Calendar event sources", async () => {
    const workspaceId = "workspace:account:gmail:gmail-1";
    const calendar = {
      ...replyCandidate(),
      sourceType: "calendar_event" as const,
      sourceKey: "calendar:gmail-1:event-1",
      providerThreadId: null,
      role: "agenda" as const,
    };
    await expect(reconcileBriefMemory({ workspaceId, candidates: [{ ...calendar, target: { view: "calendar" } }] })).rejects.toThrow("Brief item target is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [{ ...calendar, target: { view: "calendar", draftId: "draft-1" } }] })).rejects.toThrow("Brief item target is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [{ ...calendar, target: { view: "calendar", eventId: "event-1" } }] })).rejects.toThrow("Brief item target is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [{ ...calendar, target: { view: "calendar", date: "2026-08-30" } }] })).rejects.toThrow("Brief item target is invalid");
    await expect(reconcileBriefMemory({
      workspaceId,
      candidates: [{ ...calendar, target: { view: "calendar", eventId: "event-1", date: "2026-08-30" } }],
    })).resolves.toMatchObject({
      current: [expect.objectContaining({ sourceKey: calendar.sourceKey })],
    });
    await expect(reconcileBriefMemory({
      workspaceId,
      candidates: [{
        ...replyCandidate(),
        sourceType: "action_center",
        sourceKey: "action:calendar-draft",
        providerThreadId: null,
        target: { view: "calendar", draftId: "draft-1" },
      }],
    })).resolves.toMatchObject({
      current: [expect.objectContaining({ sourceKey: "action:calendar-draft" })],
    });
  });

  it("accepts every typed view target with its required nonempty identifiers", async () => {
    const workspaceId = "workspace:account:gmail:gmail-1";
    const targets: BriefCandidate["target"][] = [
      { view: "mail", messageId: "message-1" },
      { view: "drafts", draftId: "draft-1" },
      { view: "drafts", messageId: "message-1" },
      { view: "outbox" },
      { view: "outbox", draftId: "draft-1" },
      { view: "calendar" },
      { view: "calendar", draftId: "draft-1" },
      { view: "calendar", eventId: "event-1", date: "2026-08-30" },
      { view: "today" },
      { view: "today", messageId: "message-1" },
      { view: "settings" },
      { view: "settings", accountId: "gmail-1" },
    ];
    for (const [index, candidateTarget] of targets.entries()) {
      const view = await reconcileBriefMemory({ workspaceId, candidates: [replyCandidate({ sourceKey: `mail:gmail-1:target-${index}`, target: candidateTarget })] });
      expect(view.current.at(-1)?.target).toEqual(candidateTarget);
    }
  });

  it("rejects wrong-workspace mutations without changing the owning item", async () => {
    const first = await reconcileBriefMemory({ workspaceId: "workspace:account:gmail:gmail-1", now: "2026-08-30T14:00:00.000Z", candidates: [replyCandidate()] });
    await expect(updateBriefItemMemory({ workspaceId: "workspace:account:microsoft:ms-1", itemId: first.carryovers[0].id, action: "dismiss", now: "2026-08-30T14:05:00.000Z" })).rejects.toThrow("Brief memory item was not found in this workspace");
    expect((await listBriefMemory("workspace:account:gmail:gmail-1", "2026-08-30T14:10:00.000Z")).items[0].state).toBe("open");
  });

  it("accepts accountless Action Center sources but rejects accountless calendar sources", async () => {
    const workspaceId = "workspace:account:gmail:gmail-1";
    await expect(reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [{ ...replyCandidate(), sourceType: "calendar_event", sourceAccountId: null, provider: null }] })).rejects.toThrow("Brief calendar source is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [{ ...replyCandidate(), sourceType: "action_center", sourceAccountId: null, provider: "gmail", providerThreadId: null, sourceKey: "action:provider", target: { view: "today" } }] })).rejects.toThrow("Brief Action Center source is invalid");
    await expect(reconcileBriefMemory({ workspaceId, candidates: [{ ...replyCandidate(), sourceType: "action_center", sourceAccountId: null, provider: null, providerThreadId: "thread-1", sourceKey: "action:thread", target: { view: "today" } }] })).rejects.toThrow("Brief Action Center source is invalid");
    const view = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [{ ...replyCandidate(), sourceType: "action_center", sourceAccountId: null, provider: null, providerThreadId: null, sourceKey: "action:repair", target: { view: "today" } }] });
    expect(view.items).toHaveLength(1);
    const accountBound = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:01:00.000Z", candidates: [{ ...replyCandidate(), sourceType: "action_center", providerThreadId: null, sourceKey: "action:gmail-1:repair", target: { view: "today" } }] });
    expect(accountBound.items).toEqual(expect.arrayContaining([expect.objectContaining({ sourceKey: "action:gmail-1:repair", provider: "gmail" })]));
  });

  it("excludes and refuses mutations for a source whose account was disabled after insertion", async () => {
    const workspaceId = "workspace:all";
    const first = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [replyCandidate()] });
    await execute("UPDATE email_accounts SET status = 'disabled' WHERE id = 'gmail-1'");
    expect((await resolveBriefWorkspace(workspaceId)).accountIds).toEqual(["gmail-2", "ms-1"]);
    expect((await listBriefMemory(workspaceId, "2026-08-30T14:10:00.000Z")).items).toHaveLength(0);
    await expect(updateBriefItemMemory({ workspaceId, itemId: first.items[0].id, action: "dismiss", now: "2026-08-30T14:10:00.000Z" })).rejects.toThrow("Brief memory item was not found in this workspace");
    expect((await execute("SELECT state FROM brief_item_memory WHERE id = ?", [first.items[0].id])).rows[0].state).toBe("open");
  });

  it("allows only accountless Action Center memory when a workspace has no active accounts", async () => {
    const workspaceId = "workspace:all";
    const action = { ...replyCandidate(), sourceType: "action_center" as const, sourceAccountId: null, provider: null, providerThreadId: null, sourceKey: "action:repair", target: { view: "today" as const } };
    const first = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [replyCandidate(), action] });
    const mailId = first.items.find((item) => item.sourceType === "mail_thread")!.id;
    const actionId = first.items.find((item) => item.sourceType === "action_center")!.id;
    await execute("UPDATE email_accounts SET status = 'disabled'");
    expect((await resolveBriefWorkspace(workspaceId)).accountIds).toEqual([]);
    expect((await listBriefMemory(workspaceId, "2026-08-30T14:10:00.000Z")).items.map((item) => item.sourceKey)).toEqual([action.sourceKey]);
    await expect(updateBriefItemMemory({ workspaceId, itemId: mailId, action: "dismiss", now: "2026-08-30T14:10:00.000Z" })).rejects.toThrow("Brief memory item was not found in this workspace");
    await expect(updateBriefItemMemory({ workspaceId, itemId: actionId, action: "dismiss", now: "2026-08-30T14:10:00.000Z" })).resolves.toMatchObject({ state: "dismissed" });
  });

  it("skips malformed persisted rows without hiding a valid row", async () => {
    const workspaceId = "workspace:all";
    const valid = replyCandidate({ sourceKey: "mail:gmail-1:valid" });
    const malformed = replyCandidate({ sourceKey: "mail:gmail-1:malformed", providerThreadId: "thread-2", target: { view: "mail", messageId: "message-2" } });
    await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [valid, malformed] });
    const malformedId = (await execute("SELECT id FROM brief_item_memory WHERE source_key = ?", [malformed.sourceKey])).rows[0].id;
    await execute("UPDATE brief_item_memory SET target_json = '{broken' WHERE source_key = ?", [malformed.sourceKey]);
    const refreshed = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:01:00.000Z", candidates: [{ ...valid, topicKind: "reply" }, { ...malformed, topicKind: "fyi" }] });
    expect(refreshed.items.map(item => item.sourceKey)).toEqual([valid.sourceKey]);
    const validSnapshot = JSON.stringify({ target: malformed.target, provider: malformed.provider, providerThreadId: malformed.providerThreadId, role: malformed.role });
    const malformedChanges: Array<{ sql: string; args?: Array<string | number | null> }> = [
      { sql: "source_type = 'unknown'" },
      { sql: "state = 'unknown'" },
      { sql: "source_account_id = NULL" },
      { sql: "target_json = ?", args: [JSON.stringify({ target: malformed.target, provider: "", providerThreadId: malformed.providerThreadId, role: malformed.role })] },
      { sql: "target_json = ?", args: [JSON.stringify({ target: malformed.target, provider: malformed.provider, providerThreadId: "   ", role: malformed.role })] },
      { sql: "target_json = ?", args: [JSON.stringify({ target: malformed.target, provider: malformed.provider, providerThreadId: malformed.providerThreadId, role: "unknown" })] },
      { sql: "source_revision_at = 'not-a-date'" },
      { sql: "occurred_at = 'not-a-date'" },
      { sql: "first_seen_at = 'not-a-date'" },
      { sql: "last_seen_at = 'not-a-date'" },
      { sql: "state = 'completed', completed_at = NULL" },
      { sql: "state = 'completed', completed_at = 'not-a-date'" },
      { sql: "state = 'dismissed', dismissed_at = NULL" },
      { sql: "state = 'dismissed', dismissed_at = 'not-a-date'" },
      { sql: "completed_at = 'not-a-date'" },
      { sql: "dismissed_at = 'not-a-date'" },
      { sql: "restored_at = 'not-a-date'" },
      { sql: "target_json = ?", args: [JSON.stringify({ target: malformed.target, provider: null, providerThreadId: malformed.providerThreadId, role: malformed.role })] },
      { sql: "target_json = ?", args: [JSON.stringify({ target: malformed.target, provider: malformed.provider, providerThreadId: null, role: malformed.role })] },
      { sql: "source_type = 'calendar_event', target_json = ?", args: [JSON.stringify({ target: { view: "calendar" }, provider: null, providerThreadId: null, role: "agenda" })] },
      { sql: "target_json = ?", args: [JSON.stringify({ target: malformed.target, provider: "microsoft", providerThreadId: malformed.providerThreadId, role: malformed.role })] },
      { sql: "source_type = 'action_center', target_json = ?", args: [JSON.stringify({ target: { view: "today" }, provider: "microsoft", providerThreadId: null, role: "attention" })] },
      { sql: "source_type = 'action_center', source_account_id = NULL, target_json = ?", args: [JSON.stringify({ target: { view: "today" }, provider: "gmail", providerThreadId: null, role: "attention" })] },
      { sql: "source_type = 'action_center', source_account_id = NULL, target_json = ?", args: [JSON.stringify({ target: { view: "today" }, provider: null, providerThreadId: "thread-2", role: "attention" })] },
    ];
    for (const change of malformedChanges) {
      await execute("UPDATE brief_item_memory SET source_type = 'mail_thread', state = 'open', source_account_id = 'gmail-1', source_revision_at = ?, occurred_at = ?, first_seen_at = ?, last_seen_at = ?, completed_at = NULL, dismissed_at = NULL, restored_at = NULL, target_json = ? WHERE source_key = ?", [malformed.revisionAt, malformed.occurredAt, "2026-08-30T14:00:00.000Z", "2026-08-30T14:00:00.000Z", validSnapshot, malformed.sourceKey]);
      await execute(`UPDATE brief_item_memory SET ${change.sql} WHERE source_key = ?`, [...(change.args || []), malformed.sourceKey]);
      expect((await listBriefMemory(workspaceId, "2026-08-30T14:10:00.000Z")).items.map((item) => item.sourceKey)).toEqual([valid.sourceKey]);
      await expect(updateBriefItemMemory({ workspaceId, itemId: String(malformedId), action: "complete", now: "2026-08-30T14:15:00.000Z" })).rejects.toThrow("Brief memory item was not found in this workspace");
    }
    await execute("UPDATE brief_item_memory SET source_type = 'mail_thread', state = 'open', source_account_id = 'gmail-1', target_json = ? WHERE source_key = ?", [JSON.stringify({ target: malformed.target, provider: malformed.provider, providerThreadId: " thread-2 ", role: malformed.role }), malformed.sourceKey]);
    expect((await listBriefMemory(workspaceId, "2026-08-30T14:10:00.000Z")).items.find((item) => item.sourceKey === malformed.sourceKey)?.providerThreadId).toBe("thread-2");
  });

  it("canonicalizes every valid persisted timestamp exposed by the decoder", async () => {
    const workspaceId = "workspace:all";
    const first = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [replyCandidate()] });
    await execute(
      "UPDATE brief_item_memory SET source_revision_at = ?, occurred_at = ?, first_seen_at = ?, last_seen_at = ?, completed_at = ?, dismissed_at = ?, restored_at = ? WHERE id = ?",
      ["2026-08-30T07:00:00-05:00", "2026-08-30T06:00:00-05:00", "2026-08-30T09:00:00-05:00", "2026-08-30T09:05:00-05:00", "2026-08-30T09:10:00-05:00", "2026-08-30T09:15:00-05:00", "2026-08-30T09:20:00-05:00", first.items[0].id],
    );
    expect((await listBriefMemory(workspaceId, "2026-08-30T20:00:00.000Z")).items[0]).toMatchObject({
      revisionAt: "2026-08-30T12:00:00.000Z",
      occurredAt: "2026-08-30T11:00:00.000Z",
      firstSeenAt: "2026-08-30T14:00:00.000Z",
      lastSeenAt: "2026-08-30T14:05:00.000Z",
      completedAt: "2026-08-30T14:10:00.000Z",
      dismissedAt: "2026-08-30T14:15:00.000Z",
      restoredAt: "2026-08-30T14:20:00.000Z",
    });
  });

  it("never selects or mutates stored accountless mail and calendar rows", async () => {
    const workspaceId = "workspace:all";
    const mail = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [replyCandidate()] });
    const calendar = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [{ ...replyCandidate(), sourceType: "calendar_event", sourceKey: "calendar:gmail-1:event-1", providerThreadId: null, role: "agenda", target: { view: "calendar", eventId: "event-1", date: "2026-08-30" } }] });
    const ids = [mail.current[0].id, calendar.current[0].id];
    await execute("UPDATE brief_item_memory SET source_account_id = NULL WHERE id IN (?, ?)", ids);
    expect((await listBriefMemory(workspaceId, "2026-08-30T14:10:00.000Z")).items).toHaveLength(0);
    for (const id of ids) {
      await expect(updateBriefItemMemory({ workspaceId, itemId: id, action: "dismiss", now: "2026-08-30T14:10:00.000Z" })).rejects.toThrow("Brief memory item was not found in this workspace");
    }
    expect((await execute("SELECT state FROM brief_item_memory WHERE id IN (?, ?) ORDER BY id", ids)).rows.map((row) => String(row.state))).toEqual(["open", "open"]);
  });

  it("rejects a mutation when the atomic update affects no row", async () => {
    const workspaceId = "workspace:all";
    const first = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [replyCandidate()] });
    await execute(`CREATE TRIGGER ignore_brief_memory_update BEFORE UPDATE ON brief_item_memory WHEN OLD.id = '${first.items[0].id}' BEGIN SELECT RAISE(IGNORE); END`);
    await expect(updateBriefItemMemory({ workspaceId, itemId: first.items[0].id, action: "dismiss", now: "2026-08-30T14:10:00.000Z" })).rejects.toThrow("Brief memory item was not found in this workspace");
    expect((await execute("SELECT state FROM brief_item_memory WHERE id = ?", [first.items[0].id])).rows[0].state).toBe("open");
  });

  it("atomically completes only the exact open revision with unique minimal external evidence", async () => {
    const workspaceId = "workspace:account:gmail:gmail-1";
    const first = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T14:00:00.000Z", candidates: [replyCandidate()] });
    const item = first.items[0];
    const base = {
      workspaceId,
      itemId: item.id,
      sourceKey: item.sourceKey,
      accountId: "gmail-1",
      provider: "gmail" as const,
      providerThreadId: "thread-1",
      sourceRevisionAt: item.revisionAt,
      providerMessageId: "sent-1",
      providerSentAt: "2026-08-30T14:10:00.000Z",
      observedAt: "2026-08-30T15:00:00.000Z",
    };

    await expect(markBriefItemCompletedWithEvidence({ ...base, sourceRevisionAt: "2026-08-30T13:59:59.000Z" })).resolves.toBe(false);
    expect((await execute("SELECT COUNT(*) AS count FROM reply_completion_evidence")).rows[0].count).toBe(0);
    await expect(markBriefItemCompletedWithEvidence(base)).resolves.toBe(true);
    await expect(markBriefItemCompletedWithEvidence(base)).resolves.toBe(false);
    const stored = await execute("SELECT state, completed_at, completion_evidence_json FROM brief_item_memory WHERE id = ?", [item.id]);
    expect(stored.rows[0]).toMatchObject({ state: "completed", completed_at: base.providerSentAt });
    expect(JSON.parse(String(stored.rows[0].completion_evidence_json))).toEqual({ kind: "external_reply", evidenceId: expect.any(String) });
    expect((await execute("SELECT COUNT(*) AS count FROM reply_completion_evidence")).rows[0].count).toBe(1);

    await updateBriefItemMemory({ workspaceId, itemId: item.id, action: "bring_back", now: "2026-08-30T15:05:00.000Z" });
    await expect(markBriefItemCompletedWithEvidence(base)).resolves.toBe(false);
    expect((await execute("SELECT state FROM brief_item_memory WHERE id = ?", [item.id])).rows[0].state).toBe("open");

    const other = await reconcileBriefMemory({ workspaceId, now: "2026-08-30T15:10:00.000Z", candidates: [replyCandidate({ sourceKey: "mail:gmail-1:thread-other", providerThreadId: "thread-1" })] });
    await expect(markBriefItemCompletedWithEvidence({ ...base, itemId: other.current[0].id, sourceKey: other.current[0].sourceKey })).resolves.toBe(false);
    expect((await execute("SELECT state FROM brief_item_memory WHERE id = ?", [other.current[0].id])).rows[0].state).toBe("open");
    await updateBriefItemMemory({ workspaceId, itemId: other.current[0].id, action: "dismiss", now: "2026-08-30T15:11:00.000Z" });
    await expect(markBriefItemCompletedWithEvidence({ ...base, itemId: other.current[0].id, sourceKey: other.current[0].sourceKey, providerMessageId: "sent-2" })).resolves.toBe(false);
    expect((await execute("SELECT COUNT(*) AS count FROM reply_completion_evidence")).rows[0].count).toBe(1);
  });
});

describe("workspace proof associations", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./brief-links-${randomUUID()}.sqlite`);
    await seedAccount("gmail-1", "gmail");
    await seedAccount("gmail-2", "gmail");
    await seedAccount("ms-1", "microsoft");
  });

  it.each([
    ["workspace:all", "workspace:account:gmail:gmail-1"],
    ["workspace:account:gmail:gmail-1", "workspace:all"],
  ])("reuses one immutable observation visiting %s before %s", async (firstWorkspace, secondWorkspace) => {
    const first = (await reconcileBriefMemory({ workspaceId: firstWorkspace, candidates: [replyCandidate()] })).current[0];
    const second = (await reconcileBriefMemory({ workspaceId: secondWorkspace, candidates: [replyCandidate()] })).current[0];
    expect(await markBriefItemCompletedWithEvidence(proof(first))).toBe(true);
    const observation = (await execute("SELECT * FROM reply_completion_evidence")).rows;
    expect(await markBriefItemCompletedWithEvidence(proof(second))).toBe(true);
    expect((await execute("SELECT * FROM reply_completion_evidence")).rows).toEqual(observation);
    expect((await execute("SELECT brief_item_id, source_revision_at FROM reply_completion_evidence_links ORDER BY brief_item_id")).rows).toEqual(
      [first, second].sort((a, b) => a.id.localeCompare(b.id)).map((item) => ({ brief_item_id: item.id, source_revision_at: item.revisionAt })),
    );
    expect((await execute("SELECT state FROM brief_item_memory")).rows.map((row) => row.state)).toEqual(["completed", "completed"]);
    await updateBriefItemMemory({ workspaceId: secondWorkspace, itemId: second.id, action: "bring_back" });
    expect(await markBriefItemCompletedWithEvidence(proof(second))).toBe(false);
    expect((await execute("SELECT COUNT(*) AS n FROM reply_completion_evidence_links")).rows[0].n).toBe(2);
  });

  it("concurrently links All and account items and the provider workspace without closing another account", async () => {
    const items = [];
    for (const workspaceId of ["workspace:all", "workspace:account:gmail:gmail-1", "workspace:gmail"]) {
      items.push((await reconcileBriefMemory({ workspaceId, candidates: [replyCandidate()] })).current[0]);
    }
    const other = (await reconcileBriefMemory({ workspaceId: "workspace:gmail", candidates: [replyCandidate({ sourceAccountId: "gmail-2", sourceKey: "mail:gmail-2:thread-1" })] })).current[0];
    expect(await Promise.all(items.map((item) => markBriefItemCompletedWithEvidence(proof(item))))).toEqual([true, true, true]);
    expect((await execute("SELECT COUNT(*) AS n FROM reply_completion_evidence")).rows[0].n).toBe(1);
    expect((await execute("SELECT COUNT(*) AS n FROM reply_completion_evidence_links")).rows[0].n).toBe(3);
    expect((await execute("SELECT state FROM brief_item_memory WHERE id = ?", [other.id])).rows[0].state).toBe("open");
    expect(await Promise.all(items.map((item) => markBriefItemCompletedWithEvidence(proof(item))))).toEqual([false, false, false]);
  });

  it("rejects mismatched proof identities and old proof after a newer incoming revision", async () => {
    const workspaceId = "workspace:all";
    const first = (await reconcileBriefMemory({ workspaceId, candidates: [replyCandidate()] })).current[0];
    const base = proof(first);
    for (const change of [
      { sourceKey: "other-source" }, { providerThreadId: "other-thread" },
      { accountId: "gmail-2" }, { provider: "microsoft" as const },
      { providerSentAt: "2026-08-30T15:00:00.001Z" },
    ]) expect(await markBriefItemCompletedWithEvidence({ ...base, ...change })).toBe(false);
    expect(await markBriefItemCompletedWithEvidence(base)).toBe(true);
    const reopened = (await reconcileBriefMemory({ workspaceId, now: "2026-08-30T16:00:00.000Z", candidates: [replyCandidate({ revisionAt: "2026-08-30T14:30:00.000Z" })] })).current[0];
    expect(await markBriefItemCompletedWithEvidence(proof(reopened))).toBe(false);
    expect(await markBriefItemCompletedWithEvidence({ ...proof(reopened), providerSentAt: "2026-08-30T14:40:00.000Z" })).toBe(false);
    expect(await markBriefItemCompletedWithEvidence({ ...proof(reopened), providerMessageId: "sent-2", providerSentAt: "2026-08-30T14:40:00.000Z" })).toBe(true);
    expect((await execute("SELECT COUNT(*) AS n FROM reply_completion_evidence_links")).rows[0].n).toBe(2);
  });

  it.each(["reply_completion_evidence_links", "brief_item_memory"])("rolls back observation, association and item when %s rejects the write", async (table) => {
    const item = (await reconcileBriefMemory({ workspaceId: "workspace:all", candidates: [replyCandidate()] })).current[0];
    await execute(`CREATE TRIGGER reject_provenance BEFORE ${table === "brief_item_memory" ? "UPDATE" : "INSERT"} ON ${table} BEGIN SELECT RAISE(ABORT, 'local provenance failed'); END`);
    await expect(markBriefItemCompletedWithEvidence(proof(item))).rejects.toThrow("local provenance failed");
    expect((await execute("SELECT COUNT(*) AS n FROM reply_completion_evidence")).rows[0].n).toBe(0);
    expect((await execute("SELECT COUNT(*) AS n FROM reply_completion_evidence_links")).rows[0].n).toBe(0);
    expect((await execute("SELECT state, completion_evidence_json FROM brief_item_memory WHERE id = ?", [item.id])).rows[0]).toMatchObject({ state: "open", completion_evidence_json: "{}" });
  });
});

function proof(item: import("@/lib/email/types").LivingBriefItem) {
  return { workspaceId: item.workspaceId, itemId: item.id, sourceKey: item.sourceKey, accountId: item.sourceAccountId!, provider: item.provider!, providerThreadId: item.providerThreadId!, sourceRevisionAt: item.revisionAt, providerMessageId: "sent-1", providerSentAt: "2026-08-30T14:10:00.000Z", observedAt: "2026-08-30T15:00:00.000Z" };
}

function replyCandidate(overrides: Partial<BriefCandidate> = {}): BriefCandidate {
  return { sourceType: "mail_thread", sourceKey: "mail:gmail-1:thread-1", sourceAccountId: "gmail-1", provider: "gmail", providerThreadId: "thread-1", revisionAt: "2026-08-30T12:00:00.000Z", occurredAt: "2026-08-30T11:00:00.000Z", role: "attention", title: "Reply to Casey", summary: "A reply is waiting.", target: { view: "mail", messageId: "message-1" }, ...overrides };
}

async function seedAccount(id: string, provider: "gmail" | "microsoft") {
  await execute(`INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'connected', ?, ?)`, [id, provider, `${id}@example.test`, id, "2026-08-30T00:00:00.000Z", "2026-08-30T00:00:00.000Z"]);
}
