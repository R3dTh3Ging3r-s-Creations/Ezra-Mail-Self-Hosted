// @vitest-environment node
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { request as httpsRequest } from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, ensureEmailDatabase, execute, setSetting } from "@/lib/email/database";
import { enrollNotificationDevice, revokeNotificationDevice } from "@/lib/email/notification-store";
import { decideMessageNotification } from "@/lib/email/notification-governor";
import { claimGovernedNotification } from "@/lib/email/notification-claims";
import * as subscriptions from "@/lib/email/notification-subscriptions";
import { readPushConfiguration } from "@/lib/email/notification-crypto";
import { dispatchNotificationDelivery, drainPushNotifications } from "@/lib/email/notification-dispatch";

const created = "2026-09-14T15:00:00.000Z", now = "2026-09-14T15:01:00.000Z", origin = "https://ezra.example.test";
function keypair() { const key = createECDH("prime256v1"); key.generateKeys(); return key; }
function subscription(suffix = randomUUID()) { return { endpoint: "https://fcm.googleapis.com/synthetic-" + suffix, expirationTime: null, keys: { p256dh: keypair().getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } }; }
let device: Awaited<ReturnType<typeof enrollNotificationDevice>>;
async function enroll(trust: string = randomUUID(), push = true) {
  await execute("INSERT INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES (?,'Synthetic',?,?,?)", [trust, trust, created, created]);
  const result = await enrollNotificationDevice({ expectedSetupEpoch: 0, trustedDeviceId: trust, origin, channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push: false }, now: created });
  if (push) await attach(result);
  return result;
}
async function attach(value = device) { return subscriptions.attachPushSubscription({ expectedSetupEpoch: 0, deviceId: value.id, trustedDeviceId: value.trustedDeviceId, origin, generation: value.generation, subscription: subscription(), expectedVapidKeyFingerprint: readPushConfiguration()!.vapidKeyFingerprint, now: created }); }
async function message(id = "m", thread = "thread") {
  await execute("INSERT INTO email_messages (id,account_id,external_message_id,thread_id,sender_name,sender_email,subject,received_at,snippet,gmail_url,is_unread,status,created_at,updated_at) VALUES (?,'a',?,?,'Private sender','private@example.test','Private subject',?,'Private body','',1,'triaged',?,?)", [id, id, thread, created, created, created]);
  await execute("INSERT INTO triage_decisions (id,message_id,model,attention,urgency,confidence,category,summary,reason,recommendation,needs_reply,created_at) VALUES (?,?,'synthetic','interrupt',95,0.95,'urgent-work','Private summary','','',0,?)", ["triage-" + id, id, created]);
  return decideMessageNotification(id, created);
}
async function table(name: string) { return (await execute(`SELECT * FROM ${name}`)).rows; }
async function delivery() { return String((await table("notification_deliveries"))[0].id); }
function network(status = 201, delayed = false, retryAfter = "30") {
  let calls = 0, active = 0, peak = 0;
  const releases: (() => void)[] = [];
  const request = ((_options: unknown, receive: (value: unknown) => void) => {
    calls++; active++; peak = Math.max(peak, active);
    return Object.assign(new EventEmitter(), { destroy() {}, end() {
      const finish = () => { active--; const response = Object.assign(new EventEmitter(), { statusCode: status, headers: { "retry-after": retryAfter }, complete: true, destroy() {} }); receive(response); response.emit("end"); };
      if (delayed) releases.push(finish); else queueMicrotask(finish);
    } });
  }) as unknown as typeof httpsRequest;
  return { request, calls: () => calls, peak: () => peak, releases };
}
async function until(predicate: () => boolean) { for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("Synthetic barrier timed out"); }
beforeEach(async () => {
  vi.stubEnv("APP_BASE_URL", "https://ezra.example.test"); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", ""); vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID", "");
  const key = keypair();
  for (const [name, value] of Object.entries({ EZRA_BROWSER_NOTIFICATIONS_ENABLED: "true", EZRA_PUSH_KEY_ID: "synthetic", EZRA_PUSH_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), EZRA_VAPID_PUBLIC_KEY: key.getPublicKey().toString("base64url"), EZRA_VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32), key.getPrivateKey()]).subarray(-32).toString("base64url"), EZRA_VAPID_SUBJECT: "mailto:synthetic@example.test", EZRA_PUSH_OLD_KEYS_JSON: "" })) vi.stubEnv(name, value);
  configureEmailDatabaseForTests("file:./notification-dispatch-" + randomUUID() + ".sqlite"); await ensureEmailDatabase();
  await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES ('a','gmail','synthetic@example.test','Synthetic','connected',?,?)", [created, created]);
  device = await enroll();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); closeEmailDatabaseForTests(); });
describe("governed push dispatch", () => {
  it("races twenty same-event dispatches and foreground claims to exactly one browser attempt", async () => {
    await message(); const id = await delivery(), net = network();
    await Promise.all(Array.from({ length: 20 }, (_, index) => index % 2 ? dispatchNotificationDelivery(id, { now, network: net }) : claimGovernedNotification({ deliveryId: id, deviceId: device.id, generation: 1, channel: "foreground", foregroundOwner: { deviceId: device.id, generation: 1, trustedDeviceId: device.trustedDeviceId, origin }, now })));
    expect(net.calls()).toBe(1); expect(await table("notification_attempts")).toHaveLength(1);
    expect((await table("notification_deliveries"))[0].state).toBe("accepted"); expect(await table("notification_receipts")).toHaveLength(0);
  });
  it("delivers once per device and leaves non-push foreground reservations pending", async () => {
    await enroll(); const foreground = await enroll("foreground", false); await message(); const net = network();
    await drainPushNotifications({ now, network: net });
    expect(net.calls()).toBe(2); expect((await table("notification_deliveries")).find(row => row.device_id === foreground.id)?.state).toBe("pending");
  });
  it("bounds overlapping drains to ten reservations and two concurrent transports", async () => {
    for (let i = 0; i < 11; i++) await enroll(); await message(); const net = network(201, true);
    const first = drainPushNotifications({ now, network: net }), second = drainPushNotifications({ now, network: net });
    for (let batch = 0; batch < 5; batch++) { await until(() => net.releases.length === 2); net.releases.splice(0).forEach(release => release()); }
    await Promise.all([first, second]);
    expect(net.calls()).toBe(10); expect(net.peak()).toBe(2); expect((await table("notification_deliveries")).filter(row => row.state === "pending")).toHaveLength(2);
  });
  it.each(["read", "handled", "snoozed", "category", "disabled", "quiet", "feedback"])("cancels or blocks current %s work without changing immutable decisions", async change => {
    await message(); const original = await table("notification_policy_evidence");
    if (change === "read") await execute("UPDATE email_messages SET is_unread=0");
    if (change === "handled") await execute("UPDATE email_messages SET status='read'");
    if (change === "snoozed") await setSetting("notification_snoozed_until", JSON.stringify("2026-09-14T16:00:00.000Z"));
    if (change === "category") await execute("UPDATE triage_decisions SET category='fraud'");
    if (change === "quiet") { await setSetting("timezone", "UTC"); await setSetting("quiet_start", "15:00"); await setSetting("quiet_end", "16:00"); }
    if (change === "feedback") await execute("INSERT INTO notification_feedback (device_id,event_id,kind,created_at) VALUES (?,?,'too_noisy',?)", [device.id, (await table("notification_events"))[0].id, now]);
    if (change === "disabled") vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "false");
    const net = network(); await drainPushNotifications({ now, network: net }); expect(net.calls()).toBe(0); expect(await table("notification_attempts")).toHaveLength(0); expect(await table("notification_policy_evidence")).toEqual(original);
    if (change !== "disabled") expect((await table("notification_deliveries"))[0]).toMatchObject({ state: "cancelled" });
  });
  it("selects an eligible grouped member before claiming without charging admission again", async () => {
    await message("first"); await message("second"); await execute("UPDATE email_messages SET is_unread=0 WHERE id='first'");
    const net = network(); await drainPushNotifications({ now, network: net }); expect(net.calls()).toBe(1);
    expect((await table("notification_attempts"))[0].resolved_target).toContain("message=second"); expect(await table("notification_decisions")).toHaveLength(1);
  });
  it.each(["revoked", "read", "retargeted", "subscription", "configuration"])("rechecks %s immediately before I/O and cancels unsent attempts", async change => {
    await message("first"); if (change === "retargeted") await message("second");
    const original = subscriptions.getPushSubscriptionForDelivery;
    vi.spyOn(subscriptions, "getPushSubscriptionForDelivery").mockImplementationOnce(async input => {
      const captured = await original(input);
      if (change === "revoked") await revokeNotificationDevice({ deviceId: device.id, now });
      if (change === "read") await execute("UPDATE email_messages SET is_unread=0");
      if (change === "retargeted") await execute("UPDATE email_messages SET is_unread=0 WHERE id='first'");
      if (change === "subscription") await attach();
      if (change === "configuration") { const key = keypair(); vi.stubEnv("EZRA_VAPID_PUBLIC_KEY", key.getPublicKey().toString("base64url")); vi.stubEnv("EZRA_VAPID_PRIVATE_KEY", Buffer.concat([Buffer.alloc(32), key.getPrivateKey()]).subarray(-32).toString("base64url")); }
      return captured;
    });
    const net = network(); await dispatchNotificationDelivery(await delivery(), { now, network: net }); expect(net.calls()).toBe(0);
    expect((await table("notification_deliveries"))[0].state).toBe("cancelled");
    expect((await table("notification_attempts"))[0].resolved_target).toContain("message=first");
  });
  it("caps 429 known-refusal retries at three attempts", async () => {
    await message(); const net = network(429);
    for (const at of [now, "2026-09-14T15:01:30.000Z", "2026-09-14T15:02:00.000Z", "2026-09-14T15:02:30.000Z"]) await drainPushNotifications({ now: at, network: net });
    expect(net.calls()).toBe(3); expect(await table("notification_attempts")).toHaveLength(3); expect((await table("notification_deliveries"))[0].state).toBe("failed");
  });
  it.each([404, 410])("scrubs current subscription on %s", async status => {
    await message(); await drainPushNotifications({ now, network: network(status) });
    expect((await table("notification_devices"))[0]).toMatchObject({ push: 0, subscription_ciphertext: null });
    expect((await table("notification_deliveries"))[0].state).toBe("expired");
  });
  it.each([201, 410, 429])("late %s cannot scrub, revive or retry a replacement subscription", async status => {
    await message(); const net = network(status, true), pending = dispatchNotificationDelivery(await delivery(), { now, network: net });
    await until(() => net.releases.length === 1); await attach(); const current = (await table("notification_devices"))[0].subscription_ciphertext;
    net.releases[0](); await pending;
    expect((await table("notification_devices"))[0]).toMatchObject({ push: 1, subscription_ciphertext: current });
    expect((await table("notification_deliveries"))[0].state).not.toBe("pending");
    await drainPushNotifications({ now: "2026-09-14T15:03:00.000Z", network: net }); expect(net.calls()).toBe(1);
  });
  it("late accepted response cannot revive revoked enrollment", async () => {
    await message(); const net = network(201, true), pending = dispatchNotificationDelivery(await delivery(), { now, network: net });
    await until(() => net.releases.length === 1); await revokeNotificationDevice({ deviceId: device.id, now }); const revoked = (await table("notification_devices"))[0]; net.releases[0](); await pending;
    expect((await table("notification_devices"))[0]).toEqual(revoked); expect(revoked).toMatchObject({ revoked_at: now, subscription_ciphertext: null }); expect((await table("notification_deliveries"))[0].state).toBe("cancelled");
  });
  it("recovers crash-after-claim as unknown and never replays it", async () => {
    await message(); await claimGovernedNotification({ deliveryId: await delivery(), deviceId: device.id, generation: 1, channel: "push", now });
    const net = network(); await drainPushNotifications({ now: "2026-09-14T15:03:01.000Z", network: net });
    expect(net.calls()).toBe(0); expect((await table("notification_attempts"))[0].outcome).toBe("unknown"); expect((await table("notification_deliveries"))[0].state).toBe("unknown");
  });
});

// The worker must retain a live clock through a slow notification lane.
import { runNotificationWork } from "@/lib/email/notification-worker";
import * as pushTransport from "@/lib/email/notification-web-push";
it("worker cancels an event that expires during preparation instead of freezing tick time", async () => {
  await message(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
  const getSubscription = subscriptions.getPushSubscriptionForDelivery;
  vi.spyOn(subscriptions, "getPushSubscriptionForDelivery").mockImplementationOnce(async input => {
    const captured = await getSubscription(input); vi.setSystemTime(new Date("2026-09-16T15:01:00.000Z")); return captured;
  });
  const net = network(), send = pushTransport.sendPushRequest;
  vi.spyOn(pushTransport, "sendPushRequest").mockImplementation((details, _boundary, at) => send(details, net, at));
  try { await runNotificationWork(); expect(net.calls()).toBe(0); expect((await table("notification_deliveries"))[0].state).toBe("cancelled"); }
  finally { vi.useRealTimers(); }
});

it.each(["generic", "detailed"] as const)("sends only the selected %s copy and safe protocol fields", async privacy => {
  await execute("UPDATE notification_devices SET privacy=? WHERE id=?", [privacy, device.id]); await message();
  const prepare = pushTransport.createPushRequest, payloads: unknown[] = [];
  vi.spyOn(pushTransport, "createPushRequest").mockImplementation(input => { payloads.push(input.payload); return prepare(input); });
  const net = network(); await drainPushNotifications({ now, network: net }); expect(net.calls()).toBe(1);
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({ version: 1, generation: 1, kind: "interrupt", title: privacy === "generic" ? "Ezra Mail" : "Private sender", body: privacy === "generic" ? "Open Ezra Mail to review new attention." : "Private subject" });
  expect(Object.keys(payloads[0] as object).sort()).toEqual(["attemptId", "body", "deviceId", "eventId", "expiresAt", "generation", "kind", "tag", "target", "title", "version"]);
  expect(JSON.stringify(payloads)).not.toMatch(/private@example|Private body|Private summary|endpoint|vapid|keys/);
});
it("scrubs revoked subscriptions before dispatching another live device", async () => {
  const revoked = await enroll(); await message(); await execute("UPDATE trusted_devices SET revoked_at=? WHERE id=?", [now, revoked.trustedDeviceId]);
  const net = network(); await drainPushNotifications({ now, network: net }); expect(net.calls()).toBe(1);
  expect((await table("notification_devices")).find(row => row.id === revoked.id)?.subscription_ciphertext).toBeNull();
});
it("persists reset outcomes as sanitized unknown without replay", async () => {
  await message(); let calls = 0;
  const request = (() => { calls++; const req = Object.assign(new EventEmitter(), { destroy() {}, end() { queueMicrotask(() => req.emit("error", new Error("secret endpoint body header"))); } }); return req; }) as unknown as typeof httpsRequest;
  await drainPushNotifications({ now, network: { request } });
  await drainPushNotifications({ now: "2026-09-14T15:02:00.000Z", network: { request } });
  expect(calls).toBe(1); expect((await table("notification_attempts"))[0]).toMatchObject({ outcome: "unknown", error_code: "transport_unknown" });
  expect(JSON.stringify(await table("notification_attempts"))).not.toMatch(/secret|endpoint|header/);
});

import { createManualNotificationBrief } from "@/lib/email/notification-schedule";
it("dispatches shared manual brief evidence to immutable Today without recharging individual admission", async () => {
  await message(); await execute("UPDATE triage_decisions SET attention='digest',urgency=70,category='personal'");
  const brief = await createManualNotificationBrief(now); expect(brief.eventId).not.toBeNull();
  const net = network(); await drainPushNotifications({ now, network: net });
  expect(net.calls()).toBe(1); expect((await table("notification_attempts"))[0].resolved_target).toBe("/?view=today");
  expect(await table("notification_decisions")).toHaveLength(1);
});

import * as governor from "@/lib/email/notification-governor";
it("computes relay TTL after the final eligibility transaction", async () => {
  await message(); await execute("UPDATE notification_events SET expires_at='2026-09-14T15:01:45.000Z'");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
  const resolve = governor.resolveNotificationEventForClaim; let checks = 0;
  vi.spyOn(governor, "resolveNotificationEventForClaim").mockImplementation(async (tx, input) => {
    const result = await resolve(tx, input); if (++checks === 2) vi.setSystemTime(new Date("2026-09-14T15:01:30.000Z")); return result;
  });
  let ttl: unknown; const net = network();
  const request = ((options: Parameters<typeof httpsRequest>[0], callback: Parameters<typeof httpsRequest>[1]) => {
    ttl = (options as unknown as { headers: Record<string, unknown> }).headers.TTL; return net.request(options as never, callback as never);
  }) as typeof httpsRequest;
  try { await dispatchNotificationDelivery(await delivery(), { network: { request } }); expect(ttl).toBe(15); }
  finally { vi.useRealTimers(); }
});

import * as store from "@/lib/email/notification-store";
import type { Transaction } from "@libsql/client";
it("uses current quiet-hour time after waiting to acquire final authorization", async () => {
  await message(); await setSetting("quiet_start", "10:02"); await setSetting("quiet_end", "11:00");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
  const getSubscription = subscriptions.getPushSubscriptionForDelivery, write = store.withNotificationStoreWrite;
  vi.spyOn(subscriptions, "getPushSubscriptionForDelivery").mockImplementationOnce(async input => {
    const captured = await getSubscription(input);
    // Model time elapsed while the final store transaction waits for its lock.
    vi.spyOn(store, "withNotificationStoreWrite").mockImplementationOnce(async <T>(operation: (tx: Transaction) => Promise<T>): Promise<T> => {
      vi.setSystemTime(new Date("2026-09-14T15:02:00.000Z")); return write(operation);
    });
    return captured;
  });
  const net = network();
  try { await dispatchNotificationDelivery(await delivery(), { network: net }); expect(net.calls()).toBe(0); expect((await table("notification_deliveries"))[0]).toMatchObject({ state: "cancelled", cancellation_reason: "quiet_hours" }); }
  finally { vi.useRealTimers(); }
});

it.each([429, 503])("honors the complete Retry-After delay after a slow %s response with the live clock", async status => {
  await message(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
  const net = network(status, true, "60");
  try {
    const pending = dispatchNotificationDelivery(await delivery(), { network: net });
    await until(() => net.releases.length === 1);
    vi.setSystemTime(new Date("2026-09-14T15:01:10.000Z")); net.releases[0](); await pending;
    expect((await table("notification_deliveries"))[0]).toMatchObject({ state: "pending", next_attempt_at: "2026-09-14T15:02:10.000Z", attempt_count: 1 });
    const retry = network();
    vi.setSystemTime(new Date("2026-09-14T15:02:09.000Z")); await drainPushNotifications({ network: retry });
    expect(retry.calls()).toBe(0); expect(await table("notification_attempts")).toHaveLength(1);
    vi.setSystemTime(new Date("2026-09-14T15:02:10.000Z")); await drainPushNotifications({ network: retry });
    expect(retry.calls()).toBe(1); expect((await table("notification_deliveries"))[0]).toMatchObject({ state: "accepted", attempt_count: 2 });
  } finally { vi.useRealTimers(); }
});

import { enrollBrowserNotification } from "@/lib/email/notification-enrollment";
it("shares ten reservations and two transports across browser and Telegram",async()=>{
  vi.stubEnv("TELEGRAM_BOT_TOKEN","123456:synthetic");vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID","123456789");
  const telegram=await enrollBrowserNotification({trustedDeviceId:device.trustedDeviceId,origin},{channel:"telegram",platform:"other",permission:"granted",capabilities:{foreground:false,push:false}});
  for(let i=0;i<10;i++)await enroll();await message();await execute("UPDATE notification_deliveries SET id='000telegram' WHERE device_id=?",[telegram.device.id]);
  let active=0,peak=0,calls=0,telegramCalls=0;const releases:(()=>void)[]=[];
  const request=((options:{hostname:string},receive:(value:unknown)=>void)=>{active++;calls++;peak=Math.max(peak,active);const tg=options.hostname==="api.telegram.org";if(tg)telegramCalls++;
    return Object.assign(new EventEmitter(),{destroy(){},end(){releases.push(()=>{active--;const response=Object.assign(new EventEmitter(),{statusCode:tg?200:410,headers:{},complete:true,destroy(){}});receive(response);if(tg)response.emit("data",Buffer.from(JSON.stringify({ok:true,result:{message_id:41}})));response.emit("end");});}});
  }) as unknown as typeof httpsRequest;
  const pending=drainPushNotifications({now,network:{request},telegramNetwork:{request}});
  for(let i=0;i<5;i++){await until(()=>releases.length===2);releases.splice(0).forEach(release=>release());}await pending;
  expect(calls).toBe(10);expect(peak).toBe(2);expect(telegramCalls).toBe(1);expect((await table("notification_deliveries")).filter(r=>r.state==="pending")).toHaveLength(2);
  expect((await table("notification_deliveries")).find(r=>r.device_id===telegram.device.id)?.state).toBe("accepted");expect(await table("notification_receipts")).toHaveLength(0);
});

it.each(["before_claim", "after_capture"])("rejects removed push origin %s without sending", async phase => {
  vi.stubEnv("APP_BASE_URL", origin); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "");
  await message(); const id = await delivery(), net = network();
  if (phase === "before_claim") vi.stubEnv("APP_BASE_URL", "https://new.example.test");
  else {
    const original = subscriptions.getPushSubscriptionForDelivery;
    vi.spyOn(subscriptions, "getPushSubscriptionForDelivery").mockImplementationOnce(async (...args) => {
      const captured = await original(...args);
      vi.stubEnv("APP_BASE_URL", "https://new.example.test");
      return captured;
    });
  }
  await dispatchNotificationDelivery(id, { now, network: net });
  expect(net.calls()).toBe(0);
  if (phase === "after_capture") expect((await table("notification_deliveries"))[0].state).toBe("cancelled");
});
