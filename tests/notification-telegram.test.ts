// @vitest-environment node
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { request as httpsRequest } from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, ensureEmailDatabase, execute } from "@/lib/email/database";
import { enrollBrowserNotification, notificationInventory, removeNotificationDevice } from "@/lib/email/notification-enrollment";
import { decideMessageNotification } from "@/lib/email/notification-governor";
import { drainPushNotifications } from "@/lib/email/notification-dispatch";
import { getTelegramStatus, startTelegramPolling, stopTelegramPolling, sendEmailAlert, sendDigest } from "@/lib/email/telegram";
import type { InboxItem } from "@/lib/email/types";
const now = "2026-09-14T15:01:00.000Z", origin = "https://ezra.example.test";
let owner: { trustedDeviceId: string; origin: string };
const input = { channel: "telegram" as const, platform: "other" as const, permission: "granted" as const, capabilities: { foreground: false, push: false } };
async function table(name: string) { return (await execute(`SELECT * FROM ${name}`)).rows; }
async function enroll() { return enrollBrowserNotification(owner, input); }
async function message(id = "m", tag = "thread") {
 const created = "2026-09-14T15:00:00.000Z";
 await execute("INSERT INTO email_messages (id,account_id,external_message_id,thread_id,sender_name,sender_email,subject,received_at,snippet,gmail_url,is_unread,status,created_at,updated_at) VALUES (?,'a',?,?,'Private sender','private@example.test','Private subject',?,'Private body','',1,'triaged',?,?)", [id,id,tag,created,created,created]);
 await execute("INSERT INTO triage_decisions (id,message_id,model,attention,urgency,confidence,category,summary,reason,recommendation,needs_reply,created_at) VALUES (?,?,'synthetic','interrupt',95,0.95,'urgent-work','Private summary','','',0,?)", ["triage-"+id,id,created]);
 await decideMessageNotification(id, "2026-09-14T15:00:00.000Z");
}
function network(status = 200, payload: unknown = { ok: true, result: { message_id: 41 } }, delayed = false) {
 const bodies: Record<string, unknown>[] = [], paths: string[] = [], releases: (()=>void)[] = [];
 const request = ((options: {hostname:string;path:string;method:string}, receive: (value: unknown)=>void) => {
  expect(options.hostname).toBe("api.telegram.org"); expect(options.method).toBe("POST"); paths.push(options.path);
  return Object.assign(new EventEmitter(), { destroy() {}, end(body: string) {
   bodies.push(JSON.parse(body)); const release = () => { const response = Object.assign(new EventEmitter(), {statusCode:status,headers:{},complete:true,destroy(){}}); receive(response); response.emit("data",Buffer.from(JSON.stringify(payload))); response.emit("end"); };
   if (delayed) releases.push(release); else queueMicrotask(release);
  }});
 }) as unknown as typeof httpsRequest;
 return {request,bodies,paths,releases};
}
beforeEach(async () => {
  vi.stubEnv("APP_BASE_URL", "https://ezra.example.test"); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "");
 vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:" + randomUUID().replaceAll("-", "")); vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID", "123456789"); vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "false");
 configureEmailDatabaseForTests("file:./notification-telegram-"+randomUUID()+".sqlite"); await ensureEmailDatabase(); owner = {trustedDeviceId:randomUUID(),origin};
 await execute("INSERT INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES (?,'Synthetic',?,?,?)", [owner.trustedDeviceId,owner.trustedDeviceId,now,now]);
 await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES ('a','gmail','synthetic@example.test','Synthetic','connected',?,?)", [now,now]);
});
afterEach(()=>{stopTelegramPolling();vi.restoreAllMocks();vi.unstubAllEnvs();closeEmailDatabaseForTests();});
describe("explicit Telegram owner binding",()=>{
 it.each(["-123","0","1.5","001","9007199254740992","invalid"])("refuses invalid private destination %s",async chat=>{vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID",chat); expect(getTelegramStatus().configured).toBe(false); await expect(enroll()).rejects.toThrow();});
 it("environment configuration cannot poll or send legacy mail",async()=>{ const fetch = vi.fn(); vi.stubGlobal("fetch",fetch); try { expect((await startTelegramPolling()).running).toBe(false); await sendEmailAlert({subject:"Secret"} as InboxItem); await sendDigest([{} as InboxItem],"Secret"); expect(fetch).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); } });
 it("enrolls atomically without browser epoch and preserves browser pending state",async()=>{
  await execute("INSERT INTO notification_origin_setup (origin,setup_epoch,pending,operation_id,operation_epoch,operation_kind,started_at) VALUES (?,1,1,'operation',1,'worker_repair',?)",[origin,now]);
  const enrolled = await enroll(); expect(enrolled.device.channel).toBe("telegram"); expect((await enroll()).device.id).toBe(enrolled.device.id); expect((await enroll()).device.generation).toBe(1);
  expect((await table("notification_origin_setup"))[0].pending).toBe(1); expect(JSON.stringify(await notificationInventory(owner))).not.toMatch(/fingerprint|123456789|123456:/);
 });
 it("replacement by another trusted enrollment revokes the old binding",async()=>{const old=await enroll(); owner={...owner,trustedDeviceId:randomUUID()}; await execute("INSERT INTO trusted_devices (id,label,token_hash,created_at,last_used_at) VALUES (?,'Other',?,?,?)",[owner.trustedDeviceId,owner.trustedDeviceId,now,now]); const next=await enroll(); expect(next.device.id).not.toBe(old.device.id); expect((await table("notification_devices")).filter(row=>!row.revoked_at)).toHaveLength(1);});
 it("removal checks the exact Telegram owner and scrubs binding",async()=>{const {device}=await enroll(); await expect(removeNotificationDevice(device.id,{owner:{...owner,trustedDeviceId:"other"},expectedGeneration:1})).rejects.toThrow(); await removeNotificationDevice(device.id,{owner,expectedGeneration:1}); expect((await table("notification_devices"))[0]).toMatchObject({telegram_binding_fingerprint:null});});
 it.each(["token","chat","trust","remove"])("stale %s cannot deliver",async change=>{const {device}=await enroll(); await message(); if(change==="token")vi.stubEnv("TELEGRAM_BOT_TOKEN","234567:synthetic"); if(change==="chat")vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID","234567890"); if(change==="trust")await execute("UPDATE trusted_devices SET revoked_at=?",[now]); if(change==="remove")await removeNotificationDevice(device.id,{owner,expectedGeneration:1}); const net=network(); await drainPushNotifications({now,telegramNetwork:net}); expect(net.bodies).toHaveLength(0);});
});
describe("governed Telegram delivery",()=>{
 it("sends generic copy and only safe Ezra buttons without display receipts",async()=>{await enroll();await message();const net=network();await drainPushNotifications({now,telegramNetwork:net}); expect(net.bodies).toHaveLength(1);const body=JSON.stringify(net.bodies[0]);expect(body).not.toMatch(/Private|private@example|mail.google.com|draft|approve|parse_mode/);expect(body).toContain(origin+"/?view=mail");expect(body).toContain("Useful");expect(body).toContain("Too noisy");expect((await table("notification_deliveries"))[0].state).toBe("accepted");expect(await table("notification_receipts")).toHaveLength(0);});
 it.each(["read","retargeted","quiet","snoozed"])("shared policy blocks %s",async change=>{await enroll();await message();if(change==="read"||change==="retargeted")await execute("UPDATE email_messages SET is_unread=0");else await execute("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)",[change==="quiet"?"quiet_start":"notification_snoozed_until",change==="quiet"?"00:00":JSON.stringify("2026-09-15T00:00:00.000Z"),now]);if(change==="quiet")await execute("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('quiet_end','23:59',?)",[now]);const net=network();await drainPushNotifications({now,telegramNetwork:net});expect(net.bodies).toHaveLength(0);});
 it.each([302,500,502])("does not replay ambiguous %s",async status=>{await enroll();await message();const net=network(status,{ok:false,description:"secret"});await drainPushNotifications({now,telegramNetwork:net});await drainPushNotifications({now,telegramNetwork:net});expect(net.bodies).toHaveLength(1);expect((await table("notification_attempts"))[0]).toMatchObject({outcome:"unknown",error_code:"transport_unknown"});expect(JSON.stringify(await table("notification_attempts"))).not.toContain("secret");});
 it("caps JSON flood-control retries at three",async()=>{await enroll();await message();const net=network(429,{ok:false,error_code:429,parameters:{retry_after:60},description:"secret"});for(const at of [now,"2026-09-14T15:02:00.000Z","2026-09-14T15:03:00.000Z","2026-09-14T15:04:00.000Z"])await drainPushNotifications({now:at,telegramNetwork:net});expect(net.bodies).toHaveLength(3);expect((await table("notification_deliveries"))[0].state).toBe("failed");});
 it("blocked owner disables current binding",async()=>{await enroll();await message();await drainPushNotifications({now,telegramNetwork:network(403,{ok:false,error_code:403,description:"Forbidden: bot was blocked by the user"})});expect((await table("notification_devices"))[0]).toMatchObject({permission:"denied",telegram_binding_fingerprint:null});});
});

import { sendTelegramMessage, readTelegramConfiguration, getActiveTelegramBinding } from "@/lib/email/notification-telegram";
import { patchNotificationDevice, currentNotificationDevice } from "@/lib/email/notification-enrollment";
import * as telegramAdapter from "@/lib/email/notification-telegram";
import { dispatchNotificationDelivery } from "@/lib/email/notification-dispatch";
import { createManualNotificationBrief } from "@/lib/email/notification-schedule";
it("Telegram detailed copy is a separate explicit opt-in and never browser authority",async()=>{
 const {device}=await enroll();await expect(currentNotificationDevice(owner,device.id)).rejects.toThrow();await patchNotificationDevice(owner,device.id,{expectedGeneration:1,detailedCopy:true});await message();const net=network();await drainPushNotifications({now,telegramNetwork:net});expect(net.bodies[0].text).toBe("Private sender\nPrivate subject");
});
it.each(["token","generation","trust","retarget"])("final authorization cancels unsent %s changes",async change=>{
 const {device}=await enroll();await message();if(change==="retarget")await message("second");
 const prepare=telegramAdapter.telegramNotificationMessage;vi.spyOn(telegramAdapter,"telegramNotificationMessage").mockImplementationOnce((...args)=>{
  if(change==="token")vi.stubEnv("TELEGRAM_BOT_TOKEN","234567:synthetic");return prepare(...args);
 });
 const capture=telegramAdapter.getActiveTelegramBinding;vi.spyOn(telegramAdapter,"getActiveTelegramBinding").mockImplementationOnce(async (...args)=>{
  const binding=await capture(...args);if(change==="generation"){vi.stubEnv("TELEGRAM_BOT_TOKEN","234567:synthetic");await enroll();}if(change==="trust")await execute("UPDATE trusted_devices SET revoked_at=?",[now]);return binding;
 });
 if(change==="retarget")await execute("UPDATE email_messages SET is_unread=0");
 const net=network();const row=(await table("notification_deliveries")).find(r=>r.device_id===device.id)!;await dispatchNotificationDelivery(String(row.id),{now,telegramNetwork:net});expect(net.bodies).toHaveLength(0);
});
it.each([200,403,429])("late %s response cannot change a new enrollment",async status=>{
 const {device}=await enroll();await message();const net=network(status,status===200?{ok:true,result:{message_id:41}}:{ok:false,error_code:status,description:"Forbidden: bot was blocked by the user",parameters:{retry_after:60}},true);
 const pending=drainPushNotifications({now,telegramNetwork:net});for(let i=0;i<400&&!net.releases.length;i++)await new Promise(resolve=>setTimeout(resolve,5));expect(net.releases).toHaveLength(1);
 vi.stubEnv("TELEGRAM_BOT_TOKEN","234567:synthetic");await enroll();net.releases[0]();await pending;
 const row=(await table("notification_devices")).find(r=>r.id===device.id)!;expect(row).toMatchObject({generation:2,permission:"granted",revoked_at:null});expect((await getActiveTelegramBinding())?.generation).toBe(2);expect((await table("notification_deliveries"))[0].state).toBe("cancelled");
});
it.each(["accepted","notmodified","refused","ambiguous"])("replaces recent same-tag notifications: %s",async result=>{
 await enroll();await message();await drainPushNotifications({now,telegramNetwork:network()});
 await execute("UPDATE triage_decisions SET attention='digest',urgency=70,category='personal'");const brief=await createManualNotificationBrief(now);expect(brief.eventId).toBeTruthy();
 await execute("UPDATE notification_events SET replacement_tag=(SELECT replacement_tag FROM notification_events WHERE kind='interrupt' LIMIT 1) WHERE id=?",[brief.eventId!]);
 const net=network(result==="accepted"?200:result==="ambiguous"?500:400,result==="accepted"?{ok:true,result:{message_id:41}}:{ok:false,error_code:result==="ambiguous"?500:400,description:result==="notmodified"?"Bad Request: message is not modified":result==="refused"?"Bad Request: message to edit not found":"secret"});
 await drainPushNotifications({now,telegramNetwork:net});expect(net.paths[0]).toMatch(/\/editMessageText$/);expect(net.bodies[0].message_id).toBe(41);expect(net.bodies).toHaveLength(result==="refused"?2:1);if(result==="refused")expect(net.paths[1]).toMatch(/\/sendMessage$/);expect(String(net.bodies[0].text)).toContain("brief");
 const attempts=await table("notification_attempts");expect(attempts.at(-1)?.resolved_target).toBe("/?view=today");expect(await table("notification_receipts")).toHaveLength(0);
});
it.each([{}, {ok:true,result:{}}, {ok:true,result:{message_id:1.1}}, {ok:true,result:{message_id:0}}, {ok:true,result:{message_id:9007199254740992}}, {ok:false,error_code:500,description:"secret"}])("malformed or ambiguous accepted response is unknown",async payload=>{const net=network(200,payload);expect(await sendTelegramMessage(readTelegramConfiguration()!,{text:"Test"},net,{now})).toEqual({outcome:"unknown",errorCode:"transport_unknown"});});
it("response and request body are bounded; oversized response never becomes acceptance",async()=>{const net=network(200,{ok:true,result:{message_id:41},padding:"x".repeat(17000)});expect((await sendTelegramMessage(readTelegramConfiguration()!,{text:"Test"},net,{now})).outcome).toBe("unknown");const rejected=network();await sendTelegramMessage(readTelegramConfiguration()!,{text:"x".repeat(17000)},rejected,{now});expect(rejected.bodies).toHaveLength(0);});
it("hang timeout and network errors are sanitized unknown",async()=>{
 vi.useFakeTimers();try{const net=network(200,{},true);const pending=sendTelegramMessage(readTelegramConfiguration()!,{text:"Test"},net);await vi.advanceTimersByTimeAsync(15000);expect(await pending).toEqual({outcome:"unknown",errorCode:"timeout"});}finally{vi.useRealTimers();}
 const request=(()=>{const req=Object.assign(new EventEmitter(),{destroy(){},end(){queueMicrotask(()=>req.emit("error",new Error("secret raw token")));}});return req;}) as unknown as typeof httpsRequest;
 expect(await sendTelegramMessage(readTelegramConfiguration()!,{text:"Test"},{request})).toEqual({outcome:"unknown",errorCode:"transport_unknown"});
});
it("JSON retry delay is anchored at response completion and bounded",async()=>{
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(now));try{const net=network(429,{ok:false,error_code:429,parameters:{retry_after:120}},true);const pending=sendTelegramMessage(readTelegramConfiguration()!,{text:"Test"},net);vi.setSystemTime(new Date("2026-09-14T15:05:00.000Z"));net.releases[0]();expect((await pending).retryAt).toBe("2026-09-14T15:07:00.000Z");}finally{vi.useRealTimers();}
});

import { setSetting } from "@/lib/email/database";
import { runNotificationSchedule } from "@/lib/email/notification-schedule";
it("sends a governed calm check-in with browser disabled and the private brief target",async()=>{
 await enroll();await execute("UPDATE email_accounts SET last_sync_at=?",[now]);await setSetting("timezone","UTC");await setSetting("notification_calm_checkin_enabled","true");await setSetting("notification_calm_checkin_time","15:00");await runNotificationSchedule(now);
 expect((await table("notification_events"))[0].kind).toBe("checkin");const net=network();await drainPushNotifications({now,telegramNetwork:net});expect(net.bodies).toHaveLength(1);expect(net.bodies[0].text).toContain("check-in");expect((await table("notification_attempts"))[0].resolved_target).toBe("/?view=today");
});
it("unenrolled configuration cannot create external attempts",async()=>{await message();const net=network();await drainPushNotifications({now,telegramNetwork:net});expect(net.bodies).toHaveLength(0);expect(await table("notification_attempts")).toHaveLength(0);});
it("revoked device cleanup clears its binding even after revocation was recorded elsewhere",async()=>{await enroll();await execute("UPDATE notification_devices SET revoked_at=?",[now]);await notificationInventory(owner);expect((await table("notification_devices"))[0].telegram_binding_fingerprint).toBeNull();});

import { sendTelegramConnectionTest } from "@/lib/email/telegram";
import * as governor from "@/lib/email/notification-governor";
it("final governed target cannot switch to another grouped member",async()=>{
 await enroll();await message("first");await message("second");const resolve=governor.resolveNotificationEventForClaim;let checks=0;
 vi.spyOn(governor,"resolveNotificationEventForClaim").mockImplementation(async(tx,input)=>{if(++checks===2)await tx.execute("UPDATE email_messages SET is_unread=0 WHERE id='first'");return resolve(tx,input);});
 const net=network();await drainPushNotifications({now,telegramNetwork:net});expect(net.bodies).toHaveLength(0);expect((await table("notification_attempts"))[0].resolved_target).toContain("message=first");expect((await table("notification_deliveries"))[0].state).toBe("cancelled");
});
it("expiry during copy preparation cancels before transport",async()=>{
 await enroll();await message();vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(now));const prepare=telegramAdapter.telegramNotificationMessage;
 vi.spyOn(telegramAdapter,"telegramNotificationMessage").mockImplementationOnce((...args)=>{const result=prepare(...args);vi.setSystemTime(new Date("2026-09-16T15:01:00.000Z"));return result;});
 try{const net=network();await drainPushNotifications({telegramNetwork:net});expect(net.bodies).toHaveLength(0);expect((await table("notification_deliveries"))[0].state).toBe("cancelled");}finally{vi.useRealTimers();}
});
it("connection test requires exact enrolled owner and tells only the test outcome",async()=>{
 await enroll();const net=network();const send=telegramAdapter.sendTelegramMessage;vi.spyOn(telegramAdapter,"sendTelegramMessage").mockImplementation((configuration,message,_network,options)=>send(configuration,message,net,options));
 await expect(sendTelegramConnectionTest({...owner,trustedDeviceId:"other"})).rejects.toThrow();expect(net.bodies).toHaveLength(0);await sendTelegramConnectionTest(owner);expect(net.bodies).toHaveLength(1);expect(String(net.bodies[0].text)).not.toMatch(/enrolled|ready|private alerts/i);expect(String(net.bodies[0].text)).toContain("test");
});

it.each(["rotated", "removed", "origin"])("stale Telegram %s cannot spend admission budget or reserve work", async change => {
  vi.stubEnv("APP_BASE_URL", origin); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "");
  await enroll();
  if (change === "rotated") vi.stubEnv("TELEGRAM_BOT_TOKEN", "234567:synthetic");
  if (change === "removed") vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID", "");
  if (change === "origin") vi.stubEnv("APP_BASE_URL", "https://new.example.test");
  await message("stale");
  expect((await table("notification_policy_evidence"))[0]).toMatchObject({ level: "in_app", event_id: null });
  expect(await table("notification_events")).toHaveLength(0);
  expect(await table("notification_deliveries")).toHaveLength(0);
  vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID", "123456789");
  if (change === "origin") owner = { ...owner, origin: "https://new.example.test" };
  await enroll(); await message("current", "new-thread");
  expect((await table("notification_events"))[0].kind).toBe("interrupt");
  expect(await table("notification_deliveries")).toHaveLength(1);
});
it("final Telegram authorization rejects an origin removed after claim", async () => {
  vi.stubEnv("APP_BASE_URL", origin); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "");
  await enroll(); await message();
  const original = telegramAdapter.telegramNotificationMessage;
  vi.spyOn(telegramAdapter, "telegramNotificationMessage").mockImplementationOnce((...args) => {
    const payload = original(...args); vi.stubEnv("APP_BASE_URL", "https://new.example.test"); return payload;
  });
  const net = network(); await dispatchNotificationDelivery(String((await table("notification_deliveries"))[0].id), { now, telegramNetwork: net });
  expect(net.bodies).toHaveLength(0);
  expect((await table("notification_deliveries"))[0].state).toBe("cancelled");
});

it("keeps current browser enrollment usable while Telegram configuration is stale", async () => {
  await enroll(); vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID", "");
  vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "true");
  const browser = await enrollBrowserNotification(owner, { channel: "browser", expectedSetupEpoch: 0, platform: "other", permission: "granted", capabilities: { foreground: true, push: false } });
  await message();
  expect((await table("notification_events"))[0].kind).toBe("interrupt");
  expect(await table("notification_deliveries")).toMatchObject([{ device_id: browser.device.id }]);
});
it("keeps an explicitly allowed Telegram origin current while a new origin needs enrollment", async () => {
  await enroll(); vi.stubEnv("APP_BASE_URL", "https://new.example.test"); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", origin);
  expect((await getActiveTelegramBinding())?.origin).toBe(origin);
  await message(); const net = network(); await drainPushNotifications({ now, telegramNetwork: net });
  expect(net.bodies).toHaveLength(1);
  expect(JSON.stringify(net.bodies)).toContain(origin + "/?view=mail");
  const inventory = await notificationInventory({ ...owner, origin: "https://new.example.test" });
  expect(inventory.telegramConfiguration.enrolled).toBe(false);
});
it("does not reserve a scheduled brief for a stale Telegram destination", async () => {
  await enroll(); await message();
  await execute("UPDATE triage_decisions SET attention='digest',urgency=70,category='personal'");
  vi.stubEnv("TELEGRAM_DEFAULT_CHAT_ID", "");
  const brief = await createManualNotificationBrief(now);
  expect(brief.status).toBe("skipped");
  expect((await table("notification_deliveries")).filter(row => row.event_id === brief.eventId)).toHaveLength(0);
});
