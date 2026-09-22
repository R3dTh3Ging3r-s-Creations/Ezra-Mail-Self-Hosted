import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const excelVersion = "4.4.1-prerelease.0";
const originalSha256 = "f7625f314ff39396989c91880b8565d22b448e7760fc9e5f61bc661b5c234077";
const patchedSha256 = "d17f080b21a2182a59dea7bc68ccf9d2f05bc8bf0766f493d489ec653927cdc5";
const excelRoot = path.join(process.cwd(), "node_modules", "exceljs");
const readerPath = path.join(excelRoot, "lib", "stream", "xlsx", "workbook-reader.js");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function replaceExactlyOnce(contents, original, replacement) {
  const first = contents.indexOf(original);
  if (first < 0 || contents.indexOf(original, first + original.length) >= 0) {
    throw new Error("ExcelJS patch target is missing or ambiguous.");
  }
  return `${contents.slice(0, first)}${replacement}${contents.slice(first + original.length)}`;
}

const packageJson = JSON.parse(await fs.readFile(path.join(excelRoot, "package.json"), "utf8"));
if (packageJson.version !== excelVersion) {
  throw new Error(`ExcelJS patch requires ${excelVersion}; found ${String(packageJson.version)}.`);
}

const installed = await fs.readFile(readerPath, "utf8");
const installedDigest = sha256(installed);
if (installedDigest === patchedSha256) {
  console.log(`ExcelJS ${excelVersion} streaming patch already verified.`);
  process.exit(0);
}
if (installedDigest !== originalSha256) {
  throw new Error("ExcelJS streaming patch refused unreviewed upstream content.");
}

let patched = replaceExactlyOnce(
  installed,
  "for await (const entry of iterateStream(zip)) {",
  "for await (const entry of zip) {",
);
patched = replaceExactlyOnce(
  patched,
  "if (this.sharedStrings && this.workbookRels) {",
  "if (this.sharedStrings && this.workbookRels && this.model) {",
);
if (sha256(patched) !== patchedSha256) throw new Error("ExcelJS streaming patch produced unexpected content.");
await fs.writeFile(readerPath, patched, "utf8");
console.log(`ExcelJS ${excelVersion} streaming patch applied and verified.`);
