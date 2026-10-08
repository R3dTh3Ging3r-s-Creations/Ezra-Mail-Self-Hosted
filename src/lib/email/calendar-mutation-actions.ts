import { prepareCalendarMutationEvidence as prepareMicrosoft, readMicrosoftEventMutationEvidence, deleteMicrosoftEvent,updateMicrosoftEvent } from "./microsoft-calendar-actions";
import { prepareGoogleCalendarMutationEvidence, readGoogleEventMutationEvidence, deleteGoogleEvent,updateGoogleEvent } from "./google-calendar-actions";
import type { CalendarPatch,ResourceMutation, ResourceRef } from "./agent-resource-types";
export async function prepareCalendarMutationEvidence(mutation: ResourceMutation, signal?: AbortSignal) {
  if (mutation.kind !== "calendar.update" && mutation.kind !== "calendar.delete") throw new Error("Unsupported calendar mutation.");
  return mutation.target.account.provider === "gmail" ? prepareGoogleCalendarMutationEvidence(mutation, signal) : prepareMicrosoft(mutation, signal);
}
export async function readCalendarEventMutationEvidence(target: ResourceRef, eventId: string, signal?: AbortSignal) {
  return target.account.provider === "gmail" ? readGoogleEventMutationEvidence(target, eventId, signal) : readMicrosoftEventMutationEvidence(target, eventId, signal);
}
export async function deleteCalendarEvent(target: ResourceRef, eventId: string, revision: string, signal?: AbortSignal, beforeMutation?: () => Promise<void>) {
  return target.account.provider === "gmail" ? deleteGoogleEvent(target, eventId, revision, signal, beforeMutation) : deleteMicrosoftEvent(target, eventId, revision, signal, beforeMutation);
}
export async function updateCalendarEvent(target:ResourceRef,eventId:string,revision:string,patch:CalendarPatch,signal?:AbortSignal,beforeMutation?:()=>Promise<void>){
 return target.account.provider==="gmail"?updateGoogleEvent(target,eventId,revision,patch,signal,beforeMutation):updateMicrosoftEvent(target,eventId,revision,patch,signal,beforeMutation);
}
