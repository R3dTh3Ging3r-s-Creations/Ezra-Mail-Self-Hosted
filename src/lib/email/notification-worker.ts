import { drainPushNotifications } from "./notification-dispatch";
import { runNotificationSchedule } from "./notification-schedule";

/** Cleanup precedes bounded transport; source polling runs in its own worker lane. */
export async function drainNotificationWork(now?: string) {
  await drainPushNotifications({ now });
}
/** Bounded notification lane, including while source polling is paused. */
export async function runNotificationWork(now?: string) {
  await drainNotificationWork(now);
  await runNotificationSchedule(now);
}
