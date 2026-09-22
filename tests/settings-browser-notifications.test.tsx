import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserNotificationControls } from "@/components/ezra/BrowserNotificationControls";
import { BROWSER_NOTIFICATION_STORAGE_KEY, disableBrowserNotifications, enableBrowserNotifications, readBrowserNotificationState } from "@/components/ezra/browserNotifications";

let permission: NotificationPermission;
let requestPermission: ReturnType<typeof vi.fn<() => Promise<NotificationPermission>>>;
let shown: Array<{ title: string; options: NotificationOptions }>;
const device = (generation = 1) => ({ id: "device-1", generation, origin: window.location.origin, channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push: false }, detailedCopy: false, createdAt: "2026-09-14T12:00:00Z", updatedAt: "2026-09-14T12:00:00Z", revokedAt: null, lastSuccessAt: null, lastFailureAt: null, lastDisplayedAt: null, lastClickedAt: null });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const save = (generation = 1, enabled = true) => localStorage.setItem(BROWSER_NOTIFICATION_STORAGE_KEY, JSON.stringify({ origin: location.origin, enabled, deviceId: "device-1", generation }));
function harness(handle?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  let pending: unknown = null;
  const status = () => ({ origin: location.origin, setupEpoch: 4, featureEnabled: true,
    currentDevice: localStorage.getItem(BROWSER_NOTIFICATION_STORAGE_KEY) ? { id: "device-1", generation: JSON.parse(localStorage.getItem(BROWSER_NOTIFICATION_STORAGE_KEY)!).generation || 1 } : null,
    pending, completion: null });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/setup")) return json(status());
    const override = handle?.(url, init);
    if (override !== undefined) return override;
    if (url.endsWith("/begin")) {
      const body = JSON.parse(String(init?.body));
      pending = { operationId: body.operationId, pendingEpoch: 5, kind: body.kind, startedAt: "2026-09-14T12:00:00Z", recoveryInstructions: "Save work and close the initiating browser windows before manual cleanup." };
      return json({ ...status(), currentDevice: null });
    }
    if (url.endsWith("/complete")) { pending = null; return json({ ...status(), currentDevice: null }); }
    if (url.endsWith("/subscription")) return json({ generation: 1, deliveryEnabled: false, subscription: { subscribed: false, expiresAt: null, reenrollmentRequired: false, reason: "not_subscribed" } });
    return json(init?.method === "POST" ? { device: device() } : { devices: localStorage.getItem(BROWSER_NOTIFICATION_STORAGE_KEY) ? [device(JSON.parse(localStorage.getItem(BROWSER_NOTIFICATION_STORAGE_KEY)!).generation || 1)] : [], currentDeviceId: localStorage.getItem(BROWSER_NOTIFICATION_STORAGE_KEY) ? "device-1" : null });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
beforeEach(() => {
  localStorage.clear(); permission = "default"; shown = [];
  requestPermission = vi.fn(async () => { permission = "granted"; return permission; });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  vi.stubGlobal("Notification", class { static get permission() { return permission; } static requestPermission() { return requestPermission(); } constructor(title: string, options: NotificationOptions) { shown.push({ title, options }); } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
describe("explicit shared browser enrollment", () => {
  it("prompts directly from the gesture and enables only after the server returns", async () => {
    let resolve!: (value: Response) => void;
    const fetcher = harness((_url, init) => init?.method === "POST" ? new Promise<Response>((done) => { resolve = done; }) : undefined);
    render(<BrowserNotificationControls />);
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Enable notifications" }));
    fireEvent.click(screen.getByRole("button", { name: "Enabling..." }));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(resolve).toBeDefined());
    expect(readBrowserNotificationState().kind).not.toBe("enabled");
    await act(async () => resolve(json({ device: device() })));
    expect(await screen.findByText("Enabled on this browser")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(BROWSER_NOTIFICATION_STORAGE_KEY)!)).toMatchObject({ deviceId: "device-1", generation: 1 });
    expect(fetcher.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body).toBe(JSON.stringify({ expectedSetupEpoch: 4, channel: "browser", platform: "other", permission: "granted", capabilities: { foreground: true, push: false } }));
  });
  it("requires legacy local opt-in to finish setup without prompting on mount", async () => {
    permission = "granted"; localStorage.setItem(BROWSER_NOTIFICATION_STORAGE_KEY, JSON.stringify({ origin: location.origin, enabled: true, cursor: "old" }));
    const fetcher = harness(); render(<BrowserNotificationControls />);
    fireEvent.click(await screen.findByRole("button", { name: "Finish notification setup" }));
    await screen.findByText("Enabled on this browser");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it.each([[403, "trusted_device_required", /System.*trusted device/i], [503, "origin_configuration_unavailable", /configured.*origin/i], [503, "feature_disabled", /disabled.*installation/i]])("explains setup error %s %s without enabling", async (status, code, message) => {
    harness((_url, init) => init?.method === "POST" ? json({ code }, status as number) : undefined);
    render(<BrowserNotificationControls />); fireEvent.click(await screen.findByRole("button", { name: "Enable notifications" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message as RegExp);
    expect(readBrowserNotificationState().kind).not.toBe("enabled");
  });
  it("rolls back only its generation when local persistence fails", async () => {
    permission = "granted"; const fetcher = harness();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage"); });
    await expect(enableBrowserNotifications()).rejects.toThrow();
    expect(fetcher.mock.calls.find(([, init]) => init?.method === "DELETE")?.[1]?.body).toBe('{"expectedGeneration":1}');
  });
  it("does not erase a newer tab enrollment when delayed old enrollment fails", async () => {
    permission = "granted"; let resolve!: (value: Response) => void;
    const fetcher = harness((_url, init) => init?.method === "POST" ? new Promise<Response>((done) => { resolve = done; }) : init?.method === "DELETE" ? json({ code: "stale_generation" }, 409) : undefined);
    const operation = enableBrowserNotifications(); await waitFor(() => expect(resolve).toBeDefined());
    save(2); resolve(json({ device: device(1) }));
    await expect(operation).rejects.toThrow();
    expect(JSON.parse(localStorage.getItem(BROWSER_NOTIFICATION_STORAGE_KEY)!)).toMatchObject({ generation: 2, enabled: true });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });
  it("rolls back a late enrollment after controls unmount", async () => {
    permission = "granted"; let resolve!: (value: Response) => void;
    const fetcher = harness((_url, init) => init?.method === "POST" ? new Promise<Response>((done) => { resolve = done; }) : undefined);
    const ui = render(<BrowserNotificationControls />); fireEvent.click(await screen.findByRole("button", { name: "Enable notifications" }));
    await waitFor(() => expect(resolve).toBeDefined()); ui.unmount();
    await act(async () => resolve(json({ device: device() })));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    expect(readBrowserNotificationState().kind).not.toBe("enabled");
  });
  it("stops foreground immediately on failed disable and offers truthful removal retry", async () => {
    permission = "granted"; save(); harness((url) => url.endsWith("/begin") ? Promise.reject(new Error("offline")) : undefined);
    render(<BrowserNotificationControls />); fireEvent.click(await screen.findByRole("button", { name: "Disable this browser" }));
    expect(readBrowserNotificationState().kind).not.toBe("enabled");
    expect(await screen.findByRole("alert")).toHaveTextContent(/server.*removal.*retry/i);
    expect(screen.getByRole("button", { name: /Retry.*removal/i })).toBeInTheDocument();
    expect(permission).toBe("granted");
  });
  it("sends only generic explicit test copy", async () => {
    permission = "granted"; save(); harness(); render(<BrowserNotificationControls />);
    expect(shown).toHaveLength(0); fireEvent.click(await screen.findByRole("button", { name: "Send test notification" }));
    expect(shown).toEqual([{ title: "Ezra Mail", options: { body: "Notifications are working on this browser.", tag: "ezra-mail-notification-test" } }]);
  });
  it("shows inventory outcome times separately and saves separate detail opt-in with generation", async () => {
    permission = "granted"; save(); const current = { ...device(), lastSuccessAt: "2026-09-14T13:00:00Z", lastDisplayedAt: "2026-09-14T12:30:00Z", lastClickedAt: "2026-09-14T12:31:00Z" };
    const fetcher = harness((url, init) => init?.method === "PATCH" ? (current.detailedCopy = true, json({ device: current })) : url.endsWith("/devices") ? json({ devices: [current], currentDeviceId: current.id }) : undefined);
    render(<BrowserNotificationControls />);
    expect(await screen.findByText(/Last accepted: 2026-09-14T13/)).toBeInTheDocument();
    expect(screen.getByText(/Last displayed: 2026-09-14T12:30/)).toBeInTheDocument();
    const checkbox = screen.getByRole("checkbox", { name: "Show sender and subject on the lock screen" }); expect(checkbox).not.toBeChecked(); fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(fetcher.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]?.body).toBe('{"expectedGeneration":1,"detailedCopy":true}');
  });
});


describe("notification browser capability boundaries", () => {
  it.each(["denied", "insecure", "unsupported", "storage"])("does not enroll or prompt for %s", async (mode) => {
    if (mode === "denied") permission = "denied";
    if (mode === "insecure") Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    if (mode === "unsupported") vi.stubGlobal("Notification", undefined);
    if (mode === "storage") vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage"); });
    const fetcher = harness(); render(<BrowserNotificationControls />); await act(async () => {});
    expect(screen.queryByRole("button", { name: "Enable notifications" })).not.toBeInTheDocument();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it("denial during the explicit prompt leaves no server or local enrollment", async () => {
    requestPermission.mockImplementation(async () => { permission = "denied"; return permission; });
    const fetcher = harness(); render(<BrowserNotificationControls />); fireEvent.click(await screen.findByRole("button", { name: "Enable notifications" }));
    await screen.findByText("Blocked by this browser"); expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false); expect(localStorage.getItem(BROWSER_NOTIFICATION_STORAGE_KEY)).toBeNull();
  });
  it("keeps pending cleanup after native unsubscribe fails and removes it only after retry succeeds", async () => {
    permission = "granted"; save(); const unsubscribe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistrations: async () => ([{ scope: location.origin + "/", active: { scriptURL: location.origin + "/ezra-sw.js" }, waiting: null, installing: null, pushManager: { getSubscription: async () => ({ unsubscribe }) } }]) } });
    harness(); render(<BrowserNotificationControls />); fireEvent.click(await screen.findByRole("button", { name: "Disable this browser" }));
    await screen.findByRole("alert"); expect(readBrowserNotificationState().kind).toBe("removal_pending");
    fireEvent.click(screen.getByRole("button", { name: "Retry browser removal" })); await screen.findByText("Disabled in Ezra"); expect(localStorage.getItem(BROWSER_NOTIFICATION_STORAGE_KEY)).toBeNull();
    Reflect.deleteProperty(navigator, "serviceWorker");
  });
});


describe("enrollment cancellation races", () => {
  it("does not enable after disable while the explicit permission prompt is pending", async () => {
    let resolve!: (value: NotificationPermission) => void;
    requestPermission.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const fetcher = harness(); const enabling = enableBrowserNotifications();
    await disableBrowserNotifications(); permission = "granted"; resolve("granted"); await enabling;
    expect(readBrowserNotificationState().kind).not.toBe("enabled");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it("finishes authorized native cleanup while preserving a newer local enrollment after delayed lookup", async () => {
    permission = "granted"; save(); let resolve!: (value: { unsubscribe: () => Promise<boolean> }) => void;
    const unsubscribe = vi.fn(async () => true);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistrations: async () => ([{ scope: location.origin + "/", active: { scriptURL: location.origin + "/ezra-sw.js" }, waiting: null, installing: null, pushManager: { getSubscription: () => new Promise((done) => { resolve = done; }) } }]) } });
    harness(); const removing = disableBrowserNotifications(); await waitFor(() => expect(resolve).toBeDefined());
    save(2); resolve({ unsubscribe }); await removing;
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(JSON.parse(localStorage.getItem(BROWSER_NOTIFICATION_STORAGE_KEY)!)).toMatchObject({ generation: 2, enabled: true });
    Reflect.deleteProperty(navigator, "serviceWorker");
  });
});


it("does not claim enabled when inventory confirms the local enrollment was revoked", async () => {
  permission = "granted"; save(); harness(() => json({ devices: [{ ...device(), revokedAt: "2026-09-14T12:00:00Z" }], currentDeviceId: null }));
  render(<BrowserNotificationControls />);
  await waitFor(() => expect(readBrowserNotificationState().kind).toBe("disabled"));
  expect(screen.queryByText("Enabled on this browser")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Enable notifications" })).toBeInTheDocument();
});
