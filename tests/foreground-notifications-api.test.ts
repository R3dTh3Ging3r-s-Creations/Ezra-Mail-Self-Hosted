import { claimNotificationDelivery } from "./helpers/notification-ledger";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, execute } from "@/lib/email/database";
import * as auth from "@/lib/email/auth";
import { GET } from "@/app/api/notifications/foreground/route";
import { POST as receipt } from "@/app/api/notifications/receipts/route";
import { enrollNotificationDevice, createNotificationEvent, enqueueNotificationDeliveries, finishNotificationAttempt, revokeNotificationDevice } from "@/lib/email/notification-store";

const origin = "https://ezra.example.test";
let now: string;
function request(path = "foreground", method = "GET", body?: unknown) {
  return new Request(`http://localhost:3000/api/notifications/${path}`, { method, headers: { host: "ezra.example.test", origin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function enroll(trustedDeviceId = "trust", push = false, deviceOrigin = origin) {
  await execute("INSERT OR IGNORE INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES (?,'Synthetic',?,?,?)", [trustedDeviceId, trustedDeviceId, now, now]);
  return enrollNotificationDevice({ expectedSetupEpoch: 0, trustedDeviceId, origin: deviceOrigin, channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push }, now });
}
async function event(sourceKey = randomUUID(), overrides = {}) {
  return createNotificationEvent({ sourceKey, kind: "interrupt", target: "/?view=today", replacementTag: "generic-tag", reasonCode: "attention", createdAt: now, expiresAt: new Date(Date.now() + 3600000).toISOString(), ...overrides });
}
async function pending() {
  const device = await enroll(); const created = await event();
  const [delivery] = await enqueueNotificationDeliveries({ eventId: created.id, now });
  await eligibleMember(created.id, created.sourceKey);
  return { device, created, delivery };
}
async function claim(deliveryId: string, expectedGeneration = 1, extra = {}) {
  const { POST } = await import("@/app/api/notifications/claims/route");
  return POST(request("claims", "POST", { deliveryId, expectedGeneration, ...extra }));
}
async function state(id: string) { return (await execute("SELECT state FROM notification_deliveries WHERE id=?", [id])).rows[0].state; }
beforeEach(async () => {
  vi.stubEnv("APP_BASE_URL", origin); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", ""); vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "true");
  configureEmailDatabaseForTests(`file:./shared-foreground-api-${randomUUID()}.sqlite`);
  now = new Date(Date.now() - 1000).toISOString();
  vi.spyOn(auth, "getAuthSession").mockResolvedValue({ authenticated: true, configured: true, developmentBypass: false, trustedDevice: { id: "trust" } } as Awaited<ReturnType<typeof auth.getAuthSession>>);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); closeEmailDatabaseForTests(); });

describe("shared foreground HTTP boundary", () => {
  it("returns disabled without enrollment and does not create delivery work", async () => {
    const response = await GET(request()); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, deviceId: null, generation: null, events: [], hasMore: false });
    expect((await execute("SELECT * FROM notification_devices")).rows).toHaveLength(0);
  });
  it.each(["?cursor=v1.MA", "?deviceId=other", "?limit=100", "?generation=1"])("rejects old replay and client identity query %s", async (query) => {
    expect((await GET(request(`foreground${query}`))).status).toBe(400);
  });
  it("requires configured trusted authentication and exact origin", async () => {
    vi.mocked(auth.getAuthSession).mockResolvedValueOnce({ authenticated: false } as Awaited<ReturnType<typeof auth.getAuthSession>>);
    expect((await GET(request())).status).toBe(401);
    vi.mocked(auth.getAuthSession).mockResolvedValueOnce({ authenticated: true, configured: true, developmentBypass: false, trustedDevice: null } as Awaited<ReturnType<typeof auth.getAuthSession>>);
    expect((await GET(request())).status).toBe(403);
    const bad = request(); bad.headers.set("origin", "https://other.test"); expect((await GET(bad)).status).toBe(403);
  });
  it("reads safe due reservations without claiming and never replays claimed work", async () => {
    const { device, created, delivery } = await pending();
    const response = await GET(request()); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ enabled: true, deviceId: device.id, generation: 1, hasMore: false, events: [{ deliveryId: delivery.id, eventId: created.id, kind: "interrupt", target: "/?view=today", tag: "generic-tag", title: expect.any(String), body: expect.any(String), createdAt: now }] });
    expect((await execute("SELECT * FROM notification_attempts")).rows).toHaveLength(0);
    expect(await state(delivery.id)).toBe("pending");
    expect((await claim(delivery.id)).status).toBe(200);
    expect((await (await GET(request())).json()).events).toEqual([]);
  });
  it("caps feed at twenty due items with deterministic ordering", async () => {
    await enroll();
    for (let i = 0; i < 22; i++) { const e = await event(); await enqueueNotificationDeliveries({ eventId: e.id, now }); }
    const body = await (await GET(request())).json(); expect(body.events).toHaveLength(20); expect(body.hasMore).toBe(true);
    expect((await (await GET(request())).json()).events).toEqual(body.events);
  });
  it("excludes future, expired, in-app, baseline, stale, wrong origin/trust and push work", async () => {
    const old = await event(); const current = await enroll(); await enroll("other"); await enroll("trust", false, "https://second.test");
    expect(await enqueueNotificationDeliveries({ eventId: old.id, now })).toEqual([]);
    for (const overrides of [{ notBefore: new Date(Date.now() + 60000).toISOString() }, { kind: "in_app" }, { origin: "https://second.test" }]) {
      const e = await event(randomUUID(), overrides); await enqueueNotificationDeliveries({ eventId: e.id, now });
    }
    const stale = await event(); await enqueueNotificationDeliveries({ eventId: stale.id, now });
    await execute("UPDATE notification_deliveries SET generation=9 WHERE device_id=?", [current.id]);
    expect((await (await GET(request())).json()).events).toEqual([]);
    await execute("UPDATE notification_deliveries SET generation=1 WHERE device_id=?", [current.id]);
    await execute("UPDATE notification_events SET expires_at=? WHERE not_before<=?", [new Date(Date.now() - 500).toISOString(), now]);
    expect((await (await GET(request())).json()).events).toEqual([]);
    const fresh = await event(); const rows = await enqueueNotificationDeliveries({ eventId: fresh.id, now });
    await execute("UPDATE notification_devices SET push=1 WHERE id=?", [current.id]);
    expect((await (await GET(request())).json()).events).toEqual([]);
    expect((await claim(rows.find((r) => r.deviceId === current.id)!.id)).status).toBe(409);
  });
  it("enforces the master flag for feed and claims", async () => {
    const { delivery } = await pending(); vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "false");
    expect((await GET(request())).status).toBe(503); expect((await claim(delivery.id)).status).toBe(503);
    expect(await state(delivery.id)).toBe("pending");
  });
  it("claims once across competing tabs and never serializes internal fields", async () => {
    const { delivery } = await pending();
    const responses = await Promise.all([claim(delivery.id), claim(delivery.id)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const body = await responses.find((r) => r.status === 200)!.json();
    expect(body).toMatchObject({ deliveryId: delivery.id, attemptId: expect.any(String), generation: 1, target: expect.stringContaining("message=governed-message") });
    expect(Object.keys(body).sort()).toEqual(["attemptId", "body", "createdAt", "deliveryId", "eventId", "generation", "kind", "tag", "target", "title"].sort());
    expect((await execute("SELECT channel FROM notification_attempts")).rows).toEqual([{ channel: "foreground" }]);
  });
  it("rejects other device, stale generation and client transport selection", async () => {
    const { delivery } = await pending();
    expect((await claim(delivery.id, 2)).status).toBe(409);
    expect((await claim(delivery.id, 1, { channel: "push" })).status).toBe(400);
    await enroll("other"); vi.mocked(auth.getAuthSession).mockResolvedValue({ authenticated: true, configured: true, developmentBypass: false, trustedDevice: { id: "other" } } as Awaited<ReturnType<typeof auth.getAuthSession>>);
    expect((await claim(delivery.id)).status).toBe(409); expect(await state(delivery.id)).toBe("pending");
  });
  it("defaults to private copy and allows details only for current exact connected mail lookup", async () => {
    const device = await enroll();
    await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES ('account-1','gmail','private@example.test','Synthetic','connected',?,?)", [now, now]);
    await execute("INSERT INTO email_messages (id,account_id,external_message_id,thread_id,sender_name,sender_email,subject,received_at,snippet,gmail_url,is_unread,status,created_at,updated_at) VALUES ('message-1','account-1','external','thread','Private Sender','sender@example.test','Private Subject',?,'Secret snippet','#',1,'triaged',?,?)", [now, now, now]);
    const e = await event(randomUUID(), { target: "/?view=mail&workspace=workspace%3Aaccount%3Agmail%3Aaccount-1&message=message-1" }); await enqueueNotificationDeliveries({ eventId: e.id, now });
    expect(JSON.stringify(await (await GET(request())).json())).not.toMatch(/Private|private@example|sender@example|Secret snippet/);
    await execute("UPDATE notification_devices SET privacy='detailed' WHERE id=?", [device.id]);
    const detailed = await (await GET(request())).json(); expect(detailed.events[0]).toMatchObject({ title: "Private Sender", body: "Private Subject" });
    await execute("UPDATE email_accounts SET provider='microsoft'");
    expect(JSON.stringify(await (await GET(request())).json())).not.toMatch(/Private|Secret/);
    await execute("UPDATE email_accounts SET provider='gmail',status='disabled'");
    expect(JSON.stringify(await (await GET(request())).json())).not.toMatch(/Private|Secret/);
    await execute("UPDATE email_accounts SET status='connected'");
    await execute("UPDATE notification_devices SET privacy='generic' WHERE id=?", [device.id]);
    await eligibleMember(e.id, e.sourceKey, "message-1", "account-1");
    const claimed = await claim((await execute("SELECT id FROM notification_deliveries WHERE event_id=?", [e.id])).rows[0].id as string);
    expect(claimed.status).toBe(200);
    expect(JSON.stringify(await claimed.json())).not.toMatch(/Private|Secret/);
  });
});

describe("browser receipt transitions", () => {
  it.each(["foreground_shown", "foreground_failed"])("atomically records %s and cannot revive/replay", async (kind) => {
    const { device, delivery } = await pending();
    const c = (await claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground" }))!;
    const input = { attemptId: c.attempt.id, generation: device.generation, kind };
    expect((await receipt(request("receipts", "POST", input))).status).toBe(200);
    expect(await state(delivery.id)).toBe(kind === "foreground_shown" ? "displayed" : "failed");
    expect(await finishNotificationAttempt({ attemptId: c.attempt.id, outcome: "unknown" })).toBeNull();
    expect((await claim(delivery.id)).status).toBe(409);
    if (kind === "foreground_shown") {
      expect((await receipt(request("receipts", "POST", input))).status).toBe(200);
      expect((await execute("SELECT kind FROM notification_receipts")).rows).toEqual([{ kind: "displayed" }]);
    } else {
      expect((await receipt(request("receipts", "POST", { ...input, kind: "foreground_shown" }))).status).toBe(403);
    }
  });
  it.each(["displayed", "clicked"])("accepts push %s before relay completion without later regression", async (kind) => {
    const device = await enroll("trust", true); const e = await event(); const [d] = await enqueueNotificationDeliveries({ eventId: e.id, now });
    const c = (await claimNotificationDelivery({ deliveryId: d.id, channel: "push" }))!;
    expect((await receipt(request("receipts", "POST", { attemptId: c.attempt.id, generation: device.generation, kind }))).status).toBe(200);
    expect(await state(d.id)).toBe(kind);
    expect(await finishNotificationAttempt({ attemptId: c.attempt.id, outcome: "failed", errorCode: "unavailable", retryAt: new Date(Date.now() + 60000).toISOString() })).toBeNull();
    expect(await state(d.id)).toBe(kind);
  });
  it("rejects wrong ownership, generation, channel and canceled/unknown attempts", async () => {
    const { device, delivery } = await pending(); const other = await enroll("other");
    const c = (await claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground" }))!;
    const input = { attemptId: c.attempt.id, generation: device.generation, kind: "foreground_shown" };
    expect((await receipt(request("receipts", "POST", { ...input, generation: 2 }))).status).toBe(409);
    expect((await receipt(request("receipts", "POST", { ...input, kind: "displayed" }))).status).toBe(403);
    vi.mocked(auth.getAuthSession).mockResolvedValueOnce({ authenticated: true, configured: true, developmentBypass: false, trustedDevice: { id: other.trustedDeviceId } } as Awaited<ReturnType<typeof auth.getAuthSession>>);
    expect((await receipt(request("receipts", "POST", input))).status).toBe(403);
    await finishNotificationAttempt({ attemptId: c.attempt.id, outcome: "unknown" });
    expect((await receipt(request("receipts", "POST", input))).status).toBe(403);
    await revokeNotificationDevice({ deviceId: device.id });
    expect((await receipt(request("receipts", "POST", input))).status).toBe(409);
  });
});

async function eligibleMember(eventId: string, sourceKey: string, messageId = "governed-message", accountId = "governed-account") {
  await execute("INSERT OR IGNORE INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES (?,'gmail',?,'Synthetic','connected',?,?)", [accountId, `${accountId}@example.test`, now, now]);
  await execute("INSERT OR IGNORE INTO email_messages (id,account_id,external_message_id,thread_id,sender_name,sender_email,subject,received_at,snippet,gmail_url,is_unread,status,created_at,updated_at) VALUES (?,?,?,'thread','Synthetic','sender@example.test','Synthetic',?,'','',1,'triaged',?,?)", [messageId, accountId, messageId, now, now, now]);
  await execute("INSERT INTO triage_decisions (id,message_id,model,attention,urgency,confidence,category,summary,reason,recommendation,needs_reply,created_at) VALUES (?,?,'synthetic','interrupt',95,0.95,'fraud','','','',0,?)", [randomUUID(), messageId, now]);
  await execute("INSERT INTO notification_policy_evidence (source_key,message_id,event_id,account_id,sender_hash,category,grouping_key,level,critical,reason_code,rule_trace,created_at) VALUES (?,?,?,?,'hash','fraud',?,'interrupt',1,'critical','[]',?)", [sourceKey, messageId, eventId, accountId, createHash("sha256").update(JSON.stringify(["thread", accountId, "thread"])).digest("hex"), now]);
}
