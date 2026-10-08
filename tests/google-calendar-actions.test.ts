import { beforeEach, expect, it, vi } from "vitest";
import { deleteGoogleEvent, readGoogleEventMutationEvidence, prepareGoogleCalendarMutationEvidence } from "@/lib/email/google-calendar-actions";
import { ProviderPreconditionError, ProviderNotDispatchedError } from "@/lib/email/agent-provider-support";
const mocks=vi.hoisted(()=>({run:vi.fn(),personal:vi.fn(),caps:vi.fn(),support:vi.fn()}));
vi.mock("@/lib/email/google-calendar-helper",()=>({runGoogleCalendarHelper:mocks.run}));
vi.mock("@/lib/email/agent-accounts",()=>({assertPersonalAccount:mocks.personal,getAgentCapabilities:mocks.caps}));
vi.mock("@/lib/email/agent-provider-support",async original=>({...await original<typeof import("@/lib/email/agent-provider-support")>(),getConditionalWriteSupport:mocks.support}));
const account={accountId:"gg",provider:"gmail" as const,expectedEmail:"owner@gmail.test"};
const target={account,kind:"calendar" as const,id:account.expectedEmail};
const raw={id:"event",etag:'"old"',status:"confirmed",organizer:{email:account.expectedEmail,self:true},creator:{email:account.expectedEmail,self:true}};
const envelope=(status="found",mode="read",extra={})=>({protocol:"ezra-event-v1",account:account.expectedEmail,calendarId:target.id,eventId:"event",mode,ifMatch:mode==="delete"?'"old"':"",status,...(status==="found"?{raw}:{}),...extra});
beforeEach(()=>{vi.clearAllMocks();mocks.personal.mockResolvedValue(undefined);mocks.caps.mockResolvedValue({calendarWrite:"available"});mocks.support.mockResolvedValue({available:true});mocks.run.mockResolvedValue(envelope());});
it("reads exact owned event with opaque revision",async()=>{expect(await readGoogleEventMutationEvidence(target,"event")).toMatchObject({status:"found",providerRevision:'"old"',raw});});
it.each([{id:"wrong"},{etag:"change-key"},{etag:undefined},{attendees:[{}]},{recurrence:["RRULE:FREQ=DAILY"]},{recurringEventId:"parent"},{conferenceData:{}},{hangoutLink:"https://meet.test"},{organizer:{email:"other@gmail.test",self:true}},{creator:{email:account.expectedEmail,self:false}},{status:"cancelled"}])("rejects unsupported provider evidence %j",async patch=>{mocks.run.mockResolvedValue(envelope("found","read",{raw:{...raw,...patch}}));await expect(readGoogleEventMutationEvidence(target,"event")).rejects.toThrow();});
it.each([{account:"other@gmail.test"},{calendarId:"other"},{eventId:"other"},{mode:"delete"},{protocol:"wrong"},{ifMatch:'"old"'}])("rejects mismatched response envelope %j",async patch=>{mocks.run.mockResolvedValue(envelope("absent","read",patch));await expect(readGoogleEventMutationEvidence(target,"event")).rejects.toThrow();});
it.each([{...target,id:"primary"},{...target,id:"other@gmail.test"},{...target,kind:"task_list"},{...target,account:{...account,provider:"microsoft"}}])("rejects wrong target before helper %j",async input=>{await expect(readGoogleEventMutationEvidence(input as typeof target,"event")).rejects.toThrow();expect(mocks.run).not.toHaveBeenCalled();});
it("rejects stale revision before preparation",async()=>{await expect(prepareGoogleCalendarMutationEvidence({kind:"calendar.delete",target,eventId:"event",expectedRevision:'"stale"'})).rejects.toThrow();});
it("authorizes once immediately before delete and verifies exact absence",async()=>{const before=vi.fn();mocks.run.mockResolvedValueOnce(envelope()).mockImplementationOnce(async()=>{expect(before).toHaveBeenCalledOnce();return envelope("deleted","delete");}).mockResolvedValueOnce(envelope("absent"));await deleteGoogleEvent(target,"event",'"old"',undefined,before);expect(mocks.run).toHaveBeenCalledTimes(3);});
it("preflight absence never authorizes deletion",async()=>{const before=vi.fn();mocks.run.mockResolvedValue(envelope("absent"));await expect(deleteGoogleEvent(target,"event",'"old"',undefined,before)).rejects.toThrow();expect(before).not.toHaveBeenCalled();});
it("helper preflight disappearance is a definitive non-dispatch",async()=>{mocks.run.mockResolvedValueOnce(envelope()).mockResolvedValueOnce(envelope("not_dispatched","delete"));await expect(deleteGoogleEvent(target,"event",'"old"')).rejects.toBeInstanceOf(ProviderNotDispatchedError);});
it("helper 412 is a definitive precondition rejection",async()=>{mocks.run.mockResolvedValueOnce(envelope()).mockResolvedValueOnce(envelope("precondition_failed","delete"));await expect(deleteGoogleEvent(target,"event",'"old"')).rejects.toBeInstanceOf(ProviderPreconditionError);});
it("postdispatch readback failure stays unverified",async()=>{mocks.run.mockResolvedValueOnce(envelope()).mockResolvedValueOnce(envelope("deleted","delete")).mockRejectedValueOnce(new Error("unavailable"));await expect(deleteGoogleEvent(target,"event",'"old"')).rejects.toThrow("unavailable");});
it("cancellation after callback prevents helper mutation",async()=>{const controller=new AbortController();await expect(deleteGoogleEvent(target,"event",'"old"',controller.signal,async()=>controller.abort())).rejects.toThrow();expect(mocks.run).toHaveBeenCalledOnce();});
it("unqualified delete never invokes helper",async()=>{mocks.support.mockResolvedValue({available:false});await expect(deleteGoogleEvent(target,"event",'"old"')).rejects.toThrow();expect(mocks.run).not.toHaveBeenCalled();});

it.each([{account:"other@gmail.test"},{calendarId:"other"},{eventId:"other"},{ifMatch:'"other"'},{protocol:"wrong"}])("unbound non-dispatch response stays unverified %j",async patch=>{
 mocks.run.mockResolvedValueOnce(envelope()).mockResolvedValueOnce(envelope("not_dispatched","delete",patch));
 try { await deleteGoogleEvent(target,"event",'"old"'); throw new Error("unexpected success"); } catch(error) {
  expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(ProviderNotDispatchedError); expect(error).not.toBeInstanceOf(ProviderPreconditionError); expect((error as Error).message).not.toBe("unexpected success");
 }
 expect(mocks.run).toHaveBeenCalledTimes(2);
});
