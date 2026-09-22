import { AuthError, requireAuth } from "@/lib/email/auth";
import {
  inspectIncomingAttachmentPreview,
  readIncomingAttachmentPreview,
} from "@/lib/email/attachments";
import { getProfessionalMessageDetail } from "@/lib/email/professional";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string; attachmentId: string }> }) {
  try {
    await requireAuth(request);
    const { id, attachmentId } = await context.params;
    await getProfessionalMessageDetail(id);
    const inspection = await inspectIncomingAttachmentPreview(id, attachmentId);
    if (inspection.status !== "available") return Response.json({ preview: inspection }, {
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
    const preview = await readIncomingAttachmentPreview(id, attachmentId);
    const body = preview.bytes.buffer.slice(preview.bytes.byteOffset, preview.bytes.byteOffset + preview.bytes.byteLength) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "content-type": preview.kind === "text" ? "text/plain; charset=utf-8" : preview.mimeType,
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(preview.name)}`,
        "content-length": String(preview.bytes.length),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return Response.json({
      preview: {
        status: "failed",
        reason: "Ezra could not prepare this attachment preview.",
      },
    }, {
      status: error instanceof AuthError ? error.status : 400,
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
  }
}
