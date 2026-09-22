import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import {
  getWritingSettings,
  setRemoteImagesForSender,
  updateWritingSettings,
  writingLengths,
  writingTones,
} from "@/lib/email/writing-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update_writing"),
    accountId: z.string().min(1),
    signature: z.string().max(4_000).optional(),
    signatureEnabled: z.boolean().optional(),
    defaultTone: z.enum(writingTones).optional(),
    preferredLength: z.enum(writingLengths).optional(),
  }),
  z.object({
    action: z.literal("sender_images"),
    accountId: z.string().min(1),
    senderEmail: z.string().email(),
    allowed: z.boolean(),
  }),
]);

export async function GET(request: Request) {
  return authenticated(request, async () => {
    const url = new URL(request.url);
    const accountId = z.string().min(1).parse(url.searchParams.get("accountId"));
    const senderEmail = url.searchParams.get("senderEmail") || undefined;
    return getWritingSettings(accountId, senderEmail);
  });
}

export async function PATCH(request: Request) {
  return authenticated(request, async () => {
    const body = patchSchema.parse(await request.json());
    if (body.action === "sender_images") {
      return setRemoteImagesForSender(body.accountId, body.senderEmail, body.allowed);
    }
    return updateWritingSettings(body);
  });
}
