import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { upsertManualContact } from "@/lib/email/contacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("manual_upsert"),
    accountId: z.string(),
    email: z.string().min(3).max(320),
    name: z.string().max(256).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  }),
]);

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = schema.parse(await request.json());
    return upsertManualContact({
      accountId: body.accountId,
      email: body.email,
      name: body.name,
      note: body.note,
    });
  });
}
