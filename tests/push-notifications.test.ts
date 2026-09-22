import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let push: typeof import("@/components/ezra/pushNotifications");
const origin = window.location.origin;
const publicKey = "BA" + "A".repeat(85);
const configuration = { configured: true as const, reason: "configured" as const, publicKey, vapidKeyFingerprint: "a".repeat(64) };
const setup = { origin, setupEpoch: 0, featureEnabled: true, currentDevice: { id: "device", generation: 1 }, pending: null, completion: null };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let subscription: any, registration: any, fetcher: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => { vi.resetModules(); push = await import("@/components/ezra/pushNotifications");
  vi.stubGlobal("Notification", { permission: "granted" });
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class { static supportedContentEncodings = ["aes128gcm"]; });
  subscription = { options: { applicationServerKey: Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)).buffer }, toJSON: () => ({ endpoint: "https://fcm.googleapis.com/synthetic", expirationTime: null, keys: { p256dh: "synthetic", auth: "synthetic" } }), unsubscribe: vi.fn().mockResolvedValue(true) };
  registration = { scope: origin + "/", active: { scriptURL: origin + "/ezra-sw.js", state: "activated", postMessage: vi.fn((_data, ports) => ports[0].postMessage({ notificationProtocol: 1 })) }, waiting: null, installing: null,
    pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe: vi.fn().mockResolvedValue(subscription) }, showNotification: vi.fn(), unregister: vi.fn().mockResolvedValue(true) };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistrations: vi.fn().mockResolvedValue([registration]) } });
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("setup")) return json(setup);
    if (url.endsWith("begin")) { const body = JSON.parse(String(init?.body)); return json({ ...setup, setupEpoch: 1, currentDevice: body.kind === "background_disable" ? { id: "device", generation: 2 } : null, pending: { operationId: body.operationId, pendingEpoch: 1, kind: body.kind, startedAt: "2026-09-14T12:00:00Z", recoveryInstructions: "Save work and close all initiating browser windows before manual cleanup." } }); }
    if (url.endsWith("complete") || url.endsWith("recover")) return json({ ...setup, setupEpoch: 2 });
    return json({ subscription: { subscribed: true, expiresAt: null, reenrollmentRequired: false, reason: "subscribed" } });
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, "serviceWorker"); });

describe("explicit native setup", () => {
  it("preloads capability and epoch without subscribing, then subscribes synchronously in the gesture", async () => {
    const ready = await push.preparePushSetup(configuration, setup);
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(ready.reason).toBe("ready");
    const enabling = push.enableBackgroundDelivery(ready);
    expect(registration.pushManager.subscribe).toHaveBeenCalledOnce();
    await enabling;
    const body = JSON.parse(String(fetcher.mock.calls.find(([url]) => url.endsWith("subscription"))?.[1]?.body));
    expect(body).toMatchObject({ expectedGeneration: 1, expectedSetupEpoch: 0, expectedVapidKeyFingerprint: "a".repeat(64) });
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });
  it("retains a shared subscription after another tab attaches and this tab fails", async () => {
    const ready = await push.preparePushSetup(configuration, setup);
    registration.pushManager.getSubscription.mockResolvedValue(subscription);
    const second = await push.preparePushSetup(configuration, setup);
    await push.enableBackgroundDelivery(second);
    fetcher.mockResolvedValueOnce(json({ code: "setup_stale" }, 409));
    await expect(push.enableBackgroundDelivery(ready)).rejects.toMatchObject({ code: "setup_stale" });
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });
  it("requires explicit reenrollment for a mismatched native VAPID key", async () => {
    subscription.options.applicationServerKey = new Uint8Array([4, 9]).buffer;
    registration.pushManager.getSubscription.mockResolvedValue(subscription);
    const ready = await push.preparePushSetup(configuration, setup);
    expect(ready.reason).toBe("reenrollment_required");
    await expect(push.enableBackgroundDelivery(ready)).rejects.toThrow();
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });
  it("blocks an old active worker with a waiting update and handshake timeout", async () => {
    registration.active.postMessage = vi.fn();
    registration.waiting = { scriptURL: origin + "/ezra-sw.js" };
    vi.useFakeTimers();
    const preparing = push.preparePushSetup(configuration, setup);
    await vi.advanceTimersByTimeAsync(2100);
    expect((await preparing).reason).toBe("finish_update");
    vi.useRealTimers();
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
  });
  it.each(["denied", "unsupported", "feature_disabled", "setup_pending", "trusted_device_required"])("does not subscribe when %s", async reason => {
    let status: any = setup;
    if (reason === "denied") vi.stubGlobal("Notification", { permission: "denied" });
    if (reason === "unsupported") vi.stubGlobal("PushManager", undefined);
    if (reason === "feature_disabled") status = { ...setup, featureEnabled: false };
    if (reason === "setup_pending") status = { ...setup, pending: { operationId: "other" } };
    if (reason === "trusted_device_required") status = { ...setup, currentDevice: null };
    const ready = await push.preparePushSetup(configuration, status);
    expect(ready.reason).toBe(reason);
    await expect(push.enableBackgroundDelivery(ready)).rejects.toThrow();
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
  });
});

describe("durable native cleanup", () => {
  it("revokes server state before native cleanup and completes only after the actual promise", async () => {
    const native = deferred<boolean>(); subscription.unsubscribe.mockReturnValue(native.promise);
    registration.pushManager.getSubscription.mockResolvedValue(subscription);
    const cleaning = push.cleanupBrowserPush("background_disable");
    await vi.waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("complete"))).toHaveLength(0);
    expect(JSON.parse(String(fetcher.mock.calls.find(([url]) => url.endsWith("begin"))?.[1]?.body))).toMatchObject({ kind: "background_disable", expectedSetupEpoch: 0, current: { deviceId: "device", expectedGeneration: 1 } });
    native.resolve(true); await cleaning;
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("complete"))).toHaveLength(1);
    expect(registration.unregister).not.toHaveBeenCalled();
  });
  it("holds failed native cleanup for retry and never completes on a UI timeout", async () => {
    registration.pushManager.getSubscription.mockResolvedValue(subscription);
    subscription.unsubscribe.mockResolvedValueOnce(false);
    await expect(push.cleanupBrowserPush("background_disable")).rejects.toThrow();
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("complete"))).toBe(false);
    await push.cleanupBrowserPush("background_disable");
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("begin"))).toHaveLength(1);
  });
  it("repairs the owned worker even without enrollment, waiting for unsubscribe before unregister", async () => {
    fetcher.mockImplementationOnce(async () => json({ ...setup, currentDevice: null }));
    registration.pushManager.getSubscription.mockResolvedValue(subscription);
    await push.cleanupBrowserPush("worker_repair");
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(registration.unregister).toHaveBeenCalledOnce();
    expect(subscription.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(registration.unregister.mock.invocationCallOrder[0]);
  });
  it("does not mutate a foreign root worker or complete its pending cleanup", async () => {
    registration.active.scriptURL = origin + "/foreign.js";
    await expect(push.cleanupBrowserPush("worker_repair")).rejects.toThrow();
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(registration.unregister).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("complete"))).toBe(false);
  });
});

it("retries a lost begin with the exact identity before native work", async () => {
  const original = fetcher.getMockImplementation()!;
  let lost = true;
  fetcher.mockImplementation(async (url, init) => {
    if (url.endsWith("begin") && lost) { lost = false; throw new Error("lost begin response"); }
    return original(url, init);
  });
  registration.pushManager.getSubscription.mockResolvedValue(subscription);
  await expect(push.cleanupBrowserPush("background_disable")).rejects.toThrow();
  expect(subscription.unsubscribe).not.toHaveBeenCalled();
  await push.cleanupBrowserPush("background_disable");
  const begins = fetcher.mock.calls.filter(([url]) => url.endsWith("begin"));
  expect(begins).toHaveLength(2);
  expect(begins[0][1]?.body).toBe(begins[1][1]?.body);
  expect(subscription.unsubscribe).toHaveBeenCalledOnce();
});
it("retries a lost completion using retained settled evidence without repeating unsubscribe", async () => {
  const original = fetcher.getMockImplementation()!;
  let lost = true;
  fetcher.mockImplementation(async (url, init) => {
    if (url.endsWith("complete") && lost) { lost = false; throw new Error("lost complete response"); }
    return original(url, init);
  });
  registration.pushManager.getSubscription.mockResolvedValue(subscription);
  await expect(push.cleanupBrowserPush("background_disable")).rejects.toThrow();
  await push.cleanupBrowserPush("background_disable");
  expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  const completes = fetcher.mock.calls.filter(([url]) => url.endsWith("complete"));
  expect(completes).toHaveLength(2);
  expect(completes[0][1]?.body).toBe(completes[1][1]?.body);
});
it("retains native setup on attachment timeout after server commit", async () => {
  const ready = await push.preparePushSetup(configuration, setup);
  fetcher.mockRejectedValueOnce(new DOMException("Timeout after server commit", "TimeoutError"));
  await expect(push.enableBackgroundDelivery(ready)).rejects.toThrow();
  expect(subscription.unsubscribe).not.toHaveBeenCalled();
});
it("publishes the revoked generation before native cleanup settles", async () => {
  const changes: unknown[] = [];
  const native = deferred<boolean>();
  registration.pushManager.getSubscription.mockResolvedValue(subscription);
  subscription.unsubscribe.mockReturnValue(native.promise);
  const running = push.cleanupBrowserPush("background_disable", status => changes.push(status.currentDevice));
  await vi.waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalledOnce());
  expect(changes).toEqual([{ id: "device", generation: 2 }]);
  native.resolve(true); await running;
});
it("does not treat unavailable native inspection as successfully settled cleanup", async () => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  await expect(push.cleanupBrowserPush("background_disable")).rejects.toMatchObject({ code: "native_cleanup_unconfirmed" });
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("complete"))).toBe(false);
});
it("does not recapture a stale native object after cleanup changes the epoch", async () => {
  const ready = await push.preparePushSetup(configuration, setup);
  const native = deferred<any>(); registration.pushManager.subscribe.mockReturnValue(native.promise);
  const enabling = push.enableBackgroundDelivery(ready);
  await push.cleanupBrowserPush("background_disable");
  fetcher.mockResolvedValueOnce(json({ code: "setup_stale" }, 409));
  native.resolve(subscription);
  await expect(enabling).rejects.toMatchObject({ code: "setup_stale" });
  const attach = fetcher.mock.calls.find(([url]) => url.endsWith("subscription"));
  expect(JSON.parse(String(attach?.[1]?.body)).expectedSetupEpoch).toBe(0);
  expect(subscription.unsubscribe).not.toHaveBeenCalled();
});
it("requires a fresh explicit action after a definite stale begin rejection", async () => {
  const original = fetcher.getMockImplementation()!;
  let stale = true;
  fetcher.mockImplementation(async (url, init) => {
    if (url.endsWith("begin") && stale) { stale = false; return json({ code: "setup_stale" }, 409); }
    return original(url, init);
  });
  await expect(push.cleanupBrowserPush("background_disable")).rejects.toMatchObject({ code: "setup_stale" });
  await push.cleanupBrowserPush("background_disable");
  const begins = fetcher.mock.calls.filter(([url]) => url.endsWith("begin"));
  expect(begins).toHaveLength(2);
  expect(begins[0][1]?.body).not.toBe(begins[1][1]?.body);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("setup"))).toHaveLength(2);
});
it("allows fresh explicit cleanup after owner recovery of this retained interrupted operation", async () => {
  registration.pushManager.getSubscription.mockResolvedValue(subscription);
  subscription.unsubscribe.mockResolvedValueOnce(false);
  await expect(push.cleanupBrowserPush("background_disable")).rejects.toThrow();
  const begin = fetcher.mock.calls.find(([url]) => url.endsWith("begin"));
  const operationId = JSON.parse(String(begin?.[1]?.body)).operationId;
  await push.confirmInterruptedCleanup({ operationId, pendingEpoch: 1, kind: "background_disable", startedAt: "2026-09-14T12:00:00Z", recoveryInstructions: "Owner completed manual cleanup." });
  await push.cleanupBrowserPush("background_disable");
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("begin"))).toHaveLength(2);
});
it("does not infer native absence from a registration without subscription inspection", async () => {
  delete registration.pushManager;
  await expect(push.cleanupBrowserPush("worker_repair")).rejects.toMatchObject({ code: "native_cleanup_unconfirmed" });
  expect(registration.unregister).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("complete"))).toBe(false);
});
it("replays worker repair completion after native unregister removes its registration", async () => {
  expect(push.resumeSettledBrowserPushCleanup("worker_repair")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  const original = fetcher.getMockImplementation()!;
  let lost = true;
  fetcher.mockImplementation(async (url, init) => {
    if (url.endsWith("complete") && lost) { lost = false; throw new Error("lost completion"); }
    return original(url, init);
  });
  registration.pushManager.getSubscription.mockResolvedValue(subscription);
  registration.unregister.mockImplementation(async () => {
    vi.mocked(navigator.serviceWorker.getRegistrations).mockResolvedValue([]);
    return true;
  });
  await expect(push.cleanupBrowserPush("worker_repair")).rejects.toThrow();
  expect(await navigator.serviceWorker.getRegistrations()).toEqual([]);
  expect(push.resumeSettledBrowserPushCleanup("background_disable")).toBeNull();
  const resumed = push.resumeSettledBrowserPushCleanup("worker_repair");
  expect(resumed?.current).toEqual({ deviceId: "device", expectedGeneration: 1 });
  await resumed!.completion;
  expect(push.resumeSettledBrowserPushCleanup("worker_repair")).toBeNull();
  const completions = fetcher.mock.calls.filter(([url]) => url.endsWith("complete"));
  expect(completions).toHaveLength(2);
  expect(completions[1][1]?.body).toBe(completions[0][1]?.body);
  expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  expect(registration.unregister).toHaveBeenCalledOnce();
});
