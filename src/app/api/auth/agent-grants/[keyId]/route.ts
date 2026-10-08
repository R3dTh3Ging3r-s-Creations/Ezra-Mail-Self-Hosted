import { z } from "zod";
import { grantSpecSchema } from "@/lib/email/agent-resource-types";
import { revokeAgentGrant, rotateAgentGrant } from "@/lib/email/agent-grants";
import { agentJsonResponse, readAgentJson, requireGrantOwner } from "@/lib/email/agent-api";

export const runtime = "nodejs";
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("revoke"), stepUpReceiptId: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal("rotate"), spec: grantSpecSchema, stepUpReceiptId: z.string().min(1).max(200) }).strict(),
]);
export function POST(request: Request, context: { params: Promise<{ keyId: string }> }) {
  return agentJsonResponse(async () => {
    const owner = await requireGrantOwner(request);
    const { keyId } = await context.params;
    z.string().uuid().parse(keyId);
    const body = schema.parse(await readAgentJson(request));
    const authority = { ...owner, stepUpReceiptId: body.stepUpReceiptId };
    if (body.action === "rotate") return rotateAgentGrant(keyId, body.spec, authority);
    await revokeAgentGrant(keyId, authority);
    return { revoked: true };
  });
}
