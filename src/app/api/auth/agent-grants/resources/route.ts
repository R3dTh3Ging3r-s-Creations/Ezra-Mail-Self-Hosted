import { z } from "zod";
import { agentJsonResponse,readAgentJson,requireGrantOwner } from "@/lib/email/agent-api";
import { accountRefSchema } from "@/lib/email/agent-types";
import { ownerAccountChoices,ownerResourceChoices } from "@/lib/email/agent-owner-catalogue";
export const runtime="nodejs";
const schema=z.object({account:accountRefSchema,kind:z.enum(["calendar","task_list"])}).strict();
export function GET(request:Request){return agentJsonResponse(async()=>{await requireGrantOwner(request);return ownerAccountChoices();});}
export function POST(request:Request){return agentJsonResponse(async()=>{await requireGrantOwner(request);const body=schema.parse(await readAgentJson(request));return ownerResourceChoices(body.account,body.kind);});}
