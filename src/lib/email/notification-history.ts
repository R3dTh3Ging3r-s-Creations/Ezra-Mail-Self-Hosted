import { withEmailDatabaseAccess } from "./database-access";
import { execute, getEmailClient } from "./database";
import { notificationCheckinHoldUntil } from "./notification-feedback";
import type { NotificationOwner } from "./notification-api";
import type { NotificationKind, NotificationDeliveryState } from "./notification-types";

export interface NotificationHistoryEntry {
  eventId: string;
  kind: NotificationKind;
  createdAt: string;
  outcome: NotificationDeliveryState;
  feedback: "useful" | "too_noisy" | null;
}
/** One allowlisted projection, with ownership and generation checked in the same query. */
export async function getNotificationHistory(owner: NotificationOwner): Promise<{ events: NotificationHistoryEntry[]; calmCheckinHoldUntil: string | null }> {
  const result = await execute(`SELECT e.id,e.kind,e.created_at,r.state,f.kind AS feedback
    FROM notification_devices d JOIN trusted_devices t ON t.id=d.trusted_device_id
    JOIN notification_deliveries r ON r.device_id=d.id AND r.generation=d.generation
    JOIN notification_events e ON e.id=r.event_id
    LEFT JOIN notification_feedback f ON f.device_id=d.id AND f.event_id=e.id
    WHERE d.trusted_device_id=? AND d.origin=? AND d.channel='browser'
      AND d.revoked_at IS NULL AND t.revoked_at IS NULL AND (e.origin IS NULL OR e.origin=d.origin)
    ORDER BY e.sequence DESC LIMIT 10`, [owner.trustedDeviceId, owner.origin]);
  const calmCheckinHoldUntil = await withEmailDatabaseAccess(() => notificationCheckinHoldUntil(getEmailClient(), new Date()));
  return { calmCheckinHoldUntil, events: result.rows.map(row => ({ eventId: String(row.id), kind: row.kind as NotificationKind, createdAt: String(row.created_at), outcome: row.state as NotificationDeliveryState, feedback: row.feedback as NotificationHistoryEntry["feedback"] })) };
}
