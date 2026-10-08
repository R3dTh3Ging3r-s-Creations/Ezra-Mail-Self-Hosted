import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {configureEmailDatabaseForTests,execute,setSetting} from "@/lib/email/database";
import {POST as issue} from "@/app/api/auth/agent-grants/route";
import {revokeAgentGrant} from "@/lib/email/agent-grants";
import {handleAgentRoute,type AgentRoute} from "@/lib/email/agent-api-handlers";
import {createAgentHttpClient} from "@/lib/email/agent-http-client";
import {createAgentKeyMcpServer} from "@/lib/email/agent-key-mcp";
import type {CalendarEvent} from "@/lib/email/types";
import type {AccountRef} from "@/lib/email/agent-types";
const mocks=vi.hoisted(()=>({owner:vi.fn(),receipt:vi.fn(),caps:vi.fn(),account:vi.fn(),read:vi.fn(),event:vi.fn(),ms:vi.fn(),google:vi.fn()}));
vi.mock("@/lib/email/auth",async original=>({...await original<typeof import("@/lib/email/auth")>(),getAuthSession:mocks.owner}));
vi.mock("@/lib/email/passkeys",()=>({consumeStepUpReceipt:mocks.receipt}));
vi.mock("@/lib/email/agent-accounts",()=>({getAgentCapabilities:mocks.caps,assertPersonalAccount:mocks.account,assertConnectedAccount:mocks.account}));
vi.mock("@/lib/email/agent-calendar",()=>({readAgentCalendar:mocks.read,readAgentEvent:mocks.event}));
vi.mock("@/lib/email/microsoft",()=>({createMicrosoftCalendarEvent:mocks.ms}));
vi.mock("@/lib/email/gmail",()=>({createGoogleCalendarEvent:mocks.google,assertGoogleCalendarReminderSupport:vi.fn()}));
const ms={accountId:"ms",provider:"microsoft" as const,expectedEmail:"owner@hotmail.test"},gg={accountId:"gg",provider:"gmail" as const,expectedEmail:"owner@gmail.test"};
const payload=(account:AccountRef)=>({account,calendarId:"cal",title:"Synthetic reminder",description:"",location:"",startsAt:"2026-11-06T13:00:00Z",endsAt:"2026-11-06T13:10:00Z",timezone:"America/Chicago",isAllDay:false,reminder:{mode:"minutes",minutes:0},isBusy:false,privacy:"default",attendees:[],sendUpdates:false});
describe("owner grant to private HTTP to scoped MCP integration",()=>{
 const sessions:Array<{client:Client;server:ReturnType<typeof createAgentKeyMcpServer>}>=[];let secret:string,keyId:string;let events:CalendarEvent[]=[];
 beforeEach(async()=>{
  vi.clearAllMocks();events=[];configureEmailDatabaseForTests(`file:./scoped-integration-${randomUUID()}.sqlite`);
  await setSetting("agent_personal_accounts",JSON.stringify([ms,gg]));
  for(const account of [ms,gg])await execute("INSERT INTO email_accounts(id,provider,email,label,status,created_at,updated_at) VALUES (?,?,?,'Fixture','connected',?,?)",[account.accountId,account.provider,account.expectedEmail,new Date().toISOString(),new Date().toISOString()]);
  mocks.owner.mockResolvedValue({authenticated:true,trustedDevice:{id:"owner-device"},authenticationMethod:"passkey"});mocks.receipt.mockResolvedValue(undefined);
  mocks.account.mockImplementation(async (ref:AccountRef)=>{if(![ms,gg].some(a=>a.accountId===ref.accountId&&a.expectedEmail===ref.expectedEmail&&a.provider===ref.provider))throw new Error("Wrong account");return {id:ref.accountId,email:ref.expectedEmail,provider:ref.provider,label:"Fixture"};});
  mocks.caps.mockImplementation(async(account:AccountRef)=>({account,identityVerifiedAt:new Date().toISOString(),scopes:["Calendars.ReadWrite"],mailRead:"available",calendarRead:"available",calendarWrite:"available",tasksRead:"missing",tasksWrite:"missing"}));
  mocks.read.mockImplementation(async(account,calendarId,range)=>({account,calendarId,range,complete:true,fetchedAt:new Date().toISOString(),events:events.filter(event=>event.accountId===account.accountId)}));
  mocks.event.mockImplementation(async(account,_cal,id)=>({status:"found",event:events.find(event=>event.accountId===account.accountId&&event.externalEventId===id)}));
  const created=(account:AccountRef,input:ReturnType<typeof payload>)=>{const event={...input,id:randomUUID(),externalEventId:randomUUID(),accountId:account.accountId,accountProvider:account.provider,accountLabel:"Fixture",calendarName:"Calendar",dateRange:null,status:"confirmed",visibility:"default",organizerEmail:account.expectedEmail,organizerName:"Fixture",webLink:null,updatedAt:new Date().toISOString(),syncedAt:new Date().toISOString()} as CalendarEvent;events.push(event);return event;};
  mocks.ms.mockImplementation(async(_email,input)=>created(ms,input));mocks.google.mockImplementation(async input=>created(gg,input));
  const spec={label:"Synthetic integration",lifetimeDays:7,accounts:[ms,gg],resources:[ms,gg].map(account=>({account,kind:"calendar",id:"cal"})),scopes:["accounts.read","mail.read","calendar.read","calendar.create","calendar.update","calendar.delete"]};
  const response=await issue(new Request("https://ezra.test/api/auth/agent-grants",{method:"POST",headers:{origin:"https://ezra.test","content-type":"application/json"},body:JSON.stringify({spec,stepUpReceiptId:"synthetic-reviewed-receipt"})}));expect(response.status).toBe(200);const result=await response.json();({secret}=result);keyId=result.grant.keyId;
  vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{const path=new URL(url).pathname.replace("/api/agent/v1/","");const segments=path.split("/");let route=path as AgentRoute,id:string|undefined;if(path==="operations")route="operations/prepare";else if(segments[0]==="operations"){id=decodeURIComponent(segments[1]);route=`operations/${segments[2]||"status"}` as AgentRoute;}return handleAgentRoute(new Request(url,init),route,id);}));
 });
 afterEach(async()=>{for(const session of sessions.splice(0)){await session.client.close();await session.server.close();}vi.unstubAllGlobals();});
 async function connect(){const http=createAgentHttpClient({origin:"https://ezra.test",getKey:async()=>secret});const server=createAgentKeyMcpServer(http),client=new Client({name:"scoped-fixture",version:"1"});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);sessions.push({server,client});return client;}
 async function call(client:Client,name:string,args:Record<string,unknown>){const result=await client.callTool({name,arguments:args});expect(result.isError,JSON.stringify(result)).not.toBe(true);return JSON.parse((result.content as Array<{text:string}>)[0].text).result;}
 it.each([ms,gg])("verifies $provider create over HTTP/MCP and persists the receipt across clients",async account=>{const client=await connect();const caps=await call(client,"accounts.capabilities",{});expect(caps.accounts.map((a:{account:AccountRef})=>a.account.expectedEmail)).toEqual([ms.expectedEmail,gg.expectedEmail]);expect(caps.accounts[0]).toMatchObject({calendarUpdate:false,tasksRead:false,tasksCreate:false});await call(client,"calendar.list",{account,calendarId:"cal",range:{from:"2026-11-06T00:00:00Z",to:"2026-11-07T00:00:00Z"}});const op=await call(client,"operations.prepare",{idempotencyKey:"unchanged",mutation:{kind:"calendar.create",payload:payload(account)}});const second=await connect();const results=await Promise.all([call(client,"operations.execute",{operationId:op.id,payloadHash:op.payloadHash}),call(second,"operations.execute",{operationId:op.id,payloadHash:op.payloadHash})]);expect(results.some(result=>result.status==="succeeded")).toBe(true);expect(mocks.ms.mock.calls.length+mocks.google.mock.calls.length).toBe(1);expect(await call(second,"operations.get",{operationId:op.id})).toMatchObject({status:"succeeded",receipt:{outcome:"created"}});expect(mocks.receipt).toHaveBeenCalledWith(expect.objectContaining({deviceId:"owner-device",action:"manage_agent_grants",reviewHash:expect.stringMatching(/^[a-f0-9]{64}$/)}));});
 it("revoked originating access and out-of-profile requests never dispatch",async()=>{const client=await connect();const op=await call(client,"operations.prepare",{idempotencyKey:"unchanged",mutation:{kind:"calendar.create",payload:payload(ms)}});expect((await client.callTool({name:"calendar.list",arguments:{account:{...ms,expectedEmail:"work@company.test"},calendarId:"cal",range:{from:"2026-11-06T00:00:00Z",to:"2026-11-07T00:00:00Z"}}})).isError).toBe(true);await revokeAgentGrant(keyId,{deviceId:"owner-device",stepUpReceiptId:"synthetic-revoke-receipt"});expect((await client.callTool({name:"operations.get",arguments:{operationId:op.id}})).isError).toBe(true);expect((await client.callTool({name:"operations.execute",arguments:{operationId:op.id,payloadHash:op.payloadHash}})).isError).toBe(true);expect(mocks.ms).not.toHaveBeenCalled();});
 it("reports non-atomic Microsoft deletion only with scoped access and account policy over MCP",async()=>{
  const client=await connect();
  expect((await call(client,"accounts.capabilities",{})).accounts[0].calendarDelete).toBe(false);
  await setSetting("agent_microsoft_calendar_delete_policy",JSON.stringify({version:1,policy:"graph-v1-owned-appointment-delete-v1",account:ms,acceptedAt:"2026-10-08T00:00:00.000Z",approvalId:"owner-fixture",externalEditRaceAccepted:true}));
  const caps=await call(client,"accounts.capabilities",{});
  expect(caps.accounts[0]).toMatchObject({calendarDelete:true,calendarDeleteSafety:"fresh_read_non_atomic"});
  expect(caps.accounts[1]).toMatchObject({calendarDelete:false,calendarDeleteSafety:"unavailable"});
  await setSetting("agent_microsoft_calendar_delete_policy","null");
  expect((await call(client,"accounts.capabilities",{})).accounts[0]).toMatchObject({calendarDelete:false,calendarDeleteSafety:"unavailable"});
 });

});
