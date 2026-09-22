import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractAttachmentText,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_PREVIEW_BYTES,
  inspectAttachmentPreview,
  validateAttachmentPreviewBytes,
  validateAttachment,
} from "@/lib/email/attachments";

describe("attachment safety", () => {
  it("allows supported passive document types", () => {
    expect(validateAttachment("brief.pdf", 1024).allowed).toBe(true);
    expect(validateAttachment("notes.docx", 1024).allowed).toBe(true);
    expect(validateAttachment("tracking.xlsx", 1024).allowed).toBe(true);
  });

  it("blocks macros, archives, executables, and oversized files", () => {
    expect(validateAttachment("payload.exe", 100).allowed).toBe(false);
    expect(validateAttachment("archive.zip", 100).allowed).toBe(false);
    expect(validateAttachment("sheet.xlsm", 100).allowed).toBe(false);
    expect(validateAttachment("large.pdf", MAX_ATTACHMENT_BYTES + 1).allowed).toBe(false);
  });

  it("rejects malformed supported documents during extraction", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-test-"));
    const file = path.join(directory, "malformed.pdf");
    const officeFile = path.join(directory, "malformed.docx");
    await fs.writeFile(file, "This is not a PDF.");
    await fs.writeFile(officeFile, "This is not an Office document.");
    try {
      await expect(extractAttachmentText(file, "malformed.pdf")).rejects.toThrow("does not match the .pdf file type");
      await expect(extractAttachmentText(officeFile, "malformed.docx")).rejects.toThrow("does not match the .docx file type");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("allows only bounded PDF, raster image, and UTF-8 text preview candidates", () => {
    expect(inspectAttachmentPreview({ name: "report.pdf", mimeType: "application/pdf", size: 512 })).toEqual({ status: "available", kind: "pdf" });
    expect(inspectAttachmentPreview({ name: "photo.png", mimeType: "image/png", size: 512 })).toEqual({ status: "available", kind: "image" });
    expect(inspectAttachmentPreview({ name: "notes.txt", mimeType: "text/plain", size: 512 })).toEqual({ status: "available", kind: "text" });
    expect(inspectAttachmentPreview({ name: "archive.zip", mimeType: "application/zip", size: 512 })).toMatchObject({ status: "unsupported" });
    expect(inspectAttachmentPreview({ name: "large.pdf", mimeType: "application/pdf", size: MAX_ATTACHMENT_PREVIEW_BYTES + 1 })).toMatchObject({ status: "too_large" });
  });

  it("verifies bytes before previewing and never accepts disguised active content", () => {
    expect(() => validateAttachmentPreviewBytes("report.pdf", "application/pdf", Buffer.from("not a PDF"))).toThrow("does not match");
    expect(() => validateAttachmentPreviewBytes("photo.png", "image/png", Buffer.from("not an image"))).toThrow("does not match");
    expect(() => validateAttachmentPreviewBytes("notes.txt", "text/plain", Buffer.from([0xff, 0xfe]))).toThrow("valid UTF-8");
  });
});
