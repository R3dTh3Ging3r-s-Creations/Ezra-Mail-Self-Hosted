import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PwaProvider } from "@/components/ezra/PwaProvider";
import { PwaControls } from "@/components/ezra/PwaControls";
import { BROWSER_NOTIFICATION_STORAGE_KEY } from "@/components/ezra/browserNotifications";

const origin = window.location.origin;
function worker(scriptURL = `${origin}/ezra-sw.js`, state = "activated") {
  return Object.assign(new EventTarget(), { scriptURL, state });
}
function registration(scriptURL = `${origin}/ezra-sw.js`, scope = `${origin}/`) {
  return Object.assign(new EventTarget(), {
    scope, active: worker(scriptURL), waiting: null as ReturnType<typeof worker> | null,
    installing: null as ReturnType<typeof worker> | null,
    update: vi.fn().mockResolvedValue(undefined), unregister: vi.fn().mockResolvedValue(true),
  });
}
let reg: ReturnType<typeof registration>;
let register: ReturnType<typeof vi.fn>;
let getRegistrations: ReturnType<typeof vi.fn>;
let requestPermission: ReturnType<typeof vi.fn>;
let display: MediaQueryList;

beforeEach(() => {
  window.localStorage.clear();
  reg = registration();
  register = vi.fn().mockResolvedValue(reg);
  getRegistrations = vi.fn().mockResolvedValue([]);
  requestPermission = vi.fn();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("Notification", { requestPermission });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register, getRegistrations } });
  display = Object.assign(new EventTarget(), { matches: false, media: "(display-mode: standalone)" }) as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(display));
});
afterEach(() => { vi.unstubAllGlobals(); delete (navigator as unknown as Record<string, unknown>).serviceWorker; });

function renderControls() { return render(<PwaProvider browserNotificationsEnabled={false}><PwaControls /></PwaProvider>); }
async function ready() {
  const result = renderControls();
  await screen.findByText("App connection ready");
  return result;
}
function installEvent(outcome: "accepted" | "dismissed" = "dismissed") {
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: vi.fn().mockResolvedValue(undefined), userChoice: Promise.resolve({ outcome }),
  });
  act(() => { window.dispatchEvent(event); });
  return event;
}

describe("PWA install and connection controls", () => {
  it("registers only its own origin/scope without permission or automatic installation", async () => {
    await ready();
    expect(register).toHaveBeenCalledWith("/ezra-sw.js", { scope: "/", updateViaCache: "none" });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(origin.replace(/[.*+?^$()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install Ezra Mail" })).not.toBeInTheDocument();
  });

  it.each([["insecure", false], ["unsupported", true]])("keeps ordinary web use when %s", async (kind, secure) => {
    vi.stubGlobal("isSecureContext", secure);
    if (kind === "unsupported") Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
    renderControls();
    await screen.findByText(kind === "insecure" ? /Open Ezra over HTTPS/ : /This browser does not support/);
    expect(register).not.toHaveBeenCalled();
    expect(getRegistrations).not.toHaveBeenCalled();
  });

  it.each(["https://foreign.example.test/sw.js", `${origin}/other-sw.js`])("refuses to overwrite another worker %s", async (script) => {
    getRegistrations.mockResolvedValue([registration(script)]);
    renderControls();
    await screen.findByText(/Another app connection already uses this address/);
    expect(register).not.toHaveBeenCalled();
    expect(reg.unregister).not.toHaveBeenCalled();
  });

  it("ignores unrelated nested scopes while registering the root app", async () => {
    const other = registration(`${origin}/other/sw.js`, `${origin}/other/`);
    getRegistrations.mockResolvedValue([other]);
    await ready();
    expect(register).toHaveBeenCalledTimes(1);
    expect(other.unregister).not.toHaveBeenCalled();
  });

  it("prompts only on click, consumes dismissal, and never requests notification permission", async () => {
    await ready();
    const event = installEvent();
    expect(event.defaultPrevented).toBe(true);
    expect(event.prompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Install Ezra Mail" }));
    await waitFor(() => expect(event.prompt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Install Ezra Mail" })).not.toBeInTheDocument());
    expect(requestPermission).not.toHaveBeenCalled();
    expect(screen.getByText(/Installation dismissed/)).toBeInTheDocument();
  });

  it("does not claim installation from prompt acceptance alone", async () => {
    await ready();
    installEvent("accepted");
    fireEvent.click(screen.getByRole("button", { name: "Install Ezra Mail" }));
    await screen.findByText(/Finish installation in your browser/);
    expect(screen.queryByText("Installed on this browser")).not.toBeInTheDocument();
    act(() => { window.dispatchEvent(new Event("appinstalled")); });
    expect(screen.getByText("Installed on this browser")).toBeInTheDocument();
  });

  it("recognizes installed standalone display and its later changes", async () => {
    Object.defineProperty(display, "matches", { configurable: true, value: true });
    await ready();
    expect(screen.getByText("Installed on this browser")).toBeInTheDocument();
    Object.defineProperty(display, "matches", { configurable: true, value: false });
    act(() => display.dispatchEvent(new Event("change")));
    expect(screen.queryByText("Installed on this browser")).not.toBeInTheDocument();
  });

  it("recovers from a rejected installation without exposing raw errors", async () => {
    await ready();
    const event = installEvent();
    event.prompt.mockRejectedValue(new Error("private browser diagnostic"));
    fireEvent.click(screen.getByRole("button", { name: "Install Ezra Mail" }));
    await screen.findByText(/Installation could not start/);
    expect(screen.queryByText(/private browser diagnostic/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install Ezra Mail" })).not.toBeInTheDocument();
  });

  it("reports registration failures with a retry action", async () => {
    register.mockRejectedValueOnce(new Error("private diagnostic"));
    renderControls();
    await screen.findByText(/App connection could not start/);
    register.mockResolvedValue(reg);
    fireEvent.click(screen.getByRole("button", { name: "Retry app connection" }));
    await screen.findByText("App connection ready");
    expect(screen.queryByText(/private diagnostic/)).not.toBeInTheDocument();
  });

  it("checks updates only explicitly and keeps waiting updates behind window closure", async () => {
    await ready();
    expect(reg.update).not.toHaveBeenCalled();
    getRegistrations.mockResolvedValue([reg]);
    reg.update.mockImplementation(async () => { reg.waiting = worker(); });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByText(/Update ready/);
    expect(screen.getByText(/Save your work, close all Ezra windows/)).toBeInTheDocument();
    expect(reg.update).toHaveBeenCalledTimes(1);
    expect(window.location.origin).toBe(origin);
  });

  it("observes a background update without reloading the document", async () => {
    await ready();
    reg.installing = worker(undefined, "installing");
    act(() => reg.dispatchEvent(new Event("updatefound")));
    await screen.findByText("Checking app update");
    reg.waiting = reg.installing;
    reg.installing = null;
    act(() => reg.waiting!.dispatchEvent(new Event("statechange")));
    await screen.findByText(/Update ready/);
  });

  it("keeps update failure recoverable with generic copy", async () => {
    await ready();
    getRegistrations.mockResolvedValue([reg]);
    reg.update.mockRejectedValueOnce(new Error("private diagnostic"));
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByText(/Could not check for updates/);
    expect(screen.queryByText(/private diagnostic/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });

  it("repairs only the owned registration while preserving draft and enrollment storage", async () => {
    await ready();
    const other = registration(`${origin}/other/sw.js`, `${origin}/other/`);
    getRegistrations.mockResolvedValue([reg, other]);
    window.localStorage.setItem("draft", "unsaved synthetic text");
    window.localStorage.setItem("ezra-mail-browser-notifications-enabled", "synthetic enrollment");
    fireEvent.click(screen.getByRole("button", { name: "Repair app connection" }));
    await screen.findByText(/App connection removed/);
    expect(reg.unregister).toHaveBeenCalledTimes(1);
    expect(other.unregister).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("draft")).toBe("unsaved synthetic text");
    expect(window.localStorage.getItem("ezra-mail-browser-notifications-enabled")).toBe("synthetic enrollment");
  });

  it("refuses repair or update if a different worker takes over the root scope", async () => {
    await ready();
    reg.waiting = worker(`${origin}/foreign-sw.js`);
    getRegistrations.mockResolvedValue([reg]);
    fireEvent.click(screen.getByRole("button", { name: "Repair app connection" }));
    await screen.findByText(/Another app connection already uses this address/);
    expect(reg.unregister).not.toHaveBeenCalled();
    expect(reg.update).not.toHaveBeenCalled();
  });

  it("does not claim successful repair when unregister returns false", async () => {
    await ready();
    getRegistrations.mockResolvedValue([reg]);
    reg.unregister.mockResolvedValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Repair app connection" }));
    await screen.findByText(/Could not repair the app connection/);
    expect(screen.queryByText(/App connection removed/)).not.toBeInTheDocument();
  });

  it("ignores registration completion after unmount and removes event handlers", async () => {
    let resolve!: (registration: typeof reg) => void;
    register.mockReturnValue(new Promise((done) => { resolve = done; }));
    const mounted = renderControls();
    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    mounted.unmount();
    const listener = vi.spyOn(reg, "addEventListener");
    await act(async () => resolve(reg));
    expect(listener).not.toHaveBeenCalled();
    const event = installEvent();
    expect(event.defaultPrevented).toBe(false);
  });
  it("offers retry when the browser discards a failed first worker installation", async () => {
    const installing = worker(undefined, "installing");
    Object.assign(reg, { active: null, installing });
    renderControls();
    await screen.findByText("Checking app update");
    reg.installing = null;
    installing.state = "redundant";
    act(() => installing.dispatchEvent(new Event("statechange")));
    await screen.findByText(/App connection could not start/);
    expect(screen.getByRole("button", { name: "Retry app connection" })).toBeEnabled();
  });

});

it("coordinates enabled-deployment repair without local enrollment and completes after unmount", async () => {
  const calls: string[] = [];
  let settle!: (value: boolean) => void;
  const unsubscribe = vi.fn(() => { calls.push("unsubscribe"); return new Promise<boolean>(resolve => { settle = resolve; }); });
  Object.assign(reg, { pushManager: { getSubscription: async () => ({ unsubscribe }) } });
  getRegistrations.mockResolvedValue([reg]);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return new Response(JSON.stringify({ origin, setupEpoch: 0, featureEnabled: true, currentDevice: null,
      pending: url.endsWith("begin") ? { operationId: body.operationId, pendingEpoch: 1, kind: "worker_repair", startedAt: "2026-09-14T12:00:00Z", recoveryInstructions: "Save work and close initiating browser windows." } : null, completion: null }));
  }));
  const view = render(<PwaProvider><PwaControls /></PwaProvider>);
  await screen.findByText("App connection ready");
  fireEvent.click(screen.getByRole("button", { name: "Repair app connection" }));
  await waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  expect(calls.indexOf("/api/notifications/setup/begin")).toBeLessThan(calls.indexOf("unsubscribe"));
  expect(reg.unregister).not.toHaveBeenCalled();
  view.unmount();
  await act(async () => settle(true));
  await waitFor(() => expect(calls).toContain("/api/notifications/setup/complete"));
  expect(reg.unregister).toHaveBeenCalledOnce();
});
it.each([403, 503])("never bypasses enabled-deployment coordination after server status %s", async status => {
  getRegistrations.mockResolvedValue([reg]);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "notification_unavailable" }), { status })));
  render(<PwaProvider><PwaControls /></PwaProvider>);
  await screen.findByText("App connection ready");
  fireEvent.click(screen.getByRole("button", { name: "Repair app connection" }));
  await screen.findByText(/Server\/background removal is not confirmed/);
  expect(reg.unregister).not.toHaveBeenCalled();
});
it.each([false, true])("retries retained worker repair completion after unregister removes the registration (new enrollment: %s)", async newerEnrollment => {
  localStorage.setItem(BROWSER_NOTIFICATION_STORAGE_KEY, JSON.stringify({ origin, enabled: true, deviceId: "device", generation: 1 }));
  const unsubscribe = vi.fn().mockResolvedValue(true);
  Object.assign(reg, { pushManager: { getSubscription: async () => ({ unsubscribe }) } });
  getRegistrations.mockResolvedValue([reg]);
  reg.unregister.mockImplementation(async () => { getRegistrations.mockResolvedValue([]); return true; });
  let lost = true;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("complete") && lost) { lost = false; throw new Error("lost completion"); }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return new Response(JSON.stringify({ origin, setupEpoch: 0, featureEnabled: true, currentDevice: { id: "device", generation: 1 },
      pending: url.endsWith("begin") ? { operationId: body.operationId, pendingEpoch: 1, kind: "worker_repair", startedAt: "2026-09-14T12:00:00Z", recoveryInstructions: "Close initiating windows before manual cleanup." } : null, completion: null }));
  });
  vi.stubGlobal("fetch", fetcher);
  render(<PwaProvider><PwaControls /></PwaProvider>);
  await screen.findByText("App connection ready");
  fireEvent.click(screen.getByRole("button", { name: "Repair app connection" }));
  await screen.findByText(/Server\/background removal is not confirmed/);
  expect(await navigator.serviceWorker.getRegistrations()).toEqual([]);
  const replacement = JSON.stringify({ origin, enabled: true, deviceId: "device", generation: 2 });
  if (newerEnrollment) localStorage.setItem(BROWSER_NOTIFICATION_STORAGE_KEY, replacement);
  fireEvent.click(screen.getByRole("button", { name: "Repair app connection" }));
  await screen.findByText(/App connection removed/);
  const completions = fetcher.mock.calls.filter(([url]) => url.endsWith("complete"));
  expect(completions).toHaveLength(2);
  expect(completions[1][1]?.body).toBe(completions[0][1]?.body);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("begin"))).toHaveLength(1);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(reg.unregister).toHaveBeenCalledOnce();
  expect(register).toHaveBeenCalledOnce();
  expect(localStorage.getItem(BROWSER_NOTIFICATION_STORAGE_KEY)).toBe(newerEnrollment ? replacement : null);
});
