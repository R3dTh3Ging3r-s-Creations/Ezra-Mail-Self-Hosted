import {AgentReadError,isAgentReadErrorCode,AgentTransportError,isAgentTransportErrorCode,agentHttpFailure,type AgentTransportErrorCode} from "./agent-safe-errors";
import type {AgentRoute} from "./agent-api-handlers";
import {agentRequestSchemas,agentResponseSchemas} from "./agent-wire-schema";
import {accountKey,resourceKey,type ResourceRef} from "./agent-resource-types";
import type {AccountRef} from "./agent-types";
export type AgentHttpClient={call(route:AgentRoute,payload:unknown,signal?:AbortSignal):Promise<unknown>};
const MAX_RESPONSE=4*1024*1024;
export function createAgentHttpClient(options:{origin:string;getKey:()=>Promise<string>}):AgentHttpClient{
 let origin:URL;
 try{origin=new URL(options.origin);if(origin.protocol!=="https:"||origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash)throw new Error();}catch{throw new Error("A fixed HTTPS agent origin is required.");}
 const fixed=origin.origin;
 return {async call(route,payload,parent){
  let stage:AgentTransportErrorCode="request_invalid";let signal:AbortSignal|undefined;
  try{
   if(!Object.hasOwn(agentRequestSchemas,route))throw new Error();
   const input=agentRequestSchemas[route].parse(payload) as Record<string,unknown>;
   signal=AbortSignal.any([AbortSignal.timeout(150000),...(parent?[parent]:[])]);signal.throwIfAborted();
   stage="credential_unavailable";
   const key=await options.getKey();if(!/^ezra_[A-Za-z0-9-]{1,64}\.[A-Za-z0-9_-]{43}$/.test(key))throw new Error();signal.throwIfAborted();
   stage="request_invalid";
   let path:string=route,method="POST",body:unknown=input;
   if(route==="capabilities"){method="GET";body=undefined;}
   else if(route==="operations/prepare")path="operations";
   else if(route.startsWith("operations/")){
    path=`operations/${encodeURIComponent(String(input.operationId))}`;
    if(route==="operations/status"){method="GET";body=undefined;}
    else if(route==="operations/execute"){path+="/execute";body={payloadHash:input.payloadHash};}
    else{path+="/reconcile";body={};}
   }
   const serialized=body===undefined?undefined:JSON.stringify(body);
   if(serialized&&Buffer.byteLength(serialized)>65536)throw new Error();
   stage="transport_unavailable";
   const response=await fetch(`${fixed}/api/agent/v1/${path}`,{method,redirect:"error",credentials:"omit",cache:"no-store",signal,headers:{authorization:`Bearer ${key}`,accept:"application/json",...(serialized?{"content-type":"application/json"}:{})},body:serialized});
   stage="response_invalid";
   if(response.redirected||!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")){await response.body?.cancel();throw new Error();}
   const length=response.headers.get("content-length");if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_RESPONSE)){await response.body?.cancel();throw new Error();}
   const reader=response.body?.getReader();if(!reader)throw new Error();const chunks:Uint8Array[]=[];let size=0;
   try{while(true){signal.throwIfAborted();const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_RESPONSE){await reader.cancel();throw new Error();}chunks.push(part.value);}}finally{reader.releaseLock();}
   const raw=Buffer.concat(chunks).toString("utf8");if(raw.includes(key)||raw.includes(key.split(".")[1]))throw new Error();
   const decoded:unknown=JSON.parse(raw);
   if(!response.ok){
    if(response.status===503&&(route==="tasks/lists"||route==="tasks/read")&&decoded&&typeof decoded==="object"&&"ok" in decoded&&decoded.ok===false&&"error" in decoded&&isAgentReadErrorCode(decoded.error))throw new AgentReadError(decoded.error);
    throw agentHttpFailure(response.status);
   }
   const result=agentResponseSchemas[route].parse(decoded) as Record<string,unknown>;
   if(input.operationId&&result.id!==input.operationId)throw new Error();
   if(input.payloadHash&&result.payloadHash!==input.payloadHash)throw new Error();
   if(input.account&&result.account&&accountKey(input.account as AccountRef)!==accountKey(result.account as AccountRef))throw new Error();
   if(route==="calendar/read"&&(result.calendarId!==input.calendarId||JSON.stringify(result.range)!==JSON.stringify(input.range)))throw new Error();
   if(route==="tasks/read"&&(result.tasks as Array<{list:ResourceRef}>).some(task=>resourceKey(task.list)!==resourceKey(input.target as ResourceRef)))throw new Error();
   return result;
  }catch(error){if(error instanceof AgentReadError&&isAgentReadErrorCode(error.code))throw new AgentReadError(error.code);if(error instanceof AgentTransportError&&isAgentTransportErrorCode(error.code))throw new AgentTransportError(error.code);throw new AgentTransportError(signal?.aborted?"request_interrupted":stage);}
 }};
}
