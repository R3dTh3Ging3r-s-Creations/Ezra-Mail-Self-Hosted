import {describe,expect,it} from "vitest";
import {agentJsonResponse} from "@/lib/email/agent-api";
import {AgentReadError} from "@/lib/email/agent-safe-errors";
describe("safe agent read failure responses",()=>{
 it("serializes only the allowlisted diagnostic code",async()=>{
  const error=new AgentReadError("task_provider_response_invalid");error.message="SYNTHETIC_SECRET_PROVIDER_BODY";
  const response=await agentJsonResponse(async()=>{throw error;});
  expect(response.status).toBe(503);expect(await response.json()).toEqual({ok:false,error:"task_provider_response_invalid"});
 });
 it("does not serialize arbitrary error messages or lookalike codes",async()=>{
  const response=await agentJsonResponse(async()=>{throw Object.assign(new Error("SYNTHETIC_SECRET"),{code:"task_provider_response_invalid"});});
  expect(await response.json()).toEqual({ok:false,error:"request_unavailable"});
 });
});
