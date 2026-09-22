import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { execute, newId, nowIso } from "./database";
import { providerAdapterFor } from "./provider-adapter";
import type { EmailAttachment } from "./types";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const allowedExtensions = new Set([".pdf", ".docx", ".xlsx", ".csv", ".txt"]);
const blockedExtensions = new Set([
  ".exe",
  ".dll",
  ".msi",
  ".bat",
  ".cmd",
  ".ps1",
  ".js",
  ".vbs",
  ".scr",
  ".com",
  ".jar",
  ".zip",
  ".rar",
  ".7z",
  ".xlsm",
  ".docm",
  ".pptm",
]);
const riskyDownloadExtensions = new Set(blockedExtensions);
export const MAX_INCOMING_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_PREVIEW_BYTES = 5 * 1024 * 1024;

export type AttachmentPreviewKind = "pdf" | "image" | "text";
export type AttachmentPreviewInspection =
  | { status: "available"; kind: AttachmentPreviewKind }
  | { status: "unsupported"; reason: string }
  | { status: "too_large"; reason: string };

const previewImageMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const previewImageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const previewTextExtensions = new Set([".txt", ".text", ".md", ".markdown", ".csv", ".log"]);

export function inspectAttachmentPreview(input: { name: string; mimeType: string; size: number }): AttachmentPreviewInspection {
  if (input.size > MAX_ATTACHMENT_PREVIEW_BYTES) {
    return { status: "too_large", reason: "This attachment is too large to preview safely." };
  }
  const extension = path.extname(input.name).toLowerCase();
  const mimeType = input.mimeType.toLowerCase().split(";", 1)[0].trim();
  if (extension === ".pdf" && mimeType === "application/pdf") return { status: "available", kind: "pdf" };
  if (previewImageExtensions.has(extension) && previewImageMimeTypes.has(mimeType)) return { status: "available", kind: "image" };
  if (previewTextExtensions.has(extension) && mimeType.startsWith("text/") && mimeType !== "text/html") {
    return { status: "available", kind: "text" };
  }
  return { status: "unsupported", reason: "Ezra can preview only PDFs, common images, and plain-text documents." };
}

export function validateAttachmentPreviewBytes(name: string, mimeType: string, bytes: Buffer): AttachmentPreviewKind {
  const inspection = inspectAttachmentPreview({ name, mimeType, size: bytes.length });
  if (inspection.status !== "available") throw new Error(inspection.reason);
  if (inspection.kind === "pdf") {
    if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("Attachment content does not match the PDF file type.");
    }
    return "pdf";
  }
  if (inspection.kind === "image") {
    const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    const gif = bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a");
    const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!png && !jpeg && !gif && !webp) throw new Error("Attachment content does not match the image file type.");
    return "image";
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\u0000")) throw new Error("contains NUL");
  } catch {
    throw new Error("Attachment text is not valid UTF-8.");
  }
  return "text";
}

export function isRiskyAttachmentName(name: string) {
  return riskyDownloadExtensions.has(path.extname(name).toLowerCase());
}

export async function cacheMessageAttachments(messageId: string, attachments: EmailAttachment[]) {
  const now = nowIso();
  for (const attachment of attachments) {
    await execute(
      `INSERT INTO message_attachments
        (id, message_id, provider_attachment_id, filename, mime_type, byte_size, is_inline, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(message_id, provider_attachment_id) DO UPDATE SET
         filename = excluded.filename, mime_type = excluded.mime_type,
         byte_size = excluded.byte_size, updated_at = excluded.updated_at`,
      [newId("msgattach"), messageId, attachment.id, safeDownloadName(attachment.name), attachment.mimeType || "application/octet-stream", Math.max(0, Number(attachment.size || 0)), now, now],
    );
  }
}

type IncomingAttachmentMetadata = {
  accountEmail: string;
  accountProvider: import("./types").AccountProvider;
  externalMessageId: string;
  providerAttachmentId: string;
  name: string;
  mimeType: string;
  size: number;
};

async function incomingAttachmentMetadata(messageId: string, attachmentId: string): Promise<IncomingAttachmentMetadata> {
  const result = await execute(
    `SELECT ma.*, m.external_message_id, a.email AS account_email, a.provider AS account_provider
     FROM message_attachments ma
     JOIN email_messages m ON m.id = ma.message_id
     JOIN email_accounts a ON a.id = m.account_id
     WHERE ma.message_id = ? AND ma.provider_attachment_id = ?`,
    [messageId, attachmentId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Attachment metadata is not available. Open the message and try again.");
  return {
    accountEmail: String(row.account_email),
    accountProvider: String(row.account_provider || "gmail") as import("./types").AccountProvider,
    externalMessageId: String(row.external_message_id),
    providerAttachmentId: String(row.provider_attachment_id),
    name: safeDownloadName(String(row.filename)),
    mimeType: String(row.mime_type || "application/octet-stream"),
    size: Math.max(0, Number(row.byte_size || 0)),
  };
}

export async function inspectIncomingAttachmentPreview(messageId: string, attachmentId: string) {
  const attachment = await incomingAttachmentMetadata(messageId, attachmentId);
  const inspection = inspectAttachmentPreview({ name: attachment.name, mimeType: attachment.mimeType, size: attachment.size });
  return { ...inspection, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size };
}

export async function downloadIncomingAttachment(messageId: string, attachmentId: string) {
  const attachment = await incomingAttachmentMetadata(messageId, attachmentId);
  const bytes = await providerAdapterFor(attachment.accountProvider)
    .downloadAttachment(attachment.accountEmail, attachment.externalMessageId, attachment.providerAttachmentId, attachment.name);
  if (bytes.length > MAX_INCOMING_DOWNLOAD_BYTES) throw new Error("Incoming attachment exceeds the 25 MB download limit.");
  return { bytes, name: attachment.name, mimeType: attachment.mimeType, risky: isRiskyAttachmentName(attachment.name) };
}

export async function readIncomingAttachmentPreview(messageId: string, attachmentId: string) {
  const inspection = await inspectIncomingAttachmentPreview(messageId, attachmentId);
  if (inspection.status !== "available") throw new Error(inspection.reason);
  const attachment = await downloadIncomingAttachment(messageId, attachmentId);
  const kind = validateAttachmentPreviewBytes(attachment.name, attachment.mimeType, attachment.bytes);
  return { kind, name: attachment.name, mimeType: attachment.mimeType, bytes: attachment.bytes };
}

function safeDownloadName(value: string) {
  return (path.basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim() || "attachment").slice(0, 180);
}

export function validateAttachment(name: string, size: number) {
  const extension = path.extname(name).toLowerCase();
  if (size > MAX_ATTACHMENT_BYTES) {
    return { allowed: false, reason: "Attachment exceeds the 10 MB limit." };
  }
  if (blockedExtensions.has(extension)) {
    return { allowed: false, reason: "Active, executable, macro, or archive content is blocked." };
  }
  if (!allowedExtensions.has(extension)) {
    return { allowed: false, reason: "Attachment type is not supported." };
  }
  return { allowed: true, reason: null };
}

export async function extractAttachmentText(filePath: string, name: string) {
  const stat = await fs.stat(filePath);
  const validation = validateAttachment(name, stat.size);
  if (!validation.allowed) throw new Error(validation.reason || "Attachment rejected.");
  await validateAttachmentSignature(filePath, name);

  const cliPath = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const scriptPath = path.join(process.cwd(), "scripts", "extract-attachment.ts");
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, scriptPath, filePath, name], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Attachment extraction exceeded 30 seconds."));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 250_000) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.slice(0, 100_000));
      else reject(new Error(stderr.trim() || `Attachment extractor exited with ${code}`));
    });
  });
}

async function validateAttachmentSignature(filePath: string, name: string) {
  const extension = path.extname(name).toLowerCase();
  if (extension !== ".pdf" && extension !== ".docx" && extension !== ".xlsx") return;
  const handle = await fs.open(filePath, "r");
  try {
    const signature = Buffer.alloc(8);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (extension === ".pdf") {
      if (bytesRead < 5 || signature.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error("Attachment content does not match the .pdf file type.");
      }
      return;
    }
    if (bytesRead < 4 || !signature.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new Error(`Attachment content does not match the ${extension} file type.`);
    }
  } finally {
    await handle.close();
  }
}
