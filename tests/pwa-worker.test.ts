// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const origin = "https://mail.example.test";

function worker(network = vi.fn().mockRejectedValue(new Error("offline"))) {
  const handlers = new Map<string, (event: unknown) => void>();
  const persist = vi.fn(() => { throw new Error("Private persistence is forbidden"); });
  const skipWaiting = vi.fn();
  const claim = vi.fn();
  const source = existsSync("public/ezra-sw.js") ? readFileSync("public/ezra-sw.js", "utf8") : "";
  runInNewContext(source, {
    self: { location: { origin }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler), skipWaiting, clients: { claim } },
    fetch: network, Response, URL,
    caches: { open: persist, match: persist, delete: persist }, indexedDB: { open: persist },
  });
  function dispatch(url: string, method = "GET", mode = "navigate") {
    const respondWith = vi.fn();
    const request = { url, method, mode };
    handlers.get("fetch")?.({ request, respondWith });
    return { respondWith, request, response: respondWith.mock.calls[0]?.[0] as Promise<Response> | undefined };
  }
  return { dispatch, network, handlers, persist, skipWaiting, claim };
}

describe("PWA network-only worker", () => {
  it("returns a generic offline page without disclosing the exact mail target", async () => {
    const runtime = worker();
    const response = await runtime.dispatch(`${origin}/?view=mail&messageId=private-local-7&workspace=private-account`).response;
    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("content-type")).toContain("text/html");
    const html = await response!.text();
    expect(html).toContain("Ezra Mail is offline");
    expect(html).not.toContain("private-");
    // Empty href reloads the current document including its query, without a redirect.
    expect(html).toContain('href=""');
    expect(runtime.persist).not.toHaveBeenCalled();
  });

  it.each([200, 401, 503])("preserves the network's %i response and disables navigation caching", async (status) => {
    const networkResponse = new Response("server response", { status });
    const network = vi.fn().mockResolvedValue(networkResponse);
    const runtime = worker(network);
    const event = runtime.dispatch(`${origin}/?view=today&todaySection=reply`);
    expect(await event.response).toBe(networkResponse);
    expect(network).toHaveBeenCalledWith(event.request, { cache: "no-store" });
    expect(runtime.persist).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/mail?messageId=local-7", "GET", "navigate"],
    ["/api/auth/session", "GET", "same-origin"],
    ["/api/attachments/local-7", "GET", "navigate"],
    ["/_next/static/app.js", "GET", "no-cors"],
    ["/", "POST", "navigate"],
    ["/", "GET", "same-origin"],
    ["https://other.example.test/", "GET", "navigate"],
  ])("does not intercept %s %s %s", (path, method, mode) => {
    const runtime = worker();
    expect(runtime.handlers.has("fetch")).toBe(true);
    const event = runtime.dispatch(new URL(path, origin).href, method, mode);
    expect(event.respondWith).not.toHaveBeenCalled();
    expect(runtime.network).not.toHaveBeenCalled();
    expect(runtime.persist).not.toHaveBeenCalled();
  });

  it("does not force activation, claim open drafts, or persist on installation", () => {
    const runtime = worker();
    runtime.handlers.get("install")?.({ waitUntil: vi.fn() });
    runtime.handlers.get("activate")?.({ waitUntil: vi.fn() });
    expect([...runtime.handlers.keys()]).toEqual(["fetch", "push", "notificationclick", "message", "pushsubscriptionchange"]);
    expect(runtime.skipWaiting).not.toHaveBeenCalled();
    expect(runtime.claim).not.toHaveBeenCalled();
    expect(runtime.persist).not.toHaveBeenCalled();
  });
});

it("publishes a generic same-origin Today launch and correctly sized approved install icons", () => {
  const manifest = existsSync("public/manifest.webmanifest") ? JSON.parse(readFileSync("public/manifest.webmanifest", "utf8")) : {};
  expect(manifest).toMatchObject({ id: "/", scope: "/", start_url: "/?view=today", display: "standalone", name: "Ezra Mail" });
  expect(manifest.icons).toEqual([
    { src: "/branding/ezra-mail-logo-d4-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/branding/ezra-mail-logo-d4-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ]);
  for (const icon of manifest.icons) {
    const png = readFileSync(`public${icon.src}`);
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
  }
});
