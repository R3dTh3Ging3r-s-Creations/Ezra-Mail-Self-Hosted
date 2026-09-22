import { randomUUID } from "node:crypto";
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, ensureEmailDatabase, getEmailClient } from "@/lib/email/database";
import { describe, expect, it, vi } from "vitest";
import { migrateNotificationSetupSchema } from "@/lib/email/notification-setup-schema";

async function fixture() {
  configureEmailDatabaseForTests("file:./notification-setup-schema-" + randomUUID() + ".sqlite");
  await ensureEmailDatabase();
  const client = getEmailClient();
  await client.execute("DROP TABLE notification_origin_setup");
  return client;
}

describe("setup schema migration", () => {
  it("adds schema7 without changing existing rows, preserves pending on rerun, and never lowers a future version", async () => {
    const client = await fixture();
    try {
      await client.execute("CREATE TABLE synthetic_existing (id TEXT PRIMARY KEY)");
      await client.execute("INSERT INTO synthetic_existing VALUES ('preserved')");
      await client.execute("PRAGMA user_version=6");
      await migrateNotificationSetupSchema(client);
      expect((await client.execute("PRAGMA user_version")).rows[0].user_version).toBe(7);
      await client.execute("INSERT INTO notification_origin_setup (origin,setup_epoch,pending,operation_id,operation_epoch,operation_kind,started_at) VALUES ('https://ezra.example.test',1,1,'synthetic',1,'worker_repair','2026-09-14T12:00:00.000Z')");
      await migrateNotificationSetupSchema(client);
      expect((await client.execute("SELECT setup_epoch,pending FROM notification_origin_setup")).rows).toEqual([{ setup_epoch: 1, pending: 1 }]);
      expect((await client.execute("SELECT * FROM synthetic_existing")).rows).toEqual([{ id: "preserved" }]);
      await client.execute("PRAGMA user_version=8"); await migrateNotificationSetupSchema(client);
      expect((await client.execute("PRAGMA user_version")).rows[0].user_version).toBe(8);
    } finally { closeEmailDatabaseForTests(); }
  });
  it("rolls back table creation and preserves version6 if the migration cannot finish", async () => {
    const client = await fixture();
    try {
      await client.execute("PRAGMA user_version=6");
      const transaction = client.transaction.bind(client);
      const spy = vi.spyOn(client, "transaction").mockImplementationOnce(async () => {
        const tx = await transaction("write"), execute = tx.execute.bind(tx);
        vi.spyOn(tx, "execute").mockImplementation(async statement => {
          if (statement === "PRAGMA user_version=7") throw new Error("synthetic commit preparation failure");
          return execute(statement);
        });
        return tx;
      });
      await expect(migrateNotificationSetupSchema(client)).rejects.toThrow("synthetic commit preparation failure");
      expect((await client.execute("PRAGMA user_version")).rows[0].user_version).toBe(6);
      expect((await client.execute("SELECT name FROM sqlite_master WHERE name='notification_origin_setup'")).rows).toHaveLength(0);
      spy.mockRestore();
      await migrateNotificationSetupSchema(client);
      expect((await client.execute("PRAGMA user_version")).rows[0].user_version).toBe(7);
    } finally { closeEmailDatabaseForTests(); }
  });
});
