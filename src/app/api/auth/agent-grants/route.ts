import { z } from "zod";
import { grantSpecSchema } from "@/lib/email/agent-resource-types";
import { issueAgentGrant, listAgentGrants } from "@/lib/email/agent-grants";
import { agentJsonResponse, readAgentJson, requireGrantOwner } from "@/lib/email/agent-api";

export const runtime = "nodejs";
const schema = z.object({ spec: grantSpecSchema, stepUpReceiptId: z.string().min(1).max(200) }).strict();
export function GET(request: Request) {
  return agentJsonResponse(async () => { await requireGrantOwner(request); return { grants: await listAgentGrants() }; });
}
export function POST(request: Request) {
  return agentJsonResponse(async () => {
    const owner = await requireGrantOwner(request);
    const body = schema.parse(await readAgentJson(request));
    return issueAgentGrant(body.spec, { ...owner, stepUpReceiptId: body.stepUpReceiptId });
  });
}
