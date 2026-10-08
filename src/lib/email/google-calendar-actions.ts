import { z } from "zod";
import {createHash} from "node:crypto";
import { assertPersonalAccount, getAgentCapabilities } from "./agent-accounts";
import { GOOGLE_CONDITIONAL_HELPER_REVISION, GOOGLE_UPDATE_HELPER_REVISION, getConditionalWriteSupport, requireConditionalRevision, ProviderPreconditionError, ProviderNotDispatchedError } from "./agent-provider-support";
import { calendarPatchSchema,resourceRefSchema, type CalendarPatch,type ResourceRef, type ResourceMutation } from "./agent-resource-types";
import {canonicalJson} from "./agent-operation-schema";
import {calendarDateInZone,calendarDayBounds} from "./calendar-day";
import { runGoogleCalendarHelper } from "./google-calendar-helper";
const exactId = z.string().min(1).max(1024).regex(/^[^\x00-\x1f*]+$/);
const identity = z.object({ email: z.string().email(), self: z.literal(true) }).passthrough();
const rawSchema = z.object({ id: exactId, etag: z.string(), status: z.literal("confirmed"), organizer: identity, creator: identity, attendees: z.array(z.unknown()).optional(), recurrence: z.array(z.unknown()).optional(), recurringEventId: z.string().optional(), conferenceData: z.unknown().optional(), hangoutLink: z.string().optional(), eventType: z.string().optional() }).passthrough();
const envelopeSchema = z.object({ protocol: z.literal(GOOGLE_CONDITIONAL_HELPER_REVISION), account: z.string(), calendarId: z.string(), eventId: z.string(), mode: z.enum(["read", "delete"]), ifMatch: z.string(), status: z.enum(["found", "absent", "deleted", "precondition_failed", "not_dispatched"]), raw: z.unknown().optional() }).strict();
async function context(input: ResourceRef, eventId: string, signal?: AbortSignal) {
  signal?.throwIfAborted(); const target = resourceRefSchema.parse(input); exactId.parse(eventId);
  if (target.account.provider !== "gmail" || target.kind !== "calendar" || target.id.toLowerCase() !== target.account.expectedEmail.toLowerCase()) throw new Error("Exact owned Google primary calendar required.");
  await assertPersonalAccount(target.account);
  if ((await getAgentCapabilities(target.account, false)).calendarWrite !== "available") throw new Error("Calendar write permission unavailable.");
  signal?.throwIfAborted(); return target;
}
async function invoke(target: ResourceRef, eventId: string, mode: "read" | "delete", revision: string, signal?: AbortSignal) {
  const args = [target.id, eventId, "--account", target.account.expectedEmail, "--mode", mode, ...(mode === "delete" ? ["--if-match", revision, "--force"] : [])];
  const value = envelopeSchema.parse(await runGoogleCalendarHelper(args, signal));
  if (value.account !== target.account.expectedEmail || value.calendarId !== target.id || value.eventId !== eventId || value.mode !== mode || value.ifMatch !== revision) throw new Error("Calendar helper identity mismatch.");
  return value;
}
export async function readGoogleEventMutationEvidence(input: ResourceRef, eventId: string, signal?: AbortSignal) {
  const target = await context(input, eventId, signal); const result = await invoke(target, eventId, "read", "", signal);
  await assertPersonalAccount(target.account); signal?.throwIfAborted();
  if (result.status === "absent" && result.raw === undefined) return { status: "absent" as const };
  if (result.status !== "found") throw new Error("Google calendar read unavailable.");
  const raw = rawSchema.parse(result.raw); requireConditionalRevision(raw.etag);
  if (raw.id !== eventId || raw.organizer.email.toLowerCase() !== target.account.expectedEmail.toLowerCase() || raw.creator.email.toLowerCase() !== target.account.expectedEmail.toLowerCase() || raw.attendees?.length || raw.recurrence !== undefined || raw.recurringEventId !== undefined || raw.conferenceData !== undefined || raw.hangoutLink !== undefined || (raw.eventType !== undefined && raw.eventType !== "default")) throw new Error("Unsupported Google calendar event.");
  return { status: "found" as const, raw, target, complete: true as const, providerRevision: raw.etag, fetchedAt: new Date().toISOString(), identityVerifiedAt: new Date().toISOString() };
}
export async function prepareGoogleCalendarMutationEvidence(mutation: ResourceMutation, signal?: AbortSignal) {
  if ((mutation.kind !== "calendar.delete"&&mutation.kind!=="calendar.update") || mutation.target.account.provider !== "gmail") throw new Error("Unsupported Google mutation.");
  if (!(await getConditionalWriteSupport("gmail", mutation.kind)).available) throw new Error("Conditional calendar writes are not qualified.");
  requireConditionalRevision(mutation.expectedRevision);
  const current = await readGoogleEventMutationEvidence(mutation.target, mutation.eventId, signal);
  if (current.status !== "found" || current.providerRevision !== mutation.expectedRevision) throw new Error("Calendar revision changed or event unavailable.");
  if(mutation.kind==="calendar.update")validateGoogleUpdateBefore(current.raw,calendarPatchToGoogle(mutation.patch));
  return { target: current.target, complete: true as const, providerRevision: current.providerRevision, fetchedAt: current.fetchedAt, identityVerifiedAt: current.identityVerifiedAt, before: current.raw };
}

/** Minimal PATCH: omitted fields retain their provider representation. */
export function calendarPatchToGoogle(input:CalendarPatch):Record<string,unknown>{
 const patch=calendarPatchSchema.parse(input),body:Record<string,unknown>={};
 if(patch.title!==undefined)body.summary=patch.title;
 if(patch.description!==undefined)body.description=patch.description;
 if(patch.location!==undefined)body.location=patch.location;
 if(patch.isBusy!==undefined)body.transparency=patch.isBusy?"opaque":"transparent";
 if(patch.privacy!==undefined)body.visibility=patch.privacy;
 if(patch.reminder)body.reminders=patch.reminder.mode==="default"?{useDefault:true}: {useDefault:false,overrides:patch.reminder.mode==="none"?[]:[{method:"popup",minutes:patch.reminder.minutes}]};
 if(patch.time){const time=patch.time;
  if(time.isAllDay){
   if([time.startsAt,time.endsAt].some(value=>calendarDayBounds(calendarDateInZone(value,time.timezone),time.timezone).startIso!==new Date(value).toISOString()))throw new Error("All-day boundaries must be local midnight.");
   body.start={date:calendarDateInZone(time.startsAt,time.timezone)};body.end={date:calendarDateInZone(time.endsAt,time.timezone)};
  }else{body.start={dateTime:new Date(time.startsAt).toISOString(),timeZone:time.timezone};body.end={dateTime:new Date(time.endsAt).toISOString(),timeZone:time.timezone};}
 }
 return body;
}
const dateBoundary=z.union([z.object({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),dateTime:z.never().optional(),timeZone:z.string().optional()}).passthrough(),z.object({dateTime:z.string().datetime({offset:true}),timeZone:z.string().optional(),date:z.never().optional()}).passthrough()]);
const updateEventSchema=rawSchema.extend({start:dateBoundary,end:dateBoundary,reminders:z.object({useDefault:z.boolean(),overrides:z.array(z.object({method:z.string(),minutes:z.number().int()})).optional()}).passthrough()});
function validateGoogleUpdateBefore(raw:unknown,body:Record<string,unknown>){
 const event=updateEventSchema.parse(raw);
 if(("date" in event.start)!==("date" in event.end)||event.locked===true||event.endTimeUnspecified===true)throw new Error("Unsupported Google event timing.");
 // Cross-kind conversion needs a separate explicitly verified provider contract.
 if(body.start&&("date" in (body.start as object))!==("date" in event.start))throw new Error("Changing between timed and all-day events is unsupported.");
 return event;
}
function normalizedField(key:string,value:unknown):unknown{
 if(["summary","description","location"].includes(key))return value??"";
 if(key==="visibility")return value??"default";
 if(key==="transparency")return value??"opaque";
 if((key==="start"||key==="end")&&value&&typeof value==="object"){
  const time=value as Record<string,unknown>;return time.date!==undefined?{date:time.date}:{instant:Date.parse(String(time.dateTime)),timeZone:time.timeZone??null};
 }
 if(key==="reminders"&&value&&typeof value==="object"){
  const reminders=value as {useDefault:boolean;overrides?:unknown[]};return {useDefault:reminders.useDefault,overrides:reminders.useDefault?[]:reminders.overrides??[]};
 }
 return value??null;
}
function googleUpdateMatches(before:Record<string,unknown>,after:Record<string,unknown>,body:Record<string,unknown>){
 // Provider bookkeeping may change; all remaining returned fields must be preserved.
 const bookkeeping=new Set(["etag","updated","sequence","htmlLink"]);
 const keys=new Set([...Object.keys(before),...Object.keys(after),...Object.keys(body)]);
 return [...keys].every(key=>bookkeeping.has(key)||canonicalJson(normalizedField(key,Object.hasOwn(body,key)?body[key]:before[key]))===canonicalJson(normalizedField(key,after[key])));
}
const updateEnvelopeSchema=z.object({protocol:z.literal(GOOGLE_UPDATE_HELPER_REVISION),account:z.string(),calendarId:z.string(),eventId:z.string(),mode:z.literal("update"),ifMatch:z.string(),patchSha256:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(["updated","precondition_failed","not_dispatched"]),raw:z.unknown().optional()}).strict();
export async function updateGoogleEvent(input:ResourceRef,eventId:string,revision:string,patch:CalendarPatch,signal?:AbortSignal,beforeMutation?:()=>Promise<void>):Promise<void>{
 if(!(await getConditionalWriteSupport("gmail","calendar.update")).available)throw new Error("Conditional calendar writes are not qualified.");
 requireConditionalRevision(revision);const body=calendarPatchToGoogle(patch);
 const before=await readGoogleEventMutationEvidence(input,eventId,signal);
 if(before.status!=="found"||before.providerRevision!==revision)throw new Error("Calendar revision changed or event unavailable.");
 validateGoogleUpdateBefore(before.raw,body);
 const serialized=canonicalJson(body),patchSha256=createHash("sha256").update(serialized).digest("hex");
 signal?.throwIfAborted();await beforeMutation?.();signal?.throwIfAborted();
 const target=before.target;
 const result=updateEnvelopeSchema.parse(await runGoogleCalendarHelper([target.id,eventId,"--account",target.account.expectedEmail,"--mode","update","--if-match",revision,"--force","--patch-stdin","--patch-sha256",patchSha256],signal,serialized));
 if(result.account!==target.account.expectedEmail||result.calendarId!==target.id||result.eventId!==eventId||result.ifMatch!==revision||result.patchSha256!==patchSha256)throw new Error("Calendar helper identity mismatch.");
 if(result.status!=="updated"){
  if(result.raw!==undefined)throw new Error("Malformed calendar mutation result.");
  if(result.status==="not_dispatched")throw new ProviderNotDispatchedError();
  throw new ProviderPreconditionError();
 }
 const updated=validateGoogleUpdateBefore(result.raw,body);requireConditionalRevision(updated.etag);
 if(updated.etag===revision||!googleUpdateMatches(before.raw,updated,body))throw new Error("Calendar update response mismatch.");
 const readback=await readGoogleEventMutationEvidence(target,eventId,signal);
 if(readback.status!=="found"||readback.providerRevision!==updated.etag||!googleUpdateMatches(before.raw,validateGoogleUpdateBefore(readback.raw,body),body))throw new Error("Calendar update readback mismatch.");
}
export async function deleteGoogleEvent(target: ResourceRef, eventId: string, revision: string, signal?: AbortSignal, beforeMutation?: () => Promise<void>): Promise<void> {
  const calendar = resourceRefSchema.extend({ kind: z.literal("calendar") }).parse(target);
  await prepareGoogleCalendarMutationEvidence({ kind: "calendar.delete", target: calendar, eventId, expectedRevision: revision }, signal);
  signal?.throwIfAborted(); await beforeMutation?.(); signal?.throwIfAborted();
  const result = await invoke(target, eventId, "delete", revision, signal);
  if (result.raw !== undefined) throw new Error("Malformed calendar mutation result.");
  if (result.status === "not_dispatched") throw new ProviderNotDispatchedError();
  if (result.status === "precondition_failed") throw new ProviderPreconditionError();
  if (result.status !== "deleted") throw new Error("Unverified Google deletion.");
  if ((await readGoogleEventMutationEvidence(target, eventId, signal)).status !== "absent") throw new Error("Calendar delete readback still found the event.");
}
