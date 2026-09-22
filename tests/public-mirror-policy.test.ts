import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyPublicPath,
  loadPublicExportPolicy,
  scanClassifiedPublicTree,
  scanPublicText,
} from "../scripts/public-mirror-policy";
import { isAuthoritativePublicMirror } from "../scripts/build-public-mirror";

const temporaryRoots: string[] = [];
const isExportedWorkspace = await isAuthoritativePublicMirror(process.cwd());
const fixtureText = (encoded: string): string => Buffer.from(encoded, "base64").toString("utf8");

const binaryAudit: Array<{ path: string; type: string; sha256: string }> = [];

function crc32(contents: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, contents = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(contents.length);
  header.write(type, 4, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), contents])));
  return Buffer.concat([header, contents, checksum]);
}

function validPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.alloc(5))),
    pngChunk("IEND"),
  ]);
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function validIco(): Buffer {
  const image = validPng();
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 1;
  header[7] = 1;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(image.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, image]);
}

function validWoff(signature: "wOFF" | "wOF2"): Buffer {
  const header = Buffer.alloc(signature === "wOFF" ? 65 : 50);
  header.write(signature, 0, "ascii");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(header.length, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt16BE(0, 14);
  if (signature === "wOFF") {
    header.write("cmap", 44, "ascii");
    header.writeUInt32BE(64, 48);
    header.writeUInt32BE(1, 52);
    header.writeUInt32BE(1, 56);
    header[64] = 0;
  } else {
    header[48] = 0;
    header[49] = 1;
  }
  return header;
}

function validTtf(): Buffer {
  const contents = Buffer.alloc(82);
  contents.writeUInt32BE(0x00010000, 0);
  contents.writeUInt16BE(1, 4);
  contents.write("head", 12, "ascii");
  contents.writeUInt32BE(28, 20);
  contents.writeUInt32BE(54, 24);
  contents.writeUInt32BE(0x5f0f3cf5, 40);
  return contents;
}

function validPdf(): Buffer {
  const prefix = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n";
  const xref = "xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\n";
  return Buffer.from(`${prefix}${xref}startxref\n${Buffer.byteLength(prefix)}\n%%EOF\n`, "utf8");
}

const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0x00, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0xff, 0xd9]);

const validBinaryFiles: Record<string, Buffer> = {
  "assets/image.png": validPng(),
  "assets/photo.jpg": validJpeg,
  "assets/photo.jpeg": validJpeg,
  "assets/image.gif": Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
  "assets/image.ico": validIco(),
  "assets/font.woff": validWoff("wOFF"),
  "assets/font.woff2": validWoff("wOF2"),
  "assets/font.ttf": validTtf(),
  "assets/document.pdf": validPdf(),
};

async function createFixture(
  files: Record<string, string | Buffer>,
  policy: Record<string, unknown> = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-public-policy-"));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "public-export.json"), JSON.stringify({
    copyDirectories: [],
    copyFiles: ["README.md", "config/public-export.json"],
    mappedFiles: [],
    privateRoots: ["private"],
    binaryAudit,
    scriptAudit: [],
    ...policy,
  }));
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("public mirror policy", () => {
  it("keeps generated test artifacts beneath an explicit private root", async () => {
    const root = await createFixture({
      "README.md": "public",
      "data/tests/session-00000000-0000-4000-8000-000000000000.sqlite": "temporary",
    }, { privateRoots: ["data"] });

    await expect(scanClassifiedPublicTree(root)).resolves.toEqual([]);
  });

  it.skipIf(isExportedWorkspace)("finds no private identities in every public-classified text file", async () => {
    const findings = await scanClassifiedPublicTree(process.cwd());

    expect(findings).toEqual([]);
  });

  it("classifies explicit public and private paths", () => {
    expect(classifyPublicPath("src/app/page.tsx")).toBe("copy");
    expect(classifyPublicPath("public-release/README.md")).toBe("mapped");
    expect(classifyPublicPath("public-release/EZRA_MAIL_ROADMAP.md")).toBe("mapped");
    expect(classifyPublicPath("docs/EZRA_MAIL_ROADMAP.md")).toBe("private");
    expect(classifyPublicPath("SERVER_HANDOFF.md")).toBe("private");
    expect(classifyPublicPath("new-unclassified-file.txt")).toBe("unknown");
  });

  it("redacts private values in findings", () => {
    const privateIp = fixtureText("MTAuMC4wLjE=");
    const findings = scanPublicText("example.txt", `host ${privateIp}`);

    expect(findings[0]).toMatchObject({ ruleId: "rfc1918", line: 1 });
    expect(findings[0]?.redactedExcerpt).not.toContain(privateIp);
  });

  it("ignores source identifiers and request-derived values that are not credential literals", () => {
    const findings = scanPublicText("src/auth.ts", [
      "const token = crypto.randomUUID();",
      "const session = request.headers.get('cookie');",
      "const values = { password: body.password, clientSecret: process.env.CLIENT_SECRET };",
    ].join("\n"));

    expect(findings).toEqual([]);
  });

  it("continues to reject real credential literals in configuration and source assignments", () => {
    const configSecret = fixtureText("QVBJX1RPS0VOPXJlYWwtc2VjcmV0LXZhbHVl");
    const jsonSecret = fixtureText("eyAiY2xpZW50X3NlY3JldCI6ICJyZWFsLXNlY3JldC12YWx1ZSIgfQ==");
    const sourceSecret = fixtureText("Y29uc3QgYXBpVG9rZW4gPSAicmVhbC1zZWNyZXQtdmFsdWUiOw==");

    for (const content of [configSecret, jsonSecret, sourceSecret]) {
      expect(scanPublicText("config/example.txt", content)).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "token-assignment" }),
      ]));
    }
  });

  it("rejects literal credentials while allowing only syntactic code references", () => {
    const literals = [
      "QVBJX1RPS0VOPWFiYzEyMw==",
      "QVBJX1RPS0VOPSJhYmMxMjMi",
      "UEFTU1dPUkQ9cmVhbHBhc3N3b3JkMTIz",
      "QVVUSF9TRUNSRVQ9c2tfbGl2ZV9leGFtcGxl",
    ].map((encoded) => Buffer.from(encoded, "base64").toString("utf8"));
    for (const content of literals) {
      expect(scanPublicText("src/example.ts", content)).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "token-assignment" }),
      ]));
    }
    expect(scanPublicText("src/example.ts", "const apiToken = process.env.API_TOKEN;")).toEqual([]);
  });

  it("rejects dotted credential literals while allowing member expressions", () => {
    const dottedSecret = fixtureText("YXBpVG9rZW49c2subGl2ZS5zZWNyZXQ=");

    for (const [relativePath, content] of [
      ["config/provider.conf", dottedSecret],
      ["src/provider.ts", `const ${dottedSecret};`],
    ]) {
      expect(scanPublicText(relativePath, content)).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "token-assignment" }),
      ]));
    }

    expect(scanPublicText("src/provider.ts", `const ${fixtureText("YXBpVG9rZW49cHJvY2Vzcy5lbnYuQVBJX1RPS0VO")};`)).toEqual([]);
  });

  it("allows member expressions only in recognized code files", () => {
    const configMember = fixtureText("YXBpVG9rZW49Y29uZmlnLmFwaVRva2Vu");
    const yamlMember = fixtureText("YXBpVG9rZW46IGNvbmZpZy5hcGlUb2tlbg==");
    const envMember = fixtureText("QVBJX1RPS0VOPXByb2Nlc3MuZW52LkFQSV9UT0tFTg==");

    for (const [relativePath, content] of [
      ["config/provider.conf", configMember],
      [".env", envMember],
      ["config/provider.yaml", yamlMember],
      ["docs/provider.txt", configMember],
    ]) {
      expect(scanPublicText(relativePath, content)).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "token-assignment" }),
      ]));
    }

    for (const extension of ["ts", "tsx", "js", "mjs"]) {
      expect(scanPublicText(`src/provider.${extension}`, `const ${configMember};`)).toEqual([]);
      expect(scanPublicText(`scripts/provider.${extension}`, `const ${envMember};`)).toEqual([]);
    }
  });

  it("rejects member-expression credential values in non-code JSON", () => {
    const jsonMember = fixtureText("eyAiY2xpZW50X3NlY3JldCI6IGNvbmZpZy5hcGlUb2tlbiB9");

    expect(scanPublicText("config/provider.json", jsonMember)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "token-assignment" }),
    ]));
  });

  it("allows call-expression credential values only in recognized code files", () => {
    const callAssignment = fixtureText("YXBpVG9rZW49Y3J5cHRvLnJhbmRvbVVVSUQoKQ==");

    for (const relativePath of ["config/provider.conf", "docs/provider.md"]) {
      expect(scanPublicText(relativePath, callAssignment)).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "token-assignment" }),
      ]));
    }

    for (const extension of ["ts", "tsx", "js", "mjs"]) {
      expect(scanPublicText(`src/provider.${extension}`, `const ${callAssignment};`)).toEqual([]);
    }
  });

  it("does not treat dependency names in the lockfile as session credentials", () => {
    expect(scanPublicText("package-lock.json", ['{ "coo', 'kie": "^0.7.1" }'].join(""))).toEqual([]);
  });

  it("detects sensitive filenames during direct text scans", () => {
    expect(scanPublicText(".env.local", "PUBLIC_VALUE=example")).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "environment-file", line: 1 }),
    ]));
    expect(scanPublicText("data/mail.sqlite", "not a secret")).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "database-file", line: 1 }),
    ]));
  });

  it("rejects owner aliases, key variants, assignment secrets, and broad production paths", () => {
    const findings = scanPublicText("example.txt", [
      fixtureText("aG9zdD1ub2RlLmV4YW1wbGUudHMubmV0"),
      fixtureText("LS0tLS1CRUdJTiBQR1AgUFJJVkFURSBLRVkgQkxPQ0stLS0tLQ=="),
      fixtureText("Q0xJRU5UX1NFQ1JFVD1ub3QtZm9yLXB1YmxpY2F0aW9u"),
      fixtureText("UEFTU1dPUkQ9bm90LWZvci1wdWJsaWNhdGlvbg=="),
      fixtureText("UEFTU1BIUkFTRT1ub3QtZm9yLXB1YmxpY2F0aW9u"),
      "D:\\EzraMail\\data",
      "E:\\apps\\mail",
      fixtureText("L21udC9wcml2YXRlL2V6cmE="),
      fixtureText("L3Vzci9sb2NhbC9lenJh"),
    ].join("\n"));

    expect(findings.map((finding) => finding.ruleId)).toEqual(expect.arrayContaining([
      "tailscale-hostname",
      "private-key",
      "token-assignment",
      "absolute-windows-path",
      "absolute-linux-path",
    ]));
    expect(findings.every((finding) => !finding.redactedExcerpt.includes("not-for-publication"))).toBe(true);
  });

  it("detects both Windows separators without allowing placeholders to hide real paths", () => {
    const findings = scanPublicText("example.txt", [
      "C:/Users/owner/private",
      "<docs> C:\\Users\\owner\\private",
      "C:/Users/YOUR_USER/Documents",
    ].join("\n"));

    expect(findings.filter((finding) => finding.ruleId === "absolute-windows-path")).toHaveLength(2);
  });

  it("does not let a documented placeholder hide another assignment on the same line", () => {
    expect(scanPublicText(".env.example", ["API", "_TOKEN=YOUR_API_TOKEN PASS", "WORD=real-secret"].join(""))).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "token-assignment" }),
    ]));
  });

  it("scans every Windows path candidate instead of stopping after a placeholder", () => {
    const findings = scanPublicText("example.txt", "C:/Users/YOUR_USER/x C:/Users/actual/secret");

    expect(findings.filter((finding) => finding.ruleId === "absolute-windows-path")).toHaveLength(1);
  });

  it("allows explicitly documented placeholders but not database artifacts", () => {
    expect(scanPublicText(".env.example", ["API", "_TOKEN=YOUR_API_TOKEN"].join(""))).toEqual([]);
    expect(scanPublicText("scripts/cleanup-test-databases.mjs", "const sqlitePattern = /\\.sqlite$/;")).toEqual([]);
    expect(scanPublicText("data/runtime.sqlite", "")).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "database-file" }),
    ]));
  });

  it("rejects invalid and duplicate policy paths", async () => {
    const reviewedHash = "0000000000000000000000000000000000000000000000000000000000000000";
    const duplicateRoot = await createFixture({}, { copyFiles: ["README.md", "README.md"] });
    const nonCanonicalRoot = await createFixture({}, { copyFiles: ["./README.md"] });
    const incompleteAuditRoot = await createFixture({}, { binaryAudit: [{ path: "assets/bad.png", type: "png", sha256: "not-a-hash" }] });
    const missingScriptAuditRoot = await createFixture({}, { scriptAudit: undefined });
    const nonArrayScriptAuditRoot = await createFixture({}, { scriptAudit: "not-an-array" });
    const malformedScriptAuditRoot = await createFixture({}, { scriptAudit: [{ path: "scripts/example.ts" }] });
    const duplicateScriptAuditRoot = await createFixture({}, { scriptAudit: [
      { path: "Scripts/example.ts", sha256: reviewedHash },
      { path: "scripts/example.ts", sha256: reviewedHash },
    ] });
    const nonCanonicalScriptAuditRoot = await createFixture({}, { scriptAudit: [
      { path: "./scripts/example.ts", sha256: reviewedHash },
    ] });
    const uppercaseScriptHashRoot = await createFixture({}, { scriptAudit: [
      { path: "scripts/example.ts", sha256: "A".repeat(64) },
    ] });
    const nonHexScriptHashRoot = await createFixture({}, { scriptAudit: [
      { path: "scripts/example.ts", sha256: "z".repeat(64) },
    ] });
    const trustRootAuditRoot = await createFixture({}, { scriptAudit: [
      { path: "scripts/build-public-mirror.ts", sha256: reviewedHash },
    ] });
    const sortedScriptAuditRoot = await createFixture({}, { scriptAudit: [
      { path: "scripts/z-last.ts", sha256: reviewedHash },
      { path: "scripts/a-first.ts", sha256: reviewedHash },
    ] });

    expect(() => loadPublicExportPolicy(duplicateRoot)).toThrow(/duplicate/i);
    expect(() => loadPublicExportPolicy(nonCanonicalRoot)).toThrow(/normalized/i);
    expect(() => loadPublicExportPolicy(incompleteAuditRoot)).toThrow(/binaryAudit/i);
    expect(() => loadPublicExportPolicy(missingScriptAuditRoot)).toThrow(/scriptAudit/i);
    expect(() => loadPublicExportPolicy(nonArrayScriptAuditRoot)).toThrow(/scriptAudit/i);
    expect(() => loadPublicExportPolicy(malformedScriptAuditRoot)).toThrow(/scriptAudit/i);
    expect(() => loadPublicExportPolicy(duplicateScriptAuditRoot)).toThrow(/duplicate.*script audit/i);
    expect(() => loadPublicExportPolicy(nonCanonicalScriptAuditRoot)).toThrow(/normalized/i);
    expect(() => loadPublicExportPolicy(uppercaseScriptHashRoot)).toThrow(/scriptAudit.*SHA-256/i);
    expect(() => loadPublicExportPolicy(nonHexScriptHashRoot)).toThrow(/scriptAudit.*SHA-256/i);
    expect(() => loadPublicExportPolicy(trustRootAuditRoot)).toThrow(/trust root/i);
    expect(loadPublicExportPolicy(sortedScriptAuditRoot).scriptAudit).toEqual([
      { path: "scripts/a-first.ts", sha256: reviewedHash },
      { path: "scripts/z-last.ts", sha256: reviewedHash },
    ]);
  });

  it("rejects symlinks and corrupt binaries without a supported structure", async () => {
    const root = await createFixture({
      "README.md": "public",
      "assets/not-a-png.png": Buffer.from([0, 1, 2, 3]),
      "assets/not-a-pdf.pdf": "not really a PDF",
      "assets/truncated.gif": Buffer.from("GIF89a", "ascii"),
      "assets/polyglot.png": Buffer.concat([validPng(), Buffer.from("not-an-image", "ascii")]),
    }, { copyDirectories: ["assets"] });
    await fs.symlink(root, path.join(root, "assets", "linked"), "junction");

    const findings = await scanClassifiedPublicTree(root);

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "invalid-binary-signature", relativePath: "assets/not-a-png.png" }),
      expect.objectContaining({ ruleId: "invalid-binary-signature", relativePath: "assets/not-a-pdf.pdf" }),
      expect.objectContaining({ ruleId: "unaudited-binary", relativePath: "assets/truncated.gif" }),
      expect.objectContaining({ ruleId: "unaudited-binary", relativePath: "assets/polyglot.png" }),
      expect.objectContaining({ ruleId: "unsupported-file-type", relativePath: "assets/linked" }),
    ]));
  });

  it("requires an exact audit record for every public binary byte sequence and path", async () => {
    const reviewed = validPng();
    const root = await createFixture({
      "README.md": "public",
      "assets/reviewed.png": reviewed,
    }, {
      copyDirectories: ["assets"],
      binaryAudit: [{ path: "assets/reviewed.png", type: "png", sha256: sha256(reviewed) }],
    });

    await expect(scanClassifiedPublicTree(root)).resolves.toEqual([]);

    await fs.writeFile(path.join(root, "assets", "reviewed.png"), Buffer.concat([reviewed, Buffer.from("trailing", "utf8")]));
    await expect(scanClassifiedPublicTree(root)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "binary-audit-mismatch", relativePath: "assets/reviewed.png" }),
    ]));

    await fs.rename(path.join(root, "assets", "reviewed.png"), path.join(root, "assets", "renamed.png"));
    await expect(scanClassifiedPublicTree(root)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "unaudited-binary", relativePath: "assets/renamed.png" }),
    ]));
  });

  it("records exact hashes for every real public branding binary", async () => {
    const policy = loadPublicExportPolicy(process.cwd());

    expect(policy.binaryAudit).toHaveLength(8);
    for (const record of policy.binaryAudit) {
      const contents = await fs.readFile(path.join(process.cwd(), record.path));
      expect(record.type).toBe("png");
      expect(sha256(contents)).toBe(record.sha256);
    }
  });

  it("accepts every real exact-audited branding binary without scanning its bytes as text", async () => {
    const policy = loadPublicExportPolicy(process.cwd());
    const files: Record<string, Buffer> = {};
    for (const record of policy.binaryAudit) {
      files[record.path] = await fs.readFile(path.join(process.cwd(), record.path));
    }
    const root = await createFixture(files, {
      copyDirectories: ["public/branding", "docs/branding"],
      binaryAudit: policy.binaryAudit,
    });

    await expect(scanClassifiedPublicTree(root)).resolves.toEqual([]);
  });

  it("excludes policy-private roots while a clean intended-public fixture remains eligible", async () => {
    const root = await createFixture({
      "README.md": "public",
      "private/owner-only.txt": "not inspected",
    });

    await expect(scanClassifiedPublicTree(root)).resolves.toEqual([]);
  });

  it("fails closed for unknown source paths", async () => {
    const root = await createFixture({ "README.md": "public", "unclassified.txt": "no policy entry" });

    await expect(scanClassifiedPublicTree(root)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "unknown-path", relativePath: "unclassified.txt" }),
    ]));
  });
});
