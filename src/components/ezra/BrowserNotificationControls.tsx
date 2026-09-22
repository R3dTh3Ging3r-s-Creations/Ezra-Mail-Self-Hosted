"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Send } from "lucide-react";
import {
  BROWSER_NOTIFICATION_ENROLLMENT_EVENT, BrowserNotificationOperationError,
  clearMatchingBrowserEnrollment, disableBrowserNotifications, enableBrowserNotifications,
  readBrowserNotificationState, reconcileBackgroundCleanup, sendBrowserNotificationTest,
  type BrowserNotificationState,
} from "./browserNotifications";
import { NotificationClientError, notificationRequest, notificationSetupMessage, type NotificationInventory } from "./notificationClient";
import {
  cleanupBrowserPush, confirmInterruptedCleanup, enableBackgroundDelivery, getNotificationSetup,
  preparePushSetup, pushSetupMessage, type NotificationSetupStatus, type PushSetup,
} from "./pushNotifications";
import type { NotificationPushSubscriptionStatus } from "@/lib/email/notification-types";
import { NotificationDeviceControls } from "./NotificationDeviceControls";
import styles from "./EzraMail.module.css";

type SubscriptionState = { generation: number; deliveryEnabled: boolean; subscription: NotificationPushSubscriptionStatus };
export function BrowserNotificationControls() {
  const [state, setState] = useState<BrowserNotificationState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [inventory, setInventory] = useState<NotificationInventory | null>(null);
  const [setup, setSetup] = useState<NotificationSetupStatus | null>(null);
  const [push, setPush] = useState<PushSetup | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionState | null>(null);
  const [confirmedCleanup, setConfirmedCleanup] = useState(false);
  const mounted = useRef(false);
  const operation = useRef(0);
  const active = useRef(false);
  const inventoryRequest = useRef<AbortController | null>(null);
  const sync = useCallback(() => setState(readBrowserNotificationState()), []);

  const refreshInventory = useCallback(async () => {
    inventoryRequest.current?.abort();
    const request = new AbortController();
    inventoryRequest.current = request;
    setPush(null);
    const expected = readBrowserNotificationState().enrollment;
    const current = () => mounted.current && !request.signal.aborted;
    try {
      const [next, nextSetup] = await Promise.all([
        notificationRequest<NotificationInventory>("devices", { signal: request.signal }),
        // Origin cleanup recovery has its own authorization; a rejected trusted
        // inventory request must not discard this independently successful read.
        getNotificationSetup().then(nextSetup => {
          if (current()) setSetup(nextSetup);
          return nextSetup;
        }, failure => {
          if (current()) setSetup(null);
          throw failure;
        }),
      ]);
      if (!current()) return;
      setInventory(next);
      const latest = readBrowserNotificationState().enrollment;
      if (!active.current && expected?.enabled && latest?.enabled && expected.deviceId === latest.deviceId && expected.generation === latest.generation
        && !next.devices.some(device => device.id === expected.deviceId && device.id === next.currentDeviceId && device.generation === expected.generation && !device.revokedAt)) {
        clearMatchingBrowserEnrollment(expected);
        sync();
      }
      const configuration = next.pushConfiguration ?? { configured: false as const, reason: "not_configured" };
      const readiness = await preparePushSetup(configuration, nextSetup);
      if (!current()) return;
      setPush(readiness);
      const device = nextSetup.currentDevice;
      if (!device) { setSubscription(null); return; }
      const status = await notificationRequest<SubscriptionState>(`devices/${encodeURIComponent(device.id)}/subscription`, { signal: request.signal });
      if (current()) setSubscription(status);
    } catch (failure) {
      if (current()) { setInventory(null); setPush(null); setSubscription(null); setError(notificationSetupMessage(failure)); }
    }
  }, [sync]);

  useEffect(() => {
    mounted.current = true;
    sync();
    void refreshInventory();
    const refresh = () => { sync(); if (!active.current) void refreshInventory(); };
    const visible = () => { if (!document.hidden) refresh(); };
    const changed = (event: MessageEvent) => { if (event.data?.type === "EZRA_PUSH_REPAIR_REQUIRED") refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener("ezra:refresh", refresh);
    window.addEventListener(BROWSER_NOTIFICATION_ENROLLMENT_EVENT, refresh);
    document.addEventListener("visibilitychange", visible);
    navigator.serviceWorker?.addEventListener?.("message", changed);
    navigator.serviceWorker?.addEventListener?.("controllerchange", refresh);
    return () => {
      mounted.current = false;
      operation.current++;
      inventoryRequest.current?.abort();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("ezra:refresh", refresh);
      window.removeEventListener(BROWSER_NOTIFICATION_ENROLLMENT_EVENT, refresh);
      document.removeEventListener("visibilitychange", visible);
      navigator.serviceWorker?.removeEventListener?.("message", changed);
      navigator.serviceWorker?.removeEventListener?.("controllerchange", refresh);
    };
  }, [refreshInventory, sync]);
  useEffect(() => { setConfirmedCleanup(false); }, [setup?.pending?.operationId]);

  async function run(action: "enable" | "disable" | "background_enable" | "background_disable" | "recover") {
    if (active.current) return;
    active.current = true;
    const operationId = ++operation.current;
    const current = () => mounted.current && operation.current === operationId;
    const before = readBrowserNotificationState().enrollment;
    setBusy(true); setNotice(""); setError("");
    // A slow native promise stays pending even if this UI times out or unmounts.
    const timer = setTimeout(() => {
      if (current()) setNotice(action === "background_disable" || action === "disable"
        ? "This operation is still pending. Native cleanup has not been confirmed; setup remains paused until it settles or you complete interrupted cleanup."
        : "This operation is still pending. Background setup could not be confirmed; its browser subscription is retained.");
    }, 15000);
    try {
      if (action === "enable") await enableBrowserNotifications(undefined, current, setup ?? undefined);
      if (action === "disable") await disableBrowserNotifications();
      if (action === "background_enable") {
        if (!push) throw new Error("Setup not ready");
        await enableBackgroundDelivery(push);
      }
      if (action === "background_disable") {
        const result = await cleanupBrowserPush("background_disable", begun => reconcileBackgroundCleanup(before, begun));
        reconcileBackgroundCleanup(before, result);
      }
      if (action === "recover") {
        if (!setup?.pending || !confirmedCleanup) throw new Error("Confirmation required");
        await confirmInterruptedCleanup(setup.pending);
      }
      if (current()) {
        sync();
        if (action === "disable") setNotice("This browser was removed from Ezra. Browser permission remains unchanged.");
        if (action === "background_disable") setNotice("Background delivery removed. Foreground notifications remain enrolled.");
        if (action === "recover") setNotice("Owner cleanup confirmation recorded. Refresh and explicitly set up notifications again.");
        await refreshInventory();
      }
    } catch (failure) {
      if (current()) {
        if (action === "background_enable") setError(pushSetupMessage("attach_unconfirmed"));
        else if (action === "disable" || action === "background_disable") setError(failure instanceof NotificationClientError && failure.code === "native_cleanup_unconfirmed"
          ? "Server delivery is revoked, but native browser cleanup could not be confirmed. Retry removal; setup stays paused until cleanup finishes."
          : "Server/background removal is not confirmed. Retry removal when connected. If cleanup was interrupted, use the identified recovery steps below.");
        else if (failure instanceof BrowserNotificationOperationError && failure.code === "removal") setError("Setup could not finish, and server/background removal could not be confirmed. Refresh the device list and retry removal.");
        else if (!(failure instanceof DOMException && failure.name === "AbortError")) setError(notificationSetupMessage(failure));
        sync();
        await refreshInventory();
      }
    } finally {
      clearTimeout(timer);
      if (current()) { active.current = false; setBusy(false); }
    }
  }
  function sendTest() {
    try { sendBrowserNotificationTest(); setNotice("Test notification sent."); setError(""); }
    catch { setError("The test notification could not be shown. Review browser notification settings and try again."); }
  }
  if (!state) return <div className={styles.browserNotificationControls}><small>Checking this browser...</small></div>;
  const currentDevice = setup?.currentDevice;
  const liveEnrollment = state.kind === "enabled" && state.enrollment?.deviceId === currentDevice?.id && state.enrollment?.generation === currentDevice?.generation;
  const backgroundEnabled = !!subscription?.deliveryEnabled && subscription.generation === currentDevice?.generation && push?.nativeSubscribed === true && push.reason === "ready";
  const needsRenewal = subscription?.subscription?.reenrollmentRequired || (subscription?.subscription?.subscribed && push && !push.nativeSubscribed);
  return <div className={styles.browserNotificationControls}>
    <strong role="status">{stateLabel(state.kind)}</strong>
    <small>{stateDetail(state.kind)}</small>
    <small>This applies only to {state.origin}. Browser permission, Ezra enrollment, and installing the app are separate. Installing Ezra does not enable notifications.</small>
    {["prompt", "disabled", "legacy"].includes(state.kind) ? <button className={styles.deliveryTestButton} disabled={busy || setup?.featureEnabled === false || !!setup?.pending} onClick={() => void run("enable")}><Bell aria-hidden="true" /> {busy ? "Enabling..." : state.kind === "legacy" ? "Finish notification setup" : "Enable notifications"}</button> : null}
    {state.kind === "enabled" ? <div className={styles.browserNotificationActions}>
      <button className={styles.deliveryTestButton} disabled={busy} onClick={sendTest}><Send aria-hidden="true" /> Send test notification</button>
      <button className={styles.deliveryTestButton} disabled={busy} onClick={() => void run("disable")}><BellOff aria-hidden="true" /> Disable this browser</button>
    </div> : null}
    {state.kind === "removal_pending" || (state.enrollment && state.kind !== "enabled") ? <button className={styles.deliveryTestButton} disabled={busy} onClick={() => void run("disable")}>Retry browser removal</button> : null}
    <section aria-label="Background delivery" className={styles.browserNotificationControls}>
      <strong>{backgroundEnabled ? "Background delivery enabled" : "Background delivery is not confirmed enabled"}</strong>
      <small>Closed-window delivery uses a browser-controlled relay with an encrypted payload. Copy is generic unless you separately enable lock-screen details. Opening an alert still needs a connection to your private Ezra origin.</small>
      <small role="status">{pushSetupMessage(needsRenewal ? "reenrollment_required" : push?.reason ?? "checking")}</small>
      {subscription?.subscription?.expiresAt ? <small>Subscription expires: {subscription.subscription.expiresAt}</small> : null}
      {subscription?.subscription?.subscribed && !subscription.deliveryEnabled ? <small>A subscription is registered, but background delivery is disabled.</small> : null}
      <div className={styles.browserNotificationActions}>
        {!backgroundEnabled ? <button className={styles.deliveryTestButton} disabled={busy || !liveEnrollment || push?.reason !== "ready" || !!needsRenewal} onClick={() => void run("background_enable")}>Enable background delivery</button> : null}
        <button className={styles.deliveryTestButton} disabled={busy} onClick={() => void run("background_disable")}>Disable background delivery</button>
        <button className={styles.deliveryTestButton} disabled={busy} onClick={() => void refreshInventory()}>Refresh background settings</button>
      </div>
      {setup?.pending ? <fieldset disabled={busy}>
        <legend>Interrupted cleanup recovery</legend>
        <p>Operation {setup.pending.operationId} · {setup.pending.kind} · {setup.pending.startedAt}</p>
        <p>{setup.pending.recoveryInstructions}</p>
        <label><input type="checkbox" checked={confirmedCleanup} onChange={event => setConfirmedCleanup(event.target.checked)} /> I completed this exact origin&apos;s worker and subscription cleanup in browser controls after closing the initiating browser&apos;s Ezra windows.</label>
        <button className={styles.deliveryTestButton} disabled={!confirmedCleanup} onClick={() => void run("recover")}>Confirm interrupted cleanup</button>
      </fieldset> : null}
    </section>
    {notice ? <small role="status">{notice}</small> : null}
    {error ? <small className={styles.browserNotificationError} role="alert">{error}</small> : null}
    {inventory ? <NotificationDeviceControls inventory={inventory} enrollment={state.enrollment} disabled={busy} onChange={refreshInventory} onDisableCurrent={() => run("disable")} /> : null}
  </div>;
}
function stateLabel(kind: BrowserNotificationState["kind"]) {
  return ({ enabled: "Enabled on this browser", denied: "Blocked by this browser", insecure: "HTTPS is required", permission_unavailable: "Notification permission is unavailable", storage_unavailable: "Site storage is unavailable", unsupported: "Notifications are unavailable", disabled: "Disabled in Ezra", legacy: "Finish notification setup", removal_pending: "Browser removal pending", prompt: "Permission not requested" })[kind];
}
function stateDetail(kind: BrowserNotificationState["kind"]) {
  if (kind === "enabled") return "Ezra can show approved alerts while an authenticated tab or installed window is open, including in the background. Closed-window push requires separate setup. Notification copy is generic unless you separately enable lock-screen details below.";
  if (kind === "legacy") return "Browser permission is retained. Explicitly finish shared notification enrollment before receiving alerts.";
  if (kind === "denied") return "Open this site's notification permissions in your browser, choose Allow, then return to Ezra Mail.";
  if (kind === "insecure") return "Open Ezra Mail over HTTPS before enabling notifications.";
  if (kind === "permission_unavailable") return "Reload Ezra Mail, then review this site's notification permissions.";
  if (kind === "storage_unavailable") return "Allow site storage for Ezra Mail, then return to this page.";
  if (kind === "unsupported") return "Use a browser that supports system notifications.";
  if (kind === "removal_pending") return "Foreground alerts are paused here. Finish server and browser subscription removal with Retry.";
  if (kind === "disabled") return "Browser permission remains granted until you change it in browser settings.";
  return "Ezra will ask only after you choose Enable notifications.";
}
