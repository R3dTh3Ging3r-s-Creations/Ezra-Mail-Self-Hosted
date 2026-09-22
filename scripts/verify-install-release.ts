import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_FILES = [
  "docs/EMAIL_AGENT_SETUP.md",
  "installer/EzraMailSetup.ps1",
  "installer/install-ezra-ubuntu.sh",
] as const;
const PRIVATE_WINDOWS_HANDOFF = "docs/WINDOWS_TESTER_HANDOFF.md";

export async function verifyInstallRelease(root = process.cwd()) {
  const contents: Array<readonly [string, string]> = await Promise.all(REQUIRED_FILES.map(async (relativePath) => [
    relativePath,
    await fs.readFile(path.join(root, relativePath), "utf8"),
  ] as const));
  const privateWindowsHandoff = await fs.readFile(path.join(root, PRIVATE_WINDOWS_HANDOFF), "utf8")
    .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (privateWindowsHandoff !== undefined) contents.push([PRIVATE_WINDOWS_HANDOFF, privateWindowsHandoff]);
  const read = (relativePath: string) => contents.find(([file]) => file === relativePath)?.[1] || "";
  const failures: string[] = [];
  const normalDocs = `${read("docs/EMAIL_AGENT_SETUP.md")}\n${read("docs/WINDOWS_TESTER_HANDOFF.md")}`;
  if (!/auth:bootstrap/.test(read("installer/EzraMailSetup.ps1"))) failures.push("Windows installer does not use the first-owner bootstrap.");
  if (!/auth:bootstrap/.test(read("installer/install-ezra-ubuntu.sh"))) failures.push("Ubuntu installer does not use the first-owner bootstrap.");
  if (!/single-use and expires after 15 minutes/i.test(read("docs/EMAIL_AGENT_SETUP.md"))) failures.push("Ubuntu guidance does not state one-time expiry.");
  if (/npm run auth:hash|set\s+EZRA_AUTH_PASSWORD_HASH|generate a password hash/i.test(normalDocs)) {
    failures.push("Normal installation guidance still requires a manual owner password hash.");
  }
  if (/^\s*(?:sudo\s+)?(?:systemctl|ssh)\s+.*(?:install|setup)|^\s*(?:edit|open)\s+[`']?\.env\.local/im.test(normalDocs)) {
    failures.push("Normal installation guidance still requires a manual environment, service, or SSH step.");
  }
  if (failures.length) throw new Error(failures.join("\n"));
  return { ok: true, checked: contents.map(([relativePath]) => relativePath) };
}

async function main() {
  process.stdout.write(`${JSON.stringify(await verifyInstallRelease())}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
