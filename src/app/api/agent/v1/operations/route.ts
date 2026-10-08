import { handleAgentRoute } from "@/lib/email/agent-api-handlers";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return handleAgentRoute(request, "operations/prepare");
}
