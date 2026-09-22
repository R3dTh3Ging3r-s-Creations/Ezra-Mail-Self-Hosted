import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureEmailDatabaseForTests,
  ensureEmailDatabase,
  execute,
  getEmailClient,
} from "@/lib/email/database";
import {
  createOrRecoverNotificationDecision,
  getForegroundNotificationFeed,
  getNotificationDecision,
  getNotificationDecisionCooldowns,
  validateForegroundNotificationCursor,
} from "@/lib/email/foreground-notifications";

let databaseUrl: string;
const initialForegroundFeatureValue = process.env.EZRA_BROWSER_NOTIFICATIONS_ENABLED;

beforeEach(() => {
  databaseUrl = configureEmailDatabaseForTests(`file:./foreground-notifications-${randomUUID()}.sqlite`);
});

describe("foreground notification decisions", () => {
  it("creates one immutable decision and records one redacted audit entry", async () => {
    await seedMessage("message-1", "sender@example.com");

    const first = await createOrRecoverNotificationDecision({
      messageId: "message-1",
      reason: "Fresh critical message.",
      decidedAt: "2026-09-03T15:00:00.000Z",
    });
    const duplicate = await createOrRecoverNotificationDecision({
      messageId: "message-1",
      reason: "A later retry must not replace the original reason.",
      decidedAt: "2026-09-03T15:05:00.000Z",
    });

    expect(first).toMatchObject({
      created: true,
      messageId: "message-1",
      reason: "Fresh critical message.",
      decidedAt: "2026-09-03T15:00:00.000Z",
    });
    expect(first.sequence).toBeGreaterThan(0);
    expect(duplicate).toMatchObject({
      created: false,
      decisionId: first.decisionId,
      decidedAt: first.decidedAt,
      reason: first.reason,
    });
    expect(await decisionCount("message-1")).toBe(1);
    const { created: _created, ...record } = first;
    expect(await getNotificationDecision("message-1")).toMatchObject(record);
    expect(await redactedDecisionAudit(first.decisionId)).not.toContain("sender@example.com");

    const audit = await execute(
      `SELECT action, actor, target_type, target_id, metadata FROM audit_logs WHERE target_id = ?`,
      [first.decisionId],
    );
    expect(audit.rows).toEqual([expect.objectContaining({
      action: "notification.decision.created",
      actor: "worker",
      target_type: "notification_decision",
      target_id: first.decisionId,
    })]);
    expect(Object.keys(JSON.parse(String(audit.rows[0].metadata))).sort()).toEqual([
      "decidedAt", "decisionId", "messageId", "reason",
    ]);
  });

  it("rolls back a runtime decision when its required audit insert fails", async () => {
    await seedMessage("message-atomic", "atomic@example.com");
    await execute(
      `CREATE TRIGGER reject_runtime_decision_audit
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'notification.decision.created'
       BEGIN SELECT RAISE(ABORT, 'runtime decision audit rejected'); END`,
    );

    await expect(createOrRecoverNotificationDecision({
      messageId: "message-atomic",
      reason: "This write must be atomic.",
      decidedAt: "2026-09-03T15:00:00.000Z",
    })).rejects.toThrow("runtime decision audit rejected");
    expect(await decisionCount("message-atomic")).toBe(0);
    expect(await auditCount("notification.decision.created")).toBe(0);

    await execute(`DROP TRIGGER reject_runtime_decision_audit`);
    await expect(createOrRecoverNotificationDecision({
      messageId: "message-atomic",
      reason: "This write must be atomic.",
      decidedAt: "2026-09-03T15:00:00.000Z",
    })).resolves.toMatchObject({ created: true });
    expect(await decisionCount("message-atomic")).toBe(1);
    expect(await auditCount("notification.decision.created")).toBe(1);
  });

  it("creates one canonical decision and audit under concurrent ingestion", async () => {
    await seedMessage("message-concurrent", "concurrent@example.com");

    const decisions = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      createOrRecoverNotificationDecision({
        messageId: "message-concurrent",
        reason: `Concurrent attempt ${index}.`,
        decidedAt: "2026-09-03T15:00:00.000Z",
      })
    )));

    expect(decisions.filter((decision) => decision.created)).toHaveLength(1);
    expect(new Set(decisions.map((decision) => decision.decisionId)).size).toBe(1);
    expect(await decisionCount("message-concurrent")).toBe(1);
    expect(await auditCount("notification.decision.created")).toBe(1);
  });

  it("assigns increasing database sequences without accepting one from callers", async () => {
    await seedMessage("message-1", "one@example.com");
    await seedMessage("message-2", "two@example.com");

    const first = await createOrRecoverNotificationDecision({
      messageId: "message-1",
      reason: "First durable interruption decision.",
      decidedAt: "2026-09-03T15:00:00.000Z",
    });
    const second = await createOrRecoverNotificationDecision({
      messageId: "message-2",
      reason: "Second durable interruption decision.",
      decidedAt: "2026-09-03T15:01:00.000Z",
    });

    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(Object.keys(first)).toEqual(expect.arrayContaining([
      "sequence", "decisionId", "messageId", "reason", "decidedAt", "created",
    ]));
  });

  it("returns newest global and case-insensitive sender decision cooldowns", async () => {
    await seedMessage("message-1", "sender@example.com");
    await seedMessage("message-2", "SENDER@example.com");
    await seedMessage("message-3", "other@example.com");
    await createOrRecoverNotificationDecision({
      messageId: "message-1",
      reason: "Earlier sender decision.",
      decidedAt: "2026-09-03T10:00:00.000Z",
    });
    await createOrRecoverNotificationDecision({
      messageId: "message-2",
      reason: "Newer sender decision.",
      decidedAt: "2026-09-03T11:00:00.000Z",
    });
    await createOrRecoverNotificationDecision({
      messageId: "message-3",
      reason: "Newest overall decision.",
      decidedAt: "2026-09-03T12:00:00.000Z",
    });

    await expect(getNotificationDecisionCooldowns("SeNdEr@example.com")).resolves.toEqual({
      lastAnyDecidedAt: "2026-09-03T12:00:00.000Z",
      lastSenderDecidedAt: "2026-09-03T11:00:00.000Z",
    });
  });

  it("backfills all legacy interrupt attempts in stable earliest-timestamp and message-id order", async () => {
    await seedMessage("legacy-z", "sender@example.com");
    await seedMessage("legacy-b", "sender@example.com");
    await seedMessage("legacy-a", "owner@example.com");
    await seedMessage("legacy-failed-only", "failed@example.com");
    await seedMessage("legacy-unknown", "unknown@example.com");
    await execute(
      `INSERT INTO notifications (id, message_id, channel, kind, status, created_at)
       VALUES
        ('legacy-z-sent', 'legacy-z', 'telegram', 'interrupt', 'sent', '2026-09-03T12:00:00.000Z'),
        ('legacy-z-failed', 'legacy-z', 'telegram', 'interrupt', 'failed', '2026-09-03T13:00:00.000Z'),
        ('legacy-b-pending', 'legacy-b', 'telegram', 'interrupt', 'pending', '2026-09-03T10:00:00.000Z'),
        ('legacy-a-skipped', 'legacy-a', 'telegram', 'interrupt', 'skipped', '2026-09-03T10:00:00.000Z'),
        ('legacy-failed-only', 'legacy-failed-only', 'telegram', 'interrupt', 'failed', '2026-09-03T11:00:00.000Z'),
        ('legacy-unknown', 'legacy-unknown', 'telegram', 'interrupt', 'custom_legacy_status', '2026-09-03T11:30:00.000Z'),
        ('digest-ignore', 'legacy-a', 'telegram', 'digest', 'sent', '2026-09-03T09:00:00.000Z')`,
    );

    configureEmailDatabaseForTests(databaseUrl);
    await ensureEmailDatabase();

    const decisions = await execute(
      `SELECT sequence, id, message_id, reason, decided_at FROM notification_decisions ORDER BY sequence`,
    );
    expect(decisions.rows.map((row) => ({
      messageId: String(row.message_id),
      decidedAt: String(row.decided_at),
    }))).toEqual([
      { messageId: "legacy-a", decidedAt: "2026-09-03T10:00:00.000Z" },
      { messageId: "legacy-b", decidedAt: "2026-09-03T10:00:00.000Z" },
      { messageId: "legacy-failed-only", decidedAt: "2026-09-03T11:00:00.000Z" },
      { messageId: "legacy-unknown", decidedAt: "2026-09-03T11:30:00.000Z" },
      { messageId: "legacy-z", decidedAt: "2026-09-03T12:00:00.000Z" },
    ]);
    expect(decisions.rows.map((row) => String(row.id))).toEqual([
      legacyDecisionId("legacy-a"),
      legacyDecisionId("legacy-b"),
      legacyDecisionId("legacy-failed-only"),
      legacyDecisionId("legacy-unknown"),
      legacyDecisionId("legacy-z"),
    ]);
    const legacyIds = decisions.rows.map((row) => String(row.id)).join(" ");
    for (const sensitiveValue of ["sender@example.com", "owner@example.com", "account-legacy-a@example.test", "Subject", "external-legacy-a"]) {
      expect(legacyIds).not.toContain(sensitiveValue);
    }

    const audits = await execute(
      `SELECT action, metadata FROM audit_logs WHERE action = 'notification.decision.backfilled' ORDER BY target_id`,
    );
    expect(audits.rows).toHaveLength(5);
    expect(audits.rows.map((row) => JSON.parse(String(row.metadata)).messageId).sort()).toEqual([
      "legacy-a", "legacy-b", "legacy-failed-only", "legacy-unknown", "legacy-z",
    ]);
    for (const row of audits.rows) {
      expect(Object.keys(JSON.parse(String(row.metadata))).sort()).toEqual([
        "decidedAt", "decisionId", "messageId", "reason",
      ]);
    }

    const original = decisions.rows.map((row) => ({ id: String(row.id), sequence: Number(row.sequence) }));
    configureEmailDatabaseForTests(databaseUrl);
    await ensureEmailDatabase();
    const repeated = await execute(`SELECT sequence, id FROM notification_decisions ORDER BY sequence`);
    expect(repeated.rows.map((row) => ({ id: String(row.id), sequence: Number(row.sequence) }))).toEqual(original);
    await expect(execute(
      `SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'notification.decision.backfilled'`,
    )).resolves.toMatchObject({ rows: [{ count: 5 }] });
  });

  it("rolls back a legacy decision when its required backfill audit fails", async () => {
    await seedMessage("legacy-atomic", "legacy-atomic@example.com");
    await execute(
      `INSERT INTO notifications (id, message_id, channel, kind, status, created_at)
       VALUES ('legacy-atomic-notice', 'legacy-atomic', 'telegram', 'interrupt', 'failed', '2026-09-03T10:00:00.000Z')`,
    );
    await execute(
      `CREATE TRIGGER reject_backfill_decision_audit
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'notification.decision.backfilled'
       BEGIN SELECT RAISE(ABORT, 'backfill decision audit rejected'); END`,
    );

    configureEmailDatabaseForTests(databaseUrl);
    await expect(ensureEmailDatabase()).rejects.toThrow("backfill decision audit rejected");
    const client = getEmailClient();
    await expect(client.execute(
      `SELECT COUNT(*) AS count FROM notification_decisions WHERE message_id = 'legacy-atomic'`,
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(client.execute(
      `SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'notification.decision.backfilled'`,
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await client.execute(`DROP TRIGGER reject_backfill_decision_audit`);
    await ensureEmailDatabase();
    expect(await decisionCount("legacy-atomic")).toBe(1);
    expect(await auditCount("notification.decision.backfilled")).toBe(1);
  });
});

describe("foreground notification feed", () => {
  beforeEach(() => {
    vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates no-replay baselines for the current maximum sequence, including zero", async () => {
    const empty = await getForegroundNotificationFeed({ cursor: undefined });
    expect(empty).toEqual({ enabled: true, cursor: expect.any(String), hasMore: false, events: [] });
    expect(validateForegroundNotificationCursor(empty.cursor!)).toBe(0);

    await seedMessage("baseline-message", "baseline@example.test");
    const decision = await createOrRecoverNotificationDecision({ messageId: "baseline-message", reason: "Baseline decision.", decidedAt: "2026-09-03T10:00:00.000Z" });
    const baseline = await getForegroundNotificationFeed({});
    expect(validateForegroundNotificationCursor(baseline.cursor!)).toBe(decision.sequence);
    expect(baseline.events).toEqual([]);
  });

  it("returns connected-account decisions strictly after a cursor oldest-first with through-event cursors", async () => {
    const decisions = [] as Array<Awaited<ReturnType<typeof createOrRecoverNotificationDecision>>>;
    for (let index = 0; index < 22; index += 1) {
      const messageId = `feed-${index}`;
      await seedMessage(messageId, `sender-${index}@example.test`, { provider: index % 2 ? "microsoft" : "gmail", senderName: `Sender ${index}`, subject: `Subject ${index}` });
      decisions.push(await createOrRecoverNotificationDecision({ messageId, reason: "A durable local decision.", decidedAt: `2026-09-03T10:${String(index).padStart(2, "0")}:00.000Z` }));
    }
    await seedMessage("disconnected", "skip@example.test", { status: "error" });
    await createOrRecoverNotificationDecision({ messageId: "disconnected", reason: "Must not be exposed.", decidedAt: "2026-09-03T11:00:00.000Z" });

    const first = await getForegroundNotificationFeed({ cursor: encodeCursor(0) });
    expect(first.enabled).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(first.events).toHaveLength(20);
    expect(first.events.map((event) => event.messageId)).toEqual(decisions.slice(0, 20).map((decision) => decision.messageId));
    expect(first.events.map((event) => validateForegroundNotificationCursor(event.cursor))).toEqual(decisions.slice(0, 20).map((decision) => decision.sequence));
    expect(first.cursor).toBe(first.events.at(-1)?.cursor);
    expect(first.events.every((event) => Object.keys(event).join(",") === "cursor,decisionId,messageId,accountId,provider,decidedAt,senderName,subject")).toBe(true);

    const second = await getForegroundNotificationFeed({ cursor: first.cursor! });
    expect(second.hasMore).toBe(false);
    expect(second.events.map((event) => event.messageId)).toEqual(decisions.slice(20).map((decision) => decision.messageId));
    expect(second.cursor).toBe(second.events.at(-1)?.cursor);
  });

  it("preserves an accepted supplied cursor byte-for-byte when there are no newly visible decisions", async () => {
    const cursor = encodeCursor(42);
    await expect(getForegroundNotificationFeed({ cursor })).resolves.toEqual({ enabled: true, cursor, hasMore: false, events: [] });
  });

  it("rejects malformed cursors before executing a database query", async () => {
    const client = getEmailClient();
    const executeSpy = vi.spyOn(client, "execute");
    for (const cursor of [
      "",
      encodeRawCursor("-1"),
      encodeRawCursor("1.5"),
      encodeRawCursor("01"),
      `v2.${Buffer.from("1", "utf8").toString("base64url")}`,
      encodeRawCursor("9007199254740992"),
      "a".repeat(513),
    ]) {
      expect(() => validateForegroundNotificationCursor(cursor)).toThrow(/cursor/i);
      await expect(getForegroundNotificationFeed({ cursor })).rejects.toThrow(/cursor/i);
    }
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("normalizes untrusted sender and subject snapshots without reading message content", async () => {
    const sender = `  \u202eＡlice\t ${"🙂".repeat(81)} \u0000`;
    const subject = `\u2066  Important \n ${"🚀".repeat(141)}  \u2069`;
    await seedMessage("normalized", "normal@example.test", { senderName: sender, subject });
    await createOrRecoverNotificationDecision({ messageId: "normalized", reason: "Normalized snapshot.", decidedAt: "2026-09-03T10:00:00.000Z" });
    await seedMessage("fallback", "fallback@example.test", { senderName: "\u202e\u0000", subject: "\u2066\t\u2069" });
    await createOrRecoverNotificationDecision({ messageId: "fallback", reason: "Fallback snapshot.", decidedAt: "2026-09-03T10:01:00.000Z" });

    const feed = await getForegroundNotificationFeed({ cursor: encodeCursor(0) });
    expect(feed.events[0]).toMatchObject({ senderName: `Alice ${"🙂".repeat(74)}`, subject: `Important ${"🚀".repeat(130)}` });
    expect(Array.from(feed.events[0].senderName)).toHaveLength(80);
    expect(Array.from(feed.events[0].subject)).toHaveLength(140);
    expect(feed.events[1]).toMatchObject({ senderName: "New message", subject: "Open Ezra Mail to review." });
  });

  it("returns the exact disabled shape after cursor validation without querying decisions", async () => {
    vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "false");
    const client = getEmailClient();
    const executeSpy = vi.spyOn(client, "execute");
    await expect(getForegroundNotificationFeed({ cursor: encodeCursor(0) })).resolves.toEqual({ enabled: false, cursor: null, hasMore: false, events: [] });
    await expect(getForegroundNotificationFeed({ cursor: "v1.-1" })).rejects.toThrow(/cursor/i);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

describe("foreground notification feed environment isolation", () => {
  it("restores the prior feature environment after feed coverage", () => {
    expect(process.env.EZRA_BROWSER_NOTIFICATIONS_ENABLED).toBe(initialForegroundFeatureValue);
  });
});

async function seedMessage(messageId: string, senderEmail: string, options: {
  provider?: "gmail" | "microsoft";
  senderName?: string;
  subject?: string;
  status?: string;
} = {}) {
  const accountId = `account-${messageId}`;
  const timestamp = "2026-09-03T09:00:00.000Z";
  await execute(
    `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Test', ?, ?, ?)`,
    [accountId, options.provider || "gmail", `${accountId}@example.test`, options.status || "connected", timestamp, timestamp],
  );
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
       received_at, snippet, gmail_url, is_unread, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Snippet', '#', 1, 'triaged', ?, ?)`,
    [messageId, accountId, `external-${messageId}`, `thread-${messageId}`, options.senderName || "Sender", senderEmail, options.subject || "Subject", timestamp, timestamp, timestamp],
  );
}

function encodeCursor(sequence: number) {
  return encodeRawCursor(String(sequence));
}

function encodeRawCursor(sequence: string) {
  return `v1.${Buffer.from(sequence, "utf8").toString("base64url")}`;
}

async function decisionCount(messageId: string) {
  const result = await execute(`SELECT COUNT(*) AS count FROM notification_decisions WHERE message_id = ?`, [messageId]);
  return Number(result.rows[0].count);
}

async function redactedDecisionAudit(decisionId: string) {
  const result = await execute(`SELECT metadata FROM audit_logs WHERE target_id = ?`, [decisionId]);
  return JSON.stringify(result.rows[0]?.metadata || "");
}

async function auditCount(action: string) {
  const result = await execute(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = ?`, [action]);
  return Number(result.rows[0].count);
}

function legacyDecisionId(messageId: string) {
  return `decision_${createHash("sha256")
    .update(`ezra-notification-decision-v1:${messageId}`)
    .digest("hex")}`;
}
