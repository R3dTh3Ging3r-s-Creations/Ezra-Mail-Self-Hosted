import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_SCHEMA_VERSION, configureEmailDatabaseForTests, closeEmailDatabaseForTests, ensureEmailDatabase, execute, setSetting } from "@/lib/email/database";
import { enrollNotificationDevice } from "@/lib/email/notification-store";
import { runNotificationSchedule } from "@/lib/email/notification-schedule";
import { decideMessageNotification } from "@/lib/email/notification-governor";
import { claimGovernedNotification } from "@/lib/email/notification-claims";

const now = "2026-09-14T15:00:00.000Z";
const due = "2026-09-14T15:01:00.000Z";
let databaseUrl: string;
let deviceId: string;
beforeEach(async () => {
  vi.stubEnv("APP_BASE_URL", "https://ezra.example.test"); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "");
  process.env.EZRA_BROWSER_NOTIFICATIONS_ENABLED = "true";
  databaseUrl = configureEmailDatabaseForTests(`file:./notification-governor-${randomUUID()}.sqlite`);
  await ensureEmailDatabase();
  for (const id of ["a", "b"]) await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES (?,'gmail',?,'Synthetic','connected',?,?)", [id, `${id}@example.test`, now, now]);
  await execute("INSERT INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES ('trust','Synthetic','hash',?,?)", [now, now]);
  deviceId = (await enrollNotificationDevice({ expectedSetupEpoch: 0, trustedDeviceId: "trust", origin: "https://ezra.example.test", channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push: false }, now })).id;
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); delete process.env.EZRA_BROWSER_NOTIFICATIONS_ENABLED; closeEmailDatabaseForTests(); });
async function message(id: string, options: { account?: string; thread?: string; sender?: string; category?: string; received?: string } = {}) {
  await execute(`INSERT INTO email_messages (id,account_id,external_message_id,thread_id,sender_name,sender_email,subject,received_at,snippet,gmail_url,is_unread,status,created_at,updated_at) VALUES (?,?,?,?,'Private sender',?,'Private subject',?,'Private body','',1,'triaged',?,?)`, [id, options.account || "a", id, options.thread || id, options.sender || `${id}@example.test`, options.received || now, now, now]);
  await execute(`INSERT INTO triage_decisions (id,message_id,model,attention,urgency,confidence,category,summary,reason,recommendation,needs_reply,created_at) VALUES (?,?,'synthetic','interrupt',95,0.95,?,'Private summary','','',0,?)`, [`triage-${id}`, id, options.category || "urgent-work", now]);
}
async function rows(table: string) { return (await execute(`SELECT * FROM ${table}`)).rows; }
async function claim(at = due, channel: "foreground" | "push" = "foreground") {
  const delivery = (await rows("notification_deliveries"))[0];
  return claimGovernedNotification({ deliveryId: String(delivery.id), deviceId, generation: 1, channel, now: at, ...(channel === "foreground" ? { foregroundOwner: { trustedDeviceId: "trust", origin: "https://ezra.example.test", deviceId, generation: 1 } } : {}) });
}

describe("transactional attention governance", () => {
  it("serializes twenty simultaneous candidates without exceeding budget or cooldown", async () => {
    for (let i = 0; i < 20; i++) await message(`m${i}`);
    await Promise.all(Array.from({ length: 20 }, (_, i) => decideMessageNotification(`m${i}`, now)));
    expect((await rows("notification_events")).filter(row => row.kind === "interrupt")).toHaveLength(1);
    expect(await rows("notification_policy_evidence")).toHaveLength(20);
    expect(await rows("notification_decisions")).toHaveLength(1);
  });
  it("caps a critical burst at two canonical events and deduplicates ingestion", async () => {
    for (let i = 0; i < 4; i++) await message(`m${i}`, { category: "fraud" });
    await Promise.all(Array.from({ length: 12 }, (_, i) => decideMessageNotification(`m${i % 4}`, now)));
    expect((await rows("notification_events")).filter(row => row.kind === "interrupt")).toHaveLength(2);
    expect(await rows("notification_policy_evidence")).toHaveLength(4);
    expect((await rows("audit_logs")).filter(row => row.action === "notification.decision.created")).toHaveLength(2);
  });
  it("groups before cooldown, charges once, and resolves a surviving exact target without changing history", async () => {
    await message("first", { thread: "thread" }); await message("second", { thread: "thread" });
    const first = await decideMessageNotification("first", now);
    const second = await decideMessageNotification("second", now);
    expect(second.eventId).toBe(first.eventId);
    expect(await rows("notification_deliveries")).toHaveLength(1);
    await execute("UPDATE email_messages SET is_unread=0 WHERE id='first'");
    const result = await claim();
    expect(result?.attempt.resolvedTarget).toContain("message=second");
    expect(result?.event.target).toContain("message=first");
    expect(await rows("notification_decisions")).toHaveLength(1);
  });
  it("does not borrow a reservation across admission criticality", async () => {
    await message("ordinary", { thread: "thread" }); await message("critical", { thread: "thread", category: "fraud" });
    const first = await decideMessageNotification("ordinary", now);
    const second = await decideMessageNotification("critical", now);
    expect(second.eventId).not.toBe(first.eventId);
    expect(await rows("notification_decisions")).toHaveLength(2);
  });
  it.each(["fraud", "urgent-work"])("cancels classification crossing from %s without rewriting admission", async category => {
    await message("m", { category }); await decideMessageNotification("m", now);
    await execute("UPDATE triage_decisions SET category=?", [category === "fraud" ? "urgent-work" : "fraud"]);
    expect(await claim()).toBeNull();
    expect((await rows("notification_deliveries"))[0].state).toBe("cancelled");
    expect(await rows("notification_attempts")).toHaveLength(0);
    expect(await rows("notification_decisions")).toHaveLength(1);
  });
  it("cancels all handled members and never reserves an expired deferral", async () => {
    await message("old", { received: "2026-09-13T15:00:30.000Z" });
    expect(await decideMessageNotification("old", now)).toMatchObject({ level: "in_app", reasonCode: "stale" });
    expect(await rows("notification_deliveries")).toHaveLength(0);
    await message("m"); await decideMessageNotification("m", now);
    await execute("UPDATE email_messages SET status='read'");
    expect(await claim()).toBeNull();
  });
  it("rolls back policy, canonical decision, event and reservation on required audit failure", async () => {
    await message("m");
    await execute("CREATE TRIGGER reject_governor_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
    await expect(decideMessageNotification("m", now)).rejects.toThrow();
    for (const table of ["notification_policy_evidence", "notification_events", "notification_decisions", "notification_deliveries"]) expect(await rows(table)).toHaveLength(0);
  });
  it("preserves historical decisions as in-app and never replays to newly enrolled devices", async () => {
    await message("m"); await execute("INSERT INTO notification_decisions (id,message_id,reason,decided_at) VALUES ('old','m','historical',?)", [now]);
    configureEmailDatabaseForTests(databaseUrl); await ensureEmailDatabase();
    expect((await execute("PRAGMA user_version")).rows[0].user_version).toBe(EMAIL_SCHEMA_VERSION);
    expect(await decideMessageNotification("m", now)).toMatchObject({ level: "in_app" });
    expect(await rows("notification_deliveries")).toHaveLength(0);
    expect((await rows("notification_decisions"))[0].id).toBe("old");
  });
  it("respects disabled browser feature, current snooze, disconnect and malformed timestamps", async () => {
    delete process.env.EZRA_BROWSER_NOTIFICATIONS_ENABLED;
    await message("disabled"); expect(await decideMessageNotification("disabled", now)).toMatchObject({ level: "in_app" });
    process.env.EZRA_BROWSER_NOTIFICATIONS_ENABLED = "true";
    await message("bad", { received: "bad" }); expect(await decideMessageNotification("bad", now)).toMatchObject({ reasonCode: "stale" });
    await message("m"); await decideMessageNotification("m", now);
    await setSetting("notification_snoozed_until", JSON.stringify("2026-09-14T16:00:00.000Z"));
    expect(await claim()).toBeNull();
    expect(JSON.stringify(await rows("notification_policy_evidence"))).not.toContain("Private");
  });
});

import { reconcileBriefMemory, updateBriefItemMemory, markBriefItemCompletedWithEvidence } from "@/lib/email/brief-memory";
import { withNotificationStoreWrite } from "@/lib/email/notification-store";
import { notificationHandledEvidence } from "@/lib/email/notification-handled";
async function memory(workspaceId = "workspace:all") {
  return (await reconcileBriefMemory({ workspaceId, now, candidates: [{ sourceType: "mail_thread", sourceKey: "mail:a:thread", sourceAccountId: "a", provider: "gmail", providerThreadId: "thread", revisionAt: now, occurredAt: now, role: "attention", title: "Synthetic", summary: "", target: { view: "mail", messageId: "m" } }] })).items[0];
}
async function handled(receivedAt = now, accountId = "a") {
  return withNotificationStoreWrite(tx => notificationHandledEvidence(tx, { accountId, provider: "gmail", threadId: "thread", receivedAt }));
}
describe("revision-aware completion evidence", () => {
  it("aggregates owner actions across workspaces with exact account identity and revision/time bounds", async () => {
    const item = await memory();
    await updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "complete", now: due });
    expect(await handled()).toEqual({ handled: true, invalid: false });
    expect(await handled(now, "b")).toEqual({ handled: false, invalid: false });
    expect(await handled("2026-09-14T15:00:30.000Z")).toEqual({ handled: true, invalid: false });
    expect(await handled("2026-09-14T15:02:00.000Z")).toEqual({ handled: false, invalid: false });
    await updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "bring_back", now: "2026-09-14T15:03:00.000Z" });
    expect(await handled()).toEqual({ handled: false, invalid: false });
    expect(await handled("2026-09-14T14:59:00.000Z")).toEqual({ handled: true, invalid: false });
    await updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "dismiss", now: "2026-09-14T15:04:00.000Z" });
    expect(await handled()).toEqual({ handled: true, invalid: false });
    expect((await rows("brief_notification_actions")).map(row => row.kind)).toEqual(["complete", "bring_back", "dismiss"]);
  });
  it("records external provider send time atomically and gives later owner restoration precedence", async () => {
    const item = await memory();
    expect(await markBriefItemCompletedWithEvidence({ workspaceId: "workspace:all", itemId: item.id, sourceKey: "mail:a:thread", accountId: "a", provider: "gmail", providerThreadId: "thread", sourceRevisionAt: now, providerMessageId: "sent", providerSentAt: due, observedAt: "2026-09-14T15:02:00.000Z" })).toBe(true);
    expect(await handled()).toEqual({ handled: true, invalid: false });
    await updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "bring_back", now: "2026-09-14T15:03:00.000Z" });
    expect(await handled()).toEqual({ handled: false, invalid: false });
    // Same old evidence observed later does not outrank the actual owner action.
    await execute(`INSERT INTO brief_notification_actions (id,source_type,source_account_id,source_key,provider,provider_thread_id,source_revision_at,effective_at,observed_at,kind) VALUES ('late','mail_thread','a','mail:a:thread','gmail','thread',?,?,?,'external')`, [now, due, "2026-09-14T16:00:00.000Z"]);
    expect(await handled()).toEqual({ handled: false, invalid: false });
    await execute("UPDATE brief_notification_actions SET effective_at=source_revision_at WHERE id='late'");
    expect(await handled()).toEqual({ handled: true, invalid: true });
  });
});

import { claimForegroundNotification } from "@/lib/email/notification-foreground";
import { getNotificationPolicyCenter } from "@/lib/email/notification-center";
import { finishNotificationAttempt, recordNotificationReceipt } from "@/lib/email/notification-store";
describe("governed consumers", () => {
  it("foreground POST returns current resolved target and details, preserving original canonical target", async () => {
    await message("first", { thread: "thread" }); await message("second", { thread: "thread" });
    await decideMessageNotification("first", now); await decideMessageNotification("second", now);
    await execute("UPDATE email_messages SET is_unread=0 WHERE id='first'");
    await execute("UPDATE email_messages SET sender_name='Current sender',subject='Current subject' WHERE id='second'");
    await execute("UPDATE notification_devices SET privacy='detailed'");
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(due));
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(due));
    const delivery = (await rows("notification_deliveries"))[0];
    const result = await claimForegroundNotification({ trustedDeviceId: "trust", origin: "https://ezra.example.test" }, { deliveryId: String(delivery.id), expectedGeneration: 1 });
    expect(result).toMatchObject({ title: "Current sender", body: "Current subject", target: expect.stringContaining("message=second") });
    expect((await rows("notification_events"))[0].target).toContain("message=first");
  });
  it("counts each event once across device acceptance and display without claiming acceptance was sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(due));
    await execute("INSERT INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES ('other','Synthetic','other',?,?)", [now, now]);
    await enrollNotificationDevice({ expectedSetupEpoch: 0, trustedDeviceId: "other", origin: "https://ezra.example.test", channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push: false }, now });
    await message("m"); await decideMessageNotification("m", now);
    for (const delivery of await rows("notification_deliveries")) {
      const c = await claimGovernedNotification({ deliveryId: String(delivery.id), deviceId: String(delivery.device_id), generation: 1, channel: "foreground", now: due });
      await finishNotificationAttempt({ attemptId: c!.attempt.id, outcome: "accepted", now: due });
      await recordNotificationReceipt({ attemptId: c!.attempt.id, deviceId: c!.device.id, generation: 1, kind: "displayed", now: due });
    }
    expect((await getNotificationPolicyCenter()).stats).toMatchObject({ interruptsSent: 0, interruptsAccepted: 0, interruptsDisplayed: 1, interruptsFailed: 0 });
    expect((await rows("email_messages"))[0]).toMatchObject({ is_unread: 1, status: "triaged" });
  });
});

describe("budget and final-state regression boundaries", () => {
  it("admits three spaced ordinary events per local day then holds twenty simultaneous candidates", async () => {
    for (let i = 0; i < 3; i++) {
      const at = new Date(Date.parse(now) + i * 91 * 60000).toISOString();
      await message(`spaced${i}`, { received: at });
      expect(await decideMessageNotification(`spaced${i}`, at)).toMatchObject({ level: "interrupt" });
    }
    const at = "2026-09-14T20:00:00.000Z";
    for (let i = 0; i < 20; i++) await message(`overflow${i}`, { received: at });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => decideMessageNotification(`overflow${i}`, at)));
    expect(results.every(r => r.level !== "interrupt")).toBe(true);
    expect((await rows("notification_events")).filter(r => r.kind === "interrupt")).toHaveLength(3);
    expect((await rows("notification_policy_evidence")).filter(r => r.reason_code === "over_budget" || JSON.parse(String(r.rule_trace)).includes("ordinary_daily_budget"))).toHaveLength(20);
  });
  it("shares critical sender cooldown only within the same account including grouped senders", async () => {
    await message("m", { category: "fraud", sender: "Sender@example.test", thread: "group" });
    await message("grouped", { category: "fraud", sender: "Other@example.test", thread: "group" });
    await decideMessageNotification("m", now); await decideMessageNotification("grouped", now);
    const later = "2026-09-14T15:16:00.000Z";
    await message("same", { category: "fraud", sender: "other@example.test", received: later });
    await message("isolated", { category: "fraud", sender: "other@example.test", account: "b", received: later });
    expect(await decideMessageNotification("same", later)).toMatchObject({ level: "in_app" });
    expect(JSON.parse(String((await rows("notification_policy_evidence")).find(r => r.message_id === "same")!.rule_trace))).toContain("sender_cooldown");
    expect(await decideMessageNotification("isolated", later)).toMatchObject({ level: "interrupt" });
  });
  it("uses latest corrected triage and rejects a new ordinary member borrowing critical admission", async () => {
    await message("m", { thread: "group", category: "fraud" });
    const first = await decideMessageNotification("m", now);
    await message("ordinary", { thread: "group" });
    expect((await decideMessageNotification("ordinary", now)).eventId).not.toBe(first.eventId);
    await execute("UPDATE triage_decisions SET user_corrected_attention='suppress' WHERE message_id='m'");
    expect(await claim()).toBeNull();
  });
  it("retains a compatible member when the other crosses criticality and does not merge accepted events", async () => {
    await message("first", { thread: "thread", category: "fraud" }); await message("second", { thread: "thread", category: "fraud" });
    await decideMessageNotification("first", now); await decideMessageNotification("second", now);
    await execute("UPDATE triage_decisions SET category='urgent-work' WHERE message_id='first'");
    const c = await claim(); expect(c?.attempt.resolvedTarget).toContain("message=second");
    await finishNotificationAttempt({ attemptId: c!.attempt.id, outcome: "accepted", now: due });
    await message("third", { thread: "thread", category: "fraud", received: due });
    const next = await decideMessageNotification("third", due);
    expect(next.eventId).not.toBe(c!.event.id);
    expect((await rows("notification_events")).find(r => r.id === c!.event.id)!.target).toContain("message=first");
  });
  it("atomically arbitrates transports and rolls back an attempt insertion failure", async () => {
    await message("m"); await decideMessageNotification("m", now);
    await execute("UPDATE notification_devices SET push=1");
    await execute("CREATE TRIGGER reject_attempt BEFORE INSERT ON notification_attempts BEGIN SELECT RAISE(ABORT,'synthetic attempt failure'); END");
    await expect(claim(due, "push")).rejects.toThrow();
    expect((await rows("notification_deliveries"))[0]).toMatchObject({ state: "pending", attempt_count: 0 });
    await execute("DROP TRIGGER reject_attempt");
    const results = await Promise.all([claim(), claim(due, "push")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await rows("notification_attempts")).toHaveLength(1);
  });
  it.each(["UPDATE trusted_devices SET revoked_at='2026-09-14T15:00:30.000Z'", "UPDATE notification_devices SET generation=2", "UPDATE email_accounts SET status='disabled'", "UPDATE email_messages SET account_id='b'"])("fails closed on current state change: %s", async sql => {
    await message("m"); await decideMessageNotification("m", now);
    await execute(sql);
    expect(await claim()).toBeNull();
    expect(await rows("notification_attempts")).toHaveLength(0);
  });
  it("quiet, snooze and too-noisy feedback suppress before critical bypass and preserve mail", async () => {
    await message("m", { category: "fraud", sender: "same@example.test" });
    const first = await decideMessageNotification("m", now);
    await execute("INSERT INTO notification_feedback (device_id,event_id,kind,created_at) VALUES (?,?,'too_noisy',?)", [deviceId, first.eventId!, now]);
    expect(await claim()).toBeNull();
    await setSetting("notification_snoozed_until", JSON.stringify("2026-09-14T16:00:00.000Z"));
    await message("new", { category: "fraud" }); expect(await decideMessageNotification("new", now)).toMatchObject({ reasonCode: "snoozed" });
    const quiet = "2026-09-15T04:59:45.000Z";
    await message("quiet", { received: quiet }); expect(await decideMessageNotification("quiet", quiet)).toMatchObject({ level: "in_app", reasonCode: "stale" });
    expect((await rows("email_messages")).every(r => r.is_unread === 1 && r.status === "triaged")).toBe(true);
  });
  it("uses local day across DST without allowing a folded hour to reset the budget", async () => {
    await setSetting("timezone", "America/New_York"); await setSetting("notification_daily_interrupt_budget", "1");
    await setSetting("quiet_start", "00:00"); await setSetting("quiet_end", "00:00");
    const before = "2026-11-01T03:30:00.000Z", after = "2026-11-01T05:01:00.000Z", folded = "2026-11-01T07:00:00.000Z";
    await message("before", { received: before }); await decideMessageNotification("before", before);
    await message("after", { received: after }); expect(await decideMessageNotification("after", after)).toMatchObject({ level: "interrupt" });
    await message("folded", { received: folded }); expect((await decideMessageNotification("folded", folded)).level).not.toBe("interrupt");
    expect((await rows("notification_decisions"))).toHaveLength(2);
  });
});

import { getEmailClient } from "@/lib/email/database";
import { migrateNotificationGovernorSchema } from "@/lib/email/notification-governor-schema";
describe("v5 migration and action chronology", () => {
  it("rolls back additive v5 tables and version on a schema failure, then retries without downgrading", async () => {
    await execute("DROP TABLE notification_policy_evidence"); await execute("DROP TABLE brief_notification_actions");
    await execute("CREATE TABLE brief_notification_actions (broken TEXT)"); await execute("PRAGMA user_version=4");
    await expect(migrateNotificationGovernorSchema(getEmailClient())).rejects.toThrow();
    expect((await execute("PRAGMA user_version")).rows[0].user_version).toBe(4);
    expect((await execute("SELECT name FROM sqlite_master WHERE name='notification_policy_evidence'")).rows).toHaveLength(0);
    await execute("DROP TABLE brief_notification_actions"); await migrateNotificationGovernorSchema(getEmailClient());
    expect((await execute("PRAGMA user_version")).rows[0].user_version).toBe(5);
    await execute("PRAGMA user_version=6"); await migrateNotificationGovernorSchema(getEmailClient());
    expect((await execute("PRAGMA user_version")).rows[0].user_version).toBe(6);
  });
  it("seeds baseline closures once, never infers historical Bring back and honors future explicit owner actions", async () => {
    const item = await memory();
    await updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "complete", now: due });
    await execute("DELETE FROM brief_notification_actions"); await execute("PRAGMA user_version=4");
    await execute("UPDATE brief_item_memory SET restored_at='2026-09-14T15:02:00.000Z',updated_at='2026-09-14T15:02:00.000Z'");
    await migrateNotificationGovernorSchema(getEmailClient()); await migrateNotificationGovernorSchema(getEmailClient());
    expect((await rows("brief_notification_actions")).map(r => r.kind)).toEqual(["baseline_complete"]);
    expect(await handled()).toEqual({ handled: true, invalid: false });
    await updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "bring_back", now: "2026-09-14T15:03:00.000Z" });
    expect(await handled()).toEqual({ handled: false, invalid: false });
    expect(await rows("notification_events")).toHaveLength(0);
  });
  it("automatic reopening never clears the old revision closure or creates an owner action", async () => {
    const item = await memory();
    await updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "dismiss", now: due });
    await reconcileBriefMemory({ workspaceId: "workspace:all", now: "2026-09-14T15:03:00.000Z", candidates: [{ sourceType: "mail_thread", sourceKey: "mail:a:thread", sourceAccountId: "a", provider: "gmail", providerThreadId: "thread", revisionAt: "2026-09-14T15:02:00.000Z", occurredAt: "2026-09-14T15:02:00.000Z", role: "attention", title: "New revision", summary: "", target: { view: "mail", messageId: "new" } }] });
    expect((await rows("brief_item_memory"))[0].state).toBe("open");
    expect(await handled()).toEqual({ handled: true, invalid: false });
    expect(await handled("2026-09-14T15:02:00.000Z")).toEqual({ handled: false, invalid: false });
    expect((await rows("brief_notification_actions")).map(r => r.kind)).toEqual(["dismiss"]);
  });
  it("preserves external closure source/send chronology on migration after automatic reopening", async () => {
    const item = await memory();
    await markBriefItemCompletedWithEvidence({ workspaceId: "workspace:all", itemId: item.id, sourceKey: "mail:a:thread", accountId: "a", provider: "gmail", providerThreadId: "thread", sourceRevisionAt: now, providerMessageId: "sent", providerSentAt: due, observedAt: "2026-09-14T15:02:00.000Z" });
    await execute("DELETE FROM brief_notification_actions"); await execute("PRAGMA user_version=4");
    await execute("UPDATE brief_item_memory SET state='open',source_revision_at='2026-09-14T15:03:00.000Z',restored_at='2026-09-14T15:03:00.000Z'");
    await migrateNotificationGovernorSchema(getEmailClient());
    expect((await rows("brief_notification_actions"))[0]).toMatchObject({ kind: "external", source_revision_at: now, effective_at: due });
    expect(await handled()).toEqual({ handled: true, invalid: false });
    expect(await handled("2026-09-14T15:03:00.000Z")).toEqual({ handled: false, invalid: false });
  });
  it.each(["bad", now, "2026-09-14T16:00:00.000Z"])("fails closed on malformed/equal/future external chronology %s", async effective => {
    await execute("INSERT INTO brief_notification_actions (id,source_type,source_account_id,source_key,provider,provider_thread_id,source_revision_at,effective_at,observed_at,kind) VALUES ('bad','mail_thread','a','mail:a:thread','gmail','thread',?,?,?,'external')", [now, effective, due]);
    await message("m", { thread: "thread" });
    expect(await decideMessageNotification("m", now)).toMatchObject({ level: "in_app", reasonCode: "source_unhealthy" });
    expect(JSON.parse(String((await rows("notification_policy_evidence"))[0].rule_trace))).toEqual(["completion-evidence-invalid"]);
  });
  it("does not allow equal-time Bring back to override external evidence and later dismissal wins", async () => {
    const item = await memory(); await updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "complete", now: due });
    await updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "bring_back", now: "2026-09-14T15:02:00.000Z" });
    await execute("INSERT INTO brief_notification_actions (id,source_type,source_account_id,source_key,provider,provider_thread_id,source_revision_at,effective_at,observed_at,kind) VALUES ('external','mail_thread','a','mail:a:thread','gmail','thread',?,'2026-09-14T15:02:00.000Z','2026-09-14T15:03:00.000Z','external')", [now]);
    expect(await handled()).toEqual({ handled: true, invalid: true });
    await execute("UPDATE brief_notification_actions SET effective_at=? WHERE id='external'", [due]);
    expect(await handled()).toEqual({ handled: false, invalid: false });
    await updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "dismiss", now: "2026-09-14T15:04:00.000Z" });
    expect(await handled()).toEqual({ handled: true, invalid: false });
  });
  it("rolls back explicit and external memory mutations if ledger insertion fails", async () => {
    const item = await memory();
    await execute("CREATE TRIGGER reject_memory_action BEFORE INSERT ON brief_notification_actions BEGIN SELECT RAISE(ABORT,'synthetic evidence failure'); END");
    await expect(updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "complete", now: due })).rejects.toThrow();
    expect((await rows("brief_item_memory"))[0].state).toBe("open");
    await expect(markBriefItemCompletedWithEvidence({ workspaceId: "workspace:all", itemId: item.id, sourceKey: "mail:a:thread", accountId: "a", provider: "gmail", providerThreadId: "thread", sourceRevisionAt: now, providerMessageId: "sent", providerSentAt: due, observedAt: due })).rejects.toThrow();
    expect((await rows("brief_item_memory"))[0].state).toBe("open");
    expect(await rows("reply_completion_evidence")).toHaveLength(0);
    expect(await rows("reply_completion_evidence_links")).toHaveLength(0);
  });
  it("uses exact closure evidence at both admission and dispatch across workspace rows", async () => {
    await message("m", { thread: "thread" }); const item = await memory();
    await decideMessageNotification("m", now);
    await updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "complete", now: due });
    expect(await claim()).toBeNull();
    await message("later", { thread: "thread", received: "2026-09-14T15:00:30.000Z" });
    expect(await decideMessageNotification("later", due)).toMatchObject({ reasonCode: "handled" });
    await memory("workspace:account:gmail:a");
    expect(await handled()).toEqual({ handled: true, invalid: false });
  });
});

import { createNotificationEvent, enqueueNotificationDeliveries } from "@/lib/email/notification-store";
describe("remaining dispatch safety boundaries", () => {
  it("does not let the shared reservation helper override the disabled browser switch", async () => {
    delete process.env.EZRA_BROWSER_NOTIFICATIONS_ENABLED;
    const event = await createNotificationEvent({ sourceKey: "flag-test", kind: "interrupt", target: "/?view=today", replacementTag: "flag-test", reasonCode: "attention", createdAt: now, expiresAt: "2026-09-14T16:00:00.000Z" });
    expect(await enqueueNotificationDeliveries({ eventId: event.id, now, browserEnabled: true })).toEqual([]);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:synthetic"); vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID", "123456789");
    const { readTelegramConfiguration } = await import("@/lib/email/notification-telegram-config");
    const telegram = await enrollNotificationDevice({ telegramBindingFingerprint: readTelegramConfiguration()!.fingerprint, trustedDeviceId: "trust", origin: "https://ezra.example.test", channel: "telegram", platform: "other", permission: "granted", capabilities: { foreground: false, push: false }, now });
    await message("telegram", { category: "fraud" });
    const next = await decideMessageNotification("telegram", now);
    expect(next.status).toBe("queued");
    expect((await rows("notification_deliveries")).map(r => r.device_id)).toEqual([telegram.id]);
  });
  it("blocks a deferred brief when quiet hours change after admission", async () => {
    const before = "2026-09-14T21:20:00.000Z", dispatch = "2026-09-14T21:30:00.000Z";
    await message("m", { received: before });
    await execute("UPDATE triage_decisions SET attention='digest'");
    expect(await decideMessageNotification("m", before)).toMatchObject({ level: "brief", eventId: null });
    expect(await rows("notification_deliveries")).toHaveLength(0);
    await runNotificationSchedule(dispatch);
    expect(await rows("notification_deliveries")).toHaveLength(1);
    await setSetting("quiet_start", "16:00"); await setSetting("quiet_end", "17:00");
    expect(await claim(dispatch)).toBeNull();
  });
  it("uses the persisted group timer at the freshness boundary rather than resetting burst delay", async () => {
    const firstAt = "2026-09-14T14:59:10.000Z", received = "2026-09-13T15:00:30.000Z";
    await message("first", { received, thread: "thread" }); await message("second", { received, thread: "thread" });
    const first = await decideMessageNotification("first", firstAt);
    expect(await decideMessageNotification("second", now)).toMatchObject({ level: "interrupt", eventId: first.eventId });
    expect(await claim("2026-09-14T15:00:10.000Z")).not.toBeNull();
  });
  it("does not send or call provider/model work from an enrolled service decision", async () => {
    await message("m", { category: "fraud" });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network is authorized"));
    const { notifyMessage } = await import("@/lib/email/service");
    expect(await notifyMessage("m")).toMatchObject({ ok: true, status: "queued", skipped: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(await rows("notifications")).toHaveLength(0);
    expect(await rows("notification_attempts")).toHaveLength(0);
  });
  it("imports identifiable malformed external evidence without inventing restoration from an open snapshot", async () => {
    const item = await memory();
    await execute("INSERT INTO reply_completion_evidence (id,brief_item_id,source_key,account_id,provider,provider_message_id,provider_thread_id,provider_sent_at,observed_at,created_at) VALUES ('legacy-invalid',?,'mail:a:thread','a','gmail','sent','thread',?,?,?)", [item.id, now, due, due]);
    await execute("PRAGMA user_version=4");
    await migrateNotificationGovernorSchema(getEmailClient());
    expect(await handled()).toEqual({ handled: true, invalid: true });
  });
});

describe("review regression: current completion migration", () => {
  it.each(["new_revision", "same_revision_owner", "current_external"] as const)("seeds only the actual current completion baseline: %s", async scenario => {
    const item = await memory();
    await markBriefItemCompletedWithEvidence({ workspaceId: "workspace:all", itemId: item.id, sourceKey: "mail:a:thread", accountId: "a", provider: "gmail", providerThreadId: "thread", sourceRevisionAt: now, providerMessageId: "sent", providerSentAt: due, observedAt: "2026-09-14T15:02:00.000Z" });
    let revision = now;
    if (scenario === "new_revision") {
      revision = "2026-09-14T15:03:00.000Z";
      await reconcileBriefMemory({ workspaceId: "workspace:all", now: "2026-09-14T15:04:00.000Z", candidates: [{ sourceType: "mail_thread", sourceKey: "mail:a:thread", sourceAccountId: "a", provider: "gmail", providerThreadId: "thread", revisionAt: revision, occurredAt: revision, role: "attention", title: "New revision", summary: "", target: { view: "mail", messageId: "new" } }] });
    } else if (scenario === "same_revision_owner") {
      await updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "bring_back", now: "2026-09-14T15:03:00.000Z" });
    }
    if (scenario !== "current_external") await updateBriefItemMemory({ workspaceId: "workspace:all", itemId: item.id, action: "complete", now: "2026-09-14T15:05:00.000Z" });
    const priorMemory = await rows("brief_item_memory");
    const priorLinks = await rows("reply_completion_evidence_links");
    // Simulate the v4 snapshot: its surviving old link is not owner-action evidence.
    await execute("DELETE FROM brief_notification_actions"); await execute("PRAGMA user_version=4");
    await migrateNotificationGovernorSchema(getEmailClient()); await migrateNotificationGovernorSchema(getEmailClient());
    const actions = await rows("brief_notification_actions");
    expect(actions.filter(r => r.kind === "external")).toHaveLength(1);
    expect(actions.filter(r => r.kind === "baseline_complete")).toHaveLength(scenario === "current_external" ? 0 : 1);
    expect(await rows("brief_item_memory")).toEqual(priorMemory);
    expect(await rows("reply_completion_evidence_links")).toEqual(priorLinks);
    expect(await handled(revision)).toEqual({ handled: true, invalid: false });
    await message("post-upgrade", { thread: "thread", received: revision });
    expect(await decideMessageNotification("post-upgrade", "2026-09-14T15:06:00.000Z")).toMatchObject({ level: "in_app", reasonCode: "handled" });
    expect(await rows("notification_deliveries")).toHaveLength(0);
  });
});
