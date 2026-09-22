import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, execute, ensureEmailDatabase } from "@/lib/email/database";
import * as auth from "@/lib/email/auth";
import { enrollNotificationDevice, createNotificationEvent, enqueueNotificationDeliveries } from "@/lib/email/notification-store";
import { GET } from "@/app/api/notifications/history/route";
import { POST } from "@/app/api/notifications/feedback/route";
import { updateNotificationPolicy } from "@/lib/email/notification-center";
const origin = "https://ezra.example.test", now = "2026-09-14T15:00:00.000Z";
let deviceId: string;
function request(method = "GET", body?: unknown, host = origin) { return new Request(`${host}/api/notifications/history`, { method, headers: { host: new URL(host).host, origin: host, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
beforeEach(async () => {
  vi.stubEnv("APP_BASE_URL", origin); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "https://other.example.test"); vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "true");
  configureEmailDatabaseForTests(`file:./notification-history-${randomUUID()}.sqlite`); await ensureEmailDatabase();
  await execute("INSERT INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES ('trust','Synthetic','hash',?,?)", [now, now]);
  vi.spyOn(auth, "getAuthSession").mockResolvedValue({ authenticated: true, configured: true, developmentBypass: false, expiresAt: null, authenticationMethod: "trusted_device", trustedDevice: { id: "trust", label: "Synthetic" } });
  deviceId = (await enrollNotificationDevice({ expectedSetupEpoch: 0, trustedDeviceId: "trust", origin, channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push: false }, now })).id;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); closeEmailDatabaseForTests(); });
async function event(i: number) { const e = await createNotificationEvent({ sourceKey: `synthetic-${i}`, kind: "brief", target: "/?view=today", replacementTag: "brief", reasonCode: "brief", createdAt: now, expiresAt: "2026-09-14T16:00:00.000Z" }); await enqueueNotificationDeliveries({ eventId: e.id, now }); return e; }
it("returns only last ten events reserved to the current trusted device and origin with mutable feedback", async () => {
  for (let i = 0; i < 11; i++) await event(i);
  const response = await GET(request()); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const history = await response.json(); expect(history.events).toHaveLength(10);
  expect(Object.keys(history.events[0]).sort()).toEqual(["createdAt", "eventId", "feedback", "kind", "outcome"]);
  const eventId = history.events[0].eventId;
  for (const kind of ["too_noisy", "useful"]) { expect((await POST(request("POST", { eventId, kind }))).status).toBe(200); expect((await (await GET(request())).json()).events[0].feedback).toBe(kind); }
  expect((await (await GET(request("GET", undefined, "https://other.example.test"))).json()).events).toEqual([]);
  await execute("UPDATE trusted_devices SET revoked_at=? WHERE id='trust'", [now]);
  expect((await (await GET(request())).json()).events).toEqual([]);
});
it("never offers feedback for a different device's event", async () => {
  const e = await event(1); await execute("DELETE FROM notification_deliveries WHERE device_id=?", [deviceId]);
  expect((await POST(request("POST", { eventId: e.id, kind: "useful" }))).status).toBe(403);
});
it("computes snooze actions server-side and rejects conflicting or invalid changes atomically", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
  expect(await updateNotificationPolicy({ snooze: "hour" })).toMatchObject({ snoozedUntil: "2026-09-14T16:00:00.000Z" });
  expect(await updateNotificationPolicy({ snooze: "tomorrow" })).toMatchObject({ snoozedUntil: "2026-09-15T12:30:00.000Z" });
  await expect(updateNotificationPolicy({ dailyInterruptBudget: 21, snooze: "clear" })).rejects.toThrow();
  expect((await execute("SELECT value FROM settings WHERE key='notification_snoozed_until'")).rows[0].value).toContain("2026-09-15");
  expect(await updateNotificationPolicy({ snooze: "clear" })).toMatchObject({ snoozedUntil: null });
});
it("shows a safe current check-in hold even after its event leaves the ten-item history", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
  const checkin = await createNotificationEvent({ sourceKey: "checkin", kind: "checkin", target: "/?view=today", replacementTag: "checkin", reasonCode: "checkin", createdAt: now, expiresAt: "2026-09-14T16:00:00Z" });
  await enqueueNotificationDeliveries({ eventId: checkin.id, now }); await POST(request("POST", { eventId: checkin.id, kind: "too_noisy" }));
  for (let i = 0; i < 11; i++) await event(i);
  const payload = await (await GET(request())).json();
  expect(payload.events).toHaveLength(10); expect(payload.events.some((e: { eventId: string }) => e.eventId === checkin.id)).toBe(false);
  expect(payload.calmCheckinHoldUntil).toBe("2026-09-21T15:00:00.000Z");
  await updateNotificationPolicy({ dailyInterruptBudget: 4 });
  expect((await (await GET(request())).json()).calmCheckinHoldUntil).toBe(payload.calmCheckinHoldUntil);
});
