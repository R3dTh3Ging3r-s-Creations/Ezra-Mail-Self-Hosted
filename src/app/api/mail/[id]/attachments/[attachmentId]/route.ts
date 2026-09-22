import { apiError } from "@/lib/email/api";
import { requireAuth } from "@/lib/email/auth";
import { downloadIncomingAttachment } from "@/lib/email/attachments";
import { getProfessionalMessageDetail } from "@/lib/email/professional";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string; attachmentId: string }> }) {
  try {
    await requireAuth(request);
    const { id, attachmentId } = await context.params;
    await getProfessionalMessageDetail(id);
    const attachment = await downloadIncomingAttachment(id, attachmentId);
    const confirmed = new URL(request.url).searchParams.get("confirmRisk") === "true";
    if (attachment.risky && !confirmed) return Response.json({ error: "This file type can contain active content. Confirm the warning before downloading." }, { status: 409 });
    const body = attachment.bytes.buffer.slice(attachment.bytes.byteOffset, attachment.bytes.byteOffset + attachment.bytes.byteLength) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "content-type": attachment.mimeType,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
        "content-length": String(attachment.bytes.length),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
