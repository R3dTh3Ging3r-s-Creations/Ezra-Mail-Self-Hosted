import {beforeEach,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {calendarPatchToGoogle,updateGoogleEvent} from "@/lib/email/google-calendar-actions";
import {resourceMutationSchema} from "@/lib/email/agent-resource-types";
import {ProviderPreconditionError} from "@/lib/email/agent-provider-support";
const mocks=vi.hoisted(()=>({run:vi.fn(),support:vi.fn()}));
vi.mock("@/lib/email/google-calendar-helper",()=>({runGoogleCalendarHelper:mocks.run}));
vi.mock("@/lib/email/agent-accounts",()=>({assertPersonalAccount:vi.fn(),getAgentCapabilities:async()=>({calendarWrite:"available"})}));
vi.mock("@/lib/email/agent-provider-support",async original=>({...await original<typeof import("@/lib/email/agent-provider-support")>(),getConditionalWriteSupport:mocks.support}));
const account={accountId:"gg",provider:"gmail" as const,expectedEmail:"owner@gmail.test"};
const target={account,kind:"calendar" as const,id:account.expectedEmail};
const before={id:"event",etag:'"old"',status:"confirmed",organizer:{email:account.expectedEmail,self:true},creator:{email:account.expectedEmail,self:true},summary:"Before",description:"Keep",location:"Place",start:{dateTime:"2026-11-06T07:00:00-06:00",timeZone:"America/Chicago"},end:{dateTime:"2026-11-06T07:10:00-06:00",timeZone:"America/Chicago"},visibility:"private",transparency:"transparent",reminders:{useDefault:false,overrides:[]}};
const envelope=(raw:unknown,extra={})=>({protocol:"ezra-event-v1",account:account.expectedEmail,calendarId:target.id,eventId:"event",mode:"read",ifMatch:"",status:"found",raw,...extra});
let current:typeof before;
beforeEach(()=>{vi.clearAllMocks();current=structuredClone(before);mocks.support.mockResolvedValue({available:true});mocks.run.mockImplementation(async(args:string[],_signal:unknown,input?:string)=>{
 if(args.includes("update")){const body=JSON.parse(input!);current={...current,...body,etag:'"new"'};return envelope(current,{protocol:"ezra-event-update-v1",mode:"update",ifMatch:'"old"',status:"updated",patchSha256:createHash("sha256").update(input!).digest("hex")});}
 return envelope(current);
});});
it("accepts Gmail update without enabling Microsoft public privacy",()=>{
 const update={kind:"calendar.update",target,eventId:"event",expectedRevision:'"old"',patch:{privacy:"public"}};
 expect(resourceMutationSchema.safeParse(update).success).toBe(true);
 expect(resourceMutationSchema.safeParse({...update,target:{...target,account:{...account,provider:"microsoft"}}}).success).toBe(false);
});
it("sends only requested Google fields through stdin and verifies exact readback",async()=>{
 const dispatch=vi.fn();await updateGoogleEvent(target,"event",'"old"',{title:"After"},undefined,dispatch);
 expect(dispatch).toHaveBeenCalledOnce();expect(mocks.run).toHaveBeenCalledTimes(3);
 const call=mocks.run.mock.calls.find(([args])=>args.includes("update"))!;
 expect(call[0]).not.toContain("After");expect(JSON.parse(call[2])).toEqual({summary:"After"});
 expect(call[0]).toContain("--patch-stdin");expect(mocks.support).toHaveBeenCalledWith("gmail","calendar.update");
});
it("maps explicit clears, busy/privacy and no reminders without defaulting",()=>{
 expect(calendarPatchToGoogle({description:"",location:"",isBusy:false,privacy:"public",reminder:{mode:"none"}})).toEqual({description:"",location:"",transparency:"transparent",visibility:"public",reminders:{useDefault:false,overrides:[]}});
});
it("maps all-day local boundaries and rejects non-midnight boundaries",()=>{
 const time={startsAt:"2026-11-01T00:00:00-05:00",endsAt:"2026-11-02T00:00:00-06:00",timezone:"America/Chicago",isAllDay:true};
 expect(calendarPatchToGoogle({time})).toEqual({start:{date:"2026-11-01"},end:{date:"2026-11-02"}});
 expect(()=>calendarPatchToGoogle({time:{...time,startsAt:"2026-11-01T01:00:00-05:00"}})).toThrow();
});
it("unqualified updates perform no helper request",async()=>{mocks.support.mockResolvedValue({available:false});await expect(updateGoogleEvent(target,"event",'"old"',{title:"After"})).rejects.toThrow();expect(mocks.run).not.toHaveBeenCalled();});
it("stale preflight does not dispatch",async()=>{const dispatch=vi.fn();await expect(updateGoogleEvent(target,"event",'"stale"',{title:"After"},undefined,dispatch)).rejects.toThrow();expect(dispatch).not.toHaveBeenCalled();expect(mocks.run).toHaveBeenCalledOnce();});
it.each([{summary:"Wrong"},{description:"Lost"},{etag:'"old"'},{attendees:[{}]},{start:{dateTime:"2026-11-06T08:00:00-06:00",timeZone:"America/Chicago"}}])("does not accept changed or incomplete update response %j",async change=>{
 const original=mocks.run.getMockImplementation()!;mocks.run.mockImplementation(async(...args)=>{const result=await original(...args);return args[0].includes("update")?{...result,raw:{...result.raw,...change}}:result;});
 await expect(updateGoogleEvent(target,"event",'"old"',{title:"After"})).rejects.toThrow();expect(mocks.run.mock.calls.filter(([args])=>args.includes("update"))).toHaveLength(1);
});
it("rejects an update receipt for another patch",async()=>{const original=mocks.run.getMockImplementation()!;mocks.run.mockImplementation(async(...args)=>{const result=await original(...args);return args[0].includes("update")?{...result,patchSha256:"0".repeat(64)}:result;});await expect(updateGoogleEvent(target,"event",'"old"',{title:"After"})).rejects.toThrow();});
it("readback mismatch remains unknown without retry",async()=>{mocks.run.mockImplementationOnce(async()=>envelope(before)).mockImplementationOnce(async(_args,_signal,input)=>envelope({...before,summary:"After",etag:'"new"'},{protocol:"ezra-event-update-v1",mode:"update",ifMatch:'"old"',status:"updated",patchSha256:createHash("sha256").update(input).digest("hex")})).mockResolvedValueOnce(envelope({...before,summary:"Other",etag:'"later"'}));await expect(updateGoogleEvent(target,"event",'"old"',{title:"After"})).rejects.toThrow();expect(mocks.run).toHaveBeenCalledTimes(3);});
it("a bound412 is terminal and never retried",async()=>{mocks.run.mockImplementationOnce(async()=>envelope(before)).mockImplementationOnce(async(_args,_signal,input)=>({...envelope(undefined),protocol:"ezra-event-update-v1",mode:"update",ifMatch:'"old"',status:"precondition_failed",patchSha256:createHash("sha256").update(input).digest("hex")}));await expect(updateGoogleEvent(target,"event",'"old"',{title:"After"})).rejects.toBeInstanceOf(ProviderPreconditionError);expect(mocks.run).toHaveBeenCalledTimes(2);});
it("cancellation after authority prevents the helper mutation",async()=>{const controller=new AbortController();await expect(updateGoogleEvent(target,"event",'"old"',{title:"After"},controller.signal,async()=>controller.abort())).rejects.toThrow();expect(mocks.run).toHaveBeenCalledOnce();});
