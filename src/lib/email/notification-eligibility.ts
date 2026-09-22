import { foregroundBrowserNotificationsEnabled } from "./foreground-notifications";
import { isCurrentNotificationOrigin } from "./notification-origin";
import { readTelegramConfiguration } from "./notification-telegram-config";

/** Pure runtime checks for a row whose permission and trust were checked in SQL.
 * Safe inside a store transaction: environment reads only, no database or I/O. */
export function isCurrentNotificationEnrollment(row: Record<string, unknown>, browserEnabled = true): boolean {
  if (!isCurrentNotificationOrigin(String(row.origin))) return false;
  if (row.channel === "telegram") {
    const configuration = readTelegramConfiguration();
    return !!configuration && row.telegram_binding_fingerprint === configuration.fingerprint;
  }
  return row.channel === "browser" && browserEnabled && foregroundBrowserNotificationsEnabled()
    && (row.foreground === 1 || row.push === 1);
}
