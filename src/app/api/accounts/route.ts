import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import {
  getAccountFreshness,
  markWorkspacePurposesReviewed,
  syncAccountNow,
  updateAccountSetup,
  updateAccountPurpose,
} from "@/lib/email/account-health";
import { disconnectMailAccount } from "@/lib/email/account-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update_purpose"), accountId: z.string(), purposeLabel: z.string() }),
  z.object({ action: z.literal("update_setup"), accountId: z.string(), purposeLabel: z.string(), syncRangeDays: z.number().int() }),
  z.object({ action: z.literal("mark_purposes_reviewed") }),
  z.object({ action: z.literal("sync_now"), accountId: z.string() }),
  z.object({
    action: z.literal("disconnect"),
    accountId: z.string(),
    confirmEmail: z.string().email(),
  }),
]);

export async function GET(request: Request) {
  return authenticated(request, getAccountFreshness);
}

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = schema.parse(await request.json());
    if (body.action === "update_purpose") return updateAccountPurpose(body);
    if (body.action === "update_setup") return updateAccountSetup(body);
    if (body.action === "mark_purposes_reviewed") return markWorkspacePurposesReviewed();
    if (body.action === "disconnect") {
      const result = await disconnectMailAccount(body);
      return { result, freshness: await getAccountFreshness() };
    }
    return syncAccountNow(body.accountId);
  });
}
