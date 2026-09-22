import { claimNotificationDelivery } from "./helpers/notification-ledger";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, execute } from "@/lib/email/database";
import { buildNotificationTarget, parseNotificationTarget } from "@/lib/email/notification-target";
import { createNotificationEvent, enqueueNotificationDeliveries, enrollNotificationDevice, finishNotificationAttempt, recordBrowserNotificationReceipt, revokeNotificationDevice } from "@/lib/email/notification-store";

beforeEach(() => { vi.stubEnv("APP_BASE_URL", "https://ezra.example.test"); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", ""); vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "true"); configureEmailDatabaseForTests(`file:./notification-target-${randomUUID()}.sqlite`); });
afterEach(() => { vi.unstubAllEnvs(); closeEmailDatabaseForTests(); });
describe("exact notification target codec", () => {
  it.each(["gmail", "microsoft"] as const)("retains exact %s account and message identity", (provider) => {
    const target = { view: "mail" as const, provider, accountId: "account_1", messageId: "message-1" };
    const href = buildNotificationTarget(target);
    expect(href).toBe(`/?view=mail&workspace=workspace%3Aaccount%3A${provider}%3Aaccount_1&message=message-1`);
    expect(parseNotificationTarget(href)).toEqual({ ...target, workspaceId: `workspace:account:${provider}:account_1` });
  });
  it("builds Today and accepts reordered exact root mail links", () => {
    expect(buildNotificationTarget({ view: "today" })).toBe("/?view=today");
    expect(parseNotificationTarget("/?view=today")).toEqual({ view: "today" });
    expect(parseNotificationTarget("/?message=m&workspace=workspace:account:gmail:a&view=mail")).toEqual({ view: "mail", provider: "gmail", accountId: "a", messageId: "m", workspaceId: "workspace:account:gmail:a" });
  });
  const invalid = ["https://evil.test/?view=today", "//evil.test/?view=today", "/other?view=today", "/./?view=today", "/?view=today#", "/?view=today&view=today", "/?view=today&x=y", "/?view=today\\", "/?view=today\n", "/?view=%74oday%", "/?view=%C0%AF", "/?view=mail&workspace=workspace:account:gmail:a&message=%00", "/?view=mail&workspace=workspace:account:gmail:a&message=m%5c", "/?view=mail&workspace=workspace:gmail&message=m", "/?view=mail&workspace=workspace:account:gmail:a:other&message=m", "/?view=mail&workspace=workspace:account:gmail:a&message=m&message=n", "/?view=mail&workspace=workspace:account:gmail:a&message=" + "m".repeat(201), "/?view=today&", "/?view=today&&"];
  it.each(invalid)("rejects unsafe or inexact target %s in both parser and store", async (target) => {
    expect(parseNotificationTarget(target)).toBeNull();
    await expect(createNotificationEvent({ sourceKey: randomUUID(), kind: "interrupt", target, replacementTag: "tag", reasonCode: "attention", createdAt: "2026-09-14T12:00:00.000Z", expiresAt: "2026-09-14T13:00:00.000Z" })).rejects.toThrow();
  });
  it("rejects missing or non-string opaque builder IDs", () => {
    for (const accountId of [undefined, null, 123]) {
      expect(() => buildNotificationTarget({ view: "mail", provider: "gmail", accountId, messageId: "message" } as unknown as Parameters<typeof buildNotificationTarget>[0])).toThrow();
    }
  });
  it("validates builder identifiers and normalizes store targets with the same codec", async () => {
    expect(() => buildNotificationTarget({ view: "mail", provider: "gmail", accountId: "bad:account", messageId: "message" })).toThrow();
    const e = await createNotificationEvent({ sourceKey: "source", kind: "interrupt", target: "/?message=m&workspace=workspace:account:gmail:a&view=mail", replacementTag: "tag", reasonCode: "attention", createdAt: "2026-09-14T12:00:00.000Z", expiresAt: "2026-09-14T13:00:00.000Z" });
    expect(e.target).toBe("/?view=mail&workspace=workspace%3Aaccount%3Agmail%3Aa&message=m");
  });
});

const now = "2026-09-14T12:00:00.000Z";
async function setup(push = false) {
  await execute("INSERT INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES ('trust','Synthetic','hash',?,?)", [now, now]);
  const owner = { trustedDeviceId: "trust", origin: "https://ezra.example.test" };
  const device = await enrollNotificationDevice({ expectedSetupEpoch: 0, ...owner, channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push }, now });
  const event = await createNotificationEvent({ sourceKey: "source", kind: "interrupt", target: "/?view=today", replacementTag: "tag", reasonCode: "attention", createdAt: now, expiresAt: "2026-09-14T13:00:00.000Z" });
  const [delivery] = await enqueueNotificationDeliveries({ eventId: event.id, now });
  return { device, delivery, owner };
}
describe("atomic browser claim and receipt store boundary", () => {
  it.each([{ deviceId: "other" }, { generation: 2 }, { trustedDeviceId: "other" }, { origin: "https://other.test" }])("checks foreground binding inside the claim: %j", async (wrong) => {
    const { device, delivery, owner } = await setup();
    const binding = { ...owner, deviceId: device.id, generation: 1 };
    expect(await claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground", foregroundOwner: { ...binding, ...wrong }, now })).toBeNull();
    expect((await execute("SELECT * FROM notification_attempts")).rows).toHaveLength(0);
    expect(await claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground", foregroundOwner: binding, now })).not.toBeNull();
  });
  it("rejects foreground authority on a transport-selected push claim", async () => {
    const { device, delivery, owner } = await setup(true);
    await expect(claimNotificationDelivery({ deliveryId: delivery.id, channel: "push", foregroundOwner: { ...owner, deviceId: device.id, generation: 1 }, now })).rejects.toThrow();
    expect(await claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground", foregroundOwner: { ...owner, deviceId: device.id, generation: 1 }, now })).toBeNull();
  });
  it("rolls back acceptance when receipt insertion fails", async () => {
    const { device, delivery, owner } = await setup(true);
    const c = (await claimNotificationDelivery({ deliveryId: delivery.id, channel: "push", now }))!;
    await execute("CREATE TRIGGER reject_browser_receipt BEFORE INSERT ON notification_receipts BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
    const input = { ...owner, deviceId: device.id, attemptId: c.attempt.id, generation: 1, kind: "displayed" as const, now };
    await expect(recordBrowserNotificationReceipt(input)).rejects.toThrow();
    expect((await execute("SELECT state FROM notification_deliveries")).rows).toEqual([{ state: "claimed" }]);
    expect((await execute("SELECT outcome FROM notification_attempts")).rows).toEqual([{ outcome: null }]);
    await execute("DROP TRIGGER reject_browser_receipt");
    expect(await recordBrowserNotificationReceipt(input)).toBe(true);
  });
  it("allows an issued foreground receipt after push attaches and never regresses clicked", async () => {
    const { device, delivery, owner } = await setup();
    const c = (await claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground", now }))!;
    await execute("UPDATE notification_devices SET push=1");
    const input = { ...owner, deviceId: device.id, attemptId: c.attempt.id, generation: 1, now };
    expect(await recordBrowserNotificationReceipt({ ...input, kind: "foreground_shown" })).toBe(true);
    expect(await recordBrowserNotificationReceipt({ ...input, kind: "clicked" })).toBe(true);
    expect(await recordBrowserNotificationReceipt({ ...input, kind: "foreground_shown" })).toBe(true);
    expect(await recordBrowserNotificationReceipt({ ...input, kind: "foreground_failed" })).toBe(false);
    expect((await execute("SELECT state FROM notification_deliveries")).rows).toEqual([{ state: "clicked" }]);
    expect((await execute("SELECT kind FROM notification_receipts ORDER BY kind")).rows).toEqual([{ kind: "clicked" }, { kind: "displayed" }]);
  });
  it.each(["failed", "expired", "unknown", "cancelled"] as const)("cannot revive a %s push attempt", async (outcome) => {
    const { device, delivery, owner } = await setup(true);
    const c = (await claimNotificationDelivery({ deliveryId: delivery.id, channel: "push", now }))!;
    if (outcome === "cancelled") await revokeNotificationDevice({ deviceId: device.id, now });
    else await finishNotificationAttempt({ attemptId: c.attempt.id, outcome, now });
    expect(await recordBrowserNotificationReceipt({ ...owner, deviceId: device.id, attemptId: c.attempt.id, generation: 1, kind: "displayed", now })).toBe(false);
    expect((await execute("SELECT * FROM notification_receipts")).rows).toHaveLength(0);
  });
  it("rejects expired and future-started claims and wrong origin before changing state", async () => {
    const { device, delivery, owner } = await setup(true);
    const c = (await claimNotificationDelivery({ deliveryId: delivery.id, channel: "push", now }))!;
    const input = { ...owner, deviceId: device.id, attemptId: c.attempt.id, generation: 1, kind: "displayed" as const };
    expect(await recordBrowserNotificationReceipt({ ...input, now: "2026-09-14T11:59:59.000Z" })).toBe(false);
    expect(await recordBrowserNotificationReceipt({ ...input, now: "2026-09-14T13:00:00.000Z" })).toBe(false);
    expect(await recordBrowserNotificationReceipt({ ...input, origin: "https://other.test", now })).toBe(false);
    expect((await execute("SELECT outcome FROM notification_attempts")).rows).toEqual([{ outcome: null }]);
  });
});

it.each(["accepted", "failed", "unknown", "expired"] as const)("preserves device-reported display against late relay outcome %s", async outcome => {
  const { device, delivery, owner } = await setup(true);
  const claim = (await claimNotificationDelivery({ deliveryId: delivery.id, channel: "push", now }))!;
  expect(await recordBrowserNotificationReceipt({ ...owner, deviceId: device.id, attemptId: claim.attempt.id, generation: 1, kind: "displayed", now })).toBe(true);
  expect((await execute("SELECT outcome FROM notification_attempts")).rows).toEqual([{ outcome: "accepted" }]);
  expect(await finishNotificationAttempt({ attemptId: claim.attempt.id, outcome, now: "2026-09-14T12:00:01.000Z" })).toBeNull();
  expect((await execute("SELECT state FROM notification_deliveries")).rows).toEqual([{ state: "displayed" }]);
  expect((await execute("SELECT kind FROM notification_receipts")).rows).toEqual([{ kind: "displayed" }]);
});
