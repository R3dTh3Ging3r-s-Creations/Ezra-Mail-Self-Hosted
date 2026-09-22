import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { addOutgoingDraftAttachment, removeOutgoingDraftAttachment } from "@/lib/email/composition";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ draftId: string }> }) {
  return authenticated(request, async () => {
    const { draftId } = await context.params;
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Choose one attachment to upload.");
    return addOutgoingDraftAttachment(draftId, file);
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ draftId: string }> }) {
  return authenticated(request, async () => {
    const { draftId } = await context.params;
    const { attachmentId } = z.object({ attachmentId: z.string() }).parse(await request.json());
    return removeOutgoingDraftAttachment(draftId, attachmentId);
  });
}
