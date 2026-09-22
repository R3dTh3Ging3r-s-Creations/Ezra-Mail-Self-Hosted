// @vitest-environment node
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { request as httpsRequest } from "node:https";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, ensureEmailDatabase, execute } from "@/lib/email/database";
import { enrollBrowserNotification, removeNotificationDevice } from "@/lib/email/notification-enrollment";
import { createNotificationEvent, enqueueNotificationDeliveries, claimNotificationDeliveryInTransaction, finishNotificationAttempt } from "@/lib/email/notification-store";
import * as store from "@/lib/email/notification-store";
import * as telegram from "@/lib/email/telegram";
import { getActiveTelegramBinding } from "@/lib/email/notification-telegram";
const now = "2026-09-14T15:01:00.000Z", origin = "https://ezra.example.test";
let owner: {
  trustedDeviceId: string;
  origin: string;
}, attemptId: string, eventId: string;
async function rows(table: string) {
  return (await execute('SELECT * FROM ' + table)).rows;
}
function update(action = "u", id = 1): unknown {
  return { update_id: id, callback_query: { id: "query-" + id, data: 'n:' + action + ':' + attemptId, from: { id: 123456789 }, message: { message_id: 41, chat: { id: 123456789, type: "private" } } } };
}
function network(payload: unknown = { ok: true, result: true }, delayed = false) {
  const bodies: Record<string, unknown>[] = [], paths: string[] = [], releases: (() => void)[] = [];
  let destroyed = false;
  const request = ((options: {
    path: string;
  }, receive: (response: unknown) => void) => {
    paths.push(options.path);
    return Object.assign(new EventEmitter(), {
      destroy() {
        destroyed = true;
      }, end(body: string) {
        bodies.push(JSON.parse(body));
        const release = () => {
          const r = Object.assign(new EventEmitter(), { statusCode: 200, complete: true, destroy() { } });
          receive(r);
          r.emit("data", Buffer.from(JSON.stringify(payload)));
          r.emit("end");
        };
        if (delayed)
          releases.push(release);
        else
          queueMicrotask(release);
      }
    });
  }) as unknown as typeof httpsRequest;
  return {
    request, bodies, paths, releases, get destroyed() {
      return destroyed;
    }
  };
}
async function process(value: unknown = update(), net = network()) {
  return telegram.processTelegramUpdate((await getActiveTelegramBinding())!, value, { now, network: net });
}
beforeEach(async () => {
  vi.stubEnv("APP_BASE_URL", "https://ezra.example.test");
  vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:synthetic");
  vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID", "123456789");
  configureEmailDatabaseForTests('file:./telegram-callbacks-' + randomUUID() + '.sqlite');
  await ensureEmailDatabase();
  owner = { trustedDeviceId: randomUUID(), origin };
  await execute("INSERT INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES (?,'Synthetic',?,?,?)", [owner.trustedDeviceId, owner.trustedDeviceId, now, now]);
  await enrollBrowserNotification(owner, { channel: "telegram", platform: "other", permission: "granted", capabilities: { foreground: false, push: false } });
  const event = await createNotificationEvent({ sourceKey: randomUUID(), kind: "checkin", target: "/?view=today", replacementTag: randomUUID(), reasonCode: "checkin", createdAt: now, expiresAt: "2026-09-15T15:01:00.000Z" });
  eventId = event.id;
  const [delivery] = await enqueueNotificationDeliveries({ eventId, now });
  const claim = await store.withNotificationStoreWrite(tx => claimNotificationDeliveryInTransaction(tx, { deliveryId: delivery.id, resolvedTarget: "/?view=today", channel: "telegram", now }));
  attemptId = claim!.attempt.id;
  await finishNotificationAttempt({ attemptId, outcome: "accepted", externalId: "41", now });
});
afterEach(() => {
  telegram.stopTelegramPolling();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeEmailDatabaseForTests();
});
it("commits Useful once before acknowledgement and resumes durable offset", async () => {
  const net = network();
  await process(update(), net);
  expect(await rows("notification_feedback")).toMatchObject([{ event_id: eventId, kind: "useful" }]);
  expect(net.paths[0]).toMatch(/answerCallbackQuery$/);
  expect(net.bodies[0]).toMatchObject({ callback_query_id: "query-1" });
  await process(update(), net);
  expect(net.bodies).toHaveLength(1);
  expect(await telegram.telegramUpdateOffset((await getActiveTelegramBinding())!)).toBe(2);
});
it.each(["chat", "sender", "group", "missingSender", "missingChat", "message", "attempt", "data"])("fails closed for %s", async (change) => {
  const value = update() as any;
  if (change === "chat")
    value.callback_query.message.chat.id = 7;
  if (change === "sender")
    value.callback_query.from.id = 7;
  if (change === "group")
    value.callback_query.message.chat.type = "group";
  if (change === "missingSender")
    delete value.callback_query.from;
  if (change === "missingChat")
    delete value.callback_query.message.chat;
  if (change === "message")
    value.callback_query.message.message_id = 42;
  if (change === "attempt")
    value.callback_query.data = 'n:u:' + randomUUID();
  if (change === "data")
    value.callback_query.data = 'n:u:' + "x".repeat(100);
  await process(value);
  expect(await rows("notification_feedback")).toHaveLength(0);
});
it.each(["generation", "binding", "trust"])("rechecks stale %s inside the write transaction", async (change) => {
  const binding = (await getActiveTelegramBinding())!;
  if (change === "generation")
    await execute("UPDATE notification_devices SET generation=generation+1");
  if (change === "binding")
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "654321:synthetic");
  if (change === "trust")
    await execute("UPDATE trusted_devices SET revoked_at=?", [now]);
  const net = network();
  await telegram.processTelegramUpdate(binding, update(), { now, network: net });
  expect(await rows("notification_feedback")).toHaveLength(0);
  expect(net.bodies).toHaveLength(0);
});
it("Too noisy and one-hour snooze only change notification policy", async () => {
  await process(update("q"));
  await process(update("s", 2));
  expect(await rows("notification_feedback")).toMatchObject([{ kind: "too_noisy" }]);
  expect((await execute("SELECT value FROM settings WHERE key='notification_snoozed_until'")).rows[0].value).toBe(JSON.stringify("2026-09-14T16:01:00.000Z"));
  expect(await rows("feedback_events")).toHaveLength(0);
  expect(await rows("reply_drafts")).toHaveLength(0);
});
it("legacy Send directs the owner to Ezra without a provider action", async () => {
  const value = update() as any;
  value.callback_query.data = "send:legacy";
  const net = network();
  await process(value, net);
  expect(net.paths).toHaveLength(1);
  expect(net.paths[0]).toMatch(/answerCallbackQuery$/);
  expect(net.bodies[0].text).toMatch(/Open Ezra/);
  expect(await rows("reply_drafts")).toHaveLength(0);
});
it("rollback during feedback keeps update retryable and sends no acknowledgement", async () => {
  const original = store.recordNotificationFeedbackInTransaction;
  const spy = vi.spyOn(store, "recordNotificationFeedbackInTransaction").mockImplementationOnce(async (...args) => {
    await original(...args);
    throw new Error("synthetic crash");
  });
  const net = network();
  await expect(process(update(), net)).rejects.toThrow("synthetic crash");
  expect(await rows("notification_feedback")).toHaveLength(0);
  expect(net.bodies).toHaveLength(0);
  expect(await telegram.telegramUpdateOffset((await getActiveTelegramBinding())!)).toBe(0);
  spy.mockRestore();
  await process();
  expect(await rows("notification_feedback")).toHaveLength(1);
});
it("concurrent workers claim one callback and unknown acknowledgement does not replay", async () => {
  const binding = (await getActiveTelegramBinding())!, net = network({ ok: false, description: "SENSITIVE" });
  await Promise.all([telegram.processTelegramUpdate(binding, update(), { now, network: net }), telegram.processTelegramUpdate(binding, update(), { now, network: net })]);
  expect(await rows("notification_feedback")).toHaveLength(1);
  expect(net.bodies).toHaveLength(1);
  expect(JSON.stringify(await rows("notification_telegram_updates"))).not.toContain("SENSITIVE");
});
it("disable aborts polling and rejects its in-flight update", async () => {
  const net = network({ ok: true, result: [update()] }, true);
  await telegram.startTelegramPolling({ network: net, now });
  for (let i = 0; i < 100 && !net.releases.length; i++)
    await new Promise(r => setTimeout(r, 5));
  expect(net.releases).toHaveLength(1);
  telegram.stopTelegramPolling();
  expect(net.destroyed).toBe(true);
  net.releases[0]();
  await new Promise(r => setTimeout(r, 20));
  expect(await rows("notification_feedback")).toHaveLength(0);
});
it("removal rejects a captured binding", async () => {
  const binding = (await getActiveTelegramBinding())!;
  await removeNotificationDevice(binding.deviceId, { owner, expectedGeneration: binding.generation });
  await telegram.processTelegramUpdate(binding, update(), { now, network: network() });
  expect(await rows("notification_feedback")).toHaveLength(0);
});
it("respects explicitly disabled command polling after enrollment", async () => {
  vi.stubEnv("TELEGRAM_POLLING_ENABLED", "false");
  const net = network();
  expect((await telegram.startTelegramPolling({ network: net, now })).running).toBe(false);
  expect(net.bodies).toHaveLength(0);
});
it("leases the polling batch so concurrent workers cannot receive disjoint batches", async () => {
  const first = network({ ok: true, result: [update()] }, true), second = network({ ok: true, result: [update("s", 2)] });
  const pending = telegram.pollTelegramUpdatesOnce({ network: first, now });
  for (let i = 0; i < 100 && !first.releases.length; i++)
    await new Promise(r => setTimeout(r, 5));
  await telegram.pollTelegramUpdatesOnce({ network: second, now });
  expect(second.bodies).toHaveLength(0);
  first.releases[0]();
  for (let i = 0; i < 100 && first.releases.length < 2; i++)
    await new Promise(r => setTimeout(r, 5));
  first.releases[1]?.();
  await pending;
  expect(await rows("notification_feedback")).toHaveLength(1);
});
it("failed lower update stops its batch before any higher offset can commit", async () => {
  const original = store.recordNotificationFeedbackInTransaction;
  vi.spyOn(store, "recordNotificationFeedbackInTransaction").mockImplementationOnce(async (...args) => {
    await original(...args);
    throw new Error("synthetic lower failure");
  });
  const net = network({ ok: true, result: [update(), update("s", 2)] });
  await expect(telegram.pollTelegramUpdatesOnce({ network: net, now })).rejects.toThrow("synthetic lower failure");
  expect(await telegram.telegramUpdateOffset((await getActiveTelegramBinding())!)).toBe(0);
  expect((await execute("SELECT value FROM settings WHERE key='notification_snoozed_until'")).rows).toHaveLength(0);
});
it("expired poll owner cannot commit an in-flight callback", async () => {
  const net = network({ ok: true, result: [update()] }, true);
  const pending = telegram.pollTelegramUpdatesOnce({ network: net, now });
  for (let i = 0; i < 100 && !net.releases.length; i++)
    await new Promise(r => setTimeout(r, 5));
  await execute("UPDATE notification_telegram_poll_leases SET expires_at='2026-09-14T00:00:00.000Z'");
  net.releases[0]();
  await pending;
  expect(await rows("notification_feedback")).toHaveLength(0);
});
it("duplicate callback identity with a new update ID still advances the consumed offset", async () => {
  await process();
  const value = update("u", 2) as any;
  value.callback_query.id = "query-1";
  await process(value);
  expect(await telegram.telegramUpdateOffset((await getActiveTelegramBinding())!)).toBe(3);
  expect(await rows("notification_feedback")).toHaveLength(1);
});
import * as adapter from "@/lib/email/notification-telegram";
it("crash after commit cannot replay feedback or acknowledgement", async () => {
  const spy = vi.spyOn(adapter, "telegramControlRequest").mockImplementationOnce(async () => {
    expect(await rows("notification_feedback")).toHaveLength(1);
    expect(await telegram.telegramUpdateOffset((await getActiveTelegramBinding())!)).toBe(2);
    throw new Error("synthetic post-commit crash");
  });
  await expect(process()).rejects.toThrow("synthetic post-commit crash");
  spy.mockRestore();
  const net = network();
  await process(update(), net);
  expect(net.bodies).toHaveLength(0);
  expect(await rows("notification_feedback")).toHaveLength(1);
});
it.each(["oversized", "batch", "malformed"])("bounds and redacts %s polling response", async (kind) => {
  const payload = kind === "oversized" ? { ok: true, result: [], padding: "SECRET".repeat(12000) } : kind === "batch" ? { ok: true, result: Array.from({ length: 21 }, (_, i) => update("u", i + 1)) } : { ok: true, result: [{ update_id: "SECRET" }] };
  const net = network(payload), stderr = vi.spyOn(globalThis.process.stderr, "write");
  await telegram.pollTelegramUpdatesOnce({ network: net, now });
  expect(net.bodies[0]).toMatchObject({ offset: 0, limit: 20, timeout: 10 });
  expect(await rows("notification_feedback")).toHaveLength(0);
  expect(telegram.getTelegramStatus().lastError).toBe("Telegram polling unavailable.");
  expect(stderr).not.toHaveBeenCalled();
});
it("today and help are generic owner-only commands and never claim all quiet", async () => {
  const net = network();
  await process({ update_id: 1, message: { text: "/today", from: { id: 123456789 }, chat: { id: 123456789, type: "private" } } }, net);
  expect(net.paths[0]).toMatch(/sendMessage$/);
  expect(net.bodies[0].text).toMatch(/current private brief/);
  expect(JSON.stringify(net.bodies)).not.toMatch(/all quiet|subject|sender|draft|approve/i);
  await process({ update_id: 2, message: { text: "/help", from: { id: 7 }, chat: { id: 123456789, type: "private" } } }, net);
  expect(net.bodies).toHaveLength(1);
});
it("disable through enrollment aborts local polling immediately", async () => {
  const binding = (await getActiveTelegramBinding())!, net = network({ ok: true, result: [update()] }, true);
  await telegram.startTelegramPolling({ network: net, now });
  for (let i = 0; i < 100 && !net.releases.length; i++)
    await new Promise(r => setTimeout(r, 5));
  await removeNotificationDevice(binding.deviceId, { owner, expectedGeneration: binding.generation });
  expect(telegram.getTelegramStatus().running).toBe(false);
  expect(net.destroyed).toBe(true);
  net.releases[0]();
  await new Promise(r => setTimeout(r, 30));
  expect(await rows("notification_feedback")).toHaveLength(0);
});
it("an owner cannot target an accepted attempt belonging to another device", async () => {
  const binding = (await getActiveTelegramBinding())!;
  await execute("INSERT INTO notification_devices (id,trusted_device_id,origin,channel,platform,permission,foreground,push,privacy,generation,baseline_sequence,created_at,updated_at) VALUES ('other-device',?,?,'browser','other','granted',1,0,'generic',1,0,?,?)", [owner.trustedDeviceId, origin, now, now]);
  await execute("UPDATE notification_deliveries SET device_id='other-device'");
  await telegram.processTelegramUpdate(binding, update(), { now, network: network() });
  expect(await rows("notification_feedback")).toHaveLength(0);
});
it("replaced external message buttons cannot mutate an older event", async () => {
  const binding = (await getActiveTelegramBinding())!;
  const event = await createNotificationEvent({ sourceKey: randomUUID(), kind: "checkin", target: "/?view=today", replacementTag: randomUUID(), reasonCode: "checkin", createdAt: now, expiresAt: "2026-09-15T15:01:00.000Z" });
  const [delivery] = await enqueueNotificationDeliveries({ eventId: event.id, now });
  const claim = await store.withNotificationStoreWrite(tx => claimNotificationDeliveryInTransaction(tx, { deliveryId: delivery.id, resolvedTarget: "/?view=today", channel: "telegram", now }));
  await finishNotificationAttempt({ attemptId: claim!.attempt.id, outcome: "accepted", externalId: "41", now });
  await telegram.processTelegramUpdate(binding, update(), { now, network: network() });
  expect(await rows("notification_feedback")).toHaveLength(0);
});
it("rotation after lease acquisition prevents a stale offset request", async () => {
  const original = store.withNotificationStoreWrite;
  vi.spyOn(store, "withNotificationStoreWrite").mockImplementationOnce(async operation => {
    const result = await original(operation);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "654321:synthetic");
    return result;
  });
  const net = network({ ok: true, result: [] });
  await telegram.pollTelegramUpdatesOnce({ network: net, now });
  expect(net.bodies).toHaveLength(0);
});
it("stop cancels startup while the binding lookup is pending", async () => {
  const binding = await getActiveTelegramBinding();
  let resolveBinding!: (value: typeof binding) => void;
  vi.spyOn(adapter, "getActiveTelegramBinding").mockImplementationOnce(
    () => new Promise(resolve => {
      resolveBinding = resolve;
    }),
  );
  const net = network({ ok: true, result: [] });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const starting = telegram.startTelegramPolling({ network: net, now });
    expect(resolveBinding).toBeDefined();
    telegram.stopTelegramPolling();
    resolveBinding(binding);

    expect((await starting).running).toBe(false);
    expect(telegram.getTelegramStatus().running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(net.bodies).toHaveLength(0);
  } finally {
    telegram.stopTelegramPolling();
    vi.useRealTimers();
  }
});

it("removed origin rejects captured callbacks and further polling without offset progression", async () => {
  vi.stubEnv("APP_BASE_URL", origin);
  vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "");
  const binding = (await getActiveTelegramBinding())!;
  vi.stubEnv("APP_BASE_URL", "https://new.example.test");
  const net = network();
  expect(await telegram.processTelegramUpdate(binding, update(), { now, network: net })).toBe(false);
  await telegram.pollTelegramUpdatesOnce({ now, network: net });
  expect(await getActiveTelegramBinding()).toBeNull();
  expect(await rows("notification_feedback")).toHaveLength(0);
  expect(await telegram.telegramUpdateOffset(binding)).toBe(0);
  expect(net.bodies).toHaveLength(0);
});
it("origin removal after poll lease acquisition prevents a stale request", async () => {
  vi.stubEnv("APP_BASE_URL", origin);
  vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "");
  const original = store.withNotificationStoreWrite;
  vi.spyOn(store, "withNotificationStoreWrite").mockImplementationOnce(async operation => {
    const result = await original(operation);
    vi.stubEnv("APP_BASE_URL", "https://new.example.test");
    return result;
  });
  const net = network({ ok: true, result: [] });
  await telegram.pollTelegramUpdatesOnce({ network: net, now });
  expect(net.bodies).toHaveLength(0);
});

it("rejects updates from an in-flight poll after its origin is removed", async () => {
  const binding = (await getActiveTelegramBinding())!, net = network({ ok: true, result: [update()] }, true);
  const pending = telegram.pollTelegramUpdatesOnce({ network: net, now });
  for (let i = 0; i < 100 && !net.releases.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(net.releases).toHaveLength(1);
  vi.stubEnv("APP_BASE_URL", "https://new.example.test");
  net.releases[0]();
  await pending;
  expect(await rows("notification_feedback")).toHaveLength(0);
  expect(await telegram.telegramUpdateOffset(binding)).toBe(0);
  expect(net.bodies).toHaveLength(1);
});
it("rolls back callback action and offset if origin disappears during the transaction", async () => {
  const binding = (await getActiveTelegramBinding())!, net = network();
  const original = store.recordNotificationFeedbackInTransaction;
  vi.spyOn(store, "recordNotificationFeedbackInTransaction").mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    vi.stubEnv("APP_BASE_URL", "https://new.example.test");
    return result;
  });
  await expect(telegram.processTelegramUpdate(binding, update(), { now, network: net })).rejects.toThrow("interrupted");
  expect(await rows("notification_feedback")).toHaveLength(0);
  expect(await telegram.telegramUpdateOffset(binding)).toBe(0);
  expect(net.bodies).toHaveLength(0);
});
