import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractAttachmentText } from "@/lib/email/attachments";

const runFile = promisify(execFile);
const projectRequire = createRequire(path.join(process.cwd(), "package.json"));
const mammothRequire = createRequire(projectRequire.resolve("mammoth/package.json"));
const cli = path.join(path.dirname(projectRequire.resolve("mammoth/package.json")), "bin", "mammoth");
let directory: string;
let documentPath: string;
const documentText = "Quarterly report %.101f — café";

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-docx-"));
  documentPath = path.join(directory, "report %.101f with spaces.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${documentText}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table value</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`);
  await fs.writeFile(documentPath, await zip.generateAsync({ type: "nodebuffer" }));
});

afterAll(async () => {
  if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith("ezra-docx-")) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("Mammoth dependency compatibility", () => {
  it("cannot resolve the vulnerable formatter from the installed document reader", async () => {
    expect(() => mammothRequire.resolve("sprintf-js")).toThrow(/Cannot find module/);
    const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
    expect(Object.keys(lock.packages).filter((name) => /(?:^|\/)node_modules\/sprintf-js$/.test(name))).toEqual([]);
  });

  it("extracts real DOCX paragraphs and table text through the application subprocess", async () => {
    const text = await extractAttachmentText(documentPath, path.basename(documentPath));
    expect(text).toContain(documentText);
    expect(text).toContain("Table value");
  }, 30_000);

  it("rejects a ZIP that is not a Word document through the application subprocess", async () => {
    const zip = new JSZip();
    zip.file("unrelated.txt", "Not a Word document");
    const file = path.join(directory, "invalid.docx");
    await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
    await expect(extractAttachmentText(file, "invalid.docx")).rejects.toThrow();
  }, 30_000);

  it("preserves the installed Mammoth CLI help and option names", async () => {
    const { stdout } = await runFile(process.execPath, [cli, "--help"], { windowsHide: true });
    expect(stdout).toContain("--output-dir");
    expect(stdout).toContain("--output-format");
    expect(stdout).toContain("--style-map");
  });

  it("converts a document with literal format syntax in its name and contents", async () => {
    const { stdout } = await runFile(process.execPath, [cli, documentPath], { windowsHide: true });
    expect(stdout).toContain(`<p>${documentText}</p>`);
    expect(stdout).toContain("<table>");
  });

  it("preserves output-path and style-map parsing", async () => {
    const output = path.join(directory, "converted output.html");
    const styleMap = path.join(directory, "style map.txt");
    await fs.writeFile(styleMap, "p => section:fresh\n");
    await runFile(process.execPath, [cli, documentPath, output, "--style-map", styleMap], { windowsHide: true });
    expect(await fs.readFile(output, "utf8")).toContain(`<section>${documentText}</section>`);
  });

  it("rejects mutually exclusive output destinations without writing output", async () => {
    const output = path.join(directory, "must-not-exist.html");
    await expect(runFile(process.execPath, [cli, documentPath, output, "--output-dir", directory], { windowsHide: true }))
      .rejects.toMatchObject({ code: 2 });
    await expect(fs.access(output)).rejects.toThrow();
  });
});