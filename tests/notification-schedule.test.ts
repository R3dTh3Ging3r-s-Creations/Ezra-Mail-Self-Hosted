import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, ensureEmailDatabase, execute, setSetting } from "@/lib/email/database";
import { enrollNotificationDevice } from "@/lib/email/notification-store";
import { claimGovernedNotification } from "@/lib/email/notification-claims";
import { runNotificationSchedule, createManualNotificationBrief } from "@/lib/email/notification-schedule";

const now = "2026-09-14T15:00:00.000Z";
let databaseUrl: string, deviceId: string;
beforeEach(async () => {
  vi.stubEnv("APP_BASE_URL", "https://ezra.example.test"); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "");
  vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "true");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network allowed"); }));
  databaseUrl = configureEmailDatabaseForTests(`file:./notification-schedule-${randomUUID()}.sqlite`);
  await ensureEmailDatabase();
  await execute("INSERT INTO email_accounts (id,provider,email,label,status,last_sync_at,created_at,updated_at) VALUES ('a','gmail','a@example.test','Synthetic','connected',?,?,?)", [now, now, now]);
  await execute("INSERT INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES ('trust','Synthetic','hash',?,?)", [now, now]);
  deviceId = (await enrollNotificationDevice({ expectedSetupEpoch: 0, trustedDeviceId: "trust", origin: "https://ezra.example.test", channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push: false }, now })).id;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); closeEmailDatabaseForTests(); });
async function rows(table: string) { return (await execute(`SELECT * FROM ${table}`)).rows; }
async function message(id: string, thread = id) {
  await execute(`INSERT INTO email_messages (id,account_id,external_message_id,thread_id,sender_name,sender_email,subject,received_at,snippet,gmail_url,is_unread,status,created_at,updated_at) VALUES (?,'a',?,?,'Private','sender@example.test','Private',?,'Private','',1,'triaged',?,?)`, [id, id, thread, now, now, now]);
  await execute("INSERT INTO triage_decisions (id,message_id,model,attention,urgency,confidence,category,summary,reason,recommendation,needs_reply,created_at) VALUES (?,?,'synthetic','digest',70,0.95,'personal','','','',0,?)", [`t-${id}`, id, now]);
}
async function claim(at = now) {
  const d = (await rows("notification_deliveries"))[0];
  return claimGovernedNotification({ deliveryId: String(d.id), deviceId, generation: 1, channel: "foreground", now: at, foregroundOwner: { trustedDeviceId: "trust", origin: "https://ezra.example.test", deviceId, generation: 1 } });
}
async function calm() { await setSetting("notification_calm_checkin_enabled", "true"); await setSetting("notification_calm_checkin_time", "10:00"); }

describe("restart-safe local schedule", () => {
  it("selects only the most recent missed slot, deduplicates threads and survives concurrent ticks and restart", async () => {
    await setSetting("digest_times", '["08:00","09:30"]');
    await message("one", "thread"); await message("two", "thread");
    await Promise.all(Array.from({ length: 8 }, () => runNotificationSchedule(now)));
    expect(await rows("notification_events")).toHaveLength(1);
    expect((await rows("notification_schedule_evidence"))[0]).toMatchObject({ slot_time: "09:30", item_count: 1 });
    expect(await rows("email_digest_items")).toHaveLength(1);
    configureEmailDatabaseForTests(databaseUrl); await ensureEmailDatabase();
    await runNotificationSchedule(now);
    expect(await rows("notification_events")).toHaveLength(1);
    expect((await claim())?.attempt.resolvedTarget).toBe("/?view=today");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("atomically rolls back the source key, members and event after an interrupted reservation", async () => {
    await message("one");
    await execute("CREATE TRIGGER fail_schedule BEFORE INSERT ON notification_deliveries BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    await expect(runNotificationSchedule(now)).rejects.toThrow();
    expect(await rows("notification_schedule_evidence")).toHaveLength(0);
    expect(await rows("notification_events")).toHaveLength(0);
    await execute("DROP TRIGGER fail_schedule"); await runNotificationSchedule(now);
    expect(await rows("notification_events")).toHaveLength(1);
  });
  it("retains local history without pretending queued is sent or marking mail digested", async () => {
    await message("one"); await runNotificationSchedule(now);
    expect((await rows("email_digests"))[0]).toMatchObject({ status: "pending", channel: "shared", sent_at: null });
    expect((await rows("email_messages"))[0].status).toBe("triaged");
    expect(JSON.stringify(await rows("notification_schedule_evidence"))).not.toContain("Private");
    await execute("UPDATE email_messages SET is_unread=0");
    expect(await claim()).toBeNull();
  });
  it.each(["quiet", "snoozed", "paused", "browser_off"])("does not create a new scheduled send while %s", async gate => {
    await message("one");
    if (gate === "quiet") { await setSetting("quiet_start", "09:00"); await setSetting("quiet_end", "11:00"); }
    if (gate === "snoozed") await setSetting("notification_snoozed_until", JSON.stringify("2026-09-14T16:00:00.000Z"));
    if (gate === "paused") await execute("INSERT INTO service_state (key,value,updated_at) VALUES ('polling_paused_at','paused',?)", [now]);
    if (gate === "browser_off") vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "false");
    await runNotificationSchedule(now);
    expect(await rows("notification_deliveries")).toHaveLength(0);
  });
  it("manual requests create bounded local Today events with independent identity", async () => {
    for (let i = 0; i < 14; i++) await message(`m${i}`);
    expect(await createManualNotificationBrief(now)).toMatchObject({ count: 12, status: "pending" });
    expect(await rows("notification_events")).toHaveLength(1);
  });
  it("calm defaults off and requires a fresh positive all-source snapshot", async () => {
    await runNotificationSchedule(now); expect(await rows("notification_events")).toHaveLength(0);
    await calm(); await runNotificationSchedule(now);
    expect((await rows("notification_events"))[0].kind).toBe("checkin");
    expect((await claim())?.attempt.resolvedTarget).toBe("/?view=today");
  });
  it.each(["missing", "disconnected", "stale", "future", "invalid", "unknown", "unread", "calendar_missing", "carryover"])("suppresses calm for %s evidence", async gate => {
    await calm();
    if (gate === "missing") await execute("DELETE FROM email_accounts");
    if (gate === "disconnected") await execute("UPDATE email_accounts SET status='error'");
    if (["stale", "future", "invalid"].includes(gate)) await execute("UPDATE email_accounts SET last_sync_at=?", [gate === "stale" ? "2026-09-14T14:54:59.000Z" : gate === "future" ? "2026-09-14T15:00:01.000Z" : "bad"]);
    if (["unknown", "unread"].includes(gate)) { await message("m"); if (gate === "unknown") await execute("DELETE FROM triage_decisions"); }
    if (gate === "calendar_missing") await execute("INSERT INTO account_integrations (account_id,feature,provider,access,status,updated_at) VALUES ('a','calendar','gmail','read','connected',?)", [now]);
    if (gate === "carryover") await execute("INSERT INTO brief_item_memory (id,workspace_id,source_type,source_key,source_revision_at,state,title,summary,occurred_at,target_json,first_seen_at,last_seen_at,created_at,updated_at) VALUES ('b','workspace:all','action_center','action:b',?,'open','','',?,'{}',?,?,?,?)", [now, now, now, now, now, now]);
    await runNotificationSchedule(now);
    expect((await rows("notification_events")).filter(row => row.kind === "checkin")).toHaveLength(0);
  });
  it("rechecks calm health at claim and enforces local-day plus rolling 24-hour limits", async () => {
    await calm(); await runNotificationSchedule(now);
    await execute("UPDATE email_accounts SET status='error'"); expect(await claim()).toBeNull();
    await execute("UPDATE email_accounts SET status='connected',last_sync_at=?", ["2026-09-15T14:45:00.000Z"]);
    await setSetting("notification_calm_checkin_time", "09:45"); await runNotificationSchedule("2026-09-15T14:45:00.000Z");
    expect((await rows("notification_events")).filter(row => row.kind === "checkin")).toHaveLength(1);
  });
  it("never sends a late calm check-in outside its 60-minute window", async () => {
    await calm(); await setSetting("notification_calm_checkin_time", "08:59"); await runNotificationSchedule(now);
    expect(await rows("notification_events")).toHaveLength(0);
  });
});
import { recoverNotificationAttempts, recordNotificationFeedback } from "@/lib/email/notification-store";
import { notificationCandidateContextInTransaction, loadNotificationCandidateInTransaction } from "@/lib/email/notification-source";
import { withNotificationStoreWrite } from "@/lib/email/notification-store";
import { migrateNotificationScheduleSchema } from "@/lib/email/notification-schedule-schema";
import { getEmailClient } from "@/lib/email/database";

describe("schedule boundary regressions", () => {
  it("does not recreate consumed members at later automatic slots, including unknown attempts", async () => {
    await setSetting("digest_times", '["09:00","11:00"]'); await message("m"); await runNotificationSchedule(now);
    expect(await claim()).not.toBeNull(); await recoverNotificationAttempts({ now: "2026-09-14T15:03:00.000Z" });
    expect((await rows("notification_attempts"))[0].outcome).toBe("unknown");
    await runNotificationSchedule("2026-09-14T16:00:00.000Z");
    expect(await rows("notification_events")).toHaveLength(1);
  });
  it("reads feedback from scheduled brief members in future sender policy", async () => {
    await message("m"); await runNotificationSchedule(now);
    await recordNotificationFeedback({ deviceId, eventId: String((await rows("notification_events"))[0].id), kind: "too_noisy", now });
    const context = await withNotificationStoreWrite(async tx => notificationCandidateContextInTransaction(tx, (await loadNotificationCandidateInTransaction(tx, "m"))!.item, new Date(now)));
    expect(context.feedback).toContainEqual(expect.objectContaining({ kind: "too_noisy", accountId: "a", senderEmail: "sender@example.test" }));
  });
  it("preserves the useful afternoon needs-reply rule", async () => {
    await message("m"); await execute("UPDATE triage_decisions SET urgency=20,needs_reply=1");
    await setSetting("digest_times", '["08:00","09:00"]'); await runNotificationSchedule(now);
    expect(await rows("notification_events")).toHaveLength(1);
  });
  it("handles a spring DST missed slot and a repeated fall slot exactly once", async () => {
    await setSetting("quiet_start", "23:00"); await setSetting("quiet_end", "00:00"); await setSetting("digest_times", '["02:30"]');
    await message("spring"); await execute("UPDATE email_messages SET received_at='2026-03-08T08:00:00.000Z'");
    await runNotificationSchedule("2026-03-08T08:05:00.000Z");
    expect(await rows("notification_events")).toHaveLength(1);
    await setSetting("digest_times", '["01:30"]'); await message("fall"); await execute("UPDATE email_messages SET received_at='2026-11-01T06:00:00.000Z' WHERE id='fall'");
    await runNotificationSchedule("2026-11-01T06:35:00.000Z"); await runNotificationSchedule("2026-11-01T07:35:00.000Z");
    expect(await rows("notification_events")).toHaveLength(2);
  });
  it("requires every enabled calendar source to be fresh, covered and error-free", async () => {
    await calm();
    await execute("INSERT INTO account_integrations (account_id,feature,provider,access,status,updated_at) VALUES ('a','calendar','gmail','read','connected',?)", [now]);
    await execute("INSERT INTO calendar_sync_state (account_id,calendar_id,status,last_sync_at,range_from,range_to,updated_at) VALUES ('a','primary','connected',?,'2026-09-14T00:00:00Z','2026-09-16T00:00:00Z',?)", [now, now]);
    await runNotificationSchedule(now); expect((await rows("notification_events"))[0].kind).toBe("checkin");
    await execute("UPDATE calendar_sync_state SET range_to='2026-09-14T16:00:00Z'"); expect(await claim()).toBeNull();
  });
  it.each(["stale", "future", "error", "range", "access", "second"])("suppresses calm on calendar %s evidence", async gate => {
    await calm();
    await execute("INSERT INTO account_integrations (account_id,feature,provider,access,status,updated_at) VALUES ('a','calendar','gmail','write','connected',?)", [now]);
    await execute("INSERT INTO calendar_sync_state (account_id,calendar_id,status,last_sync_at,range_from,range_to,updated_at) VALUES ('a','primary','connected',?,'2026-09-14T00:00:00Z','2026-09-16T00:00:00Z',?)", [now, now]);
    if (gate === "stale") await execute("UPDATE calendar_sync_state SET last_sync_at='2026-09-14T14:49:59Z'");
    if (gate === "future") await execute("UPDATE calendar_sync_state SET last_sync_at='2026-09-14T15:00:01Z'");
    if (gate === "error") await execute("UPDATE calendar_sync_state SET last_error='synthetic'");
    if (gate === "range") await execute("UPDATE calendar_sync_state SET range_from=NULL");
    if (gate === "access") await execute("UPDATE account_integrations SET access='none'");
    if (gate === "second") await execute("INSERT INTO calendar_sync_state (account_id,calendar_id,status,updated_at) VALUES ('a','second','error',?)", [now]);
    await runNotificationSchedule(now); expect(await rows("notification_events")).toHaveLength(0);
  });
  it("rolls back v6 DDL and version atomically and preserves v5 evidence on upgrade", async () => {
    await execute("DROP TABLE notification_schedule_members"); await execute("DROP TABLE notification_schedule_evidence");
    await execute("CREATE TABLE notification_schedule_evidence (broken TEXT)"); await execute("PRAGMA user_version=5");
    await expect(migrateNotificationScheduleSchema(getEmailClient())).rejects.toThrow();
    expect((await execute("PRAGMA user_version")).rows[0].user_version).toBe(5);
    expect((await execute("SELECT name FROM sqlite_master WHERE name='notification_schedule_members'")).rows).toHaveLength(0);
    await execute("DROP TABLE notification_schedule_evidence"); await migrateNotificationScheduleSchema(getEmailClient()); await migrateNotificationScheduleSchema(getEmailClient());
    expect((await execute("PRAGMA user_version")).rows[0].user_version).toBe(6);
    expect((await execute("SELECT name FROM sqlite_master WHERE name='brief_notification_actions'")).rows).toHaveLength(1);
  });
});

describe("calm all-gates", () => {
  it("suppresses a routine unread cleanup candidate instead of treating suppressed classification as no action", async () => {
    await calm(); await message("routine"); await execute("UPDATE triage_decisions SET attention='suppress',category='newsletter'");
    await runNotificationSchedule(now); expect((await rows("notification_events")).filter(row => row.kind === "checkin")).toHaveLength(0);
  });
  it("suppresses outstanding source permission repair", async () => {
    await calm(); await execute("INSERT INTO account_integrations (account_id,feature,provider,access,status,last_error,updated_at) VALUES ('a','contacts','gmail','read','error','synthetic',?)", [now]);
    await runNotificationSchedule(now); expect(await rows("notification_events")).toHaveLength(0);
  });
  it.each(["poll_invalid", "second_account", "action", "calendar_event", "truncated", "snooze", "pause", "opt_out_claim"])("suppresses calm for %s", async gate => {
    await calm();
    if (gate === "poll_invalid") await setSetting("poll_minutes", "bad");
    if (gate === "second_account") await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES ('b','microsoft','b@example.test','Synthetic','connected',?,?)", [now, now]);
    if (gate === "action") await execute("INSERT INTO mail_actions (id,action,status,message_ids,created_at) VALUES ('action','archive','failed','[]',?)", [now]);
    if (gate === "calendar_event") await execute("INSERT INTO calendar_events (id,account_id,external_event_id,calendar_id,calendar_name,title,starts_at,ends_at,status,synced_at,created_at,updated_at) VALUES ('e','a','e','primary','Calendar','','2026-09-14T16:00:00Z','2026-09-14T17:00:00Z','confirmed',?,?,?)", [now, now, now]);
    if (gate === "truncated") await execute(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<501) INSERT INTO email_messages (id,account_id,external_message_id,thread_id,sender_name,sender_email,subject,received_at,snippet,gmail_url,is_unread,status,created_at,updated_at) SELECT 'm'||i,'a','m'||i,'m'||i,'','','',?,'','',1,'new',?,? FROM n`, [now, now, now]);
    if (gate === "snooze") await setSetting("notification_snoozed_until", JSON.stringify("2026-09-14T16:00:00Z"));
    if (gate === "pause") await execute("INSERT INTO service_state (key,value,updated_at) VALUES ('polling_paused_at','paused',?)", [now]);
    await runNotificationSchedule(now);
    if (gate === "opt_out_claim") { await setSetting("notification_calm_checkin_enabled", "false"); expect(await claim()).toBeNull(); }
    else expect((await rows("notification_events")).filter(row => row.kind === "checkin")).toHaveLength(0);
  });
});
import { runNotificationWork } from "@/lib/email/notification-worker";
import { finishNotificationAttempt, recordNotificationReceipt } from "@/lib/email/notification-store";
import { getNotificationPolicyCenter } from "@/lib/email/notification-center";

describe("notification lane and statistics", () => {
  it("recovers unknown attempts and purges revoked subscriptions even while polling is paused", async () => {
    for (const key of ["EZRA_PUSH_KEY_ID", "EZRA_PUSH_ENCRYPTION_KEY", "EZRA_PUSH_OLD_KEYS_JSON", "EZRA_VAPID_PUBLIC_KEY", "EZRA_VAPID_PRIVATE_KEY", "EZRA_VAPID_SUBJECT"]) vi.stubEnv(key, "");
    await message("m"); await runNotificationSchedule(now); await claim();
    await execute("INSERT INTO service_state (key,value,updated_at) VALUES ('polling_paused_at','paused',?)", [now]);
    await runNotificationWork("2026-09-14T15:03:00.000Z");
    expect((await rows("notification_attempts"))[0].outcome).toBe("unknown");
    await execute("UPDATE notification_devices SET subscription_ciphertext='synthetic',subscription_fingerprint='synthetic'");
    await execute("UPDATE trusted_devices SET revoked_at=?", [now]);
    await runNotificationWork("2026-09-14T15:04:00.000Z");
    expect((await rows("notification_devices"))[0].subscription_ciphertext).toBeNull();
    expect(await rows("notification_events")).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("counts accepted and displayed shared briefs separately from historical sent records", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
    try {
      await message("m"); await runNotificationSchedule(now); const c = (await claim())!;
      expect((await getNotificationPolicyCenter()).stats).toMatchObject({ digestsSent: 0, digestsAccepted: 0, digestsDisplayed: 0 });
      await finishNotificationAttempt({ attemptId: c.attempt.id, outcome: "accepted", now });
      expect((await getNotificationPolicyCenter()).stats).toMatchObject({ digestsSent: 0, digestsAccepted: 1, digestsDisplayed: 0 });
      await recordNotificationReceipt({ attemptId: c.attempt.id, deviceId, generation: 1, kind: "displayed", now });
      expect((await getNotificationPolicyCenter()).stats).toMatchObject({ digestsSent: 0, digestsDisplayed: 1 });
    } finally { vi.useRealTimers(); }
  });
});
it("never automatically replays a member consumed by an explicit manual brief", async () => {
  await message("m"); await createManualNotificationBrief(now); await claim();
  await recoverNotificationAttempts({ now: "2026-09-14T15:03:00.000Z" });
  await runNotificationSchedule("2026-09-14T15:04:00.000Z");
  expect(await rows("notification_events")).toHaveLength(1);
});
it("uses current check-in feedback for future check-ins and permits changing the answer", async () => {
  await calm(); await runNotificationSchedule(now);
  const eventId = String((await rows("notification_events"))[0].id);
  await recordNotificationFeedback({ deviceId, eventId, kind: "too_noisy", now });
  const tomorrow = "2026-09-15T15:00:00.000Z";
  await execute("UPDATE email_accounts SET last_sync_at=?", [tomorrow]);
  await runNotificationSchedule(tomorrow);
  expect(await rows("notification_events")).toHaveLength(1);
  await recordNotificationFeedback({ deviceId, eventId, kind: "useful", now: tomorrow });
  await runNotificationSchedule(tomorrow);
  expect(await rows("notification_events")).toHaveLength(2);
});
it("expires a check-in feedback hold after seven days without bypassing opt-out or health", async () => {
  await calm(); await runNotificationSchedule(now);
  const eventId = String((await rows("notification_events"))[0].id);
  await recordNotificationFeedback({ deviceId, eventId, kind: "too_noisy", now });
  const nextWeek = "2026-09-21T15:00:00.000Z";
  await execute("UPDATE email_accounts SET last_sync_at=?", [nextWeek]);
  await setSetting("notification_calm_checkin_enabled", "false"); await runNotificationSchedule(nextWeek);
  expect(await rows("notification_events")).toHaveLength(1);
  await setSetting("notification_calm_checkin_enabled", "true"); await execute("UPDATE email_accounts SET status='error'"); await runNotificationSchedule(nextWeek);
  expect(await rows("notification_events")).toHaveLength(1);
  await execute("UPDATE email_accounts SET status='connected'"); await runNotificationSchedule(nextWeek);
  expect(await rows("notification_events")).toHaveLength(2);
});
it("does not substitute another calendar cache for missing primary source evidence", async () => {
  await calm();
  await execute("INSERT INTO account_integrations (account_id,feature,provider,access,status,updated_at) VALUES ('a','calendar','gmail','read','connected',?)", [now]);
  await execute("INSERT INTO calendar_sync_state (account_id,calendar_id,status,last_sync_at,range_from,range_to,updated_at) VALUES ('a','other','connected',?,'2026-09-14T00:00:00Z','2026-09-16T00:00:00Z',?)", [now, now]);
  await runNotificationSchedule(now); expect(await rows("notification_events")).toHaveLength(0);
});
import { evaluateAttentionCandidate } from "@/lib/email/notification-attention";
import { decideMessageNotification } from "@/lib/email/notification-governor";
import { createNotificationEvent, enqueueNotificationDeliveries } from "@/lib/email/notification-store";
import { buildNotificationTarget } from "@/lib/email/notification-target";
import { claimNotificationDelivery as claimLegacyFixture } from "./helpers/notification-ledger";

async function claimEvery(at: string) {
  return Promise.all((await rows("notification_deliveries")).map(d => claimGovernedNotification({ deliveryId: String(d.id), deviceId, generation: 1, channel: "foreground", now: at, foregroundOwner: { trustedDeviceId: "trust", origin: "https://ezra.example.test", deviceId, generation: 1 } })));
}
async function legacyBrief(id: string) {
  const groupingKey = await withNotificationStoreWrite(async tx => evaluateAttentionCandidate(await notificationCandidateContextInTransaction(tx, (await loadNotificationCandidateInTransaction(tx, id))!.item, new Date(now))).groupingKey);
  const event = await createNotificationEvent({ sourceKey: `legacy-${id}`, kind: "brief", target: buildNotificationTarget({ view: "mail", provider: "gmail", accountId: "a", messageId: id }), replacementTag: "legacy", reasonCode: "brief", createdAt: now, expiresAt: "2026-09-14T16:00:00.000Z" });
  await execute(`INSERT INTO notification_policy_evidence (source_key,message_id,event_id,account_id,sender_hash,category,grouping_key,level,critical,reason_code,rule_trace,created_at) VALUES (?,?,?,'a','synthetic','personal',?,'brief',0,'brief','[]',?)`, [event.sourceKey, id, event.id, groupingKey, now]);
  await enqueueNotificationDeliveries({ eventId: event.id, now });
  return event;
}
describe("canonical shared brief composition", () => {
  const before = "2026-09-14T15:20:00.000Z", slot = "2026-09-14T15:30:00.000Z";
  it("normal multi-message admission followed by a due slot yields exactly one shared Today claim", async () => {
    await setSetting("digest_times", '["10:30"]');
    for (const id of ["one", "two", "three"]) {
      await message(id);
      expect(await decideMessageNotification(id, before)).toMatchObject({ level: "brief", eventId: null, status: "in_app" });
    }
    expect(await rows("notification_policy_evidence")).toHaveLength(3);
    expect(await rows("notification_deliveries")).toHaveLength(0);
    await runNotificationSchedule(slot);
    const claims = (await claimEvery(slot)).filter(Boolean);
    expect(claims).toHaveLength(1); expect(claims[0]?.attempt.resolvedTarget).toBe("/?view=today");
    expect((await rows("notification_schedule_evidence"))[0].item_count).toBe(3);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["budget", "cooldown"])("keeps %s-held interrupt evidence eligible for the shared brief without individual delivery", async gate => {
    await setSetting("digest_times", '["10:30"]');
    if (gate === "budget") await setSetting("notification_daily_interrupt_budget", "0");
    else {
      await message("prior"); await execute("UPDATE triage_decisions SET attention='interrupt',urgency=95,category='urgent-work'");
      await decideMessageNotification("prior", now);
      const previous = (await claim("2026-09-14T15:01:00.000Z"))!;
      await finishNotificationAttempt({ attemptId: previous.attempt.id, outcome: "accepted", now: "2026-09-14T15:01:00.000Z" });
    }
    await message("held"); await execute("UPDATE triage_decisions SET attention='interrupt',urgency=95,category='urgent-work'");
    expect(await decideMessageNotification("held", before)).toMatchObject({ level: "brief", reasonCode: gate === "budget" ? "over_budget" : "cooldown", eventId: null });
    await runNotificationSchedule(slot);
    expect((await claimEvery(slot)).filter(Boolean)).toHaveLength(1);
    expect((await rows("notification_events")).filter(e => e.kind === "brief")).toHaveLength(1);
    expect((await rows("notification_events")).find(e => e.kind === "brief")?.target).toBe("/?view=today");
  });
  it("rejects old unattempted individual briefs while permitting their one shared replacement", async () => {
    await message("old"); const old = await legacyBrief("old");
    const beforeEvidence = await rows("notification_policy_evidence");
    expect(await claim()).toBeNull();
    expect((await rows("notification_deliveries"))[0].state).toBe("cancelled");
    await runNotificationSchedule(now);
    const claimed = (await claimEvery(now)).filter(Boolean);
    expect(claimed).toHaveLength(1); expect(claimed[0]?.attempt.resolvedTarget).toBe("/?view=today");
    expect(await rows("notification_policy_evidence")).toEqual(beforeEvidence);
    expect((await rows("notification_events")).find(e => e.id === old.id)?.target).toContain("message=old");
  });
  it.each(["accepted", "unknown"])("does not automatically replay an old %s individual brief; explicit manual requests remain bounded", async outcome => {
    await message("old"); await legacyBrief("old");
    const d = (await rows("notification_deliveries"))[0];
    const c = (await claimLegacyFixture({ deliveryId: String(d.id), deviceId, generation: 1, channel: "foreground", now, foregroundOwner: { trustedDeviceId: "trust", origin: "https://ezra.example.test", deviceId, generation: 1 } }))!;
    if (outcome === "accepted") await finishNotificationAttempt({ attemptId: c.attempt.id, outcome: "accepted", now });
    else await recoverNotificationAttempts({ now: "2026-09-14T15:03:00.000Z" });
    const attempts = await rows("notification_attempts");
    await runNotificationSchedule("2026-09-14T15:04:00.000Z");
    expect(await rows("notification_schedule_evidence")).toHaveLength(0); expect(await rows("notification_attempts")).toEqual(attempts);
    expect(await createManualNotificationBrief("2026-09-14T15:04:00.000Z")).toMatchObject({ count: 1 });
    const explicitClaims = (await claimEvery("2026-09-14T15:04:00.000Z")).filter(Boolean);
    expect(explicitClaims).toHaveLength(1); expect(explicitClaims[0]?.attempt.resolvedTarget).toBe("/?view=today");
  });
  it("does not replay an unknown interrupt reclassified as digest, but a new source revision remains eligible", async () => {
    await message("old"); await execute("UPDATE triage_decisions SET attention='interrupt',urgency=95,category='urgent-work'");
    await decideMessageNotification("old", now); await claim("2026-09-14T15:01:00.000Z");
    await recoverNotificationAttempts({ now: "2026-09-14T15:04:00.000Z" });
    await execute("UPDATE triage_decisions SET attention='digest'");
    await runNotificationSchedule("2026-09-14T15:05:00.000Z");
    expect(await rows("notification_schedule_evidence")).toHaveLength(0);
    await message("new", "old"); await runNotificationSchedule("2026-09-14T15:05:00.000Z");
    expect((await rows("notification_schedule_members")).map(m => m.message_id)).toEqual(["new"]);
    expect((await rows("notification_attempts"))[0].outcome).toBe("unknown");
  });
});

it("counts a skipped canonical shared brief once and retains legacy skipped rows", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(now));
  try {
    await message("skipped"); await execute("UPDATE notification_devices SET permission='denied'");
    await createManualNotificationBrief(now);
    expect((await rows("email_digests"))[0]).toMatchObject({ channel: "shared", status: "skipped" });
    const { getNotificationPolicyCenter } = await import("@/lib/email/notification-center");
    expect((await getNotificationPolicyCenter()).stats.digestsSkipped).toBe(1);
    await execute("UPDATE email_digests SET channel='telegram'");
    expect((await getNotificationPolicyCenter()).stats.digestsSkipped).toBe(2);
  } finally { vi.restoreAllMocks(); }
});
