import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { updateBriefItemMemory } from "@/lib/email/brief-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const identifier = z.string().trim().min(1).max(240);
const schema = z.object({
  workspaceId: identifier,
  itemId: identifier,
  action: z.enum(["complete", "dismiss", "bring_back"]),
}).strict();

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = schema.parse(await request.json());
    return { item: await updateBriefItemMemory(body) };
  });
}
