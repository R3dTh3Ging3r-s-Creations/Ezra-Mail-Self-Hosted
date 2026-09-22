"use client";
import { useEffect, useRef, useState } from "react";
import { NotificationClientError, notificationRequest, notificationSetupMessage, type NotificationInventory } from "./notificationClient";
import styles from "./EzraMail.module.css";
export function TelegramNotificationSettings() {
    const [inventory, setInventory] = useState<NotificationInventory | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
    const mounted = useRef(true), active = useRef(false);
    async function refresh() { const value = await notificationRequest<NotificationInventory>("devices"); if (mounted.current)
        setInventory(value); }
    useEffect(() => { mounted.current = true; void refresh().catch(failure => { if (mounted.current)
        setError(notificationSetupMessage(failure)); }); return () => { mounted.current = false; }; }, []);
    const status = inventory?.telegramConfiguration;
    const device = status?.enrolled ? inventory?.devices.find(d => d.id === status.deviceId && d.channel === "telegram") : undefined;
    async function act(action: "enable" | "disable" | "test" | "privacy" | "refresh", detailedCopy?: boolean) {
        if (active.current)
            return;
        active.current = true;
        setBusy(true);
        setError("");
        setNotice("");
        try {
            if (action === "enable" && status?.configured)
                await notificationRequest("devices", { method: "POST", body: JSON.stringify({ channel: "telegram", platform: "other", permission: "granted", capabilities: { foreground: false, push: false } }) });
            else if (action === "disable" && device)
                await notificationRequest(`devices/${encodeURIComponent(device.id)}`, { method: "DELETE", body: JSON.stringify({ expectedGeneration: device.generation }) });
            else if (action === "privacy" && device)
                await notificationRequest(`devices/${encodeURIComponent(device.id)}`, { method: "PATCH", body: JSON.stringify({ expectedGeneration: device.generation, detailedCopy }) });
            else if (action === "test" && status?.configured && device) {
                const response = await fetch("/api/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "test", deviceId: device.id, expectedGeneration: device.generation }) });
                const value = await response.json();
                if (!response.ok || value.test?.ok !== true)
                    throw new NotificationClientError(value.code || "unavailable", response.status);
                if (mounted.current)
                    setNotice("Telegram accepted the generic test. This does not confirm display or reading.");
            }
            await refresh();
        }
        catch (failure) {
            if (mounted.current)
                setError(notificationSetupMessage(failure));
        }
        finally {
            active.current = false;
            if (mounted.current)
                setBusy(false);
        }
    }
    return <section className={styles.browserNotificationControls} aria-label="Telegram notification settings">
    <strong>{status?.enrolled ? "Telegram notifications enrolled" : status?.configured ? "Configured; enrollment required" : "Telegram configuration unavailable"}</strong>
    <small>{status?.disclosure || "Telegram bots are not end-to-end encrypted. Generic notification copy is recommended. Enabling replaces the previous Telegram enrollment for this destination."}</small>
    <small>Use a trusted device on this Ezra origin to enable Telegram. The configured destination must be your positive private owner chat ID. Configuration alone does not enable alerts.</small>
    <small>Commands are managed by the worker and become available on its next notification tick when polling is enabled. Feedback changes local notification preferences; review mail actions in Ezra.</small>
    <button className={styles.deliveryTestButton} disabled={busy || !status?.configured} onClick={() => void act(device ? "disable" : "enable")}>{device ? "Disable Telegram notifications" : "Enable Telegram notifications"}</button>
    <button className={styles.deliveryTestButton} disabled={busy || !status?.configured || !device} onClick={() => void act("test")}>Send generic Telegram test</button>
    <button className={styles.deliveryTestButton} disabled={busy} onClick={() => void act("refresh")}>Refresh Telegram status</button>
    {device ? <>
      <small>Last accepted: {device.lastSuccessAt || "None"}. Acceptance does not confirm display or reading.</small>
      <small>Last failure: {device.lastFailureAt || "None"}</small>
      <label><input type="checkbox" checked={device.detailedCopy} disabled={busy} onChange={event => void act("privacy", event.target.checked)}/> Show sender and subject in Telegram notifications</label>
    </> : null}
    {notice ? <small role="status">{notice}</small> : null}
    {error ? <small role="alert">{error}</small> : null}
  </section>;
}
