import type { Client } from "@libsql/client";

/** Additive only: the version and every table/index commit together. */
export async function migrateNotificationSchema(client: Client) {
  const tx = await client.transaction("write");
  try {
    const statements = [
      `CREATE TABLE IF NOT EXISTS notification_devices (
        id TEXT PRIMARY KEY,
        trusted_device_id TEXT NOT NULL REFERENCES trusted_devices(id),
        origin TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('browser','telegram')),
        platform TEXT NOT NULL CHECK(platform IN ('windows','macos','linux','android','ios','other')),
        permission TEXT NOT NULL CHECK(permission IN ('default','granted','denied')),
        foreground INTEGER NOT NULL CHECK(foreground IN (0,1)),
        push INTEGER NOT NULL CHECK(push IN (0,1)),
        privacy TEXT NOT NULL DEFAULT 'generic' CHECK(privacy IN ('generic','detailed')),
        generation INTEGER NOT NULL CHECK(generation >= 1),
        baseline_sequence INTEGER NOT NULL CHECK(baseline_sequence >= 0),
        subscription_ciphertext TEXT,
        subscription_fingerprint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(trusted_device_id,origin,channel),
        CHECK(channel = 'browser' OR (foreground = 0 AND push = 0))
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_devices_active_endpoint ON notification_devices(subscription_fingerprint) WHERE channel='browser' AND revoked_at IS NULL AND subscription_fingerprint IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS notification_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        source_key TEXT NOT NULL UNIQUE,
        decision_id TEXT REFERENCES notification_decisions(id),
        kind TEXT NOT NULL CHECK(kind IN ('interrupt','brief','checkin','in_app')),
        target TEXT NOT NULL,
        origin TEXT,
        replacement_tag TEXT NOT NULL,
        reason_code TEXT NOT NULL CHECK(reason_code IN ('attention','critical','brief','checkin','quiet_hours','low_confidence','routine','handled','snoozed','over_budget','cooldown','burst','stale','source_unhealthy')),
        created_at TEXT NOT NULL,
        not_before TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        CHECK(created_at <= not_before AND not_before < expires_at)
      )`,
      `CREATE TABLE IF NOT EXISTS notification_deliveries (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES notification_events(id),
        device_id TEXT NOT NULL REFERENCES notification_devices(id),
        generation INTEGER NOT NULL CHECK(generation >= 1),
        state TEXT NOT NULL CHECK(state IN ('pending','claimed','accepted','displayed','clicked','failed','expired','cancelled','unknown')),
        next_attempt_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(event_id,device_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due ON notification_deliveries(state,next_attempt_at)`,
      `CREATE INDEX IF NOT EXISTS idx_notification_deliveries_device ON notification_deliveries(device_id,generation,state)`,
      `CREATE TABLE IF NOT EXISTS notification_attempts (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES notification_deliveries(id),
        channel TEXT NOT NULL CHECK(channel IN ('foreground','push','telegram')),
        generation INTEGER NOT NULL CHECK(generation >= 1),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        outcome TEXT CHECK(outcome IN ('accepted','failed','expired','unknown')),
        error_code TEXT CHECK(error_code IN ('rejected','rate_limited','unavailable','permission_denied','subscription_expired','timeout','transport_unknown','invalid_payload')),
        external_id TEXT CHECK(external_id IS NULL OR (length(external_id) BETWEEN 1 AND 128)),
        CHECK((completed_at IS NULL AND outcome IS NULL) OR (completed_at IS NOT NULL AND outcome IS NOT NULL))
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_attempts_active ON notification_attempts(delivery_id) WHERE completed_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_notification_attempts_delivery ON notification_attempts(delivery_id,started_at)`,
      `CREATE TABLE IF NOT EXISTS notification_receipts (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES notification_attempts(id),
        device_id TEXT NOT NULL REFERENCES notification_devices(id),
        generation INTEGER NOT NULL CHECK(generation >= 1),
        kind TEXT NOT NULL CHECK(kind IN ('displayed','clicked')),
        created_at TEXT NOT NULL,
        UNIQUE(attempt_id,device_id,generation,kind)
      )`,
      `CREATE TABLE IF NOT EXISTS notification_feedback (
        device_id TEXT NOT NULL REFERENCES notification_devices(id),
        event_id TEXT NOT NULL REFERENCES notification_events(id),
        kind TEXT NOT NULL CHECK(kind IN ('useful','too_noisy')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(device_id,event_id)
      )`,
    ];
    for (const sql of statements) await tx.execute(sql);
    const version = Number((await tx.execute("PRAGMA user_version")).rows[0].user_version);
    if (version < 4) await tx.execute("PRAGMA user_version = 4");
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}
