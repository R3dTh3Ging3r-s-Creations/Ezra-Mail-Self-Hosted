"use client";
import { useEffect, useRef, useState } from "react";
import type { NotificationPolicySettings } from "@/lib/email/types";
import type { NotificationHistoryEntry } from "@/lib/email/notification-history";
import { api } from "./api";
import styles from "./EzraMail.module.css";

const outcomes: Record<NotificationHistoryEntry["outcome"], string> = {
  pending: "Queued", claimed: "Delivery in progress", accepted: "Accepted by transport", displayed: "Displayed", clicked: "Opened", failed: "Failed", expired: "Expired", cancelled: "Cancelled", unknown: "Outcome unknown",
};
export function NotificationAttentionControls({ policy, onSaved }: { policy: NotificationPolicySettings; onSaved: (policy: NotificationPolicySettings) => void }) {
  const [draft, setDraft] = useState(policy), [events, setEvents] = useState<NotificationHistoryEntry[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [historyStatus, setHistoryStatus] = useState("Loading this device's history.");
  const [calmHoldUntil, setCalmHoldUntil] = useState<string | null>(null);
  const dirty = useRef(false), requests = useRef<AbortController | null>(null);
  useEffect(() => { if (!dirty.current) setDraft(policy); }, [policy]);
  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    let revision = 0;
    const refresh = () => {
      const captured = ++revision;
      api<{ events: NotificationHistoryEntry[]; calmCheckinHoldUntil: string | null }>("/api/notifications/history", { signal: controller.signal })
        .then(result => {
          if (controller.signal.aborted || captured !== revision) return;
          setEvents(result.events);
          setCalmHoldUntil(result.calmCheckinHoldUntil && Date.parse(result.calmCheckinHoldUntil) > Date.now() ? result.calmCheckinHoldUntil : null);
          setHistoryStatus(result.events.length ? "" : "No shared notification history on this device.");
        })
        .catch(() => {
          if (controller.signal.aborted || captured !== revision) return;
          setEvents([]); setCalmHoldUntil(null);
          setHistoryStatus("This device's notification history is unavailable.");
        });
    };
    refresh();
    window.addEventListener("ezra:refresh", refresh);
    window.addEventListener("ezra-mail-browser-notification-enrollment-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("ezra:refresh", refresh);
      window.removeEventListener("ezra-mail-browser-notification-enrollment-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  useEffect(() => {
    if (!calmHoldUntil) return;
    const remaining = Date.parse(calmHoldUntil) - Date.now();
    if (remaining <= 0) { setCalmHoldUntil(null); return; }
    const timer = setTimeout(() => setCalmHoldUntil(null), Math.min(remaining, 2147483647));
    return () => clearTimeout(timer);
  }, [calmHoldUntil]);
  function change(update: Partial<NotificationPolicySettings>) { dirty.current = true; setDraft(current => ({ ...current, ...update })); }
  async function save(snooze?: "hour" | "tomorrow" | "clear") {
    if (busy) return;
    const signal = requests.current?.signal;
    setBusy(true); setError(""); setNotice("");
    try {
      const body = snooze ? { snooze } : { dailyInterruptBudget: draft.dailyInterruptBudget, burstWindowSeconds: draft.burstWindowSeconds, senderCooldownMinutes: draft.senderCooldownMinutes, calmCheckinEnabled: draft.calmCheckinEnabled, calmCheckinTime: draft.calmCheckinTime };
      const saved = await api<NotificationPolicySettings>("/api/notifications/policy", { method: "PATCH", body: JSON.stringify(body), signal });
      if (signal?.aborted) return;
      if (snooze) setDraft(current => ({ ...current, snoozedUntil: saved.snoozedUntil }));
      else { dirty.current = false; setDraft(saved); }
      onSaved(saved); setNotice(snooze ? "Snooze updated." : "Attention controls saved.");
    } catch { if (!signal?.aborted) setError("Attention controls could not be saved. Check the values and try again."); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  async function feedback(eventId: string, kind: "useful" | "too_noisy") {
    if (busy) return;
    const signal = requests.current?.signal;
    setBusy(true); setError("");
    try {
      await api("/api/notifications/feedback", { method: "POST", body: JSON.stringify({ eventId, kind }), signal });
      if (!signal?.aborted) {
        setEvents(current => current.map(event => event.eventId === eventId ? { ...event, feedback: kind } : event));
        const history = await api<{ calmCheckinHoldUntil: string | null }>("/api/notifications/history", { signal });
        if (!signal?.aborted) setCalmHoldUntil(history.calmCheckinHoldUntil ?? null);
      }
    } catch { if (!signal?.aborted) setError("Feedback could not be saved. Try again."); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  return <section className={styles.schedulePanel} aria-label="Notification attention">
    <header><div><h3>Attention controls</h3><p>Keep ordinary nudges within your day. Critical alerts allow at most two events in 15 minutes, with a 20-minute sender cooldown.</p></div></header>
    <form aria-label="Attention controls" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy}>
        <legend>Interrupt limits and calm check-in</legend>
        <div className={styles.notificationFormGrid}>
          <label>Ordinary interrupts per day<input type="number" min={0} max={20} step={1} required value={draft.dailyInterruptBudget} onChange={event => change({ dailyInterruptBudget: event.target.valueAsNumber })} /></label>
          <label>Burst grouping window (seconds)<input type="number" min={0} max={300} step={1} required value={draft.burstWindowSeconds} onChange={event => change({ burstWindowSeconds: event.target.valueAsNumber })} /></label>
          <label>Sender cooldown (minutes)<input type="number" min={20} max={1440} step={1} required value={draft.senderCooldownMinutes} onChange={event => change({ senderCooldownMinutes: event.target.valueAsNumber })} /></label>
          <label><input type="checkbox" checked={draft.calmCheckinEnabled} onChange={event => change({ calmCheckinEnabled: event.target.checked })} />Enable calm check-in</label>
          <label>Calm check-in time<input type="time" required value={draft.calmCheckinTime} onChange={event => change({ calmCheckinTime: event.target.value })} /></label>
        </div>
        <p>Calm check-ins are off by default. Ezra sends one only when fresh local evidence shows no outstanding attention.</p>
        <p>Too noisy pauses calm check-ins for seven days. Changing that answer to Useful can end the pause earlier; your settings and safety checks still apply.</p>
        {calmHoldUntil ? <p role="status">Calm check-ins paused by feedback until {calmHoldUntil}.</p> : null}
        <button className={styles.primaryButton} type="submit">Save attention controls</button>
      </fieldset>
    </form>
    <fieldset disabled={busy}><legend>Pause external notifications</legend>
      <p>{draft.snoozedUntil ? `Snoozed until ${draft.snoozedUntil}` : "No notification snooze is active."}</p>
      <button type="button" onClick={() => void save("hour")}>Snooze 1 hour</button>{" "}
      <button type="button" onClick={() => void save("tomorrow")}>Snooze until tomorrow</button>{" "}
      <button type="button" onClick={() => void save("clear")}>Clear snooze</button>
      <p>Tomorrow resumes at the end of quiet hours in your configured timezone. Today stays available.</p>
    </fieldset>
    <p>Notification copy is generic by default. Device sleep, Focus, browser settings, and network availability can delay or prevent delivery; acceptance does not confirm display.</p>
    {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    <h3>Recent notifications on this device</h3>
    {historyStatus ? <p>{historyStatus}</p> : null}
    <ol>{events.map(event => <li key={event.eventId}>
      <span>{event.kind === "interrupt" ? "Interrupt" : event.kind === "checkin" ? "Calm check-in" : event.kind === "brief" ? "Brief" : "In-app"} · <time dateTime={event.createdAt}>{event.createdAt}</time> · {outcomes[event.outcome]}</span>
      <fieldset disabled={busy}><legend>Feedback for {event.kind} at {event.createdAt}</legend>
        <button type="button" aria-pressed={event.feedback === "useful"} onClick={() => void feedback(event.eventId, "useful")}>Useful</button>{" "}
        <button type="button" aria-pressed={event.feedback === "too_noisy"} onClick={() => void feedback(event.eventId, "too_noisy")}>Too noisy</button>
      </fieldset>
    </li>)}</ol>
  </section>;
}
