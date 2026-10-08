import { z } from "zod";
import { agentJsonResponse,readAgentJson,requireGrantOwner } from "@/lib/email/agent-api";
import { resourceMutationSchema } from "@/lib/email/agent-resource-types";
import { prepareOwnerTaskOperation,executeOwnerTaskOperation } from "@/lib/email/agent-resource-operations";
import { makeOwnerTaskAuthority,ownerTaskOperation } from "@/lib/email/owner-task-authority";
export const runtime="nodejs";
const schema=z.discriminatedUnion("action",[
 z.object({action:z.literal("prepare"),mutation:resourceMutationSchema}).strict(),
 z.object({action:z.literal("execute"),operationId:z.string().uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export function POST(request:Request){return agentJsonResponse(async()=>{
 await requireGrantOwner(request);const body=schema.parse(await readAgentJson(request));
 if(body.action==="prepare")return prepareOwnerTaskOperation(makeOwnerTaskAuthority(body.mutation),body.mutation);
 const op=await ownerTaskOperation(body.operationId);
 return executeOwnerTaskOperation(op.authority,op.id,body.payloadHash,request.signal);
});}
