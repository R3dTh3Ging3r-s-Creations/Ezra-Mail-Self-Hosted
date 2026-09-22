import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserNotificationControls } from "@/components/ezra/BrowserNotificationControls";
import { BROWSER_NOTIFICATION_STORAGE_KEY } from "@/components/ezra/browserNotifications";
const origin = location.origin;
let generation: number, enabled: boolean, pushEnabled: boolean, pending: any, setupEpoch: number;
let native: any, registration: any, fetcher: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
const key = "BA" + "A".repeat(85);
const device = () => ({ id: "device", generation, origin, channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push: pushEnabled }, detailedCopy: false, createdAt: "2026-09-14T12:00:00Z", updatedAt: "2026-09-14T12:00:00Z", revokedAt: null, lastSuccessAt: null, lastFailureAt: null, lastDisplayedAt: null, lastClickedAt: null });
const status = () => ({ origin, setupEpoch, featureEnabled: true, currentDevice: enabled ? { id: "device", generation } : null, pending, completion: null });
beforeEach(() => {
  localStorage.clear(); generation = 1; enabled = true; pushEnabled = false; pending = null; setupEpoch = 0;
  localStorage.setItem(BROWSER_NOTIFICATION_STORAGE_KEY, JSON.stringify({ origin, enabled: true, deviceId: "device", generation }));
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("Notification", { permission: "granted" });
  vi.stubGlobal("PushManager", class { static supportedContentEncodings = ["aes128gcm"]; });
  native = { options: { applicationServerKey: Uint8Array.from(atob(key), c => c.charCodeAt(0)).buffer }, unsubscribe: vi.fn().mockResolvedValue(true), toJSON: () => ({ endpoint: "https://fcm.googleapis.com/synthetic", expirationTime: null, keys: { p256dh: "synthetic", auth: "synthetic" } }) };
  registration = Object.assign(new EventTarget(), { scope: origin + "/", active: { scriptURL: origin + "/ezra-sw.js", state: "activated", postMessage: (_data: unknown, ports: MessagePort[]) => ports[0].postMessage({ notificationProtocol: 1 }) }, waiting: null, installing: null, showNotification: vi.fn(),
    pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe: vi.fn().mockImplementation(async () => { registration.pushManager.getSubscription.mockResolvedValue(native); return native; }) } });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: Object.assign(new EventTarget(), { getRegistrations: async () => [registration] }) });
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let result: unknown;
    if (url.endsWith("/setup")) result = status();
    else if (url.endsWith("/begin")) { generation++; pushEnabled = false; setupEpoch++; pending = { operationId: body.operationId, pendingEpoch: setupEpoch, kind: body.kind, startedAt: "2026-09-14T12:00:00Z", recoveryInstructions: "Setup is paused on every browser using this origin. Save work and close the initiating browser windows, then clean up in browser controls." }; result = status(); }
    else if (url.endsWith("/complete") || url.endsWith("/recover")) { pending = null; setupEpoch++; result = status(); }
    else if (url.endsWith("/subscription")) { if (init?.method === "POST") pushEnabled = true; result = { generation, deliveryEnabled: pushEnabled, subscription: { subscribed: pushEnabled, expiresAt: pushEnabled ? "2026-12-13T12:00:00Z" : null, reenrollmentRequired: false, reason: pushEnabled ? "subscribed" : "not_subscribed" } }; }
    else result = { devices: enabled ? [device()] : [], currentDeviceId: enabled ? "device" : null, pushConfiguration: { configured: true, reason: "configured", publicKey: key, vapidKeyFingerprint: "a".repeat(64) } };
    return new Response(JSON.stringify(result));
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, "serviceWorker"); });
it("explains relay privacy and explicitly enables then disables background while retaining foreground", async () => {
  render(<BrowserNotificationControls />);
  const enable = await screen.findByRole("button", { name: "Enable background delivery" });
  await waitFor(() => expect(enable).toBeEnabled());
  expect(screen.getByText(/browser-controlled relay/i)).toBeInTheDocument();
  expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: "Show sender and subject on the lock screen" })).not.toBeChecked();
  fireEvent.click(enable);
  expect(registration.pushManager.subscribe).toHaveBeenCalledOnce();
  await screen.findByText("Background delivery enabled");
  fireEvent.click(screen.getByRole("button", { name: "Disable background delivery" }));
  await screen.findByText(/Background delivery removed. Foreground/);
  expect(JSON.parse(localStorage.getItem(BROWSER_NOTIFICATION_STORAGE_KEY)!)).toMatchObject({ enabled: true, generation: 2 });
  expect(native.unsubscribe).toHaveBeenCalledOnce();
});
it("retains native subscriptions and reports failed attachment without false enablement", async () => {
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => url.endsWith("/subscription") && init?.method === "POST" ? new Response(JSON.stringify({ code: "setup_stale" }), { status: 409 }) : original(url, init));
  render(<BrowserNotificationControls />);
  const enable = await screen.findByRole("button", { name: "Enable background delivery" });
  await waitFor(() => expect(enable).toBeEnabled()); fireEvent.click(enable);
  expect(await screen.findByRole("alert")).toHaveTextContent(/could not be confirmed.*retained/i);
  expect(native.unsubscribe).not.toHaveBeenCalled();
  expect(screen.queryByText("Background delivery enabled")).not.toBeInTheDocument();
});
it("presents the identified pending operation and requires explicit owner cleanup confirmation", async () => {
  pending = { operationId: "interrupted-op", pendingEpoch: 3, kind: "worker_repair", startedAt: "2026-09-14T12:00:00Z", recoveryInstructions: "Setup is paused on every browser using this origin. Save work and close the initiating browser windows, then clean up in browser controls." };
  await act(async () => { render(<BrowserNotificationControls />); });
  expect(await screen.findByText(/interrupted-op/)).toBeInTheDocument();
  const confirm = screen.getByRole("button", { name: "Confirm interrupted cleanup" });
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I completed this exact origin/ }));
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/recover"))).toBe(true));
  expect(native.unsubscribe).not.toHaveBeenCalled();
});

it("keeps cleanup pending after UI timeout and completes the actual native promise after unmount", async () => {
  const view = render(<BrowserNotificationControls />);
  const enable = await screen.findByRole("button", { name: "Enable background delivery" });
  await waitFor(() => expect(enable).toBeEnabled());
  fireEvent.click(enable);
  await screen.findByText("Background delivery enabled");
  let settle!: (value: boolean) => void;
  native.unsubscribe.mockReturnValue(new Promise<boolean>(resolve => { settle = resolve; }));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    fireEvent.click(screen.getByRole("button", { name: "Disable background delivery" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15001); });
    expect(screen.getByText(/This operation is still pending/)).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/complete"))).toBe(false);
    view.unmount();
    await act(async () => settle(true));
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/complete"))).toBe(true);
  } finally { vi.useRealTimers(); }
});
it("distinguishes revoked server delivery from incomplete native removal and allows retry", async () => {
  render(<BrowserNotificationControls />);
  const enable = await screen.findByRole("button", { name: "Enable background delivery" });
  await waitFor(() => expect(enable).toBeEnabled());
  fireEvent.click(enable);
  await screen.findByText("Background delivery enabled");
  native.unsubscribe.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "Disable background delivery" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/Server delivery is revoked.*native browser cleanup/i);
  expect(pushEnabled).toBe(false);
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/complete"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Disable background delivery" }));
  await screen.findByText(/Background delivery removed. Foreground/);
});
it("retains authorized password-only owner recovery when trusted inventory is forbidden", async () => {
  localStorage.clear(); enabled = false;
  pending = { operationId: "password-owner-interrupted", pendingEpoch: 7, kind: "worker_repair", startedAt: "2026-09-14T12:00:00Z", recoveryInstructions: "Close the initiating browser windows and finish this origin's worker and subscription cleanup in browser controls." };
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => url.endsWith("/devices")
    ? new Response(JSON.stringify({ code: "trusted_device_required" }), { status: 403 }) : original(url, init));
  await act(async () => { render(<BrowserNotificationControls />); });
  expect(await screen.findByText(/password-owner-interrupted/)).toBeInTheDocument();
  expect(screen.getByText(pending.recoveryInstructions)).toBeInTheDocument();
  const confirm = screen.getByRole("button", { name: "Confirm interrupted cleanup" });
  expect(confirm).toBeDisabled();
  expect(screen.getByRole("button", { name: "Enable background delivery" })).toBeDisabled();
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/recover"))).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: /I completed this exact origin/ }));
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByText(/password-owner-interrupted/)).not.toBeInTheDocument());
  const recovery = fetcher.mock.calls.filter(([url]) => url.endsWith("/recover"));
  expect(recovery).toHaveLength(1);
  expect(JSON.parse(String(recovery[0][1]?.body))).toEqual({ operationId: "password-owner-interrupted", pendingEpoch: 7, ownerConfirmedNativeCleanup: true });
  expect(fetcher.mock.calls.some(([url, init]) => url.endsWith("/subscription") || (url.endsWith("/devices") && init?.method === "POST"))).toBe(false);
  expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
  expect(native.unsubscribe).not.toHaveBeenCalled();
});
