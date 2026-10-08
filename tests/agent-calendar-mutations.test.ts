import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { updateMicrosoftEvent,deleteMicrosoftEvent } from "@/lib/email/microsoft-calendar-actions";
const mocks=vi.hoisted(()=>({support:vi.fn(),caps:vi.fn(),personal:vi.fn(),token:vi.fn(),profile:vi.fn(),fetch:vi.fn()}));
vi.mock("@/lib/email/agent-provider-support",async original=>({...await original<typeof import("@/lib/email/agent-provider-support")>(),getConditionalWriteSupport:mocks.support}));
vi.mock("@/lib/email/agent-accounts",()=>({getAgentCapabilities:mocks.caps,assertPersonalAccount:mocks.personal}));
vi.mock("@/lib/email/microsoft",()=>({getMicrosoftAccessToken:mocks.token,getMicrosoftProfile:mocks.profile}));
vi.mock("@/lib/email/microsoft-calendar-delete-policy",()=>({getMicrosoftCalendarDeleteSupport:async()=>({available:true,policyId:"fixture-policy"})}));
const account={accountId:"ms",provider:"microsoft" as const,expectedEmail:"owner@hotmail.test"};
const target={account,kind:"calendar" as const,id:"cal"};
const before={id:"event",subject:"Before",body:{contentType:"text",content:"Keep"},location:{displayName:"Place"},start:{dateTime:"2026-11-06T07:00:00",timeZone:"Central Standard Time"},end:{dateTime:"2026-11-06T07:10:00",timeZone:"Central Standard Time"},isAllDay:false,showAs:"tentative",sensitivity:"personal",isReminderOn:true,reminderMinutesBeforeStart:0,attendees:[],organizer:{emailAddress:{address:account.expectedEmail}},isOrganizer:true,isOnlineMeeting:false,isCancelled:false,type:"singleInstance",recurrence:null,"@odata.etag":'W/"old"'};
describe("qualified conditional calendar mutations",()=>{
  let raw: typeof before;
  beforeEach(()=>{
    vi.clearAllMocks();raw=structuredClone(before);
    mocks.support.mockResolvedValue({available:true});mocks.caps.mockResolvedValue({calendarWrite:"available"});mocks.personal.mockResolvedValue({});mocks.token.mockResolvedValue("fixture");mocks.profile.mockResolvedValue({email:account.expectedEmail});
    mocks.fetch.mockImplementation(async(url,init)=>{
      if(String(url).includes("?$select"))return Response.json({id:"cal",canEdit:true,owner:{address:account.expectedEmail}});
      if(init?.method==="PATCH"){raw={...raw,...JSON.parse(init.body),"@odata.etag":'W/"new"'};return Response.json(raw);}
      if(init?.method==="DELETE")return new Response(null,{status:204});
      return Response.json(raw);
    });vi.stubGlobal("fetch",mocks.fetch);
  });afterEach(()=>vi.unstubAllGlobals());
  it.each([["tentative","personal"],["oof","confidential"]])("title-only patch preserves %s/%s and native Windows timezone",async(showAs,sensitivity)=>{
    raw={...raw,showAs,sensitivity};
    await updateMicrosoftEvent(target,"event",'W/"old"',{title:"After"});
    const write=mocks.fetch.mock.calls.find(([,init])=>init.method==="PATCH")!;
    expect(JSON.parse(write[1].body)).toEqual({subject:"After"});expect(write[1].headers["if-match"]).toBe('W/"old"');
    expect(raw).toMatchObject({showAs,sensitivity,start:before.start,end:before.end,body:before.body,isReminderOn:true,reminderMinutesBeforeStart:0});
  });
  it("accepts equivalent changed instants and provider HTML body representation",async()=>{
    mocks.fetch.mockImplementation(async(url,init)=>{if(String(url).includes("?$select"))return Response.json({id:"cal",canEdit:true,owner:{address:account.expectedEmail}});if(init?.method==="PATCH"){raw={...raw,...JSON.parse(init.body),body:{contentType:"html",content:"<html><body><div>New &amp; literal</div></body></html>"},start:{dateTime:"2026-11-06T13:00:00.0000000",timeZone:"UTC"},end:{dateTime:"2026-11-06T13:10:00.0000000",timeZone:"UTC"},"@odata.etag":'W/"new"'};}return Response.json(raw);});
    await expect(updateMicrosoftEvent(target,"event",'W/"old"',{description:"New & literal",time:{startsAt:"2026-11-06T13:00:00Z",endsAt:"2026-11-06T13:10:00Z",timezone:"America/Chicago",isAllDay:false}})).resolves.toBeUndefined();
  });
  it("unqualified action performs no token or provider request",async()=>{
    mocks.support.mockResolvedValue({available:false});await expect(updateMicrosoftEvent(target,"event",'W/"old"',{title:"After"})).rejects.toThrow(/qualified|unavailable/i);
    expect(mocks.token).not.toHaveBeenCalled();expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([{type:"seriesMaster"},{attendees:[{emailAddress:{address:"other@example.test"}}]},{isOnlineMeeting:true},{id:"moved"},{"@odata.etag":""}])("rejects unsupported or mismatched before-state %#",async patch=>{
    raw={...raw,...patch} as typeof raw;
    await expect(updateMicrosoftEvent(target,"event",'W/"old"',{title:"After"})).rejects.toThrow();
    expect(mocks.fetch.mock.calls.some(([,init])=>init.method==="PATCH")).toBe(false);
  });
  it("rejects stale requested revision before patch",async()=>{
    await expect(updateMicrosoftEvent(target,"event",'W/"stale"',{title:"After"})).rejects.toThrow(/revision/i);
    expect(mocks.fetch.mock.calls.some(([,init])=>init.method==="PATCH")).toBe(false);
  });
  it("treats provider 412 as a precondition rejection, never success",async()=>{
    mocks.fetch.mockImplementation(async(url,init)=>String(url).includes("?$select")?Response.json({id:"cal",canEdit:true,owner:{address:account.expectedEmail}}):init?.method==="PATCH"?new Response(null,{status:412}):Response.json(raw));
    await expect(updateMicrosoftEvent(target,"event",'W/"old"',{title:"After"})).rejects.toMatchObject({code:"provider_precondition_failed"});
  });
  it("requires exact readback after update",async()=>{
    let patched=false;mocks.fetch.mockImplementation(async(url,init)=>{
      if(String(url).includes("?$select"))return Response.json({id:"cal",canEdit:true,owner:{address:account.expectedEmail}});
      if(init?.method==="PATCH"){patched=true;return Response.json({...raw,subject:"After","@odata.etag":'W/"new"'});}
      return Response.json(patched?{...raw,subject:"Different","@odata.etag":'W/"later"'}:raw);
    });await expect(updateMicrosoftEvent(target,"event",'W/"old"',{title:"After"})).rejects.toThrow(/readback/i);
  });
  it("initial absence never becomes a deleted receipt",async()=>{
    mocks.fetch.mockImplementation(async url=>String(url).includes("?$select")?Response.json({id:"cal",canEdit:true,owner:{address:account.expectedEmail}}):new Response(null,{status:404}));
    await expect(deleteMicrosoftEvent(target,"event",'W/"old"')).rejects.toThrow();
    expect(mocks.fetch.mock.calls.some(([,init])=>init.method==="DELETE")).toBe(false);
  });
});
