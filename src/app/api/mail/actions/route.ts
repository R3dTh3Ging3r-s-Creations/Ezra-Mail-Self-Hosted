import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { applyProfessionalMailAction } from "@/lib/email/professional";

export const runtime = "nodejs";

const schema = z.object({
  action: z.enum([
    "done",
    "keep",
    "raise_priority",
    "lower_priority",
    "mark_read",
    "teach_care",
    "quiet",
    "unsubscribe",
    "spam",
    "delete",
    "delete_and_teach",
    "pin",
    "unpin",
    "flag",
    "unflag",
    "undo",
  ]),
  messageIds: z.array(z.string()).max(100).optional(),
  actionId: z.string().optional(),
  care: z.enum(["more", "less", "useful"]).optional(),
  scopes: z.array(z.enum(["message", "sender", "topic"])).max(3).optional(),
  topicLabel: z.string().max(160).optional(),
});

export async function POST(request: Request) {
  return authenticated(request, async () =>
    applyProfessionalMailAction(schema.parse(await request.json())),
  );
}
