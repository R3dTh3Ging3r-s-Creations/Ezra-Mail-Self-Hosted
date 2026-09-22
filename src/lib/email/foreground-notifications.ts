import {
  ensureEmailDatabase,
  execute,
  executeBatch,
  newId,
  nowIso,
} from "./database";
import type {
  ForegroundNotificationEvent,
  ForegroundNotificationFeed,
  NotificationDecisionRecord,
} from "./types";

const FOREGROUND_CURSOR_VERSION = "v1";
const FOREGROUND_CURSOR_MAX_LENGTH = 512;
const FOREGROUND_PAGE_SIZE = 20;

type NotificationDecisionRow = {
  sequence: number;
  id: string;
  message_id: string;
  reason: string;
  decided_at: string;
};

type ForegroundNotificationRow = {
  sequence: number;
  decision_id: string;
  message_id: string;
  account_id: string;
  provider: string;
  decided_at: string;
  sender_name: string;
  subject: string;
};

export function foregroundBrowserNotificationsEnabled() {
  return process.env.EZRA_BROWSER_NOTIFICATIONS_ENABLED?.trim().toLowerCase() === "true";
}

export function validateForegroundNotificationCursor(cursor: string): number {
  if (cursor.length > FOREGROUND_CURSOR_MAX_LENGTH) {
    throw new Error("Foreground notification cursor is invalid.");
  }
  const match = new RegExp(`^${FOREGROUND_CURSOR_VERSION}\\.([A-Za-z0-9_-]+)$`).exec(cursor);
  if (!match) throw new Error("Foreground notification cursor is invalid.");
  const encodedSequence = match[1];
  const decoded = Buffer.from(encodedSequence, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== encodedSequence || !/^(0|[1-9]\d*)$/.test(decoded)) {
    throw new Error("Foreground notification cursor is invalid.");
  }
  const sequence = Number(decoded);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Foreground notification cursor is invalid.");
  }
  return sequence;
}

export async function getForegroundNotificationFeed(input: { cursor?: string } = {}): Promise<ForegroundNotificationFeed> {
  const suppliedCursor = input.cursor;
  const suppliedSequence = suppliedCursor === undefined
    ? undefined
    : validateForegroundNotificationCursor(suppliedCursor);
  if (!foregroundBrowserNotificationsEnabled()) {
    return { enabled: false, cursor: null, hasMore: false, events: [] };
  }
  if (suppliedSequence === undefined) {
    const result = await execute(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM notification_decisions`);
    return {
      enabled: true,
      cursor: encodeForegroundNotificationCursor(asSafeSequence(result.rows[0]?.sequence)),
      hasMore: false,
      events: [],
    };
  }
  const result = await execute(
    `SELECT d.sequence, d.id AS decision_id, d.message_id, m.account_id, a.provider,
            d.decided_at, m.sender_name, m.subject
     FROM notification_decisions d
     JOIN email_messages m ON m.id = d.message_id
     JOIN email_accounts a ON a.id = m.account_id
     WHERE d.sequence > ? AND a.status = 'connected'
     ORDER BY d.sequence ASC
     LIMIT ?`,
    [suppliedSequence, FOREGROUND_PAGE_SIZE + 1],
  );
  const events = result.rows.slice(0, FOREGROUND_PAGE_SIZE).map((row) => toForegroundNotificationEvent(row as unknown as ForegroundNotificationRow));
  return {
    enabled: true,
    cursor: events.at(-1)?.cursor || suppliedCursor!,
    hasMore: result.rows.length > FOREGROUND_PAGE_SIZE,
    events,
  };
}

export async function createOrRecoverNotificationDecision(input: {
  messageId: string;
  reason: string;
  decidedAt?: string;
}): Promise<NotificationDecisionRecord & { created: boolean }> {
  const decisionId = newId("decision");
  const decidedAt = input.decidedAt || nowIso();
  await ensureEmailDatabase();
  const [inserted] = await executeBatch([
    {
      sql: `INSERT INTO notification_decisions (id, message_id, reason, decided_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(message_id) DO NOTHING`,
      args: [decisionId, input.messageId, input.reason, decidedAt],
    },
    {
      sql: `INSERT INTO audit_logs
        (id, action, actor, target_type, target_id, metadata, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE changes() = 1`,
      args: [
        newId("audit"),
        "notification.decision.created",
        "worker",
        "notification_decision",
        decisionId,
        JSON.stringify({ decisionId, messageId: input.messageId, reason: input.reason, decidedAt }),
        nowIso(),
      ],
    },
  ], "write");
  const decision = await getNotificationDecision(input.messageId);
  if (!decision) throw new Error(`Notification decision was not found for message ${input.messageId}`);

  const created = inserted.rowsAffected === 1;
  return { ...decision, created };
}

export async function getNotificationDecision(
  messageId: string,
): Promise<NotificationDecisionRecord | null> {
  const result = await execute(
    `SELECT sequence, id, message_id, reason, decided_at
     FROM notification_decisions WHERE message_id = ?`,
    [messageId],
  );
  const row = result.rows[0] as unknown as NotificationDecisionRow | undefined;
  return row ? toNotificationDecisionRecord(row) : null;
}

export async function getNotificationDecisionCooldowns(
  senderEmail: string,
): Promise<{ lastAnyDecidedAt: string | null; lastSenderDecidedAt: string | null }> {
  const result = await execute(
    `SELECT
      (SELECT decided_at FROM notification_decisions ORDER BY decided_at DESC, sequence DESC LIMIT 1) AS last_any_decided_at,
      (SELECT d.decided_at
       FROM notification_decisions d
       JOIN email_messages m ON m.id = d.message_id
       WHERE lower(m.sender_email) = lower(?)
       ORDER BY d.decided_at DESC, d.sequence DESC
       LIMIT 1) AS last_sender_decided_at`,
    [senderEmail],
  );
  const row = result.rows[0];
  return {
    lastAnyDecidedAt: row?.last_any_decided_at ? String(row.last_any_decided_at) : null,
    lastSenderDecidedAt: row?.last_sender_decided_at ? String(row.last_sender_decided_at) : null,
  };
}

function toNotificationDecisionRecord(row: NotificationDecisionRow): NotificationDecisionRecord {
  return {
    sequence: Number(row.sequence),
    decisionId: String(row.id),
    messageId: String(row.message_id),
    reason: String(row.reason),
    decidedAt: String(row.decided_at),
  };
}

function encodeForegroundNotificationCursor(sequence: number) {
  return `${FOREGROUND_CURSOR_VERSION}.${Buffer.from(String(sequence), "utf8").toString("base64url")}`;
}

function asSafeSequence(value: unknown) {
  const sequence = Number(value || 0);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Foreground notification sequence is invalid.");
  }
  return sequence;
}

function toForegroundNotificationEvent(row: ForegroundNotificationRow): ForegroundNotificationEvent {
  return {
    cursor: encodeForegroundNotificationCursor(asSafeSequence(row.sequence)),
    decisionId: String(row.decision_id),
    messageId: String(row.message_id),
    accountId: String(row.account_id),
    provider: String(row.provider) as ForegroundNotificationEvent["provider"],
    decidedAt: String(row.decided_at),
    senderName: normalizeForegroundText(row.sender_name, 80, "New message"),
    subject: normalizeForegroundText(row.subject, 140, "Open Ezra Mail to review."),
  };
}

function normalizeForegroundText(value: unknown, maxCodePoints: number, fallback: string) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const truncated = Array.from(normalized).slice(0, maxCodePoints).join("");
  return truncated || fallback;
}
