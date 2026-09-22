"use client";

import { cleanupBrowserPush, resumeSettledBrowserPushCleanup } from "./pushNotifications";
import { clearMatchingBrowserEnrollment, readBrowserNotificationState } from "./browserNotifications";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Phase = "checking" | "insecure" | "unsupported" | "ready" | "installing" | "waiting" | "error" | "conflict" | "repaired";
type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
type PwaState = { phase: Phase; origin: string; installed: boolean; canInstall: boolean; busy: boolean; notice: string };
type PwaContextValue = PwaState & {
  connect: () => Promise<void>; checkUpdate: () => Promise<void>; repair: () => Promise<void>; install: () => Promise<void>;
};
const PwaContext = createContext<PwaContextValue | null>(null);
const initialState: PwaState = { phase: "checking", origin: "", installed: false, canInstall: false, busy: false, notice: "" };

function ownsRegistration(registration: ServiceWorkerRegistration, origin: string) {
  const scripts = [registration.active, registration.waiting, registration.installing].filter((worker) => worker !== null);
  return registration.scope === `${origin}/` && scripts.length > 0
    && scripts.every((worker) => worker!.scriptURL === `${origin}/ezra-sw.js`);
}

async function rootRegistration() {
  const registrations = await navigator.serviceWorker.getRegistrations();
  return registrations.find((registration) => registration.scope === `${window.location.origin}/`);
}

export function PwaProvider({ children, browserNotificationsEnabled = true }: { children: ReactNode; browserNotificationsEnabled?: boolean }) {
  const [state, setState] = useState(initialState);
  const lifecycle = useRef(0);
  const live = useRef(false);
  const operation = useRef(false);
  const installPrompt = useRef<InstallPrompt | null>(null);
  const detachRegistration = useRef<() => void>(() => {});

  const watch = useCallback((registration: ServiceWorkerRegistration, generation: number) => {
    detachRegistration.current();
    const workers = new Set<ServiceWorker>();
    const current = () => live.current && lifecycle.current === generation;
    const sync = () => {
      if (!current()) return;
      if (!registration.active && !registration.installing && !registration.waiting) {
        setState((previous) => ({ ...previous, phase: "error", notice: "App connection could not start. Check your connection and retry." }));
        return;
      }
      setState((previous) => ({ ...previous, phase: registration.waiting ? "waiting"
        : registration.installing ? "installing" : registration.active ? "ready" : "checking" }));
    };
    const track = () => {
      for (const worker of [registration.installing, registration.waiting, registration.active]) {
        if (worker && !workers.has(worker)) { workers.add(worker); worker.addEventListener("statechange", sync); }
      }
      sync();
    };
    registration.addEventListener("updatefound", track);
    track();
    detachRegistration.current = () => {
      registration.removeEventListener("updatefound", track);
      for (const worker of workers) worker.removeEventListener("statechange", sync);
    };
  }, []);

  const connect = useCallback(async () => {
    if (!live.current || operation.current) return;
    if (!window.isSecureContext) { setState((previous) => ({ ...previous, phase: "insecure" })); return; }
    if (!navigator.serviceWorker) { setState((previous) => ({ ...previous, phase: "unsupported" })); return; }
    const generation = lifecycle.current;
    const current = () => live.current && lifecycle.current === generation;
    operation.current = true;
    setState((previous) => ({ ...previous, phase: "checking", busy: true, notice: "" }));
    try {
      const existing = await rootRegistration();
      if (!current()) return;
      if (existing && !ownsRegistration(existing, window.location.origin)) {
        setState((previous) => ({ ...previous, phase: "conflict" }));
        return;
      }
      const registration = await navigator.serviceWorker.register("/ezra-sw.js", { scope: "/", updateViaCache: "none" });
      if (!current()) return;
      if (!ownsRegistration(registration, window.location.origin)) {
        setState((previous) => ({ ...previous, phase: "conflict" }));
        return;
      }
      watch(registration, generation);
    } catch {
      if (current()) setState((previous) => ({ ...previous, phase: "error", notice: "App connection could not start. Check your connection and retry." }));
    } finally {
      if (current()) { operation.current = false; setState((previous) => ({ ...previous, busy: false })); }
    }
  }, [watch]);

  useEffect(() => {
    live.current = true;
    lifecycle.current += 1;
    operation.current = false;
    const display = window.matchMedia?.("(display-mode: standalone)");
    const syncInstalled = () => setState((previous) => ({ ...previous,
      installed: Boolean(display?.matches || (navigator as Navigator & { standalone?: boolean }).standalone) }));
    const beforeInstall = (event: Event) => {
      if (!window.isSecureContext || !navigator.serviceWorker || !("prompt" in event)) return;
      event.preventDefault();
      installPrompt.current = event as InstallPrompt;
      setState((previous) => ({ ...previous, canInstall: true }));
    };
    const installed = () => {
      installPrompt.current = null;
      setState((previous) => ({ ...previous, installed: true, canInstall: false, notice: "" }));
    };
    setState((previous) => ({ ...previous, origin: window.location.origin }));
    syncInstalled();
    display?.addEventListener("change", syncInstalled);
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", installed);
    void connect();
    return () => {
      live.current = false;
      lifecycle.current += 1;
      installPrompt.current = null;
      detachRegistration.current();
      display?.removeEventListener("change", syncInstalled);
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", installed);
    };
  }, [connect]);

  async function registrationAction(action: "update" | "repair") {
    if (!live.current || operation.current) return;
    const generation = lifecycle.current;
    const current = () => live.current && lifecycle.current === generation;
    operation.current = true;
    setState((previous) => ({ ...previous, busy: true, notice: "" }));
    try {
      const enrollment = readBrowserNotificationState().enrollment;
      const resumed = action === "repair" && browserNotificationsEnabled ? resumeSettledBrowserPushCleanup("worker_repair") : null;
      if (resumed) {
        await resumed.completion;
        if (enrollment && enrollment.deviceId === resumed.current?.deviceId && enrollment.generation === resumed.current.expectedGeneration) {
          clearMatchingBrowserEnrollment(enrollment);
        }
        if (current()) {
          detachRegistration.current();
          setState((previous) => ({ ...previous, phase: "repaired", canInstall: false, notice: "" }));
        }
        return;
      }
      const registration = await rootRegistration();
      if (!current()) return;
      if (!registration || !ownsRegistration(registration, window.location.origin)) {
        setState((previous) => ({ ...previous, phase: registration ? "conflict" : "error",
          notice: registration ? "" : "App connection is missing. Retry to reconnect." }));
        return;
      }
      if (action === "update") {
        await registration.update();
        if (current()) {
          watch(registration, generation);
          setState((previous) => ({ ...previous, notice: "Update check finished." }));
        }
      } else {
        if (browserNotificationsEnabled) {
          const enrollment = readBrowserNotificationState().enrollment;
          await cleanupBrowserPush("worker_repair");
          if (enrollment) clearMatchingBrowserEnrollment(enrollment);
        } else if (!await registration.unregister()) throw new Error("Unregister incomplete");
        if (current()) {
          detachRegistration.current();
          setState((previous) => ({ ...previous, phase: "repaired", canInstall: false, notice: "" }));
        }
      }
    } catch {
      if (current()) setState((previous) => ({ ...previous, notice: action === "update"
        ? "Could not check for updates. Check your connection and try again."
        : "Could not repair the app connection. Server/background removal is not confirmed. Retry when connected, or review the pending cleanup in notification settings." }));
    } finally {
      if (current()) { operation.current = false; setState((previous) => ({ ...previous, busy: false })); }
    }
  }

  async function install() {
    const event = installPrompt.current;
    if (!event || !live.current || operation.current) return;
    const generation = lifecycle.current;
    const current = () => live.current && lifecycle.current === generation;
    installPrompt.current = null;
    operation.current = true;
    setState((previous) => ({ ...previous, canInstall: false, busy: true, notice: "" }));
    try {
      await event.prompt();
      const result = await event.userChoice;
      if (current()) setState((previous) => ({ ...previous, notice: result.outcome === "accepted"
        ? "Finish installation in your browser." : "Installation dismissed. You can install later from your browser menu." }));
    } catch {
      if (current()) setState((previous) => ({ ...previous, notice: "Installation could not start. Try your browser menu." }));
    } finally {
      if (current()) { operation.current = false; setState((previous) => ({ ...previous, busy: false })); }
    }
  }

  return <PwaContext.Provider value={{ ...state, connect, checkUpdate: () => registrationAction("update"), repair: () => registrationAction("repair"), install }}>{children}</PwaContext.Provider>;
}

export function usePwa() { return useContext(PwaContext); }
