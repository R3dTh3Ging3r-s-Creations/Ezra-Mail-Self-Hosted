import { notificationSettingsReads } from "../fixtures/notification-settings";
import { expect, test, type Page, type Worker, type Request, type Response, type Frame } from "@playwright/test";

import type { getMailMeta } from "../../src/lib/email/professional";
import type { MessageDetail } from "../../src/lib/email/types";

const publicKey = "BA" + "A".repeat(85);
const exactTarget = "/?view=mail&workspace=workspace%3Aaccount%3Agmail%3Asynthetic-account&message=synthetic-message";
const stamp = "2026-09-14T12:00:00.000Z";

const targetMeta: Awaited<ReturnType<typeof getMailMeta>> = {
  accounts: [{ id: "synthetic-account", provider: "gmail", label: "Synthetic account", email: "account@example.test", purpose: "Testing" }],
  workspaces: [{ id: "workspace:account:gmail:synthetic-account", label: "Synthetic account", provider: "gmail", accountIds: ["synthetic-account"], isAllAccounts: false, purpose: "Testing", calendarRole: "none" }],
  categories: [],
};

const targetDetail: MessageDetail = {
  message: {
    id: "synthetic-message", accountId: "synthetic-account", accountLabel: "Synthetic account", accountProvider: "gmail",
    externalMessageId: "synthetic-external", threadId: "synthetic-thread", senderName: "Synthetic sender",
    senderEmail: "sender@example.test", subject: "Synthetic notification target", receivedAt: stamp,
    snippet: "Exact synthetic account message.", gmailUrl: "https://mail.google.com/", hasAttachments: false,
    isUnread: true, mailboxLabels: [], status: "processed", attention: null, urgency: null, confidence: null,
    category: null, summary: null, reason: null, recommendation: null, needsReply: false, deadline: null,
    injectionFlags: [], model: null, notifiedAt: null,
  },
  bodyText: "Exact synthetic account message.", bodyIsExcerpt: false, attachments: [],
  contactMemory: { summary: "Synthetic contact.", messageCount: 1, firstSeenAt: stamp, lastSeenAt: stamp, categories: [] },
};

async function fixture(page: Page, unsupported = false) {
  await page.context().addInitScript(({ unsupported }) => {
    // New tabs first execute init scripts on about:blank, without secure-origin APIs.
    if (location.origin !== "http://localhost:3000") return;
    const state = { documentId: crypto.randomUUID(), permission: "default" as NotificationPermission, prompts: 0, subscriptions: 0, removals: 0,
      shown: [] as Array<{ title: string; options?: NotificationOptions; onclick?: () => void }> };
    Object.assign(window, { __notificationFixture: state });
    class FixtureNotification {
      static get permission() { return localStorage.getItem("synthetic-notification-permission") === "granted" ? "granted" : state.permission; }
      static async requestPermission() { state.prompts++; state.permission = "granted"; localStorage.setItem("synthetic-notification-permission", "granted"); return state.permission; }
      onclick?: () => void;
      close() {}
      constructor(public title: string, public options?: NotificationOptions) { state.shown.push(this); }
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: FixtureNotification });
    Object.defineProperty(window, "PushManager", { configurable: true, value: unsupported ? undefined : class { static supportedContentEncodings = ["aes128gcm"]; } });
    let subscription: object | null = null;
    // Real owned service worker and MessageChannel; synthetic native subscription boundary.
    Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", { configurable: true, get() {
      return {
        getSubscription: async () => subscription,
        subscribe: async (options: PushSubscriptionOptionsInit) => {
          state.subscriptions++;
          if (subscription) return subscription;
          subscription = {
            options: { applicationServerKey: options.applicationServerKey },
            toJSON: () => ({ endpoint: "https://fcm.googleapis.com/synthetic-fixture", expirationTime: null, keys: { p256dh: "synthetic", auth: "synthetic" } }),
            unsubscribe: async () => { state.removals++; subscription = null; return true; },
          };
          return subscription;
        },
      };
    } });
  }, { unsupported });
  const state = { enrolled: false, generation: 1, epoch: 0, push: false, detailed: false,
    pending: null as null | { operationId: string; pendingEpoch: number; kind: string; startedAt: string; recoveryInstructions: string },
    event: false, claimed: false, receipts: [] as string[], posts: [] as string[] };
  const current = () => state.enrolled ? { id: "synthetic-device", generation: state.generation } : null;
  const setup = (origin: string) => ({ origin, setupEpoch: state.epoch, featureEnabled: true, currentDevice: current(), pending: state.pending, completion: null });
  const device = (origin: string) => ({ id: "synthetic-device", generation: state.generation, origin, channel: "browser", platform: "other", permission: "granted", capabilities: { foreground: true, push: state.push }, detailedCopy: state.detailed,
    createdAt: stamp, updatedAt: stamp, revokedAt: null, lastSuccessAt: null, lastFailureAt: null, lastDisplayedAt: null, lastClickedAt: null });
  const event = { deliveryId: "synthetic-delivery", eventId: "synthetic-event", kind: "interrupt", target: exactTarget, title: "Ezra Mail", body: "Open Ezra Mail to review new attention.", tag: "synthetic-attention", createdAt: stamp };
  await page.context().route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const body = request.postData() ? request.postDataJSON() : {};
    if (request.method() !== "GET") state.posts.push(path);
    let value: unknown;
    if (Object.hasOwn(notificationSettingsReads, path)) value = notificationSettingsReads[path];
    else if (path === "/api/auth/session") value = { authenticated: true, configured: true, developmentBypass: false, authenticationMethod: "trusted_device", expiresAt: null };
    else if (path === "/api/mail/meta") value = targetMeta;
    else if (path === "/api/accounts") value = { items: [{ accountId: "synthetic-account", accountProvider: "gmail", accountLabel: "Synthetic account", status: "connected", purposeLabel: "Testing" }] };
    else if (path === "/api/settings") value = { accounts: [], health: { worker: "running", lastPollAt: stamp, lastPollError: null, ollama: true, telegramConfigured: false, telegramRunning: false, gogInstalled: true, gmailModifyAuthorized: false }, updates: { app: { currentVersion: "0.8.0", commit: "synthetic" } }, backlog: { status: "idle", discovered: 0 } };
    else if (path === "/api/notifications/policy") value = { timezone: "America/Chicago", digestTimes: ["08:30", "16:30"], quietStart: "22:00", quietEnd: "07:00", dailyInterruptBudget: 3, burstWindowSeconds: 60, senderCooldownMinutes: 360, snoozedUntil: null, calmCheckinEnabled: false, calmCheckinTime: "12:30", channels: [{ id: "browser", label: "Browser/app notifications", status: "available", detail: "Explicit setup", lastError: null }], categoryPolicies: [], guardrails: [], stats: { windowDays: 7, interruptsSent: 0, interruptsSkipped: 0, interruptsFailed: 0, interruptsAccepted: 0, interruptsDisplayed: 0, digestsSent: 0, digestsSkipped: 0, digestsFailed: 0, digestsAccepted: 0, digestsDisplayed: 0, lastNotificationAt: null, lastDigestAt: null } };
    else if (path === "/api/notifications/history") value = { events: [], calmCheckinHoldUntil: null };
    else if (path === "/api/notifications/setup") value = setup(url.origin);
    else if (path === "/api/notifications/setup/begin") {
      expect(body.expectedSetupEpoch).toBe(state.epoch);
      if (state.enrolled) expect(body.current).toEqual({ deviceId: "synthetic-device", expectedGeneration: state.generation });
      state.epoch++; state.generation++; state.push = false;
      if (body.kind !== "background_disable") state.enrolled = false;
      state.pending = { operationId: body.operationId, pendingEpoch: state.epoch, kind: body.kind, startedAt: stamp, recoveryInstructions: "Save work, close initiating browser windows, and complete exact-origin native cleanup before confirming." };
      value = setup(url.origin);
    } else if (path === "/api/notifications/setup/complete") {
      expect(body.nativeCleanupSettled).toBe(true);
      expect(body.operationId).toBe(state.pending?.operationId);
      state.pending = null; state.epoch++; value = setup(url.origin);
    } else if (path === "/api/notifications/devices") {
      if (request.method() === "POST") { expect(body.expectedSetupEpoch).toBe(state.epoch); state.enrolled = true; value = { device: device(url.origin) }; }
      else value = { devices: state.enrolled ? [device(url.origin)] : [], currentDeviceId: current()?.id ?? null, pushConfiguration: { configured: true, reason: "configured", publicKey, vapidKeyFingerprint: "a".repeat(64) } };
    } else if (path.endsWith("/synthetic-device/subscription")) {
      if (request.method() === "POST") { expect(body.expectedSetupEpoch).toBe(state.epoch); expect(body.expectedGeneration).toBe(state.generation); state.push = true; }
      value = { generation: state.generation, deliveryEnabled: state.push, subscription: { subscribed: state.push, expiresAt: state.push ? "2026-12-13T12:00:00Z" : null, reenrollmentRequired: false, reason: state.push ? "subscribed" : "not_subscribed" } };
    } else if (path.endsWith("/synthetic-device") && request.method() === "PATCH") { state.detailed = body.detailedCopy; value = { device: device(url.origin) }; }
    else if (path === "/api/notifications/foreground") value = { enabled: state.enrolled, deviceId: current()?.id ?? null, generation: state.generation, events: state.event && !state.claimed && !state.push ? [event] : [], hasMore: false };
    else if (path === "/api/notifications/claims") {
      if (state.claimed || state.push) { await route.fulfill({ status: 409, json: { code: "already_claimed_or_stale" } }); return; }
      state.claimed = true; value = { ...event, attemptId: "synthetic-attempt", generation: state.generation };
    } else if (path === "/api/notifications/receipts") { state.receipts.push(body.kind); value = { recorded: true }; }
    else if (path === "/api/mail/synthetic-message") value = { detail: targetDetail, thread: [], capabilities: { unsubscribeSupported: false, protectedMessage: false } };
    else if (path === "/api/settings/writing") value = { remoteImagesAllowed: false };
    else if (path === "/api/views") value = { items: [] };
    else if (path === "/api/mail") value = { items: [], total: 0, hasMore: false, nextCursor: null };
    else if (path === "/api/auth/devices") value = { devices: [], passkeys: [], currentDeviceId: null, configured: true, bypassActive: false };
    else { await route.fulfill({ status: 503, json: { message: "Synthetic fixture has no provider access." } }); return; }
    await route.fulfill({ json: value, headers: { "cache-control": "no-store" } });
  });
  await page.goto("/?view=settings");
  await expect(page.getByRole("button", { name: "Delivery", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delivery", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Notification Policy Center" })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  return state;
}
async function nativeState(page: Page) {
  return page.evaluate(() => (window as unknown as { __notificationFixture: { documentId: string; prompts: number; subscriptions: number; removals: number; shown: unknown[] } }).__notificationFixture);
}

test("explicit notification setup preserves privacy and foreground on background disable", async ({ page }) => {
  const state = await fixture(page);
  expect(await nativeState(page)).toMatchObject({ prompts: 0, subscriptions: 0 });
  await page.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await expect(page.getByText("Enabled on this browser", { exact: true })).toBeVisible();
  const background = page.getByRole("region", { name: "Background delivery" });
  await expect(background.getByText(/browser-controlled relay/)).toBeVisible();
  const details = page.getByRole("checkbox", { name: "Show sender and subject on the lock screen" });
  await expect(details).not.toBeChecked();
  await expect(background.getByRole("button", { name: "Enable background delivery" })).toBeEnabled();
  expect((await nativeState(page)).subscriptions).toBe(0);
  await background.getByRole("button", { name: "Enable background delivery" }).click();
  await expect(background.getByText("Background delivery enabled", { exact: true })).toBeVisible();
  expect(state.push).toBe(true);
  expect(state.detailed).toBe(false);
  // The controlled checkbox commits after PATCH and inventory refresh.
  await details.click();
  await expect(details).toBeChecked();
  await expect.poll(() => state.detailed).toBe(true);
  await background.getByRole("button", { name: "Disable background delivery" }).click();
  await expect(page.getByText(/Background delivery removed. Foreground/)).toBeVisible();
  expect(state.push).toBe(false);
  expect(state.enrolled).toBe(true);
  expect(await nativeState(page)).toMatchObject({ prompts: 1, subscriptions: 1, removals: 1 });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ezra-mail-browser-notifications-enabled")!))).toMatchObject({ enabled: true, generation: 2 });
});

test("unsupported background guidance keeps explicit foreground use available", async ({ page }) => {
  await fixture(page, true);
  await page.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enable background delivery" })).toBeDisabled();
  await expect(page.getByText(/On iPhone or iPad, add Ezra to the Home Screen/)).toBeVisible();
  expect((await nativeState(page)).subscriptions).toBe(0);
});

test("shared foreground claim receipts open the exact full target", async ({ page }) => {
  let stage = "setup";
  let diagnosticsActive = true;
  const evidence: Array<Record<string, unknown>> = [];
  const labels = new Map<Page, string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const cleanups: Array<() => void> = [];
  const fixturePath = (value: string) => {
    const url = new URL(value);
    return url.origin === "http://localhost:3000" ? (url.pathname + url.search).slice(0, 300) : "outside-fixture";
  };
  const record = (kind: string, candidate: Page, detail: Record<string, unknown> = {}) => {
    if (!diagnosticsActive) return;
    if (evidence.length === 80) evidence.shift();
    evidence.push({ kind, tab: labels.get(candidate), stage, ...detail });
  };
  const watch = (candidate: Page) => {
    labels.set(candidate, "tab-" + (labels.size + 1));
    const error = (failure: Error) => record("pageerror", candidate, { message: failure.message.slice(0, 160) });
    const ready = () => record("domcontentloaded", candidate, { path: fixturePath(candidate.url()) });
    const loaded = () => record("load", candidate, { path: fixturePath(candidate.url()) });
    const request = (value: Request) => record("request", candidate, { type: value.resourceType(), path: fixturePath(value.url()) });
    const response = (value: Response) => record("response", candidate, { type: value.request().resourceType(), path: fixturePath(value.url()), status: value.status(), fromServiceWorker: value.fromServiceWorker() });
    const finished = (value: Request) => record("finished", candidate, { type: value.resourceType(), path: fixturePath(value.url()) });
    const failed = (value: Request) => record("failed", candidate, { type: value.resourceType(), path: fixturePath(value.url()), error: value.failure()?.errorText.slice(0, 160) });
    const frame = (value: Frame) => record("frame", candidate, { main: value === candidate.mainFrame(), path: fixturePath(value.url()) });
    candidate.on("pageerror", error);
    candidate.on("domcontentloaded", ready);
    candidate.on("load", loaded);
    candidate.on("request", request);
    candidate.on("response", response);
    candidate.on("requestfinished", finished);
    candidate.on("requestfailed", failed);
    candidate.on("framenavigated", frame);
    cleanups.push(() => {
      candidate.off("pageerror", error); candidate.off("domcontentloaded", ready); candidate.off("load", loaded);
      candidate.off("request", request); candidate.off("response", response); candidate.off("requestfinished", finished);
      candidate.off("requestfailed", failed); candidate.off("framenavigated", frame);
    });
  };
  const scheduleSnapshot = (recipient: Page, previousDocument: string, afterMs: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      // Observation only: neither this probe nor its deadline gates the real reload assertion.
      let deadline: ReturnType<typeof setTimeout>;
      const snapshot = recipient.evaluate(() => {
        const reader = document.querySelector('aside[aria-label="Conversation: Synthetic notification target"]');
        return {
          readyState: document.readyState, pathname: location.pathname.slice(0, 300), search: location.search.slice(0, 300),
          fixtureDocumentId: (window as unknown as { __notificationFixture?: { documentId: string } }).__notificationFixture?.documentId ?? null,
          readerHeadingPresent: reader?.querySelector("h2")?.textContent === "Synthetic notification target",
          plainTextButtonPresent: Boolean(reader && [...reader.querySelectorAll("button")].some(button => button.textContent === "Plain text")),
          controllerURL: navigator.serviceWorker?.controller?.scriptURL.slice(0, 200) ?? null,
        };
      }).then(value => ({ status: "captured", previousDocument, ...value }), error => ({ status: "evaluation-failed", error: error instanceof Error ? error.name : "unknown" }));
      const bounded = new Promise<{ status: string }>(resolve => {
        deadline = setTimeout(() => { timers.delete(deadline); resolve({ status: "evaluation-pending" }); }, 750);
        timers.add(deadline);
      });
      void Promise.race([snapshot, bounded]).then(value => {
        if (!diagnosticsActive) return;
        record("reload-snapshot", recipient, { afterMs, ...value, frameCount: recipient.frames().length, framePaths: recipient.frames().map(frame => fixturePath(frame.url())).slice(0, 4) });
      }).finally(() => { clearTimeout(deadline); timers.delete(deadline); });
    }, afterMs);
    timers.add(timer);
  };
  watch(page);
  page.context().on("page", watch);
  try {
    const state = await fixture(page);
    await page.getByRole("button", { name: "Enable notifications", exact: true }).click();
    await expect(page.getByText("Enabled on this browser", { exact: true })).toBeVisible();
    state.event = true;
    const second = await page.context().newPage();
    await second.goto("/?view=settings");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => state.receipts.filter(kind => kind === "foreground_shown").length).toBe(1);
    const firstCount = (await nativeState(page)).shown.length;
    const recipient = firstCount ? page : second;
    await recipient.evaluate(() => {
      const state = (window as unknown as { __notificationFixture: { shown: Array<{ onclick?: () => void }> } }).__notificationFixture;
      state.shown[0].onclick?.();
    });
    await expect(recipient).toHaveURL(new URL(exactTarget, recipient.url()).href);
    await expect.poll(() => state.receipts).toEqual(["foreground_shown", "clicked"]);
    const assertExactReader = async () => {
      await expect(recipient).toHaveURL(new URL(exactTarget, recipient.url()).href);
      const reader = recipient.getByRole("complementary", { name: "Conversation: Synthetic notification target" });
      await expect(reader.getByRole("heading", { name: targetDetail.message.subject, exact: true })).toBeVisible();
      await expect(reader.getByText("sender@example.test · Synthetic account", { exact: true })).toBeVisible();
      await expect(reader.getByRole("region", { name: "Original message" })).toContainText(targetDetail.bodyText);
      // A working reader control proves hydration as well as the correct account/message.
      const plainText = reader.getByRole("button", { name: "Plain text", exact: true });
      await plainText.click();
      await expect(plainText).toHaveAttribute("aria-pressed", "true");
    };
    stage = "reader before reload";
    await assertExactReader();
    const previousDocument = (await nativeState(recipient)).documentId;
    stage = "reload";
    record("recipient", recipient, { previousDocument });
    scheduleSnapshot(recipient, previousDocument, 500);
    scheduleSnapshot(recipient, previousDocument, 2500);
    // Use a content reload; Firefox's chrome command also performs tab/remoteness preparation.
    await Promise.all([
      recipient.waitForEvent("domcontentloaded"),
      recipient.evaluate(() => location.reload()),
    ]);
    expect(await recipient.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).type)).toBe("reload");
    expect((await nativeState(recipient)).documentId).not.toBe(previousDocument);
    stage = "reader after reload";
    await assertExactReader();
    stage = "complete";
  } finally {
    diagnosticsActive = false;
    for (const timer of timers) clearTimeout(timer);
    console.info("Notification exact target", JSON.stringify({ stage, evidence }));
    page.context().off("page", watch);
    for (const cleanup of cleanups) cleanup();
  }
});

test("owned active worker reports protocol without subscription or activation mutation", async ({ page }) => {
  await fixture(page);
  const capability = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const channel = new MessageChannel();
    const response = new Promise(resolve => { channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); }; });
    registration.active!.postMessage({ type: "EZRA_NOTIFICATION_CAPABILITIES" }, [channel.port2]);
    return response;
  });
  expect(capability).toEqual({ notificationProtocol: 1 });
  expect((await nativeState(page)).subscriptions).toBe(0);
});

type PushObservation = {
  completed: number;
  errors: string[];
  shown: Array<{ title: string; options?: NotificationOptions }>;
};

async function observeWorkerPush(worker: Worker) {
  await worker.evaluate(() => {
    const scope = self as unknown as {
      registration: ServiceWorkerRegistration;
      ExtendableEvent: { prototype: { type: string; waitUntil(promise: Promise<unknown>): void } };
      __pushObservation: PushObservation;
    };
    const observation: PushObservation = { completed: 0, errors: [], shown: [] };
    scope.__pushObservation = observation;
    // Chromium headless shell has no platform notification service. Keep the real
    // push listener and IDB, replacing only its native display boundary.
    scope.registration.showNotification = async (title, options) => { observation.shown.push({ title, options }); };
    const waitUntil = scope.ExtendableEvent.prototype.waitUntil;
    scope.ExtendableEvent.prototype.waitUntil = function (promise) {
      waitUntil.call(this, promise);
      if (this.type === "push") void Promise.resolve(promise).then(
        () => { observation.completed++; },
        error => { observation.errors.push(String(error)); observation.completed++; },
      );
    };
  });
}

function pushObservation(worker: Worker) {
  return worker.evaluate(() => (self as unknown as { __pushObservation: PushObservation }).__pushObservation);
}

function pushMarkers(page: Page) {
  return page.evaluate(() => new Promise<unknown[]>((resolve, reject) => {
    const request = indexedDB.open("ezra-push-receipts", 1);
    request.onupgradeneeded = () => request.transaction!.abort(); // The real push must have created it.
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("received", "readonly");
      const rows = transaction.objectStore("received").getAll();
      transaction.oncomplete = () => { database.close(); resolve(rows.result); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }));
}

test("Chromium synthetic push uses real IDB duplicate markers across worker restart", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "CDP injection is Chromium-only, not native Firefox/iOS relay evidence.");
  await context.grantPermissions(["notifications"]);
  // Context routing also covers the worker-owned receipt request.
  await context.route("**/api/**", route => route.fulfill({ status: 401, json: { authenticated: false, configured: true } }));
  const cdp = await context.newCDPSession(page);
  let registrationId = "", versionId = "", runningStatus = "";
  cdp.on("ServiceWorker.workerRegistrationUpdated", event => {
    for (const registration of event.registrations) if (registration.scopeURL === "http://localhost:3000/" && !registration.isDeleted) registrationId = registration.registrationId;
  });
  cdp.on("ServiceWorker.workerVersionUpdated", event => {
    for (const version of event.versions) if (version.scriptURL === "http://localhost:3000/ezra-sw.js" && version.status === "activated") {
      versionId = version.versionId;
      runningStatus = version.runningStatus;
    }
  });
  await cdp.send("ServiceWorker.enable");
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => registrationId).not.toBe("");
  await expect.poll(() => versionId).not.toBe("");
  await expect.poll(() => runningStatus).toBe("running");
  const worker = context.serviceWorkers().find(candidate => candidate.url() === "http://localhost:3000/ezra-sw.js")!;
  expect(worker).toBeDefined();
  await observeWorkerPush(worker);
  const data = JSON.stringify({ version: 1, eventId: "cdp-event", attemptId: "cdp-attempt", deviceId: "cdp-device", generation: 1, kind: "interrupt", title: "Ezra Mail", body: "Open Ezra Mail to review new attention.", target: "/?view=today", tag: "cdp-tag", expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const inject = () => cdp.send("ServiceWorker.deliverPushMessage", { origin: "http://localhost:3000", registrationId, data });
  await Promise.all([inject(), inject()]);
  // CDP acknowledges dispatch before waitUntil settles; wait for both actual handlers.
  await expect.poll(async () => (await pushObservation(worker)).completed).toBe(2);
  expect(await pushObservation(worker)).toEqual({ completed: 2, errors: [], shown: [{
    title: "Ezra Mail", options: {
      body: "Open Ezra Mail to review new attention.", tag: "cdp-tag", renotify: false,
      icon: "/branding/ezra-mail-logo-d4-192.png",
      data: { target: "/?view=today", attemptId: "cdp-attempt", generation: 1 },
    },
  }] });
  const markers = await pushMarkers(page);
  expect(markers).toEqual([{ eventId: "cdp-event", receivedAt: expect.any(Number) }]);
  await cdp.send("ServiceWorker.stopWorker", { versionId });
  await expect.poll(() => runningStatus).toBe("stopped");
  await cdp.send("ServiceWorker.startWorker", { scopeURL: "http://localhost:3000/" });
  await expect.poll(() => runningStatus).toBe("running");
  // Chromium/Playwright retain the Worker handle but replace its execution realm.
  // Verify that replacement before installing fresh observation in the new realm.
  expect(await worker.evaluate(() => "__pushObservation" in self)).toBe(false);
  await observeWorkerPush(worker);
  expect(await pushObservation(worker)).toEqual({ completed: 0, errors: [], shown: [] });
  await inject();
  await expect.poll(async () => (await pushObservation(worker)).completed).toBe(1);
  expect(await pushObservation(worker)).toEqual({ completed: 1, errors: [], shown: [] });
  expect(await pushMarkers(page)).toEqual(markers);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});
