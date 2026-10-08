import { z } from "zod";
import { agentJsonResponse,readAgentJson,requireGrantOwner } from "@/lib/email/agent-api";
import { resourceRefSchema } from "@/lib/email/agent-resource-types";
import { readOwnerTasks } from "@/lib/email/agent-owner-catalogue";
export const runtime="nodejs";
const schema=z.object({target:resourceRefSchema}).strict();
export function POST(request:Request){return agentJsonResponse(async()=>{await requireGrantOwner(request);const body=schema.parse(await readAgentJson(request));return readOwnerTasks(body.target,request.signal);});}
