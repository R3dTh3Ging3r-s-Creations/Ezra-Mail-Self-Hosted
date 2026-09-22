import type { Client } from "@libsql/client";
/** Additive v8: binding identity only; runtime secrets never persist here. */
export async function migrateNotificationTelegramSchema(client: Client) {
  const tx = await client.transaction("write");
  try {
    const columns = (await tx.execute("PRAGMA table_info(notification_devices)")).rows;
    if (!columns.some(row => row.name === "telegram_binding_fingerprint")) await tx.execute("ALTER TABLE notification_devices ADD COLUMN telegram_binding_fingerprint TEXT");
    await tx.execute("CREATE UNIQUE INDEX IF NOT EXISTS notification_telegram_destination ON notification_devices(telegram_binding_fingerprint) WHERE channel='telegram' AND revoked_at IS NULL AND telegram_binding_fingerprint IS NOT NULL");
    const version = Number((await tx.execute("PRAGMA user_version")).rows[0].user_version);
    if (version < 8) await tx.execute("PRAGMA user_version=8");
    await tx.commit();
  } catch (error) { await tx.rollback(); throw error; }
  finally { tx.close(); }
}
