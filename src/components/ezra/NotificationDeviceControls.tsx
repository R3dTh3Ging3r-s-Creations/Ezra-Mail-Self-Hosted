"use client";
import { useEffect, useRef, useState } from "react";
import type { BrowserNotificationEnrollment } from "./browserNotifications";
import { notificationRequest, notificationSetupMessage, type NotificationInventory } from "./notificationClient";
import styles from "./EzraMail.module.css";

export function NotificationDeviceControls({ inventory, enrollment, disabled, onChange, onDisableCurrent }: { inventory: NotificationInventory; enrollment: BrowserNotificationEnrollment | null; disabled: boolean; onChange: () => Promise<void>; onDisableCurrent: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const mounted = useRef(true), active = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function mutate(id: string, detailedCopy?: boolean) {
    if (active.current || disabled) return;
    active.current = true; setBusy(true); setError("");
    try {
      if (detailedCopy === undefined && enrollment?.deviceId === id) await onDisableCurrent();
      else await notificationRequest(`devices/${encodeURIComponent(id)}`, detailedCopy === undefined ? { method: "DELETE" } : { method: "PATCH", body: JSON.stringify({ expectedGeneration: enrollment!.generation, detailedCopy }) });
      if (mounted.current) await onChange();
    } catch (failure) { if (mounted.current) setError(notificationSetupMessage(failure)); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  return <section aria-label="Notification devices">
    <strong>Notification devices</strong>
    <button className={styles.deliveryTestButton} disabled={disabled || busy} onClick={() => void onChange()}>Refresh notification devices</button>
    <small>Accepted means the transport accepted a delivery. Displayed and clicked require separate browser receipts; timestamps can refer to different alerts.</small>
    {inventory.devices.length ? inventory.devices.map((device) => <div key={device.id} className={styles.browserNotificationControls}>
      <strong>{device.origin}</strong>
      <small>{device.platform} · {device.channel} · Permission: {device.permission} · {device.revokedAt ? "Revoked" : "Enabled"}</small>
      <small>Last accepted: {device.lastSuccessAt || "None"}</small>
      <small>Last displayed: {device.lastDisplayedAt || "None"}</small>
      <small>Last clicked: {device.lastClickedAt || "None"}</small>
      <small>Last failure: {device.lastFailureAt || "None"}</small>
      {enrollment?.enabled && enrollment.deviceId === device.id && enrollment.generation === device.generation && !device.revokedAt ? <label><input type="checkbox" checked={device.detailedCopy} disabled={disabled || busy} onChange={(event) => void mutate(device.id, event.target.checked)} /> Show sender and subject on the lock screen</label> : null}
      {!device.revokedAt ? <button className={styles.deliveryTestButton} disabled={disabled || busy} onClick={() => void mutate(device.id)}>Remove notification device</button> : null}
    </div>) : <small>No notification devices enrolled.</small>}
    {error ? <small role="alert">{error}</small> : null}
  </section>;
}
