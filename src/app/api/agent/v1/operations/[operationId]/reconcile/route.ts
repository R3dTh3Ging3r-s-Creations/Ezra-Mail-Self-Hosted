import { handleAgentRoute } from "@/lib/email/agent-api-handlers";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ operationId: string }> }) {
  return handleAgentRoute(request, "operations/reconcile", (await context.params).operationId);
}
