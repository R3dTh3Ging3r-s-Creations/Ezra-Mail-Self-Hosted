import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {configureEmailDatabaseForTests,execute,setSetting} from "@/lib/email/database";
import {prepareAgentOperation,agentResourceStore} from "@/lib/email/agent-resource-store";
import {executeAgentOperation,reconcileAgentOperation} from "@/lib/email/agent-resource-operations";
const mocks=vi.hoisted(()=>({support:vi.fn(),caps:vi.fn(),personal:vi.fn(),token:vi.fn(),profile:vi.fn(),fetch:vi.fn()}));
vi.mock("@/lib/email/agent-provider-support",async original=>({...await original<typeof import("@/lib/email/agent-provider-support")>(),getConditionalWriteSupport:mocks.support}));
vi.mock("@/lib/email/agent-accounts",()=>({getAgentCapabilities:mocks.caps,assertPersonalAccount:mocks.personal}));
vi.mock("@/lib/email/microsoft",()=>({getMicrosoftAccessToken:mocks.token,getMicrosoftProfile:mocks.profile}));
const account={accountId:"ms",provider:"microsoft" as const,expectedEmail:"owner@hotmail.test"};
const target={account,kind:"calendar" as const,id:"cal"},principal={keyId:"fixture",revision:1};
const raw={id:"event",subject:"Before",body:{contentType:"text",content:"Keep"},location:{displayName:"Place"},start:{dateTime:"2026-11-06T07:00:00",timeZone:"Central Standard Time"},end:{dateTime:"2026-11-06T07:10:00",timeZone:"Central Standard Time"},isAllDay:false,showAs:"free",sensitivity:"normal",isReminderOn:true,reminderMinutesBeforeStart:0,attendees:[],organizer:{emailAddress:{address:account.expectedEmail}},isOrganizer:true,isOnlineMeeting:false,isCancelled:false,type:"singleInstance",recurrence:null,"@odata.etag":'W/"old"'};
const policy={version:1,policy:"graph-v1-owned-appointment-delete-v1",account,acceptedAt:"2026-10-08T00:00:00.000Z",approvalId:"owner-approval-fixture",externalEditRaceAccepted:true};
const deletion={kind:"calendar.delete" as const,target,eventId:"event",expectedRevision:'W/"old"'};
describe("account-bound ordinary Microsoft deletion",()=>{
 beforeEach(async()=>{vi.clearAllMocks();configureEmailDatabaseForTests(`file:./delete-boundary-${randomUUID()}.sqlite`);await setSetting("agent_personal_accounts",JSON.stringify([account,{accountId:"gg",provider:"gmail",expectedEmail:"owner@gmail.test"}]));await execute("INSERT INTO email_accounts(id,provider,email,label,status,created_at,updated_at) VALUES ('ms','microsoft',?,'Fixture','connected',?,?)",[account.expectedEmail,new Date().toISOString(),new Date().toISOString()]);await execute("INSERT INTO agent_grants(key_id,secret_digest,grant_json,revision,created_at,expires_at) VALUES ('fixture','synthetic',?,1,?,?)",[JSON.stringify({label:"Fixture",lifetimeDays:7,accounts:[account],resources:[target],scopes:["calendar.delete"]}),new Date().toISOString(),new Date(Date.now()+86400000).toISOString()]);await setSetting("agent_microsoft_calendar_delete_policy",JSON.stringify(policy));mocks.support.mockResolvedValue({available:false});mocks.caps.mockResolvedValue({calendarWrite:"available"});mocks.personal.mockResolvedValue({});mocks.token.mockResolvedValue("synthetic");mocks.profile.mockResolvedValue({email:account.expectedEmail});vi.stubGlobal("fetch",mocks.fetch);});
 afterEach(()=>vi.unstubAllGlobals());
 it("absence on adapter final GET cannot fabricate a dispatched delete receipt",async()=>{let gets=0;mocks.fetch.mockImplementation(async(url,init)=>{if(String(url).includes("/calendars/cal?$select"))return Response.json({id:"cal",canEdit:true,owner:{address:account.expectedEmail}});if(init?.method==="DELETE")throw new Error("DELETE must not happen");return ++gets<=2?Response.json(raw):new Response(null,{status:404});});const op=await prepareAgentOperation(principal,"request",{kind:"calendar.delete",target,eventId:"event",expectedRevision:'W/"old"'});expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"failed"});expect(mocks.fetch.mock.calls.filter(([,init])=>init.method==="DELETE")).toHaveLength(0);expect((await execute("SELECT dispatched_at FROM agent_resource_operation_attempts WHERE operation_id=?",[op.id])).rows[0].dispatched_at).toBeNull();expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({status:"failed"});});
 it("deletes the exact appointment without pretending If-Match is supported",async()=>{
  let deleted=false;mocks.fetch.mockImplementation(async(url,init)=>{
   if(String(url).includes("/calendars/cal?$select"))return Response.json({id:"cal",canEdit:true,owner:{address:account.expectedEmail}});
   if(String(url).includes("/me/events/"))return deleted?new Response(null,{status:404}):Response.json({id:"event"});
   expect(String(url)).toBe("https://graph.microsoft.com/v1.0/me/calendars/cal/events/event");
   if(init.method==="DELETE"){expect(init.headers["if-match"]).toBeUndefined();expect(init.headers.prefer).toBe('IdType="ImmutableId"');deleted=true;return new Response(null,{status:204});}
   return deleted?new Response(null,{status:404}):Response.json(raw);
  });
  const op=await prepareAgentOperation(principal,"ordinary-delete",deletion);
  expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"succeeded",receipt:{providerId:"event",outcome:"deleted"}});
  expect(mocks.fetch.mock.calls.filter(([,init])=>init.method==="DELETE")).toHaveLength(1);
  expect((await prepareAgentOperation(principal,"ordinary-delete",deletion)).id).toBe(op.id);
  await executeAgentOperation(principal,op.id,op.payloadHash);
  expect(mocks.fetch.mock.calls.filter(([,init])=>init.method==="DELETE")).toHaveLength(1);
 });

 function providerReads(event:Record<string,unknown>=raw){mocks.fetch.mockImplementation(async url=>String(url).includes("/calendars/cal?$select")?Response.json({id:"cal",canEdit:true,owner:{address:account.expectedEmail}}):Response.json(event));}
 const writes=()=>mocks.fetch.mock.calls.filter(([,init])=>init.method==="DELETE");
 it.each([null,{...policy,externalEditRaceAccepted:false},{...policy,account:{...account,accountId:"other"}},{...policy,account:{...account,expectedEmail:"other@hotmail.test"}},{...policy,acceptedAt:"2999-01-01T00:00:00.000Z"},{...policy,policy:"future-policy"}])("unapproved or mismatched policy blocks provider access %#",async value=>{
  await setSetting("agent_microsoft_calendar_delete_policy",JSON.stringify(value));providerReads();
  await expect(prepareAgentOperation(principal,"blocked",deletion)).rejects.toThrow();expect(mocks.fetch).not.toHaveBeenCalled();expect(mocks.token).not.toHaveBeenCalled();
 });
 it.each([{type:"seriesMaster"},{recurrence:{pattern:{type:"daily"}}},{attendees:[{}]},{isOnlineMeeting:true},{isOrganizer:false},{organizer:{emailAddress:{address:"other@example.test"}}},{id:"other"},{isCancelled:true},{body:undefined},{"@odata.etag":'W/"changed"'}])("rejects unsafe or changed exact appointment %#",async patch=>{
  providerReads({...raw,...patch});await expect(prepareAgentOperation(principal,"unsafe",deletion)).rejects.toThrow();expect(writes()).toHaveLength(0);
 });
 it("rejects a foreign calendar even when the event looks owned",async()=>{
  providerReads();mocks.fetch.mockResolvedValueOnce(Response.json({id:"cal",canEdit:true,owner:{address:"other@example.test"}}));
  await expect(prepareAgentOperation(principal,"shared",deletion)).rejects.toThrow();expect(writes()).toHaveLength(0);
 });
 it.each(["missing","replaced"])("does not reactivate a %s preparation policy",async mode=>{
  providerReads();const op=mode==="missing" ? await agentResourceStore.prepareKeyOperation(principal,"old",deletion,{target,complete:true,providerRevision:'W/"old"',fetchedAt:new Date().toISOString(),identityVerifiedAt:new Date().toISOString(),before:raw}) : await prepareAgentOperation(principal,"old",deletion);
  if(mode==="replaced")await setSetting("agent_microsoft_calendar_delete_policy",JSON.stringify({...policy,approvalId:"replacement"}));
  await expect(executeAgentOperation(principal,op.id,op.payloadHash)).rejects.toThrow();
  expect(writes()).toHaveLength(0);expect((await execute("SELECT * FROM agent_resource_operation_attempts")).rows).toHaveLength(0);
 });
 it.each(["revoked","expired","policy","revision"])("rechecks %s immediately before dispatch",async mode=>{
  let reads=0;mocks.fetch.mockImplementation(async url=>{
   if(String(url).includes("/calendars/cal?$select"))return Response.json({id:"cal",canEdit:true,owner:{address:account.expectedEmail}});
   if(++reads===3){
    if(mode==="revoked")await execute("UPDATE agent_grants SET revoked_at=? WHERE key_id='fixture'",[new Date().toISOString()]);
    if(mode==="expired")await execute("UPDATE agent_grants SET expires_at='2000-01-01T00:00:00.000Z' WHERE key_id='fixture'");
    if(mode==="policy")await setSetting("agent_microsoft_calendar_delete_policy","null");
    if(mode==="revision")return Response.json({...raw,"@odata.etag":'W/"changed"'});
   }return Response.json(raw);
  });
  const op=await prepareAgentOperation(principal,"boundary",deletion);
  // Revocation/expiry may deny the final operation-status read as well.
  await executeAgentOperation(principal,op.id,op.payloadHash).catch(()=>undefined);
  expect(writes()).toHaveLength(0);
  expect((await execute("SELECT status FROM agent_resource_operations WHERE id=?",[op.id])).rows[0].status).toBe("failed");
  expect((await execute("SELECT dispatched_at FROM agent_resource_operation_attempts WHERE operation_id=?",[op.id])).rows[0].dispatched_at).toBeNull();
 });
 it.each(["lost-response","readback-outage","still-present"])("keeps %s unknown and locked without replay",async failure=>{
  let attempted=false;let absent=false;let outage=true;
  mocks.fetch.mockImplementation(async(url,init)=>{
   if(String(url).includes("/calendars/cal?$select"))return Response.json({id:"cal",canEdit:true,owner:{address:account.expectedEmail}});
   if(init.method==="DELETE"){attempted=true;if(failure==="lost-response")throw new Error("lost");return new Response(null,{status:204});}
   if(absent)return new Response(null,{status:404});
   if(attempted&&outage&&failure==="readback-outage")return new Response(null,{status:503});
   return Response.json(raw);
  });
  const op=await prepareAgentOperation(principal,"unknown",deletion);
  expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"unknown",errorCode:"unverified_provider_outcome"});
  expect((await execute("SELECT * FROM agent_resource_locks")).rows).toHaveLength(1);
  expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"unknown"});
  expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({status:"unknown"});
  outage=false;const duplicate=await prepareAgentOperation(principal,"replacement-attempt",deletion);
  expect(await executeAgentOperation(principal,duplicate.id,duplicate.payloadHash)).toMatchObject({status:"approved"});expect(writes()).toHaveLength(1);
  absent=true;expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({status:"succeeded",receipt:{providerId:"event",outcome:"deleted"}});expect(writes()).toHaveLength(1);
 });

 it.each([200,403,503])("does not confuse original-calendar absence with deletion when mailbox lookup returns %s",async mailboxStatus=>{
  let attempted=false;
  mocks.fetch.mockImplementation(async(url,init)=>{
   if(String(url).includes("/me/events/")){expect(String(url)).toBe("https://graph.microsoft.com/v1.0/me/events/event?$select=id");expect(init.headers.prefer).toBe('IdType="ImmutableId"');return mailboxStatus===200?Response.json({id:"event"}):new Response(null,{status:mailboxStatus});}
   if(String(url).includes("/calendars/cal?$select"))return Response.json({id:"cal",canEdit:true,owner:{address:account.expectedEmail}});
   if(init.method==="DELETE"){attempted=true;throw new Error("lost response");}
   return attempted?new Response(null,{status:404}):Response.json(raw);
  });
  const op=await prepareAgentOperation(principal,"moved",deletion);
  expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"unknown"});
  expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({status:"unknown"});
  expect((await execute("SELECT * FROM agent_resource_locks")).rows).toHaveLength(1);
  expect(writes()).toHaveLength(1);
 });

});
