import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { claimNotificationDelivery } from "./helpers/notification-ledger";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EMAIL_SCHEMA_VERSION, configureEmailDatabaseForTests, closeEmailDatabaseForTests, ensureEmailDatabase, execute, getEmailClient } from "@/lib/email/database";

const now = "2026-09-14T12:00:00.000Z";
let url: string;
beforeEach(async () => {
  vi.stubEnv("APP_BASE_URL", "https://ezra.example.test"); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "");
  vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "true");
  url = configureEmailDatabaseForTests(`file:./notification-store-${randomUUID()}.sqlite`);
  await ensureEmailDatabase();
});
afterEach(() => { vi.unstubAllEnvs(); closeEmailDatabaseForTests(); });

describe("notification schema", () => {
  it("adds v4/v5 ledgers without importing legacy decisions and preserves it on restart", async () => {
    expect((await execute("PRAGMA user_version")).rows[0].user_version).toBe(EMAIL_SCHEMA_VERSION);
    await execute("INSERT INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES ('trust','Synthetic','hash',?,?)", [now, now]);
    configureEmailDatabaseForTests(url);
    await ensureEmailDatabase();
    expect((await execute("PRAGMA user_version")).rows[0].user_version).toBe(EMAIL_SCHEMA_VERSION);
    expect((await execute("SELECT id FROM trusted_devices")).rows[0].id).toBe("trust");
    expect((await execute("SELECT * FROM notification_events")).rows).toEqual([]);
  });
  it("rolls back all v4 additions on DDL failure and leaves version 3 for a retry", async () => {
    const client = getEmailClient();
    for (const table of ["notification_feedback", "notification_receipts", "notification_attempts", "notification_deliveries", "notification_events", "notification_devices"]) await client.execute(`DROP TABLE IF EXISTS ${table}`);
    await client.execute("PRAGMA user_version = 3");
    await client.execute("CREATE TABLE notification_deliveries (broken TEXT)");
    configureEmailDatabaseForTests(url);
    await expect(ensureEmailDatabase()).rejects.toThrow();
    expect((await getEmailClient().execute("PRAGMA user_version")).rows[0].user_version).toBe(3);
    expect((await getEmailClient().execute("SELECT name FROM sqlite_master WHERE name = 'notification_devices'")).rows).toEqual([]);
    await getEmailClient().execute("DROP TABLE notification_deliveries");
    await ensureEmailDatabase();
    expect((await execute("PRAGMA user_version")).rows[0].user_version).toBe(EMAIL_SCHEMA_VERSION);
    await execute("PRAGMA user_version = 5");
    configureEmailDatabaseForTests(url);
    await ensureEmailDatabase();
    expect((await execute("PRAGMA user_version")).rows[0].user_version).toBe(EMAIL_SCHEMA_VERSION);
  });
});

async function store() {
  return { ...await import("@/lib/email/notification-store"), claimNotificationDelivery };
}
async function trust(id = "trust") {
  await execute("INSERT OR IGNORE INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES (?,'Synthetic',?,?,?)", [id, id, now, now]);
}
async function enroll(trustedDeviceId = "trust", origin = "https://ezra.example.test") {
  await trust(trustedDeviceId);
  return (await store()).enrollNotificationDevice({ expectedSetupEpoch: 0, trustedDeviceId, origin, channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push: true }, now });
}
async function event(sourceKey = "source-1", overrides = {}) {
  return (await store()).createNotificationEvent({ sourceKey, kind: "interrupt", target: "/?view=mail&workspace=workspace%3Aaccount%3Agmail%3Aaccount-1&message=message-1", replacementTag: "tag-1", reasonCode: "attention", createdAt: now, notBefore: now, expiresAt: "2026-09-14T13:00:00.000Z", ...overrides });
}
async function reservation() {
  const device = await enroll();
  const created = await event();
  const [delivery] = await (await store()).enqueueNotificationDeliveries({ eventId: created.id, now });
  return { device, created, delivery };
}
async function state(id: string) {
  return (await execute("SELECT * FROM notification_deliveries WHERE id = ?", [id])).rows[0];
}

describe("shared notification delivery store", () => {
  it("enrolls explicitly above the existing event baseline without legacy replay", async () => {
    const s = await store();
    const old = await event();
    const device = await enroll();
    expect(device.baselineSequence).toBe(old.sequence);
    expect(device.generation).toBe(1);
    expect(await s.enqueueNotificationDeliveries({ eventId: old.id, now })).toEqual([]);
    const fresh = await event("source-2");
    expect(await s.enqueueNotificationDeliveries({ eventId: fresh.id, now })).toHaveLength(1);
    const rotated = await enroll();
    expect(rotated.id).toBe(device.id);
    expect(rotated.generation).toBe(2);
    expect((await execute("SELECT state FROM notification_deliveries")).rows[0].state).toBe("cancelled");
    expect(await s.enqueueNotificationDeliveries({ eventId: fresh.id, now })).toEqual([]);
  });
  it("deduplicates simultaneous immutable events, reservations, and competing transports", async () => {
    const s = await store();
    const device = await enroll();
    const events = await Promise.all([event(), event()]);
    expect(events[0]).toEqual(events[1]);
    expect(await event("source-1", { target: "/?view=today" })).toEqual(events[0]);
    await Promise.all([s.enqueueNotificationDeliveries({ eventId: events[0].id, now }), s.enqueueNotificationDeliveries({ eventId: events[0].id, now })]);
    const rows = (await execute("SELECT id FROM notification_deliveries")).rows;
    expect(rows).toHaveLength(1);
    const claims = await Promise.all([s.claimNotificationDelivery({ deliveryId: String(rows[0].id), channel: "foreground", now }), s.claimNotificationDelivery({ deliveryId: String(rows[0].id), channel: "push", now })]);
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.device.id).toBe(device.id);
    expect((await execute("SELECT * FROM notification_attempts")).rows).toHaveLength(1);
    expect((await state(String(rows[0].id))).attempt_count).toBe(1);
  });
  it("scrubs revoked trust and blocks claims even before the cleanup pass", async () => {
    const s = await store();
    const { device, delivery } = await reservation();
    await execute("UPDATE notification_devices SET subscription_ciphertext='opaque-envelope', subscription_fingerprint='opaque-fingerprint'");
    await execute("UPDATE trusted_devices SET revoked_at = ?", [now]);
    expect(await s.claimNotificationDelivery({ deliveryId: delivery.id, channel: "push", now })).toBeNull();
    await s.purgeRevokedNotificationDevices({ now });
    expect((await state(delivery.id)).state).toBe("cancelled");
    expect((await execute("SELECT subscription_ciphertext,subscription_fingerprint,revoked_at FROM notification_devices WHERE id=?", [device.id])).rows[0]).toEqual({ subscription_ciphertext: null, subscription_fingerprint: null, revoked_at: now });
    await expect(enroll()).rejects.toThrow();
  });
  it("revokes idempotently and never exposes subscription material in public DTOs", async () => {
    const s = await store();
    const { device, delivery } = await reservation();
    await execute("UPDATE notification_devices SET subscription_ciphertext='opaque-envelope', subscription_fingerprint='opaque-fingerprint'");
    const inventory = await s.listNotificationDevices();
    expect(JSON.stringify(inventory)).not.toMatch(/ciphertext|fingerprint|opaque-envelope|opaque-fingerprint/);
    expect(JSON.stringify(device)).not.toMatch(/ciphertext|fingerprint/);
    await s.revokeNotificationDevice({ deviceId: device.id, now });
    await s.revokeNotificationDevice({ deviceId: device.id, now: "2026-09-14T12:01:00.000Z" });
    expect((await execute("SELECT revoked_at,updated_at FROM notification_devices WHERE id=?", [device.id])).rows[0]).toEqual({ revoked_at: now, updated_at: now });
    expect((await state(delivery.id)).state).toBe("cancelled");
    expect((await execute("SELECT subscription_ciphertext FROM notification_devices")).rows[0].subscription_ciphertext).toBeNull();
  });
  it("invalidates old claims and receipts on explicit rotation", async () => {
    const s = await store();
    const { device, delivery } = await reservation();
    const claim = (await s.claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground", now }))!;
    await enroll();
    expect(await s.finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "accepted", now })).toBeNull();
    expect(await s.recordNotificationReceipt({ deviceId: device.id, attemptId: claim.attempt.id, generation: 1, kind: "clicked", now })).toBeNull();
    expect((await state(delivery.id)).state).toBe("cancelled");
    expect((await s.listNotificationDevices())[0].generation).toBe(2);
  });
  it("keeps acceptance separate from idempotent display/click receipts and rejects regression", async () => {
    const s = await store();
    const { device, delivery } = await reservation();
    const claim = (await s.claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground", now }))!;
    const receipt = { deviceId: device.id, attemptId: claim.attempt.id, generation: device.generation, now };
    expect(await s.recordNotificationReceipt({ ...receipt, kind: "displayed" })).toBeNull();
    await s.finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "accepted", now });
    expect((await state(delivery.id)).state).toBe("accepted");
    await s.recordNotificationReceipt({ ...receipt, kind: "displayed" });
    await s.recordNotificationReceipt({ ...receipt, kind: "displayed" });
    expect((await state(delivery.id)).state).toBe("displayed");
    await s.recordNotificationReceipt({ ...receipt, kind: "clicked" });
    await s.recordNotificationReceipt({ ...receipt, kind: "displayed" });
    expect((await state(delivery.id)).state).toBe("clicked");
    expect((await execute("SELECT * FROM notification_receipts")).rows).toHaveLength(2);
    expect(await s.finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "failed", errorCode: "rejected", now })).toBeNull();
    await s.revokeNotificationDevice({ deviceId: device.id, now });
    expect(await s.recordNotificationReceipt({ ...receipt, kind: "clicked" })).toBeNull();
  });
  it("retries only explicit rejection with bounded future backoff and caps attempts at three", async () => {
    const s = await store();
    const { delivery } = await reservation();
    let time = now;
    for (let i = 0; i < 3; i++) {
      const claim = (await s.claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground", now: time }))!;
      expect(claim).not.toBeNull();
      const retryAt = new Date(Date.parse(time) + 60_000).toISOString();
      if (i === 0) {
        await expect(s.finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "failed", errorCode: "rejected", retryAt: time, now: time })).rejects.toThrow();
        await expect(s.finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "failed", errorCode: "timeout", retryAt, now: time })).rejects.toThrow();
        await expect(s.finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "failed", errorCode: "rejected", retryAt: "2026-09-15T12:00:00.000Z", now: time })).rejects.toThrow();
      }
      await s.finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "failed", errorCode: "rejected", retryAt, now: time });
      expect((await state(delivery.id)).state).toBe(i < 2 ? "pending" : "failed");
      expect(await s.claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground", now: time })).toBeNull();
      time = retryAt;
    }
    expect(await s.claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground", now: time })).toBeNull();
  });
  it("recovers interrupted claims as unknown and does not replay after restart or late acceptance", async () => {
    const s = await store();
    const { delivery } = await reservation();
    const claim = (await s.claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground", now }))!;
    configureEmailDatabaseForTests(url);
    await s.recoverNotificationAttempts({ now: "2026-09-14T12:02:01.000Z" });
    expect((await state(delivery.id)).state).toBe("unknown");
    expect(await s.claimNotificationDelivery({ deliveryId: delivery.id, channel: "push", now: "2026-09-14T12:03:00.000Z" })).toBeNull();
    expect(await s.finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "accepted", now: "2026-09-14T12:03:00.000Z" })).toBeNull();
  });
  it("enforces origin, capabilities, not-before, in-app exclusion and expiry", async () => {
    const s = await store();
    const device = await enroll();
    await enroll("other-trust", "https://other.example.test");
    const created = await event("delayed", { origin: device.origin, notBefore: "2026-09-14T12:01:00.000Z" });
    const deliveries = await s.enqueueNotificationDeliveries({ eventId: created.id, now });
    expect(deliveries).toHaveLength(1);
    expect(await s.claimNotificationDelivery({ deliveryId: deliveries[0].id, channel: "foreground", now })).toBeNull();
    expect(await s.claimNotificationDelivery({ deliveryId: deliveries[0].id, channel: "telegram", now: "2026-09-14T12:02:00.000Z" })).toBeNull();
    const inApp = await event("in-app", { kind: "in_app" });
    expect(await s.enqueueNotificationDeliveries({ eventId: inApp.id, now })).toEqual([]);
    const expired = await event("expired");
    expect(await s.enqueueNotificationDeliveries({ eventId: expired.id, now: "2026-09-14T13:00:00.000Z" })).toEqual([]);
    await s.recoverNotificationAttempts({ now: "2026-09-14T13:00:00.000Z" });
    expect((await state(deliveries[0].id)).state).toBe("expired");
    expect(await s.claimNotificationDelivery({ deliveryId: deliveries[0].id, channel: "push", now: "2026-09-14T13:00:00.000Z" })).toBeNull();
  });
  it("allows only delivery owners to update local feedback", async () => {
    const s = await store();
    const { device, created } = await reservation();
    const other = await enroll("other-trust");
    expect(await s.recordNotificationFeedback({ deviceId: other.id, eventId: created.id, kind: "useful", now })).toBeNull();
    await s.recordNotificationFeedback({ deviceId: device.id, eventId: created.id, kind: "useful", now });
    await s.recordNotificationFeedback({ deviceId: device.id, eventId: created.id, kind: "too_noisy", now });
    expect((await execute("SELECT kind FROM notification_feedback")).rows).toEqual([{ kind: "too_noisy" }]);
    expect((await execute("SELECT * FROM email_messages")).rows).toEqual([]);
    expect((await execute("SELECT * FROM outgoing_drafts")).rows).toEqual([]);
    await s.revokeNotificationDevice({ deviceId: device.id, now });
    expect(await s.recordNotificationFeedback({ deviceId: device.id, eventId: created.id, kind: "useful", now })).toBeNull();
  });
  it("rejects private text, malformed targets, unbounded codes and invalid timestamps", async () => {
    const s = await store();
    for (const target of ["https://evil.test", "//evil.test", "/?view=mail&message=message-1", "/?view=today&detail=unexpected", "/?view=mail&message=one&message=two&account=a", "/?view=today#secret"]) await expect(event(randomUUID(), { target })).rejects.toThrow();
    for (const invalid of [{ sourceKey: "mail subject text" }, { reasonCode: "secret subject" }, { createdAt: "not-date" }, { expiresAt: now }, { replacementTag: "secret subject" }, { title: "private text" }]) await expect(event(randomUUID(), invalid)).rejects.toThrow();
    await expect(s.enrollNotificationDevice({ expectedSetupEpoch: 0, trustedDeviceId: "missing", origin: "https://ezra.example.test", channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push: false }, now })).rejects.toThrow();
  });
});

it("rejects authority or privacy bypasses and stores only bounded transport status", async () => {
  const s = await store();
  const { device, delivery } = await reservation();
  for (const changes of [
    { origin: "https://ezra.example.test/" }, { origin: "https://user:pass@ezra.example.test" },
    { platform: "unbounded-value" }, { permission: "yes" }, { capabilities: { foreground: true, push: true, arbitrary: true } },
    { channel: "telegram" }, { privacy: "detailed" },
  ]) {
    await expect(s.enrollNotificationDevice({ expectedSetupEpoch: 0, trustedDeviceId: "trust", origin: device.origin, channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push: true }, now, ...changes } as Parameters<typeof s.enrollNotificationDevice>[0])).rejects.toThrow();
  }
  const claim = (await s.claimNotificationDelivery({ deliveryId: delivery.id, channel: "push", now }))!;
  await expect(s.finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "failed", errorCode: "secret-provider-url" as never, now })).rejects.toThrow();
  await expect(s.finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "accepted", externalId: "https://secret.test/token", now })).rejects.toThrow();
  await s.finishNotificationAttempt({ attemptId: claim.attempt.id, outcome: "unknown", errorCode: "transport_unknown", now });
  expect((await s.listNotificationDevices())[0]).toMatchObject({ lastSuccessAt: null, lastFailureAt: now, lastErrorCode: "transport_unknown" });
  expect(await s.claimNotificationDelivery({ deliveryId: delivery.id, channel: "foreground", now })).toBeNull();
  const next = await event("next");
  const [nextDelivery] = await s.enqueueNotificationDeliveries({ eventId: next.id, now });
  const accepted = (await s.claimNotificationDelivery({ deliveryId: nextDelivery.id, channel: "foreground", now }))!;
  await s.finishNotificationAttempt({ attemptId: accepted.attempt.id, outcome: "accepted", now });
  expect((await s.listNotificationDevices())[0].lastSuccessAt).toBe(now);
  await enroll();
  expect(await s.recordNotificationReceipt({ deviceId: device.id, attemptId: accepted.attempt.id, generation: 1, kind: "clicked", now })).toBeNull();
});

it("enforces closed states and foreign keys at the database boundary", async () => {
  const { device, delivery } = await reservation();
  await expect(execute("UPDATE notification_devices SET privacy='secret' WHERE id=?", [device.id])).rejects.toThrow();
  await expect(execute("UPDATE notification_devices SET foreground=2 WHERE id=?", [device.id])).rejects.toThrow();
  await expect(execute("UPDATE notification_deliveries SET state='sent' WHERE id=?", [delivery.id])).rejects.toThrow();
  await expect(execute("UPDATE notification_deliveries SET attempt_count=4 WHERE id=?", [delivery.id])).rejects.toThrow();
  await expect(execute("UPDATE notification_deliveries SET event_id='missing' WHERE id=?", [delivery.id])).rejects.toThrow();
});

it("shares one reservation while independent processes compete for a claim", async () => {
  const { spawn } = await import("node:child_process");
  const { delivery } = await reservation();
  const workers = ["foreground", "push"].map((channel) => {
    const script = `
      const store = require('./tests/helpers/notification-ledger.ts');
      const db = require('./src/lib/email/database.ts');
      db.ensureEmailDatabase().then(() => {
        process.once('message', async () => {
          try {
            const claim = await store.claimNotificationDelivery(${JSON.stringify({ deliveryId: delivery.id, channel, now })});
            process.send({ winner: Boolean(claim) });
            await db.closeEmailDatabaseForTests();
            process.disconnect();
          } catch(error) { console.error(error); process.exit(1); }
        });
        process.send({ ready: true });
      }).catch(error => { console.error(error); process.exit(1); });
    `;
    return observeClaimWorker(spawn(process.execPath, ["--import", "tsx", "-e", script], { env: { ...process.env, EZRA_EMAIL_DATABASE_URL: url }, stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  });
  try {
    await Promise.all(workers.map(worker => worker.ready));
    for (const worker of workers) worker.child.send({ claim: true });
    const outcomes = await Promise.all(workers.map(worker => worker.result));
    for (const outcome of outcomes) if ("error" in outcome) throw outcome.error;
    expect(outcomes.filter(outcome => "winner" in outcome && outcome.winner)).toHaveLength(1);
    expect((await state(delivery.id)).attempt_count).toBe(1);
    expect((await execute("SELECT * FROM notification_attempts")).rows).toHaveLength(1);
  } finally {
    for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(workers.map(worker => worker.closed));
  }
}, 20_000);

it("preserves synthetic legacy decisions and notifications without migrating them into deliveries", async () => {
  await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES ('legacy-account','gmail','synthetic@example.test','Synthetic','connected',?,?)", [now, now]);
  await execute("INSERT INTO email_messages (id,account_id,external_message_id,thread_id,sender_name,sender_email,subject,received_at,snippet,gmail_url,created_at,updated_at) VALUES ('legacy-message','legacy-account','external-1','thread-1','Synthetic','synthetic@example.test','Synthetic',?,'Synthetic','',?,?)", [now, now, now]);
  await execute("INSERT INTO notification_decisions (id,message_id,reason,decided_at) VALUES ('legacy-decision','legacy-message','synthetic',?)", [now]);
  await execute("INSERT INTO notifications (id,message_id,channel,kind,status,created_at) VALUES ('legacy-notification','legacy-message','browser','interrupt','sent',?)", [now]);
  const legacy = (await execute("SELECT * FROM notification_decisions")).rows;
  const notifications = (await execute("SELECT * FROM notifications")).rows;
  for (const table of ["notification_feedback", "notification_receipts", "notification_attempts", "notification_deliveries", "notification_events", "notification_devices"]) await execute(`DROP TABLE ${table}`);
  await execute("PRAGMA user_version=3");
  configureEmailDatabaseForTests(url);
  await ensureEmailDatabase();
  expect((await execute("SELECT * FROM notification_decisions")).rows).toEqual(legacy);
  expect((await execute("SELECT * FROM notifications")).rows).toEqual(notifications);
  expect((await execute("SELECT * FROM notification_events")).rows).toEqual([]);
  await enroll();
  const linked = await event("linked", { decisionId: "legacy-decision" });
  expect(linked.decisionId).toBe("legacy-decision");
  await expect(event("missing-decision", { decisionId: "missing-decision" })).rejects.toThrow();
});

it("respects explicit Telegram enrollment, disabled browser capability and denied permission", async () => {
  const s = await store();
  await trust();
  const base = { trustedDeviceId: "trust", origin: "https://ezra.example.test", platform: "other" as const, permission: "granted" as const, capabilities: { foreground: false, push: false }, now };
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:synthetic"); vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID", "123456789");
  const { readTelegramConfiguration } = await import("@/lib/email/notification-telegram-config");
  const telegram = await s.enrollNotificationDevice({ ...base, channel: "telegram", telegramBindingFingerprint: readTelegramConfiguration()!.fingerprint });
  await s.enrollNotificationDevice({ expectedSetupEpoch: 0, ...base, channel: "browser" });
  const created = await event();
  const rows = await s.enqueueNotificationDeliveries({ eventId: created.id, now });
  expect(rows).toHaveLength(1);
  expect(rows[0].deviceId).toBe(telegram.id);
  expect(await s.claimNotificationDelivery({ deliveryId: rows[0].id, channel: "foreground", now })).toBeNull();
  expect(await s.claimNotificationDelivery({ deliveryId: rows[0].id, channel: "telegram", now })).not.toBeNull();
  await s.enrollNotificationDevice({ ...base, channel: "telegram", permission: "denied" });
  const fresh = await event("later");
  expect(await s.enqueueNotificationDeliveries({ eventId: fresh.id, now })).toEqual([]);
});


type ClaimWorkerResult = { winner: boolean } | { error: Error };
function observeClaimWorker(child: ChildProcess) {
  let errors = "", readyReceived = false, winner: boolean | undefined, failure: Error | undefined;
  let resolveReady: () => void, rejectReady: (error: Error) => void;
  let resolveResult: (result: ClaimWorkerResult) => void, resolveClosed: () => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Completion is observed immediately, even if initialization rejects readiness.
  const result = new Promise<ClaimWorkerResult>(resolve => { resolveResult = resolve; });
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const stderr = (chunk: Buffer | string) => { errors = (errors + String(chunk)).slice(-4000); };
  const message = (value: unknown) => {
    if (typeof value !== "object" || !value) return;
    if ("ready" in value && value.ready === true) { readyReceived = true; resolveReady(); }
    if ("winner" in value && typeof value.winner === "boolean") winner = value.winner;
  };
  const error = (value: Error) => { failure = value; rejectReady(value); };
  const exit = (code: number | null) => {
    if (code !== 0 || !readyReceived) error(new Error(errors || "Claim worker exited before completion"));
  };
  const close = (code: number | null) => {
    if (!readyReceived || code !== 0 || winner === undefined) failure ??= new Error(errors || "Claim worker exited before completion");
    if (failure) rejectReady(failure);
    resolveResult(failure ? { error: failure } : { winner: winner! });
    child.stderr!.off("data", stderr);
    child.off("message", message); child.off("error", error); child.off("exit", exit); child.off("close", close);
    resolveClosed();
  };
  child.stderr!.on("data", stderr);
  child.on("message", message); child.on("error", error); child.on("exit", exit); child.on("close", close);
  return { child, ready, result, closed };
}

it("observes claim worker initialization failure with diagnostics until process cleanup", async () => {
  const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() }) as unknown as ChildProcess;
  const worker = observeClaimWorker(child);
  const readiness = expect(worker.ready).rejects.toThrow("Synthetic initialization failure");
  const result = expect(worker.result).resolves.toMatchObject({ error: expect.objectContaining({ message: "Synthetic initialization failure" }) });
  child.stderr!.emit("data", "Synthetic initialization failure");
  child.emit("exit", 1, null);
  child.emit("close", 1, null);
  await Promise.all([readiness, result, worker.closed]);
});

it("requires successful process exit after a claim worker reports a result", async () => {
  const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() }) as unknown as ChildProcess;
  const worker = observeClaimWorker(child);
  let settled = false;
  void worker.result.then(() => { settled = true; });
  child.emit("message", { ready: true });
  await worker.ready;
  child.emit("message", { winner: true });
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  await expect(worker.result).resolves.toEqual({ winner: true });
  await worker.closed;
});
