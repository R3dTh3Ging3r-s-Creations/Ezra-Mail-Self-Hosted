import type { Client } from "@libsql/client";
/** Additive v9: no Telegram content, credentials, or response bodies are retained. */
export async function migrateNotificationTelegramUpdatesSchema(client: Client) {
    const tx = await client.transaction("write");
    try {
        await tx.execute(`CREATE TABLE IF NOT EXISTS notification_telegram_updates (
      fingerprint TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES notification_devices(id),
      generation INTEGER NOT NULL, update_id INTEGER NOT NULL CHECK(update_id>=0),
      callback_id TEXT, processed_at TEXT NOT NULL,
      PRIMARY KEY(fingerprint,device_id,generation,update_id),
      UNIQUE(fingerprint,device_id,generation,callback_id)
    )`);
        await tx.execute(`CREATE TABLE IF NOT EXISTS notification_telegram_poll_leases (fingerprint TEXT PRIMARY KEY, device_id TEXT NOT NULL, generation INTEGER NOT NULL, owner TEXT NOT NULL, expires_at TEXT NOT NULL)`);
        const version = Number((await tx.execute("PRAGMA user_version")).rows[0].user_version);
        if (version < 9)
            await tx.execute("PRAGMA user_version=9");
        await tx.commit();
    }
    catch (error) {
        await tx.rollback();
        throw error;
    }
    finally {
        tx.close();
    }
}
