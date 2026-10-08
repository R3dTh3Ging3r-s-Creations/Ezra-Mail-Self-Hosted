import { getMicrosoftCalendarDeleteSupport } from "./microsoft-calendar-delete-policy";
import {changedProviderFieldMatches} from "./microsoft-value-evidence";
import { z } from "zod";
import { assertPersonalAccount,getAgentCapabilities } from "./agent-accounts";
import { getMicrosoftAccessToken,getMicrosoftProfile } from "./microsoft";
import { getConditionalWriteSupport,requireConditionalRevision,ProviderPreconditionError } from "./agent-provider-support";
import { calendarPatchSchema,resourceRefSchema,type CalendarPatch,type ResourceRef,type ResourceMutation } from "./agent-resource-types";
import { canonicalJson } from "./agent-operation-schema";
import { calendarDateInZone,calendarDayBounds } from "./calendar-day";

const ROOT="https://graph.microsoft.com/v1.0/me/calendars";
const dateTime=z.object({dateTime:z.string().min(1).max(100),timeZone:z.string().min(1).max(100)}).passthrough();
const rawSchema=z.object({
  id:z.string().min(1).max(1024),subject:z.string().max(10_000),body:z.object({contentType:z.string(),content:z.string().max(100_000)}).passthrough(),
  start:dateTime,end:dateTime,isAllDay:z.boolean(),location:z.object({displayName:z.string()}).passthrough(),
  showAs:z.string(),sensitivity:z.string(),isReminderOn:z.boolean(),reminderMinutesBeforeStart:z.number().int().nonnegative(),
  attendees:z.array(z.unknown()),organizer:z.object({emailAddress:z.object({address:z.string().email()}).passthrough()}).passthrough(),
  isOrganizer:z.boolean(),isOnlineMeeting:z.boolean(),isCancelled:z.boolean(),type:z.string(),recurrence:z.unknown().optional(),seriesMasterId:z.string().nullish(),
  "@odata.etag":z.string().min(1).max(2048),
}).passthrough();
export type RawCalendarMutationEvent=z.infer<typeof rawSchema>;
type Context={target:ResourceRef;token:string;signal:AbortSignal;identityVerifiedAt:string};
async function graph(ctx:Context,url:string,init:RequestInit={},absent=false,beforeMutation?:()=>Promise<void>):Promise<Record<string,unknown>|null>{
  ctx.signal.throwIfAborted();
  await beforeMutation?.();
  const response=await fetch(url,{...init,signal:ctx.signal,redirect:"error",headers:{authorization:`Bearer ${ctx.token}`,"content-type":"application/json",prefer:'IdType="ImmutableId"',...init.headers}});
  if(absent&&response.status===404)return null;
  if(response.status===412)throw new ProviderPreconditionError();
  if(!response.ok)throw new Error("Microsoft calendar mutation request unavailable.");
  if(response.status===204)return {};
  const reader=response.body?.getReader();if(!reader)throw new Error("Incomplete calendar response.");
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>4_194_304){await reader.cancel();throw new Error("Calendar response exceeds limit.");}chunks.push(item.value);}}finally{reader.releaseLock();}
  const raw:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("Malformed calendar response.");
  const result=raw as Record<string,unknown>;
  if(!result["@odata.etag"]&&response.headers.get("etag"))result["@odata.etag"]=response.headers.get("etag");
  return result;
}
async function context(input:ResourceRef,parent?:AbortSignal):Promise<Context>{
  const target=resourceRefSchema.parse(input);
  if(target.kind!=="calendar"||target.account.provider!=="microsoft"||target.id==="primary")throw new Error("Exact Microsoft calendar required.");
  const signal=AbortSignal.any([AbortSignal.timeout(120_000),...(parent?[parent]:[])]);
  await assertPersonalAccount(target.account);
  if((await getAgentCapabilities(target.account,false)).calendarWrite!=="available")throw new Error("Calendar write permission unavailable.");
  const token=await getMicrosoftAccessToken(target.account.expectedEmail,"calendar-write",signal);
  if((await getMicrosoftProfile(token,signal)).email.toLowerCase()!==target.account.expectedEmail.toLowerCase())throw new Error("Calendar provider identity changed.");
  const ctx={target,token,signal,identityVerifiedAt:new Date().toISOString()};
  const calendar=await graph(ctx,`${ROOT}/${encodeURIComponent(target.id)}?$select=id,owner,canEdit`);
  const parsed=z.object({id:z.string(),canEdit:z.boolean(),owner:z.object({address:z.string()})}).parse(calendar);
  if(parsed.id!==target.id||!parsed.canEdit||parsed.owner.address.toLowerCase()!==target.account.expectedEmail.toLowerCase())throw new Error("Calendar is unavailable or shared.");
  return ctx;
}
function path(ctx:Context,id:string){z.string().min(1).max(1024).regex(/^[^\x00-\x1f*]+$/).parse(id);return `${ROOT}/${encodeURIComponent(ctx.target.id)}/events/${encodeURIComponent(id)}`;}
function supported(raw:RawCalendarMutationEvent,ctx:Context,id:string){
  requireConditionalRevision(raw["@odata.etag"]);
  if(raw.id!==id||raw.type!=="singleInstance"||raw.recurrence!=null||raw.seriesMasterId||raw.attendees.length||!raw.isOrganizer||raw.isOnlineMeeting||raw.isCancelled||raw.organizer.emailAddress.address.toLowerCase()!==ctx.target.account.expectedEmail.toLowerCase())throw new Error("Unsupported or changed calendar event identity.");
  return raw;
}
async function confirmMailboxAbsence(ctx:Context,eventId:string):Promise<void>{
  // Immutable IDs survive same-mailbox calendar moves. An original-calendar 404
  // alone is not deletion. Request only this exact ID, never other event content.
  const found=await graph(ctx,`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}?$select=id`,{},true);
  if(found)throw new Error("Calendar event still exists or moved within the mailbox.");
}
export async function readMicrosoftEventMutationEvidence(target:ResourceRef,eventId:string,signal?:AbortSignal){
  const ctx=await context(target,signal);const value=await graph(ctx,path(ctx,eventId),{},true);
  await assertPersonalAccount(target.account);
  if(!value){await confirmMailboxAbsence(ctx,eventId);return {status:"absent" as const};}
  const raw=supported(rawSchema.parse(value),ctx,eventId);
  return {status:"found" as const,raw,target,complete:true as const,providerRevision:raw["@odata.etag"],fetchedAt:new Date().toISOString(),identityVerifiedAt:ctx.identityVerifiedAt};
}
export async function prepareCalendarMutationEvidence(mutation:ResourceMutation,signal?:AbortSignal){
  if(mutation.kind!=="calendar.update"&&mutation.kind!=="calendar.delete")throw new Error("Unsupported calendar mutation.");
  const deletePolicy = mutation.kind === "calendar.delete" ? await getMicrosoftCalendarDeleteSupport(mutation.target.account) : undefined;
  if (deletePolicy && !deletePolicy.available) throw new Error("Microsoft ordinary deletion policy unavailable.");
  if (mutation.kind === "calendar.update" && !(await getConditionalWriteSupport("microsoft",mutation.kind)).available) throw new Error("Conditional calendar writes are not qualified.");
  requireConditionalRevision(mutation.expectedRevision);
  if(mutation.kind==="calendar.update")calendarPatchToGraph(mutation.patch);
  const evidence=await readMicrosoftEventMutationEvidence(mutation.target,mutation.eventId,signal);
  if(evidence.status!=="found"||evidence.providerRevision!==mutation.expectedRevision)throw new Error("Calendar revision changed or event unavailable.");
  return {target:mutation.target,complete:true as const,providerRevision:evidence.providerRevision,fetchedAt:evidence.fetchedAt,identityVerifiedAt:evidence.identityVerifiedAt,before:evidence.raw,...(deletePolicy?.available ? {deletePolicyId:deletePolicy.policyId} : {})};
}
export function calendarPatchToGraph(input:CalendarPatch){
  const patch=calendarPatchSchema.parse(input);const result:Record<string,unknown>={};
  if(patch.title!==undefined)result.subject=patch.title;
  if(patch.description!==undefined)result.body={contentType:"text",content:patch.description};
  if(patch.location!==undefined)result.location={displayName:patch.location};
  if(patch.time){const t=patch.time;
    if(t.isAllDay&&[t.startsAt,t.endsAt].some(value=>calendarDayBounds(calendarDateInZone(value,t.timezone),t.timezone).startIso!==new Date(value).toISOString()))throw new Error("All-day boundaries must be local midnight.");
    result.start={dateTime:t.isAllDay?`${calendarDateInZone(t.startsAt,t.timezone)}T00:00:00`:new Date(t.startsAt).toISOString().replace(/Z$/,""),timeZone:t.isAllDay?t.timezone:"UTC"};
    result.end={dateTime:t.isAllDay?`${calendarDateInZone(t.endsAt,t.timezone)}T00:00:00`:new Date(t.endsAt).toISOString().replace(/Z$/,""),timeZone:t.isAllDay?t.timezone:"UTC"};result.isAllDay=t.isAllDay;
  }
  if(patch.reminder){if(patch.reminder.mode==="default")throw new Error("Default reminder reset is unavailable; choose explicit minutes or none.");result.isReminderOn=patch.reminder.mode!=="none";if(patch.reminder.mode==="minutes")result.reminderMinutesBeforeStart=patch.reminder.minutes;}
  if(patch.isBusy!==undefined)result.showAs=patch.isBusy?"busy":"free";
  if(patch.privacy!==undefined){if(patch.privacy==="public")throw new Error("Microsoft public privacy is unsupported.");result.sensitivity=patch.privacy==="private"?"private":"normal";}
  return result;
}
function matchesPatch(before:RawCalendarMutationEvent,after:RawCalendarMutationEvent,patch:Record<string,unknown>){
  const keys=["subject","body","location","start","end","isAllDay","showAs","sensitivity","isReminderOn","reminderMinutesBeforeStart","attendees","organizer","isOrganizer","isOnlineMeeting","type","recurrence","seriesMasterId"];
  return keys.every(key=>{
    const expected=Object.hasOwn(patch,key)?patch[key]:before[key];
    const actual=after[key];
    if(key==="location"&&Object.hasOwn(patch,key))return (actual as {displayName?:string})?.displayName===(expected as {displayName?:string}).displayName;
    return Object.hasOwn(patch,key)?changedProviderFieldMatches(key,expected,actual):canonicalJson(actual??null)===canonicalJson(expected??null);
  });
}
export async function updateMicrosoftEvent(target:ResourceRef,eventId:string,revision:string,patch:CalendarPatch,signal?:AbortSignal,beforeMutation?:()=>Promise<void>):Promise<void>{
  if(!(await getConditionalWriteSupport("microsoft","calendar.update")).available)throw new Error("Conditional calendar writes are not qualified.");
  requireConditionalRevision(revision);const body=calendarPatchToGraph(patch);const ctx=await context(target,signal);
  const beforeValue=await graph(ctx,path(ctx,eventId),{},true);if(!beforeValue)throw new Error("Calendar event unavailable.");
  const before=supported(rawSchema.parse(beforeValue),ctx,eventId);if(before["@odata.etag"]!==revision)throw new Error("Calendar revision changed.");
  const response=supported(rawSchema.parse(await graph(ctx,path(ctx,eventId),{method:"PATCH",headers:{"if-match":revision},body:JSON.stringify(body)},false,beforeMutation)),ctx,eventId);
  if(response["@odata.etag"]===revision||!matchesPatch(before,response,body))throw new Error("Calendar update response did not verify the patch.");
  const current=supported(rawSchema.parse(await graph(ctx,path(ctx,eventId))),ctx,eventId);
  if(current["@odata.etag"]!==response["@odata.etag"]||!matchesPatch(before,current,body))throw new Error("Calendar update readback mismatch.");
}
export async function deleteMicrosoftEvent(target:ResourceRef,eventId:string,revision:string,signal?:AbortSignal,beforeMutation?:()=>Promise<void>):Promise<void>{
  const policy = await getMicrosoftCalendarDeleteSupport(target.account);
  if (!policy.available) throw new Error("Microsoft ordinary deletion policy unavailable.");
  requireConditionalRevision(revision);const ctx=await context(target,signal);
  const value=await graph(ctx,path(ctx,eventId),{},true);if(!value)throw new Error("Calendar event unavailable.");
  const before=supported(rawSchema.parse(value),ctx,eventId);if(before["@odata.etag"]!==revision)throw new Error("Calendar revision changed.");
  // Graph DELETE does not honor the stale If-Match guard qualified for PATCH.
  // Owner accepted the remaining race after this fresh read; never claim atomicity.
  await graph(ctx,path(ctx,eventId),{method:"DELETE"},false,async()=>{
    const current = await getMicrosoftCalendarDeleteSupport(target.account);
    if (!current.available || current.policyId !== policy.policyId) throw new Error("Microsoft deletion policy changed.");
    await beforeMutation?.();
  });
  if(await graph(ctx,path(ctx,eventId),{},true))throw new Error("Calendar delete readback still found the event.");
  await confirmMailboxAbsence(ctx,eventId);
}
