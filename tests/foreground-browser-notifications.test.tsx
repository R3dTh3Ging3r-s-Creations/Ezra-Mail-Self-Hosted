import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForegroundNotificationListener } from "@/components/ezra/ForegroundNotificationListener";
import { BROWSER_NOTIFICATION_ENROLLMENT_EVENT, BROWSER_NOTIFICATION_STORAGE_KEY } from "@/components/ezra/browserNotifications";
const event = { deliveryId: "delivery-1", eventId: "event-1", kind: "interrupt", target: "/?view=mail&workspace=workspace%3Aaccount%3Amicrosoft%3Ams-1&message=message-1", title: "Ezra Mail", body: "Mail needs attention.", tag: "ezra-mail-safe", createdAt: "2026-09-14T12:00:00Z" };
const claim = { ...event, attemptId: "attempt-1", generation: 1 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const save = (generation = 1, enabled = true) => {
  localStorage.setItem(BROWSER_NOTIFICATION_STORAGE_KEY, JSON.stringify({ origin: location.origin, enabled, deviceId: "device-1", generation }));
  window.dispatchEvent(new Event(BROWSER_NOTIFICATION_ENROLLMENT_EVENT));
};
let shown: Array<{ title: string; options: NotificationOptions; onclick: (() => void) | null }>;
let failDisplay: boolean;
let prompt: ReturnType<typeof vi.fn>;
function harness(handle?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => handle?.(url, init) ?? json(url.endsWith("foreground") ? { enabled: true, deviceId: "device-1", generation: 1, events: [event], hasMore: false } : url.endsWith("claims") ? claim : { recorded: true }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
beforeEach(() => {
  localStorage.clear();
  shown = [];
  failDisplay = false;
  prompt = vi.fn();
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  vi.stubGlobal("Notification", class {
    static permission = "granted"; static requestPermission = prompt; onclick: (() => void) | null = null; close() { } constructor(public title: string, public options: NotificationOptions) {
      if (failDisplay) throw new Error("display");
      shown.push(this);
    }
  });
  vi.spyOn(window, "focus").mockImplementation(() => { });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
describe("shared foreground listener", () => {
  it("never enrolls or prompts for legacy markers", async () => {
    localStorage.setItem(BROWSER_NOTIFICATION_STORAGE_KEY, JSON.stringify({ origin: location.origin, enabled: true, cursor: "old" }));
    const fetcher = harness();
    render(<ForegroundNotificationListener onOpen={vi.fn()} onAuthenticationFailure={vi.fn()} />);
    await act(async () => { });
    expect(fetcher).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });
  it("claims before display, consumes POST copy/target, and records shown and clicked once", async () => {
    save();
    const fetcher = harness((url) => url.endsWith("claims") ? json({ ...claim, body: "Claimed copy", target: "/?view=today" }) : undefined);
    const open = vi.fn();
    render(<ForegroundNotificationListener onOpen={open} onAuthenticationFailure={vi.fn()} />);
    await waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0].options).toMatchObject({ body: "Claimed copy", tag: event.tag });
    expect(fetcher.mock.calls.find(([url]) => url.endsWith("claims"))?.[1]?.body).toBe('{"deliveryId":"delivery-1","expectedGeneration":1}');
    await act(async () => {
      shown[0].onclick?.();
      shown[0].onclick?.();
    });
    expect(open).toHaveBeenCalledExactlyOnceWith({ view: "today" });
    const receipts = fetcher.mock.calls.filter(([url]) => url.endsWith("receipts")).map(([, init]) => JSON.parse(String(init?.body)).kind);
    expect(receipts).toEqual(["foreground_shown", "clicked"]);
  });
  it("two tabs compete at the server claim and only one displays", async () => {
    save();
    let claimed = false;
    harness((url) => {
      if (!url.endsWith("claims")) return;
      if (claimed) return json({ code: "already_claimed_or_stale" }, 409);
      claimed = true;
      return json(claim);
    });
    render(<><ForegroundNotificationListener onOpen={vi.fn()} onAuthenticationFailure={vi.fn()} /><ForegroundNotificationListener onOpen={vi.fn()} onAuthenticationFailure={vi.fn()} /></>);
    await waitFor(() => expect(shown).toHaveLength(1));
  });
  it.each([false, true])("discards stale claim after disable or generation rotation (%s)", async (rotate) => {
    save();
    let resolve!: (value: Response) => void;
    harness((url) => url.endsWith("claims") ? new Promise<Response>((done) => {
      resolve = done;
    }) : undefined);
    render(<ForegroundNotificationListener onOpen={vi.fn()} onAuthenticationFailure={vi.fn()} />);
    await waitFor(() => expect(resolve).toBeDefined());
    await act(async () => {
      save(rotate ? 2 : 1, rotate);
      resolve(json(claim));
    });
    expect(shown).toHaveLength(0);
  });
  it("does not redisplay after an ambiguous shown receipt", async () => {
    save();
    const fetcher = harness((url) => url.endsWith("receipts") ? Promise.reject(new Error("offline")) : undefined);
    render(<ForegroundNotificationListener onOpen={vi.fn()} onAuthenticationFailure={vi.fn()} />);
    await waitFor(() => expect(shown).toHaveLength(1));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(shown).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("claims"))).toHaveLength(1);
  });
  it("records terminal display failure without retrying that delivery", async () => {
    save();
    failDisplay = true;
    const fetcher = harness();
    render(<ForegroundNotificationListener onOpen={vi.fn()} onAuthenticationFailure={vi.fn()} />);
    await screen.findByRole("alert");
    expect(fetcher.mock.calls.find(([url]) => url.endsWith("receipts"))?.[1]?.body).toContain("foreground_failed");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("claims"))).toHaveLength(1);
  });
  it.each([401, 403, 503])("handles status %s without treating setup errors as signout", async (status) => {
    save();
    const auth = vi.fn();
    harness(() => json({ code: status === 403 ? "trusted_device_required" : status === 503 ? "feature_disabled" : "authentication_required" }, status));
    render(<ForegroundNotificationListener onOpen={vi.fn()} onAuthenticationFailure={auth} />);
    await act(async () => { });
    if (status === 401) expect(auth).toHaveBeenCalledOnce(); else {
      expect(auth).not.toHaveBeenCalled();
      expect(await screen.findByRole("alert")).toHaveTextContent(/setup|disabled|trusted device/i);
    }
  });
  it("polls every sixty seconds while hidden, on visible return, and focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    save();
    let hidden = true;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const fetcher = harness((url) => url.endsWith("foreground") ? json({ enabled: true, deviceId: "device-1", generation: 1, events: [], hasMore: false }) : undefined);
    render(<ForegroundNotificationListener onOpen={vi.fn()} onAuthenticationFailure={vi.fn()} />);
    await act(async () => { });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => {
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("rejects malformed claimed targets without displaying", async () => {
    save();
    harness((url) => url.endsWith("claims") ? json({ ...claim, target: "//evil.test/" }) : undefined);
    render(<ForegroundNotificationListener onOpen={vi.fn()} onAuthenticationFailure={vi.fn()} />);
    await act(async () => { });
    expect(shown).toHaveLength(0);
  });
});
