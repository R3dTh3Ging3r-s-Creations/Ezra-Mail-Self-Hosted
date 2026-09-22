import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { createRule, deleteRule, getRules, updateRule } from "@/lib/email/professional";

export const runtime = "nodejs";

const createSchema = z.object({
  accountId: z.string(),
  senderEmail: z.string().email(),
  action: z.enum(["mark_read", "spam"]),
});
const updateSchema = z.object({
  id: z.string(),
  source: z.enum(["cleanup", "priority"]),
  enabled: z.boolean().optional(),
  action: z.enum(["mark_read", "spam", "interrupt", "digest", "suppress"]).optional(),
  workspaceId: z.string().optional(),
}).refine((value) => value.enabled !== undefined || value.action !== undefined, "Choose a rule change.");
const deleteSchema = z.object({
  id: z.string(),
  source: z.enum(["cleanup", "priority"]),
  workspaceId: z.string().optional(),
});

export async function GET(request: Request) {
  return authenticated(request, () => {
    const url = new URL(request.url);
    return getRules({ workspaceId: url.searchParams.get("workspaceId") || undefined });
  });
}

export async function POST(request: Request) {
  return authenticated(request, async () => createRule(createSchema.parse(await request.json())));
}

export async function PATCH(request: Request) {
  return authenticated(request, async () => updateRule(updateSchema.parse(await request.json())));
}

export async function DELETE(request: Request) {
  return authenticated(request, async () => deleteRule(deleteSchema.parse(await request.json())));
}
