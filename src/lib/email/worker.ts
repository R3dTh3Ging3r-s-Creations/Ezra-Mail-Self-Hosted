import { runMorningBriefWork, stopMorningBriefWork } from "./morning-brief-worker";
import {
  consolidatePreferences,
  ensureTelegramStarted,
  isInteractiveModelBusy,
  pollGmail,
  processUnreadBacklogBatch,
} from "./service";
import { runNotificationWork } from "./notification-worker";
import { syncCalendarAccounts } from "./calendar";
import { getServiceState, getSetting, nowIso, setServiceState } from "./database";
import { readDeploymentRevision } from "./system-recovery";

type WorkerState = {
  running: boolean;
  timer?: NodeJS.Timeout;
  ticking: boolean;
  notificationTicking: boolean;
  morningBriefTicking: boolean;
  lastPollMs: number;
  lastBacklogMs: number;
  markers: Set<string>;
};

const globalWorker = globalThis as typeof globalThis & {
  __ezraEmailWorker?: WorkerState;
};

function state() {
  if (!globalWorker.__ezraEmailWorker) {
    globalWorker.__ezraEmailWorker = {
      running: false,
      ticking: false,
      notificationTicking: false,
      morningBriefTicking: false,
      lastPollMs: 0,
      lastBacklogMs: 0,
      markers: new Set(),
    };
  }
  return globalWorker.__ezraEmailWorker;
}

export function getWorkerStatus() {
  return { running: state().running, lastPollMs: state().lastPollMs };
}

export async function startEmailWorker() {
  const current = state();
  if (current.running) return getWorkerStatus();
  current.running = true;
  current.timer = setInterval(() => void runTickSafely(), 60_000);
  await runTickSafely();
  return getWorkerStatus();
}

export function stopEmailWorker() {
  const current = state();
  if (current.timer) clearInterval(current.timer);
  current.timer = undefined;
  current.running = false;
  stopMorningBriefWork();
  return getWorkerStatus();
}

async function runTickSafely() {
  // Separate lane: a slow source/model tick cannot hold notification recovery or delivery.
  const notifications = runNotificationTickSafely();
  const briefWork = runMorningBriefTickSafely();
  try {
    await tick();
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    process.stderr.write(`Ezra email worker tick failed; retrying on the next interval.\n${message}\n`);
  }
  await Promise.allSettled([notifications, briefWork]);
}

async function runMorningBriefTickSafely() {
  const current = state();
  if (current.morningBriefTicking) return;
  current.morningBriefTicking = true;
  try { await runMorningBriefWork(); }
  catch { process.stderr.write("Ezra morning brief work unavailable; retrying on the next interval.\n"); }
  finally { current.morningBriefTicking = false; }
}

async function runNotificationTickSafely() {
  const current = state();
  if (current.notificationTicking) return;
  current.notificationTicking = true;
  try { await ensureTelegramStarted(); await runNotificationWork(); }
  catch { process.stderr.write("Ezra notification work unavailable; retrying on the next interval.\n"); }
  finally { current.notificationTicking = false; }
}

async function tick() {
  const current = state();
  if (current.ticking) return;
  current.ticking = true;
  try {
    const revision = await readDeploymentRevision();
    if (revision) await setServiceState("worker_revision", revision);
    await setServiceState("worker_heartbeat", nowIso());
    const pollingPaused = Boolean(await getServiceState("polling_paused_at"));
    await setServiceState("worker_polling_state", pollingPaused ? "paused" : "running");
    const pollMinutes = Number((await getSetting("poll_minutes")) || 5);
    const interactiveModelBusy = pollingPaused ? true : await isInteractiveModelBusy();
    if (!pollingPaused && !interactiveModelBusy && Date.now() - current.lastPollMs >= pollMinutes * 60_000) {
      current.lastPollMs = Date.now();
      try {
        await pollGmail();
        await syncCalendarAccounts({ staleOnly: true }).catch((error) =>
          setServiceState(
            "last_calendar_sync_error",
            error instanceof Error ? error.message : String(error),
          ),
        );
      } catch (error) {
        await setServiceState(
          "last_poll_error",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const backlogMinutes = boundedMinutes(
      process.env.GMAIL_BACKLOG_INTERVAL_MINUTES,
      15,
    );
    const backlogWakeRequested = (await getServiceState("backlog_wake_requested")) === "1";
    const persistedBacklogAt = await getServiceState("last_backlog_worker_at");
    const persistedBacklogMs = persistedBacklogAt
      ? new Date(persistedBacklogAt).getTime()
      : 0;
    const backlogReferenceMs = Math.max(current.lastBacklogMs, persistedBacklogMs || 0);
    if (
      !pollingPaused &&
      !interactiveModelBusy &&
      (
        backlogWakeRequested ||
        Date.now() - backlogReferenceMs >= backlogMinutes * 60_000
      )
    ) {
      await setServiceState("backlog_wake_requested", "0");
      current.lastBacklogMs = Date.now();
      await setServiceState(
        "last_backlog_worker_at",
        new Date(current.lastBacklogMs).toISOString(),
      );
      await processUnreadBacklogBatch().catch((error) =>
        setServiceState(
          "last_backlog_error",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }

    const timezone = (await getSetting("timezone")) || "America/Chicago";
    const local = getLocalParts(new Date(), timezone);
    const dayKey = `${local.year}-${local.month}-${local.day}`;
    const minuteKey = `${local.hour}:${local.minute}`;
    const learningMarker = `learning:${dayKey}`;
    if (minuteKey === "21:30" && !current.markers.has(learningMarker)) {
      current.markers.add(learningMarker);
      await consolidatePreferences();
    }
    for (const marker of current.markers) {
      if (!marker.includes(dayKey)) current.markers.delete(marker);
    }
  } finally {
    current.ticking = false;
  }
}

function getLocalParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value])) as Record<
    string,
    string
  >;
}

function boundedMinutes(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(1440, Math.max(1, parsed));
}
