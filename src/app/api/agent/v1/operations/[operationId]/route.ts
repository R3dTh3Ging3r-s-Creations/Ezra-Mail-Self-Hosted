import { handleAgentRoute } from "@/lib/email/agent-api-handlers";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ operationId: string }> }) {
  return handleAgentRoute(request, "operations/status", (await context.params).operationId);
}
