import type { Client } from "@libsql/client";

/** Slot consumption, local brief history and member identity commit together. */
export async function migrateNotificationScheduleSchema(client: Client) {
  const tx = await client.transaction("write");
  try {
    await tx.execute(`CREATE TABLE IF NOT EXISTS notification_schedule_evidence (
      source_key TEXT PRIMARY KEY, event_id TEXT UNIQUE REFERENCES notification_events(id),
      kind TEXT NOT NULL CHECK(kind IN ('brief','checkin')), local_day TEXT NOT NULL,
      slot_time TEXT NOT NULL, timezone TEXT NOT NULL, manual INTEGER NOT NULL CHECK(manual IN (0,1)),
      item_count INTEGER NOT NULL CHECK(item_count BETWEEN 0 AND 12),
      digest_id TEXT REFERENCES email_digests(id), created_at TEXT NOT NULL
    )`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS notification_schedule_members (
      event_id TEXT NOT NULL REFERENCES notification_events(id), message_id TEXT NOT NULL REFERENCES email_messages(id),
      account_id TEXT NOT NULL REFERENCES email_accounts(id), thread_id TEXT NOT NULL,
      PRIMARY KEY(event_id,message_id), UNIQUE(event_id,account_id,thread_id)
    )`);
    await tx.execute("CREATE INDEX IF NOT EXISTS idx_notification_schedule_day ON notification_schedule_evidence(kind,local_day,created_at)");
    const version = Number((await tx.execute("PRAGMA user_version")).rows[0].user_version);
    if (version < 6) await tx.execute("PRAGMA user_version=6");
    await tx.commit();
  } catch (error) { await tx.rollback(); throw error; }
  finally { tx.close(); }
}
