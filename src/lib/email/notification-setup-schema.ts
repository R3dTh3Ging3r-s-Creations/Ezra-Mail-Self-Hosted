import type { Client, Transaction } from "@libsql/client";
import { z } from "zod";

export const notificationSetupEpoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export class NotificationSetupError extends Error {
  constructor(public code: "setup_pending" | "setup_stale" | "setup_operation_mismatch" | "setup_epoch_exhausted") { super("Notification setup could not be completed."); }
}
/** Must run in the SAME write transaction as enrollment or subscription attachment. */
export async function assertNotificationSetupReady(tx: Transaction, origin: string, expectedSetupEpoch: unknown) {
  const expected = notificationSetupEpoch.parse(expectedSetupEpoch);
  const row = (await tx.execute({ sql: "SELECT setup_epoch,pending FROM notification_origin_setup WHERE origin=?", args: [origin] })).rows[0];
  if (row?.pending === 1) throw new NotificationSetupError("setup_pending");
  if (Number(row?.setup_epoch ?? 0) !== expected) throw new NotificationSetupError("setup_stale");
}
/** One bounded operation identity per exact origin, independent of trust-cookie rotation. */
export async function migrateNotificationSetupSchema(client: Client) {
  const tx = await client.transaction("write");
  try {
    await tx.execute(`CREATE TABLE IF NOT EXISTS notification_origin_setup (
      origin TEXT PRIMARY KEY, setup_epoch INTEGER NOT NULL CHECK(setup_epoch BETWEEN 1 AND 9007199254740991),
      pending INTEGER NOT NULL CHECK(pending IN (0,1)), operation_id TEXT NOT NULL,
      operation_epoch INTEGER NOT NULL, operation_kind TEXT NOT NULL CHECK(operation_kind IN ('background_disable','device_disable','worker_repair')),
      initiator_trusted_device_id TEXT, target_device_id TEXT, target_generation INTEGER,
      started_at TEXT NOT NULL, completed_at TEXT,
      completion_evidence TEXT CHECK(completion_evidence IN ('client_settled','owner_confirmation')),
      CHECK((target_device_id IS NULL) = (target_generation IS NULL)),
      CHECK((pending=1 AND completed_at IS NULL AND completion_evidence IS NULL AND setup_epoch=operation_epoch)
        OR (pending=0 AND completed_at IS NOT NULL AND completion_evidence IS NOT NULL AND setup_epoch=operation_epoch+1))
    )`);
    const version = Number((await tx.execute("PRAGMA user_version")).rows[0].user_version);
    if (version < 7) await tx.execute("PRAGMA user_version=7");
    await tx.commit();
  } catch (error) { await tx.rollback(); throw error; }
  finally { tx.close(); }
}
