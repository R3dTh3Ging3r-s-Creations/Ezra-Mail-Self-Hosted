import { handleAgentRoute } from "@/lib/email/agent-api-handlers";
export const runtime = "nodejs";
export async function GET(request: Request) {
  return handleAgentRoute(request, "capabilities");
}
