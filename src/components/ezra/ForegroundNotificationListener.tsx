"use client";
import { useEffect, useRef, useState } from "react";
import { parseNotificationTarget, type NotificationTarget } from "@/lib/email/notification-target";
import type { SafeForegroundEvent, SharedForegroundFeed } from "@/lib/email/notification-foreground";
import { BROWSER_NOTIFICATION_ENROLLMENT_EVENT, readBrowserNotificationState, showForegroundNotification, type BrowserNotificationEnrollment } from "./browserNotifications";
import { NotificationClientError, notificationRequest, notificationSetupMessage } from "./notificationClient";
import styles from "./EzraMail.module.css";

type ClaimedEvent = SafeForegroundEvent & { attemptId: string; generation: number };
export function ForegroundNotificationListener(props: { onOpen: (target: NotificationTarget) => void; onAuthenticationFailure: () => void }) {
  const callbacks = useRef(props);
  useEffect(() => { callbacks.current = props; }, [props]);
  const [warning, setWarning] = useState("");
  useEffect(() => {
    let mounted = true;
    let active: AbortController | null = null;
    let activeKey: string | null = null;
    let stoppedKey: string | null = null;
    const attempted = new Set<string>();
    const key = (value: BrowserNotificationEnrollment) => `${value.origin}/${value.deviceId}/${value.generation}`;
    const stillEnrolled = (enrollment: BrowserNotificationEnrollment) => {
      const state = readBrowserNotificationState();
      return mounted && state.kind === "enabled" && state.enrollment !== null && key(state.enrollment) === key(enrollment);
    };
    const receipt = async (event: ClaimedEvent, kind: "foreground_shown" | "foreground_failed" | "clicked", signal?: AbortSignal) => {
      await notificationRequest("receipts", { method: "POST", body: JSON.stringify({ attemptId: event.attemptId, generation: event.generation, kind }), signal });
    };
    async function trigger() {
      const state = readBrowserNotificationState();
      const enrollment = state.kind === "enabled" ? state.enrollment : null;
      const currentKey = enrollment ? key(enrollment) : null;
      if (active && currentKey === activeKey) return;
      if (active) { active.abort(); active = null; }
      if (!mounted || !enrollment || currentKey === stoppedKey) return;
      const controller = new AbortController(); active = controller; activeKey = currentKey;
      const current = () => !controller.signal.aborted && stillEnrolled(enrollment);
      try {
        const feed = await notificationRequest<SharedForegroundFeed>("foreground", { signal: controller.signal });
        if (!current()) return;
        if (!feed.enabled || feed.deviceId !== enrollment.deviceId || feed.generation !== enrollment.generation) {
          stoppedKey = currentKey; setWarning("Notification setup changed. Open Settings > Delivery to finish setup."); return;
        }
        for (const discovery of feed.events) {
          if (!current()) return;
          const attemptKey = `${currentKey}/${discovery.deliveryId}`;
          if (attempted.has(attemptKey)) continue;
          // Claim errors may be ambiguous too; do not redisplay this delivery locally.
          attempted.add(attemptKey);
          let claimed: ClaimedEvent;
          try { claimed = await notificationRequest<ClaimedEvent>("claims", { method: "POST", body: JSON.stringify({ deliveryId: discovery.deliveryId, expectedGeneration: enrollment.generation }), signal: controller.signal }); }
          catch (error) { if (error instanceof NotificationClientError && error.code === "already_claimed_or_stale") continue; throw error; }
          if (!current() || claimed.generation !== enrollment.generation) return;
          const target = parseNotificationTarget(claimed.target);
          let outcome: "foreground_shown" | "foreground_failed" = "foreground_failed";
          try {
            if (!target) throw new Error("Invalid target");
            showForegroundNotification(claimed, () => {
              if (!stillEnrolled(enrollment)) return;
              void receipt(claimed, "clicked").catch(() => {});
              callbacks.current.onOpen(target);
            });
            outcome = "foreground_shown";
          } catch { if (current()) setWarning("One or more notifications could not be shown. Later alerts will still be checked."); }
          // A failed receipt is not proof of failed display and never triggers replay.
          try { await receipt(claimed, outcome, controller.signal); } catch (error) {
            if (error instanceof NotificationClientError && [401, 403, 503].includes(error.status)) throw error;
          }
        }
      } catch (error) {
        if (!current()) return;
        if (error instanceof NotificationClientError && [401, 403, 409, 503].includes(error.status)) {
          stoppedKey = currentKey;
          if (error.status === 401) callbacks.current.onAuthenticationFailure();
          else setWarning(notificationSetupMessage(error));
        }
      } finally { if (active === controller) active = null; }
    }
    const onTrigger = () => { void trigger(); };
    const visible = () => { if (!document.hidden) onTrigger(); };
    const timer = window.setInterval(onTrigger, 60000);
    window.addEventListener("focus", onTrigger); window.addEventListener("storage", onTrigger);
    window.addEventListener(BROWSER_NOTIFICATION_ENROLLMENT_EVENT, onTrigger);
    document.addEventListener("visibilitychange", visible); onTrigger();
    return () => { mounted = false; active?.abort(); window.clearInterval(timer); window.removeEventListener("focus", onTrigger); window.removeEventListener("storage", onTrigger); window.removeEventListener(BROWSER_NOTIFICATION_ENROLLMENT_EVENT, onTrigger); document.removeEventListener("visibilitychange", visible); };
  }, []);
  return warning ? <div className={styles.foregroundNotificationWarning} role="alert">{warning}</div> : null;
}
