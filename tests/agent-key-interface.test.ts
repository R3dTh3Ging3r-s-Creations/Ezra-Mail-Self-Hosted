import {AgentTransportError} from "@/lib/email/agent-safe-errors";
import {afterEach,describe,expect,it,vi} from "vitest";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {CallToolResultSchema} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";
import {AjvJsonSchemaValidator} from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {createAgentKeyMcpServer} from "@/lib/email/agent-key-mcp";

const account={accountId:"fixture",provider:"gmail",expectedEmail:"owner@example.test"};
const payload={account,calendarId:"fixture-calendar",title:"Fixture",description:"",location:"",startsAt:"2026-11-01T10:00:00Z",endsAt:"2026-11-01T11:00:00Z",timezone:"Etc/UTC",isAllDay:false,reminder:{mode:"none"},isBusy:false,privacy:"private",attendees:[],sendUpdates:false};
describe("scoped MCP action discovery and safe validation",()=>{
 const sessions:Array<{client:Client;server:ReturnType<typeof createAgentKeyMcpServer>}>=[];
 afterEach(async()=>{for(const {client,server} of sessions.splice(0)){await client.close();await server.close();}});
 async function connect(){const call=vi.fn().mockResolvedValue({id:"fixture-operation"});const server=createAgentKeyMcpServer({call});const client=new Client({name:"fixture",version:"1"});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);sessions.push({client,server});return {client,call,server};}
 it("advertises the complete calendar payload and invitation restrictions",async()=>{
  const {client}=await connect();const tool=(await client.listTools()).tools.find(t=>t.name==="operations.prepare")!;
  const schema=tool.inputSchema as any;
  const create=schema.properties.mutation.anyOf.find((branch:any)=>branch.properties.kind.const==="calendar.create");
  expect(create.required).toEqual(expect.arrayContaining(["kind","payload"]));
  expect(create.properties.payload.required).toEqual(expect.arrayContaining(["account","calendarId","privacy","description","location","sendUpdates","attendees"]));
  expect(create.properties.payload.properties.sendUpdates).toMatchObject({const:false});
  expect(create.properties.payload.properties.attendees).toMatchObject({maxItems:0});
 });
 it.each(["gmail","microsoft"] as const)("advertises and accepts calendar.update for %s through JSON Schema and tools/call",async provider=>{
  const {client,call}=await connect();
  const tool=(await client.listTools()).tools.find(t=>t.name==="operations.prepare")!;
  const validate=new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
  const args={idempotencyKey:"fixture-edit",mutation:{kind:"calendar.update",target:{account:{...account,provider},kind:"calendar",id:"fixture-calendar"},eventId:"fixture-event",expectedRevision:'"fixture-revision"',patch:{title:"Fixture updated"}}};
  expect(validate(args).valid).toBe(true);
  expect((await client.callTool({name:"operations.prepare",arguments:args})).isError).not.toBe(true);
  expect(call).toHaveBeenCalledWith("operations/prepare",args,expect.any(AbortSignal));
  expect(tool.description).toContain("Google update/delete");
  expect(validate({...args,mutation:{...args.mutation,target:{...args.mutation.target,account:{...account,provider:"unsupported"}}}}).valid).toBe(false);
 });
 it("keeps task mutations Microsoft-only in the advertised JSON Schema",async()=>{
  const {client}=await connect();
  const tool=(await client.listTools()).tools.find(t=>t.name==="operations.prepare")!;
  const validate=new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
  const args={idempotencyKey:"fixture-task",mutation:{kind:"tasks.complete",target:{account:{...account,provider:"microsoft"},kind:"task_list",id:"fixture-list"},taskId:"fixture-task",expectedRevision:'"fixture-revision"'}};
  expect(validate(args).valid).toBe(true);
  expect(validate({...args,mutation:{...args.mutation,target:{...args.mutation.target,account}}}).valid).toBe(false);
 });
 it("gives calendar-specific missing-field guidance without task-branch errors",async()=>{
  const {client,call}=await connect();const result=await client.callTool({name:"operations.prepare",arguments:{idempotencyKey:"fixture-1",mutation:{kind:"calendar.create",payload:{title:"Fixture"}}}});
  expect(result.isError).toBe(true);const text=JSON.stringify(result);
  expect(text).toContain("mutation.payload.account");expect(text).toContain("mutation.payload.calendarId");expect(text).not.toContain("taskId");expect(text).not.toContain("task_list");expect(call).not.toHaveBeenCalled();
 });
 it.each([
  {kind:"calendar.create",payload:{...payload,privacy:"SYNTHETIC_SECRET_VALUE"}},
  {kind:"calendar.create",payload:{...payload,SYNTHETIC_SECRET_KEY:"private"}},
  {kind:"SYNTHETIC_SECRET_KIND",payload},
 ])("never reflects supplied values or unknown keys from invalid actions %#",async mutation=>{
  const {client,call}=await connect();const result=await client.callTool({name:"operations.prepare",arguments:{idempotencyKey:"fixture-1",mutation}});
  expect(result.isError).toBe(true);expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");expect(JSON.stringify(result)).toContain("Invalid request");expect(call).not.toHaveBeenCalled();
 });
 it.each(["disable","remove","remove-update","rename"] as const)("does not dispatch a tool after SDK %s",async action=>{
  const {client,call,server}=await connect();
  const tool=(server as any)._registeredTools["operations.execute"];
  if(action==="rename")tool.update({name:"renamed.execute"});
  else if(action==="remove-update")tool.update({name:null});
  else tool[action]();
  expect((await client.listTools()).tools.some(tool=>tool.name==="operations.execute")).toBe(false);
  const result=await client.callTool({name:"operations.execute",arguments:{operationId:"fixture",payloadHash:"a".repeat(64)}});
  expect(result.isError).toBe(true);expect(call).not.toHaveBeenCalled();
 });
 it("does not bypass replacement output validation with the original route",async()=>{
  const {client,call,server}=await connect();
  (server as any)._registeredTools["operations.execute"].update({outputSchema:{mustExist:z.string()}});
  const result=await client.request({method:"tools/call",params:{name:"operations.execute",arguments:{operationId:"fixture",payloadHash:"a".repeat(64)}}},CallToolResultSchema);
  expect(result.isError).toBe(true);expect(call).not.toHaveBeenCalled();
 });
 it("contains date-transform failures as safe pre-dispatch validation results",async()=>{
  const {client,call}=await connect();const result=await client.callTool({name:"operations.prepare",arguments:{idempotencyKey:"fixture-offset",mutation:{kind:"calendar.create",payload:{...payload,startsAt:"2026-11-01T10:00:00+99:99"}}}});
  expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain("Invalid request");expect(JSON.stringify(result)).not.toContain("Invalid time value");expect(call).not.toHaveBeenCalled();
 });
 it("preserves the existing generic request and date normalization",async()=>{
  const {client,call}=await connect();const result=await client.callTool({name:"operations.prepare",arguments:{idempotencyKey:"fixture-1",mutation:{kind:"calendar.create",payload:{...payload,startsAt:"2026-11-01T11:00:00+01:00"}}}});
  expect(result.isError).not.toBe(true);expect(call).toHaveBeenCalledWith("operations/prepare",{idempotencyKey:"fixture-1",mutation:{kind:"calendar.create",payload:{...payload,startsAt:"2026-11-01T10:00:00.000Z",endsAt:"2026-11-01T11:00:00.000Z"}}},expect.any(AbortSignal));
 });

 it("forwards only reconstructed safe transport categories to the cloud tool",async()=>{
  const {client,call}=await connect();
  for(const code of ["http_503","transport_unavailable","response_invalid"] as const){
   const error=new AgentTransportError(code);error.message="SYNTHETIC_PRIVATE_MESSAGE";
   call.mockRejectedValueOnce(error);
   const result=await client.callTool({name:"operations.execute",arguments:{operationId:"fixture",payloadHash:"a".repeat(64)}});
   expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain(code);
   expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE");
   expect(JSON.stringify(result)).toContain("persisted operation");
   expect(JSON.stringify(result)).not.toContain("No request was dispatched");
  }
  const forged=new AgentTransportError("http_503");
  (forged as any).code="SYNTHETIC_PRIVATE_CODE";forged.message="SYNTHETIC_PRIVATE_MESSAGE";
  call.mockRejectedValueOnce(forged);
  const denied=await client.callTool({name:"operations.execute",arguments:{operationId:"fixture",payloadHash:"a".repeat(64)}});
  expect(denied.isError).toBe(true);expect(JSON.stringify(denied)).not.toContain("SYNTHETIC_PRIVATE");
  expect(call).toHaveBeenCalledTimes(4);
 });
});
