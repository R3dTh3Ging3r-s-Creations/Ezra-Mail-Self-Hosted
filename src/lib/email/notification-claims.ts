import { z } from "zod";
import { foregroundBrowserNotificationsEnabled } from "./foreground-notifications";
import { resolveNotificationEventForClaim } from "./notification-governor";
import { withNotificationStoreWrite, getNotificationClaimCandidateInTransaction, claimNotificationDeliveryInTransaction } from "./notification-store";

/** Identity comes from server-owned enrollment/reservation lookup, never from model output. */
export async function claimGovernedNotification(input: Omit<Parameters<typeof claimNotificationDeliveryInTransaction>[1], "resolvedTarget" | "deviceId" | "generation"> & { deviceId: string; generation: number }) {
  const now = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString()).parse(input.now || new Date().toISOString());
  z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).parse(input.deviceId);
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(input.generation);
  if (input.channel !== "telegram" && !foregroundBrowserNotificationsEnabled()) return null;
  return withNotificationStoreWrite(async tx => {
    const event = await getNotificationClaimCandidateInTransaction(tx, input.deliveryId);
    if (!event) return null;
    // Reject forged/stale ownership before even writing a cancellation.
    const owned = (await tx.execute({ sql: `SELECT d.id FROM notification_deliveries r JOIN notification_devices d ON d.id=r.device_id JOIN trusted_devices t ON t.id=d.trusted_device_id
      WHERE r.id=? AND d.id=? AND r.generation=? AND d.generation=r.generation AND d.revoked_at IS NULL AND t.revoked_at IS NULL
        AND (?=0 OR (d.trusted_device_id=? AND d.origin=? AND d.id=? AND d.generation=?))`,
    args: [input.deliveryId, input.deviceId, input.generation, input.foregroundOwner ? 1 : 0, input.foregroundOwner?.trustedDeviceId || "", input.foregroundOwner?.origin || "", input.foregroundOwner?.deviceId || "", input.foregroundOwner?.generation || 0] })).rows;
    if (!owned.length) return null;
    const resolved = await resolveNotificationEventForClaim(tx, { event, now });
    if (resolved.target === null) {
      await tx.execute({ sql: "UPDATE notification_deliveries SET state='cancelled',cancellation_reason=?,updated_at=? WHERE id=? AND state='pending'", args: [resolved.reasonCode, now, input.deliveryId] });
      return null;
    }
    return claimNotificationDeliveryInTransaction(tx, { ...input, now, resolvedTarget: resolved.target });
  });
}
