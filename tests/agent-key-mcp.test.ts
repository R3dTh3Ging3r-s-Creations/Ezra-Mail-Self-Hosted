import {afterEach,describe,expect,it,vi} from "vitest";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {createAgentKeyMcpServer} from "@/lib/email/agent-key-mcp";
describe("optional scoped-key MCP",()=>{
 const sessions:Array<{client:Client;server:ReturnType<typeof createAgentKeyMcpServer>}>=[];
 afterEach(async()=>{for(const session of sessions.splice(0)){await session.client.close();await session.server.close();}});
 async function connect(){const call=vi.fn().mockResolvedValue({status:"unknown"});const server=createAgentKeyMcpServer({call});const client=new Client({name:"fixture",version:"1"});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);sessions.push({client,server});return {client,call};}
 it("exposes only typed routes with no key/url/authority arguments",async()=>{const {client,call}=await connect();const names=(await client.listTools()).tools.map(t=>t.name);expect(names).toEqual(["accounts.capabilities","mail.search","mail.read","calendar.list","tasks.lists","tasks.read","operations.prepare","operations.get","operations.execute","operations.reconcile"]);expect((await client.callTool({name:"operations.execute",arguments:{operationId:"op",payloadHash:"a".repeat(64),approved:true}})).isError).toBe(true);expect(call).not.toHaveBeenCalled();});
 it("passes cancellation and redacts even a secret-bearing thrown error",async()=>{const {client,call}=await connect();call.mockRejectedValueOnce(new Error("SYNTHETIC_SECRET_NOT_FOR_MODEL"));const result=await client.callTool({name:"operations.get",arguments:{operationId:"op"}});expect(result.isError).toBe(true);expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");expect(call).toHaveBeenCalledWith("operations/status",{operationId:"op"},expect.any(AbortSignal));});
});
