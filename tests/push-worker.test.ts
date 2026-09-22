// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const origin = "https://ezra.example.test";
const target = "/?view=mail&workspace=workspace%3Aaccount%3Agmail%3Aaccount&message=message";
function payload(extra = {}) {
  return { version: 1, eventId: "event", attemptId: "attempt", deviceId: "device", generation: 1,
    kind: "interrupt", title: "Ezra Mail", body: "Open Ezra Mail to review new attention.",
    target, tag: "attention", expiresAt: new Date(Date.now() + 3600000).toISOString(), ...extra };
}
function worker(database: any = { open() { throw new Error("storage unavailable"); } }) {
  const handlers = new Map<string, (event: any) => void>();
  const show = vi.fn().mockResolvedValue(undefined);
  const windows: any[] = [];
  const openWindow = vi.fn().mockResolvedValue(null);
  const fetch = vi.fn().mockRejectedValue(new Error("offline"));
  runInNewContext(readFileSync("public/ezra-sw.js", "utf8"), {
    self: { location: { origin }, registration: { showNotification: show },
      clients: { matchAll: async () => windows, openWindow },
      addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler) },
    fetch, URL, URLSearchParams, Response, TextEncoder, setTimeout, clearTimeout,
    indexedDB: database,
  });
  async function dispatch(name: string, event: any) {
    const work: Promise<unknown>[] = [];
    handlers.get(name)?.({ ...event, waitUntil: (promise: Promise<unknown>) => work.push(promise) });
    await Promise.all(work);
  }
  return { handlers, show, windows, openWindow, fetch, dispatch,
    push: (value: unknown) => dispatch("push", { data: value === undefined ? null : { text: () => JSON.stringify(value) } }) };
}

describe("push worker privacy and lifecycle", () => {
  it.each([undefined, { title: "Private malformed text" }, payload({ target: "https://evil.test/" }),
    payload({ actions: [{ action: "delete", title: "Delete" }] }), payload({ kind: "in_app" }),
    payload({ eventId: "bad/id" }), payload({ expiresAt: "invalid" }), payload({ title: "evil\ntext" })])(
    "delivers only a generic Today fallback for invalid payload %# even without marker storage", async (value) => {
      const runtime = worker();
      await runtime.push(value);
      expect(runtime.show).toHaveBeenCalledWith("Ezra Mail", expect.objectContaining({
        body: "Open Ezra Mail to review new attention.", tag: "ezra-mail-background", renotify: false,
        icon: "/branding/ezra-mail-logo-d4-192.png", data: { target: "/?view=today" },
      }));
      expect(runtime.fetch).not.toHaveBeenCalled();
    });
  it("displays bounded producer copy and exact target with optional badge/actions omitted", async () => {
    const runtime = worker(markerDatabase());
    await runtime.push(payload({ title: "Opted-in sender", body: "Opted-in subject" }));
    expect(runtime.show).toHaveBeenCalledWith("Opted-in sender", expect.objectContaining({ body: "Opted-in subject", data: { target, attemptId: "attempt", generation: 1 } }));
    expect(runtime.show.mock.calls[0][1]).not.toHaveProperty("actions");
    expect(runtime.show.mock.calls[0][1]).not.toHaveProperty("badge");
    expect(runtime.fetch).toHaveBeenCalledWith("/api/notifications/receipts", expect.objectContaining({ credentials: "same-origin", cache: "no-store", body: JSON.stringify({ attemptId: "attempt", generation: 1, kind: "displayed" }) }));
  });
  it("focuses only an exact target; opens a new window without navigating an unsaved draft", async () => {
    const runtime = worker();
    const draft = { url: origin + "/?view=mail", focus: vi.fn(), navigate: vi.fn() };
    runtime.windows.push(draft);
    const close = vi.fn();
    await runtime.dispatch("notificationclick", { notification: { close, data: { target, attemptId: "attempt", generation: 1 } } });
    expect(close).toHaveBeenCalledOnce();
    expect(runtime.openWindow).toHaveBeenCalledWith(origin + target);
    expect(draft.focus).not.toHaveBeenCalled();
    expect(draft.navigate).not.toHaveBeenCalled();
    const exact = { url: origin + target, focus: vi.fn().mockResolvedValue(null) };
    runtime.windows.push(exact);
    await runtime.dispatch("notificationclick", { notification: { close, data: { target } } });
    expect(exact.focus).toHaveBeenCalledOnce();
    expect(runtime.openWindow).toHaveBeenCalledTimes(1);
  });
  it("revalidates click data and remains useful when receipts are offline", async () => {
    const runtime = worker();
    await runtime.dispatch("notificationclick", { notification: { close: vi.fn(), data: { target: "//evil.test/", attemptId: "bad/id", generation: 0 } } });
    expect(runtime.openWindow).toHaveBeenCalledWith(origin + "/?view=today");
    expect(runtime.fetch).not.toHaveBeenCalled();
  });
  it("answers a read-only capability handshake and requests explicit subscription repair", async () => {
    const runtime = worker();
    const postMessage = vi.fn();
    await runtime.dispatch("message", { data: { type: "EZRA_NOTIFICATION_CAPABILITIES" }, ports: [{ postMessage }] });
    expect(postMessage).toHaveBeenCalledWith({ notificationProtocol: 1 });
    runtime.windows.push({ postMessage });
    await runtime.dispatch("pushsubscriptionchange", {});
    expect(postMessage).toHaveBeenCalledWith({ type: "EZRA_PUSH_REPAIR_REQUIRED" });
    expect(runtime.show).not.toHaveBeenCalled();
  });
});

import { markerDatabase } from "./helpers/push-marker-database";
describe("opaque durable duplicate admissions", () => {
  it("serializes concurrent events and suppresses repeats after worker restart", async () => {
    const database = markerDatabase(), first = worker(database), restarted = worker(database);
    await Promise.all([first.push(payload()), first.push(payload()), restarted.push(payload())]);
    expect(first.show.mock.calls.length + restarted.show.mock.calls.length).toBe(1);
    await worker(database).push(payload());
    expect(database.rows.size).toBe(1);
    expect([...database.rows.values()]).toEqual([{ eventId: "event", receivedAt: expect.any(Number) }]);
  });
  it("releases failed display admission so explicit redelivery can show", async () => {
    const database = markerDatabase(), runtime = worker(database);
    runtime.show.mockRejectedValueOnce(new Error("display failed"));
    await expect(runtime.push(payload())).rejects.toThrow("display failed");
    expect(database.rows.size).toBe(0);
    await runtime.push(payload());
    expect(runtime.show).toHaveBeenCalledTimes(2);
    expect(database.rows.size).toBe(1);
  });
  it("prunes markers older than 24 hours and bounds retention at 256 opaque entries", async () => {
    const database = markerDatabase(), runtime = worker(database);
    database.rows.set("expired", { eventId: "expired", receivedAt: Date.now() - 86400001 });
    for (let n = 0; n < 257; n++) await runtime.push(payload({ eventId: `event_${n}` }));
    expect(database.rows.size).toBe(256);
    expect(database.rows.has("expired")).toBe(false);
    expect(database.rows.has("event_0")).toBe(false);
    expect(database.rows.has("event_256")).toBe(true);
  });
});

it("keeps valid pushes visible but generic when durable duplicate storage is unavailable", async () => {
  const runtime = worker();
  await runtime.push(payload({ title: "Opted-in sender", body: "Opted-in subject" }));
  await runtime.push(payload({ title: "Opted-in sender", body: "Opted-in subject" }));
  // Without IDB, cross-restart exactly-once suppression is unavailable. The same
  // generic stable tag and renotify=false replace the visible notification.
  expect(runtime.show).toHaveBeenCalledTimes(2);
  for (const [title, options] of runtime.show.mock.calls) {
    expect(title).toBe("Ezra Mail");
    expect(options).toMatchObject({ body: "Open Ezra Mail to review new attention.", tag: "ezra-mail-background", renotify: false, data: { target: "/?view=today" } });
  }
  expect(runtime.fetch).not.toHaveBeenCalled();
});

it("aborts timed-out marker admission before generic fallback so it cannot commit a late seen marker", async () => {
  vi.useFakeTimers();
  const abort = vi.fn();
  const transaction = { abort, objectStore: () => ({ getAll: () => ({}) }) };
  const database = { open: () => {
    const request: any = {};
    queueMicrotask(() => { request.result = { close() {}, transaction: () => transaction }; request.onsuccess?.(); });
    return request;
  } };
  try {
    const runtime = worker(database);
    const delivery = runtime.push(payload());
    await vi.advanceTimersByTimeAsync(3001);
    await delivery;
    expect(abort).toHaveBeenCalledOnce();
    expect(runtime.show).toHaveBeenCalledWith("Ezra Mail", expect.objectContaining({ tag: "ezra-mail-background", data: { target: "/?view=today" } }));
  } finally { vi.useRealTimers(); }
});
