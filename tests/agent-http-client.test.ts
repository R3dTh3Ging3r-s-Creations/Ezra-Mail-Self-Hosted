import {AgentTransportError} from "@/lib/email/agent-safe-errors";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createAgentHttpClient} from "@/lib/email/agent-http-client";
const key=`ezra_00000000-0000-4000-8000-000000000000.${"S".repeat(43)}`;
const op={id:"operation",kind:"tasks.create",payloadHash:"a".repeat(64),status:"unknown",expiresAt:"2026-10-06T00:00:00Z"};
describe("fixed private agent HTTP client",()=>{
 const fetcher=vi.fn();beforeEach(()=>{vi.stubGlobal("fetch",fetcher);fetcher.mockReset();});afterEach(()=>vi.unstubAllGlobals());
 const client=()=>createAgentHttpClient({origin:"https://ezra.test",getKey:async()=>key});
 it("rejects missing/insecure/credential-bearing origins before loading access",()=>{for(const origin of ["","http://ezra.test","https://user:password@ezra.test","https://ezra.test/path","https://ezra.test?query=1"])expect(()=>createAgentHttpClient({origin,getKey:async()=>key})).toThrow();expect(fetcher).not.toHaveBeenCalled();});
 it("never follows redirects or falls back on certificate/auth failure",async()=>{fetcher.mockRejectedValue(new Error(`TLS failure ${key}`));await expect(client().call("capabilities",{})).rejects.toThrow("Agent request failed");expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:"error",credentials:"omit",headers:{authorization:`Bearer ${key}`}});fetcher.mockResolvedValue(new Response("redirect",{status:302,headers:{location:"https://foreign.test"}}));await expect(client().call("capabilities",{})).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(2);});
 it("invalid key never reaches the network",async()=>{await expect(createAgentHttpClient({origin:"https://ezra.test",getKey:async()=>""}).call("capabilities",{})).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();});
 it("rejects unknown routes and injected transport/approval fields",async()=>{await expect(client().call("https://foreign.test" as never,{})).rejects.toThrow();await expect(client().call("operations/execute",{operationId:"op",payloadHash:"a".repeat(64),approved:true,url:"https://foreign.test"})).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();});
 it("validates DTOs, limits response size and does not expose sentinel secrets",async()=>{fetcher.mockResolvedValue(new Response(JSON.stringify({...op,privateNotes:"do not expose"}),{headers:{"content-type":"application/json"}}));expect(await client().call("operations/status",{operationId:"operation"})).toEqual(op);fetcher.mockResolvedValue(new Response(JSON.stringify({id:key}),{headers:{"content-type":"application/json"}}));await expect(client().call("operations/status",{operationId:"operation"})).rejects.not.toThrow(key);fetcher.mockResolvedValue(new Response("x",{headers:{"content-type":"application/json","content-length":"4194305"}}));await expect(client().call("capabilities",{})).rejects.toThrow();fetcher.mockResolvedValue(new Response("x".repeat(4194305),{headers:{"content-type":"application/json"}}));await expect(client().call("capabilities",{})).rejects.toThrow();});
 it("ambiguous execute has no retry and restart reads persisted status",async()=>{fetcher.mockRejectedValueOnce(new Error("disconnected"));await expect(client().call("operations/execute",{operationId:"operation",payloadHash:op.payloadHash})).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();fetcher.mockResolvedValueOnce(new Response(JSON.stringify(op),{headers:{"content-type":"application/json"}}));expect(await client().call("operations/status",{operationId:"operation"})).toMatchObject({status:"unknown"});expect(fetcher.mock.calls[1][0]).toBe("https://ezra.test/api/agent/v1/operations/operation");expect(fetcher.mock.calls[1][1].method).toBe("GET");});
 it("returns allowlisted task read failure guidance without provider details",async()=>{fetcher.mockResolvedValue(new Response(JSON.stringify({ok:false,error:"task_provider_response_invalid",details:"SYNTHETIC_SECRET_PROVIDER_BODY"}),{status:503,headers:{"content-type":"application/json"}}));await expect(client().call("tasks/lists",{account:{accountId:"fixture",provider:"microsoft",expectedEmail:"owner@example.test"}})).rejects.toThrow("Task provider returned an unsupported response");expect(fetcher).toHaveBeenCalledOnce();});
 it("does not trust unknown error codes or task codes on mutation responses",async()=>{for(const error of ["SYNTHETIC_SECRET_PROVIDER_BODY","task_provider_response_invalid"]){fetcher.mockResolvedValue(new Response(JSON.stringify({ok:false,error}),{status:503,headers:{"content-type":"application/json"}}));await expect(client().call("operations/execute",{operationId:"operation",payloadHash:op.payloadHash})).rejects.toThrow("Agent request failed");}});
 it("rejects mismatched persisted operation identities and traversal aliases",async()=>{fetcher.mockResolvedValue(new Response(JSON.stringify(op),{headers:{"content-type":"application/json"}}));await expect(client().call("operations/status",{operationId:"different"})).rejects.toThrow();await expect(client().call("operations/status",{operationId:".."})).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();});
});

describe("safe transport failure categories",()=>{
 afterEach(()=>vi.unstubAllGlobals());
 const call=()=>createAgentHttpClient({origin:"https://ezra.test",getKey:async()=>key}).call("operations/execute",{operationId:"operation",payloadHash:"a".repeat(64)});
 it("reports only bounded HTTP status categories and never provider error text",async()=>{
  for(const status of [400,401,403,404,409,413,429,503,599]){
   const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:false,error:"SYNTHETIC_PRIVATE_DIAGNOSTIC",details:key}),{status,headers:{"content-type":"application/json"}}));
   // A body containing the actual key is rejected before classifying status.
   vi.stubGlobal("fetch",fetcher);await expect(call()).rejects.toMatchObject({code:"response_invalid"});
   fetcher.mockResolvedValue(new Response(JSON.stringify({ok:false,error:"SYNTHETIC_PRIVATE_DIAGNOSTIC"}),{status,headers:{"content-type":"application/json"}}));
   const error=await call().catch(e=>e);
   if(!(error instanceof AgentTransportError))throw new Error("Expected safe categorized error");
   expect(error.code).toBe(status===599?"http_other":`http_${status}`);
   expect(error.message).not.toContain("SYNTHETIC_PRIVATE");expect(error.message).not.toContain(key);
   expect(error.message).not.toContain("No request was dispatched");expect(error.message).toContain("persisted operation");expect(fetcher).toHaveBeenCalledTimes(2);
  }
 });
 it("distinguishes local validation and key loading without any network request",async()=>{
  const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
  await expect(createAgentHttpClient({origin:"https://ezra.test",getKey:async()=>key}).call("operations/execute",{})).rejects.toMatchObject({code:"request_invalid"});
  await expect(createAgentHttpClient({origin:"https://ezra.test",getKey:async()=>{throw new Error(key);}}).call("operations/execute",{operationId:"operation",payloadHash:"a".repeat(64)})).rejects.toMatchObject({code:"credential_unavailable"});
  expect(fetcher).not.toHaveBeenCalled();
 });
 it("distinguishes failed transport, interrupted requests and invalid replies without retry",async()=>{
  const fetcher=vi.fn().mockRejectedValue(new Error("SYNTHETIC_PRIVATE_CONNECTION"));vi.stubGlobal("fetch",fetcher);
  await expect(call()).rejects.toMatchObject({code:"transport_unavailable"});expect(fetcher).toHaveBeenCalledOnce();
  fetcher.mockResolvedValue(new Response("not JSON",{headers:{"content-type":"application/json"}}));
  await expect(call()).rejects.toMatchObject({code:"response_invalid"});expect(fetcher).toHaveBeenCalledTimes(2);
  const abort=new AbortController();abort.abort();
  await expect(createAgentHttpClient({origin:"https://ezra.test",getKey:async()=>key}).call("operations/execute",{operationId:"operation",payloadHash:"a".repeat(64)},abort.signal)).rejects.toMatchObject({code:"request_interrupted"});
  expect(fetcher).toHaveBeenCalledTimes(2);
  const midflight=new AbortController();
  fetcher.mockImplementationOnce((_url,options)=>new Promise((_resolve,reject)=>{
   options.signal.addEventListener("abort",()=>reject(new Error("SYNTHETIC_PRIVATE_ABORT")));
   midflight.abort();
  }));
  const error=await createAgentHttpClient({origin:"https://ezra.test",getKey:async()=>key}).call("operations/execute",{operationId:"operation",payloadHash:"a".repeat(64)},midflight.signal).catch(e=>e);
  expect(error).toMatchObject({code:"request_interrupted"});
  if(!(error instanceof AgentTransportError))throw new Error("Expected safe categorized error");
  expect(error.message).not.toContain("No request was dispatched");expect(error.message).not.toContain("SYNTHETIC_PRIVATE");
  expect(fetcher).toHaveBeenCalledTimes(3);
 });
});
