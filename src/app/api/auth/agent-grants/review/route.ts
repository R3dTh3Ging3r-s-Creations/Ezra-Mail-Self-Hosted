import { z } from "zod";
import { agentJsonResponse,readAgentJson,requireGrantOwner } from "@/lib/email/agent-api";
import { grantSpecSchema } from "@/lib/email/agent-resource-types";
import { grantReviewHash } from "@/lib/email/agent-grants";
export const runtime="nodejs";
const schema=z.discriminatedUnion("action",[
 z.object({action:z.literal("issue"),spec:grantSpecSchema}).strict(),
 z.object({action:z.literal("rotate"),keyId:z.string().uuid(),spec:grantSpecSchema}).strict(),
 z.object({action:z.literal("revoke"),keyId:z.string().uuid()}).strict(),
]);
export function POST(request:Request){return agentJsonResponse(async()=>{await requireGrantOwner(request);const action=schema.parse(await readAgentJson(request));return {reviewHash:grantReviewHash(action)};});}
