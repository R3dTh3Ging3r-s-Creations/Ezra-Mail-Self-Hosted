/* Network-only navigation and explicit push. Normal activation waits for open drafts to close. */
const offlinePage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ezra Mail · Offline</title><style>
body{margin:0;background:#f8f6f1;color:#243c3e;font:1rem/1.6 system-ui,sans-serif}
main{max-width:34rem;margin:15vh auto;padding:1.5rem}h1{font-size:2rem;line-height:1.2}
a{display:inline-block;padding:.75rem 1rem;background:#173f43;color:white;border-radius:.5rem}
a:focus-visible{outline:3px solid #a16921;outline-offset:4px}
</style></head><body><main><h1>Ezra Mail is offline</h1>
<p>Reconnect to your Ezra address, then try again. If you use a private network, check that connection too.</p>
<p>Mail and drafts are unavailable offline. This page has not opened or changed any mail.</p>
<a href="">Try again</a></main></body></html>`;

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || request.mode !== "navigate"
    || url.origin !== self.location.origin || url.pathname !== "/") return;

  event.respondWith(fetch(request, { cache: "no-store" }).catch(() => new Response(offlinePage, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  })));
});

// Push uses the same closed target grammar as notification-target.ts. Keep this
// standalone worker free of mail caches and application/private data imports.
function safeTarget(value) {
  if (typeof value !== "string" || value.length > 1000 || !value.startsWith("/?") || /[\\#\x00-\x20\x7f]/.test(value)) return null;
  const query = value.slice(2);
  if (query.split("&").some(part => !part || !part.includes("="))) return null;
  try { if (/[\\\x00-\x20\x7f]/.test(decodeURIComponent(query))) return null; } catch { return null; }
  const params = new URLSearchParams(query), keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return null;
  if (params.get("view") === "today" && keys.length === 1) return value;
  if (params.get("view") !== "mail" || keys.length !== 3 || !keys.every(key => ["view", "workspace", "message"].includes(key))) return null;
  return /^workspace:account:(gmail|microsoft):[A-Za-z0-9_-]{1,200}$/.test(params.get("workspace")) && opaque(params.get("message")) ? value : null;
}
function opaque(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value); }
function safeText(value, limit) {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value);
}
function pushPayload(data) {
  try {
    const text = data.text();
    if (text.length > 3000 || new TextEncoder().encode(text).length > 3000) return null;
    const value = JSON.parse(text);
    const fields = ["version", "eventId", "attemptId", "deviceId", "generation", "kind", "title", "body", "target", "tag", "expiresAt"];
    if (!value || typeof value !== "object" || Object.keys(value).length !== fields.length || !Object.keys(value).every(key => fields.includes(key))
      || value.version !== 1 || !["interrupt", "brief", "checkin"].includes(value.kind)
      || ![value.eventId, value.attemptId, value.deviceId].every(opaque)
      || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !safeText(value.title, 80) || !safeText(value.body, 140) || !safeText(value.tag, 200) || !safeTarget(value.target)
      || typeof value.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.expiresAt)
      || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) return null;
    return value;
  } catch { return null; }
}
async function receipt(data, kind) {
  if (!data || !opaque(data.attemptId) || !Number.isSafeInteger(data.generation) || data.generation < 1) return;
  try {
    await fetch("/api/notifications/receipts", { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ attemptId: data.attemptId, generation: data.generation, kind }) });
  } catch { /* Opening and display never depend on authenticated network receipts. */ }
}
// Only opaque event IDs and local receipt timestamps survive worker restarts.
// Readwrite admission transactions serialize across active/waiting workers.
function markerStore(operation) {
  return new Promise((resolve, reject) => {
    let database, transaction, finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) { try { transaction?.abort(); } catch { /* Already completed or aborted. */ } }
      database?.close();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Marker storage unavailable")), 3000);
    try {
      const request = indexedDB.open("ezra-push-receipts", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("received", { keyPath: "eventId" });
      request.onerror = () => finish(new Error("Marker storage unavailable"));
      request.onsuccess = () => {
        database = request.result;
        if (finished) { database.close(); return; }
        transaction = database.transaction("received", "readwrite");
        let result;
        transaction.oncomplete = () => finish(null, result);
        transaction.onerror = transaction.onabort = () => finish(new Error("Marker transaction failed"));
        operation(transaction.objectStore("received"), value => { result = value; });
      };
    } catch (error) { finish(error); }
  });
}
function admit(eventId) {
  const receivedAt = Date.now();
  return markerStore((store, result) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const current = request.result.filter(row => row.receivedAt > receivedAt - 86400000);
      for (const row of request.result) if (row.receivedAt <= receivedAt - 86400000) store.delete(row.eventId);
      if (current.some(row => row.eventId === eventId)) { result(false); return; }
      current.sort((a, b) => a.receivedAt - b.receivedAt);
      while (current.length >= 256) store.delete(current.shift().eventId);
      store.put({ eventId, receivedAt }); result(receivedAt);
    };
  });
}
function releaseAdmission(eventId, receivedAt) {
  return markerStore((store, result) => {
    const request = store.get(eventId);
    request.onsuccess = () => {
      if (request.result?.receivedAt === receivedAt) store.delete(eventId);
      result(true);
    };
  });
}
async function displayPush(event) {
  let payload = pushPayload(event.data);
  let admission;
  if (payload) {
    try { admission = await admit(payload.eventId); }
    catch { payload = null; } // Storage failure still produces a generic visible nudge.
    if (admission === false) return;
  }
  const data = payload ? { target: payload.target, attemptId: payload.attemptId, generation: payload.generation } : { target: "/?view=today" };
  try { await self.registration.showNotification(payload ? payload.title : "Ezra Mail", {
    body: payload ? payload.body : "Open Ezra Mail to review new attention.",
    tag: payload ? payload.tag : "ezra-mail-background", renotify: false,
    icon: "/branding/ezra-mail-logo-d4-192.png", data,
  });
  } catch (error) {
    if (payload && typeof admission === "number") {
      try { await releaseAdmission(payload.eventId, admission); } catch { /* Retention bounds failed storage. */ }
    }
    throw error;
  }
  if (payload) await receipt(data, "displayed");
}
self.addEventListener("push", event => event.waitUntil(displayPush(event)));
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const data = event.notification.data;
  const url = new URL(safeTarget(data?.target) || "/?view=today", self.location.origin).href;
  event.waitUntil(Promise.all([
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const exact = windows.find(client => client.url === url);
      if (exact) await exact.focus();
      else await self.clients.openWindow(url);
    })(),
    receipt(data, "clicked"),
  ]));
});
self.addEventListener("message", event => {
  if (event.data?.type === "EZRA_NOTIFICATION_CAPABILITIES") event.ports?.[0]?.postMessage({ notificationProtocol: 1 });
});
self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    for (const client of windows) client.postMessage({ type: "EZRA_PUSH_REPAIR_REQUIRED" });
  }));
});
