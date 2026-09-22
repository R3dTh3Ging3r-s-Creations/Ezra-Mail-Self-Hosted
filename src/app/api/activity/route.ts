import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { getActivityTimeline } from "@/lib/email/activity";

export const runtime = "nodejs";

const querySchema = z.object({
  workspaceId: z.string().optional(),
  q: z.string().optional(),
  kind: z.enum([
    "all",
    "message_received",
    "classification",
    "mail_action",
    "outgoing_mail",
    "feedback",
    "learned_rule",
    "notification",
    "mail_sync",
    "calendar_sync",
    "integration",
  ]).optional(),
  accountId: z.string().optional(),
  provider: z.enum(["all", "gmail", "microsoft"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export async function GET(request: Request) {
  return authenticated(request, () => {
    const url = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams.entries()));
    return getActivityTimeline(query);
  });
}
