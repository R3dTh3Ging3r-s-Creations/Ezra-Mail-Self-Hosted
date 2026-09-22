import type { Row, Transaction } from "@libsql/client";
import { z } from "zod";
import { NotificationApiError, notificationGeneration, notificationId, type NotificationSetupOwner } from "./notification-api";
import { foregroundBrowserNotificationsEnabled } from "./foreground-notifications";
import { notificationSetupEpoch, NotificationSetupError } from "./notification-setup-schema";
import { cancelNotificationDeviceWork, withNotificationStoreWrite } from "./notification-store";

export const beginNotificationCleanupSchema = z.object({
  operationId: notificationId, expectedSetupEpoch: notificationSetupEpoch,
  kind: z.enum(["background_disable", "device_disable", "worker_repair"]),
  current: z.object({ deviceId: notificationId, expectedGeneration: notificationGeneration }).strict().optional(),
}).strict();
const operationIdentity = z.object({ operationId: notificationId, pendingEpoch: notificationSetupEpoch.refine(value => value > 0) }).strict();
export const completeNotificationCleanupSchema = operationIdentity.extend({ nativeCleanupSettled: z.literal(true) }).strict();
export const recoverNotificationCleanupSchema = operationIdentity.extend({ ownerConfirmedNativeCleanup: z.literal(true) }).strict();
const recoveryInstructions = "Setup is paused on every browser using this origin; existing unrelated enrolled delivery continues. Save your work and close all Ezra tabs and installed windows in the initiating browser. Complete this exact origin's worker and push subscription cleanup using browser controls without erasing unrelated storage or drafts. Then explicitly confirm this identified operation. Owner confirmation is not observed native cleanup evidence.";
async function state(tx: Transaction, origin: string) { return (await tx.execute({ sql: "SELECT * FROM notification_origin_setup WHERE origin=?", args: [origin] })).rows[0]; }
async function current(tx: Transaction, owner: NotificationSetupOwner) {
  if (!owner.trustedDeviceId) return undefined;
  return (await tx.execute({ sql: "SELECT d.id,d.generation FROM notification_devices d JOIN trusted_devices t ON t.id=d.trusted_device_id WHERE d.channel='browser' AND d.origin=? AND d.trusted_device_id=? AND d.revoked_at IS NULL AND t.revoked_at IS NULL", args: [owner.origin, owner.trustedDeviceId] })).rows[0];
}
async function snapshot(tx: Transaction, owner: NotificationSetupOwner, row?: Row) {
  const device = await current(tx, owner);
  return {
    origin: owner.origin, setupEpoch: Number(row?.setup_epoch ?? 0), featureEnabled: foregroundBrowserNotificationsEnabled(),
    currentDevice: device ? { id: String(device.id), generation: Number(device.generation) } : null,
    pending: row?.pending === 1 ? { operationId: String(row.operation_id), pendingEpoch: Number(row.operation_epoch), kind: String(row.operation_kind), startedAt: String(row.started_at), recoveryInstructions } : null,
    completion: row?.pending === 0 ? { operationId: String(row.operation_id), pendingEpoch: Number(row.operation_epoch), completedAt: String(row.completed_at), evidence: String(row.completion_evidence) } : null,
  };
}
/** Status neither enrolls a device nor creates/clears an origin operation. */
export function notificationSetupStatus(owner: NotificationSetupOwner) { return withNotificationStoreWrite(async tx => snapshot(tx, owner, await state(tx, owner.origin))); }
export async function beginNotificationCleanup(owner: NotificationSetupOwner, input: z.infer<typeof beginNotificationCleanupSchema>) {
  const value = beginNotificationCleanupSchema.parse(input);
  return withNotificationStoreWrite(async tx => {
    const row = await state(tx, owner.origin);
    if (row?.operation_id === value.operationId) {
      if (row.pending !== 1 || Number(row.operation_epoch) !== value.expectedSetupEpoch + 1 || row.operation_kind !== value.kind || row.initiator_trusted_device_id !== owner.trustedDeviceId || row.target_device_id !== (value.current?.deviceId ?? null) || row.target_generation !== (value.current?.expectedGeneration ?? null)) throw new NotificationSetupError("setup_operation_mismatch");
      return snapshot(tx, owner, row);
    }
    if (row?.pending === 1) throw new NotificationSetupError("setup_pending");
    if (Number(row?.setup_epoch ?? 0) !== value.expectedSetupEpoch) throw new NotificationSetupError("setup_stale");
    if (value.expectedSetupEpoch > Number.MAX_SAFE_INTEGER - 2) throw new NotificationSetupError("setup_epoch_exhausted");
    const device = await current(tx, owner);
    if (device && !value.current) throw new NotificationApiError("current_device_required", 409);
    if (value.current && (!device || device.id !== value.current.deviceId)) throw new NotificationApiError("device_forbidden", 403);
    if (device && (Number(device.generation) !== value.current!.expectedGeneration || Number(device.generation) >= Number.MAX_SAFE_INTEGER)) throw new NotificationApiError("device_unavailable", 409);
    const now = new Date().toISOString();
    await tx.execute({ sql: `INSERT INTO notification_origin_setup (origin,setup_epoch,pending,operation_id,operation_epoch,operation_kind,initiator_trusted_device_id,target_device_id,target_generation,started_at)
      VALUES (?,?,1,?,?,?,?,?,?,?) ON CONFLICT(origin) DO UPDATE SET setup_epoch=excluded.setup_epoch,pending=1,operation_id=excluded.operation_id,operation_epoch=excluded.operation_epoch,operation_kind=excluded.operation_kind,initiator_trusted_device_id=excluded.initiator_trusted_device_id,target_device_id=excluded.target_device_id,target_generation=excluded.target_generation,started_at=excluded.started_at,completed_at=NULL,completion_evidence=NULL`, args: [owner.origin, value.expectedSetupEpoch + 1, value.operationId, value.expectedSetupEpoch + 1, value.kind, owner.trustedDeviceId, value.current?.deviceId ?? null, value.current?.expectedGeneration ?? null, now] });
    if (device) {
      // Advance generation before releasing the transaction: all captured sends/attachments are stale.
      await tx.execute({ sql: "UPDATE notification_devices SET generation=generation+1,push=0,subscription_ciphertext=NULL,subscription_fingerprint=NULL,revoked_at=?,updated_at=? WHERE id=? AND generation=?", args: [value.kind === "background_disable" ? null : now, now, device.id, device.generation] });
      await cancelNotificationDeviceWork(tx, String(device.id), now);
    }
    return snapshot(tx, owner, await state(tx, owner.origin));
  });
}
async function finish(owner: NotificationSetupOwner, input: z.infer<typeof operationIdentity>, evidence: "client_settled" | "owner_confirmation") {
  return withNotificationStoreWrite(async tx => {
    const row = await state(tx, owner.origin);
    if (!row || row.operation_id !== input.operationId || Number(row.operation_epoch) !== input.pendingEpoch || (row.pending === 0 && row.completion_evidence !== evidence)) throw new NotificationSetupError("setup_operation_mismatch");
    if (row.pending === 1) await tx.execute({ sql: "UPDATE notification_origin_setup SET pending=0,setup_epoch=setup_epoch+1,completed_at=?,completion_evidence=? WHERE origin=? AND operation_id=? AND operation_epoch=? AND pending=1", args: [new Date().toISOString(), evidence, owner.origin, input.operationId, input.pendingEpoch] });
    return snapshot(tx, owner, await state(tx, owner.origin));
  });
}
/** Caller attests that every native promise settled successfully; the server cannot observe the browser. */
export function completeNotificationCleanup(owner: NotificationSetupOwner, input: z.infer<typeof completeNotificationCleanupSchema>) { return finish(owner, completeNotificationCleanupSchema.parse(input), "client_settled"); }
/** Separate explicit owner acknowledgment, never represented as observed native evidence. */
export function recoverNotificationCleanup(owner: NotificationSetupOwner, input: z.infer<typeof recoverNotificationCleanupSchema>) { return finish(owner, recoverNotificationCleanupSchema.parse(input), "owner_confirmation"); }
