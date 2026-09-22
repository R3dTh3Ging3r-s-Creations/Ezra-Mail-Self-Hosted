import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getProfessionalMessageDetail: vi.fn(),
  inspectIncomingAttachmentPreview: vi.fn(),
  readIncomingAttachmentPreview: vi.fn(),
}));

vi.mock("@/lib/email/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/email/auth")>(),
  requireAuth: calls.requireAuth,
}));
vi.mock("@/lib/email/professional", () => ({ getProfessionalMessageDetail: calls.getProfessionalMessageDetail }));
vi.mock("@/lib/email/attachments", () => ({
  inspectIncomingAttachmentPreview: calls.inspectIncomingAttachmentPreview,
  readIncomingAttachmentPreview: calls.readIncomingAttachmentPreview,
}));

import { GET } from "@/app/api/mail/[id]/attachments/[attachmentId]/preview/route";

describe("GET attachment preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.requireAuth.mockResolvedValue(undefined);
    calls.getProfessionalMessageDetail.mockResolvedValue({ detail: { message: { id: "mail-1" } } });
  });

  it("returns verified PDF bytes with private no-store and nosniff headers", async () => {
    calls.inspectIncomingAttachmentPreview.mockResolvedValue({ status: "available", kind: "pdf", name: "report.pdf", mimeType: "application/pdf", size: 24 });
    calls.readIncomingAttachmentPreview.mockResolvedValue({ kind: "pdf", name: "report.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.7\nSafe preview") });

    const response = await GET(new Request("http://localhost/api/mail/mail-1/attachments/attachment-1/preview"), {
      params: Promise.resolve({ id: "mail-1", attachmentId: "attachment-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.text()).resolves.toContain("%PDF-1.7");
    expect(calls.readIncomingAttachmentPreview).toHaveBeenCalledWith("mail-1", "attachment-1");
  });

  it("reports an unavailable preview state without downloading bytes", async () => {
    calls.inspectIncomingAttachmentPreview.mockResolvedValue({ status: "too_large", reason: "This attachment is too large to preview safely.", name: "large.pdf", mimeType: "application/pdf", size: 6_000_000 });

    const response = await GET(new Request("http://localhost/api/mail/mail-1/attachments/attachment-1/preview"), {
      params: Promise.resolve({ id: "mail-1", attachmentId: "attachment-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ preview: { status: "too_large" } });
    expect(calls.readIncomingAttachmentPreview).not.toHaveBeenCalled();
  });

  it("redacts provider failures as a failed preview decision with private security headers", async () => {
    calls.inspectIncomingAttachmentPreview.mockResolvedValue({ status: "available", kind: "pdf", name: "report.pdf", mimeType: "application/pdf", size: 24 });
    calls.readIncomingAttachmentPreview.mockRejectedValue(new Error("Graph provider secret/path detail"));

    const response = await GET(new Request("http://localhost/api/mail/mail-1/attachments/attachment-1/preview"), {
      params: Promise.resolve({ id: "mail-1", attachmentId: "attachment-1" }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await response.json();
    expect(body).toEqual({
      preview: {
        status: "failed",
        reason: "Ezra could not prepare this attachment preview.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("Graph provider secret/path detail");
  });
});
