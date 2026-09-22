import { execute } from "./database";
import { NotificationApiError, type NotificationOwner } from "./notification-api";
import { currentNotificationDevice, requireBrowserNotifications } from "./notification-enrollment";
import { claimGovernedNotification } from "./notification-claims";
import { parseNotificationTarget } from "./notification-target";
import type { NotificationDevice, NotificationEvent, NotificationKind } from "./notification-types";

export interface SafeForegroundEvent {
  deliveryId: string;
  eventId: string;
  kind: NotificationKind;
  target: string;
  tag: string;
  title: string;
  body: string;
  createdAt: string;
}
export interface SharedForegroundFeed {
  enabled: boolean;
  deviceId: string | null;
  generation: number | null;
  events: SafeForegroundEvent[];
  hasMore: boolean;
}
function boundedText(value: unknown, limit: number) { return String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit); }
async function safeEvent(event: Pick<NotificationEvent, "id" | "kind" | "target" | "replacementTag" | "createdAt">, deliveryId: string, device: NotificationDevice): Promise<SafeForegroundEvent> {
  let title = "Ezra Mail", body = event.kind === "checkin" ? "Open Ezra Mail for your daily check-in." : event.kind === "brief" ? "Your brief is ready in Ezra Mail." : "Open Ezra Mail to review new attention.";
  const target = parseNotificationTarget(event.target);
  if (!target) throw new NotificationApiError("notification_unavailable", 503);
  if (device.privacy === "detailed" && target.view === "mail") {
    // Local metadata only, scoped to the exact connected account and current opt-in.
    const result = await execute(`SELECT m.sender_name,m.subject FROM email_messages m JOIN email_accounts a ON a.id=m.account_id
      JOIN notification_devices d ON d.id=? JOIN trusted_devices t ON t.id=d.trusted_device_id
      WHERE m.id=? AND a.id=? AND a.provider=? AND a.status='connected' AND d.generation=? AND d.privacy='detailed'
      AND d.revoked_at IS NULL AND t.revoked_at IS NULL AND d.permission='granted' AND d.trusted_device_id=? AND d.origin=?`,
    [device.id, target.messageId, target.accountId, target.provider, device.generation, device.trustedDeviceId, device.origin]);
    if (result.rows[0]) { title = boundedText(result.rows[0].sender_name, 80) || title; body = boundedText(result.rows[0].subject, 140) || body; }
  }
  return { deliveryId, eventId: event.id, kind: event.kind, target: event.target, tag: event.replacementTag, title, body, createdAt: event.createdAt };
}
export async function getSharedForegroundFeed(owner: NotificationOwner): Promise<SharedForegroundFeed> {
  requireBrowserNotifications();
  let device: NotificationDevice;
  try { device = await currentNotificationDevice(owner); }
  catch (error) {
    if (!(error instanceof NotificationApiError) || !["device_forbidden", "device_unavailable"].includes(error.code)) throw error;
    return { enabled: false, deviceId: null, generation: null, events: [], hasMore: false };
  }
  const now = new Date().toISOString();
  const result = await execute(`SELECT e.id,e.kind,e.target,e.replacement_tag,e.created_at,r.id AS delivery_id
    FROM notification_deliveries r JOIN notification_events e ON e.id=r.event_id JOIN notification_devices d ON d.id=r.device_id JOIN trusted_devices t ON t.id=d.trusted_device_id
    WHERE d.id=? AND d.trusted_device_id=? AND d.origin=? AND d.generation=? AND r.generation=d.generation
    AND d.revoked_at IS NULL AND t.revoked_at IS NULL AND d.channel='browser' AND d.permission='granted' AND d.foreground=1 AND d.push=0
    AND r.state='pending' AND r.attempt_count<3 AND r.next_attempt_at<=? AND e.not_before<=? AND e.expires_at>?
    AND e.sequence>d.baseline_sequence AND e.kind<>'in_app' AND (e.origin IS NULL OR e.origin=d.origin)
    ORDER BY e.sequence,r.id LIMIT 21`, [device.id, owner.trustedDeviceId, owner.origin, device.generation, now, now, now]);
  const events = await Promise.all(result.rows.slice(0, 20).map((row) => safeEvent({ id: String(row.id), kind: row.kind as NotificationKind, target: String(row.target), replacementTag: String(row.replacement_tag), createdAt: String(row.created_at) }, String(row.delivery_id), device)));
  return { enabled: device.permission === "granted" && device.capabilities.foreground, deviceId: device.id, generation: device.generation, events, hasMore: result.rows.length > 20 };
}
export async function claimForegroundNotification(owner: NotificationOwner, input: { deliveryId: string; expectedGeneration: number }) {
  requireBrowserNotifications();
  const device = await currentNotificationDevice(owner, undefined, input.expectedGeneration);
  const claim = await claimGovernedNotification({ deliveryId: input.deliveryId, deviceId: device.id, generation: input.expectedGeneration, channel: "foreground", foregroundOwner: { ...owner, deviceId: device.id, generation: input.expectedGeneration } });
  if (!claim?.attempt.resolvedTarget) throw new NotificationApiError("already_claimed_or_stale", 409);
  return { ...await safeEvent({ ...claim.event, target: claim.attempt.resolvedTarget }, claim.delivery.id, claim.device), attemptId: claim.attempt.id, generation: claim.attempt.generation };
}
