export type NotificationDeviceChannel = "browser" | "telegram";
export type NotificationTransport = "foreground" | "push" | "telegram";
export type NotificationPlatform = "windows" | "macos" | "linux" | "android" | "ios" | "other";
export type NotificationPermission = "default" | "granted" | "denied";
export type NotificationPrivacy = "generic" | "detailed";
export interface NotificationCapabilities { foreground: boolean; push: boolean }
export type NotificationKind = "interrupt" | "brief" | "checkin" | "in_app";
export const notificationReasonCodes = ["attention", "critical", "brief", "checkin", "quiet_hours", "low_confidence", "routine", "handled", "snoozed", "over_budget", "cooldown", "burst", "stale", "source_unhealthy"] as const;
export type NotificationReasonCode = typeof notificationReasonCodes[number];
export const notificationErrorCodes = ["rejected", "rate_limited", "unavailable", "permission_denied", "subscription_expired", "timeout", "transport_unknown", "invalid_payload"] as const;
export type NotificationErrorCode = typeof notificationErrorCodes[number];
export type NotificationDeliveryState = "pending" | "claimed" | "accepted" | "displayed" | "clicked" | "failed" | "expired" | "cancelled" | "unknown";
export type NotificationAttemptOutcome = "accepted" | "failed" | "expired" | "unknown";

/** Explicit allowlist projection; never serialize an internal database row. */
export interface NotificationDevice {
  id: string;
  trustedDeviceId: string;
  origin: string;
  channel: NotificationDeviceChannel;
  platform: NotificationPlatform;
  permission: NotificationPermission;
  capabilities: NotificationCapabilities;
  privacy: NotificationPrivacy;
  generation: number;
  baselineSequence: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  lastSuccessAt: string | null;
  lastDisplayedAt: string | null;
  lastClickedAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: NotificationErrorCode | null;
}
export interface InternalNotificationDevice extends NotificationDevice {
  subscriptionCiphertext: string | null;
  subscriptionFingerprint: string | null;
}
export interface NotificationEvent {
  id: string;
  sequence: number;
  sourceKey: string;
  decisionId: string | null;
  kind: NotificationKind;
  target: string;
  origin: string | null;
  replacementTag: string;
  reasonCode: NotificationReasonCode;
  createdAt: string;
  notBefore: string;
  expiresAt: string;
}
export interface NotificationDelivery {
  id: string;
  eventId: string;
  deviceId: string;
  generation: number;
  state: NotificationDeliveryState;
  nextAttemptAt: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface NotificationAttempt {
  id: string;
  deliveryId: string;
  channel: NotificationTransport;
  generation: number;
  startedAt: string;
  completedAt: string | null;
  outcome: NotificationAttemptOutcome | null;
  errorCode: NotificationErrorCode | null;
  externalId: string | null;
  resolvedTarget: string | null;
}
export interface NotificationReceipt {
  id: string;
  attemptId: string;
  deviceId: string;
  generation: number;
  kind: "displayed" | "clicked";
  createdAt: string;
}
export interface NotificationFeedback {
  deviceId: string;
  eventId: string;
  kind: "useful" | "too_noisy";
  createdAt: string;
}
/** Internal only. Transport must recheck live trust immediately before any I/O. */
export interface NotificationClaim {
  delivery: NotificationDelivery;
  attempt: NotificationAttempt;
  device: InternalNotificationDevice;
  event: NotificationEvent;
}

/** Safe subscription projection: endpoint, keys and ciphertext are never public. */
export interface NotificationPushSubscriptionStatus {
  subscribed: boolean;
  expiresAt: string | null;
  reenrollmentRequired: boolean;
  reason: "subscribed" | "not_subscribed" | "configuration_unavailable" | "subscription_expired" | "reenrollment_required" | "device_unavailable";
}
