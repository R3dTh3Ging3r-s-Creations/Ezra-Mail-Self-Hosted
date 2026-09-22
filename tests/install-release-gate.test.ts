import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { verifyInstallRelease } from "../scripts/verify-install-release";

const execFile = promisify(execFileCallback);

describe("guided installation release gate", () => {
  it("accepts normal installer guidance that routes owner setup through the bootstrap wizard", async () => {
    const { stdout } = await execFile(process.execPath, ["--import", "tsx", "scripts/verify-install-release.ts"], {
      cwd: process.cwd(),
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      checked: expect.arrayContaining(["docs/EMAIL_AGENT_SETUP.md", "installer/EzraMailSetup.ps1", "installer/install-ezra-ubuntu.sh"]),
    });
  });

  it("accepts the public export without the private Windows tester handoff", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-install-release-public-"));
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.mkdir(path.join(root, "installer"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "EMAIL_AGENT_SETUP.md"), "The link is single-use and expires after 15 minutes.\n");
    await fs.writeFile(path.join(root, "installer", "EzraMailSetup.ps1"), "npm run auth:bootstrap\n");
    await fs.writeFile(path.join(root, "installer", "install-ezra-ubuntu.sh"), "npm run auth:bootstrap\n");

    await expect(verifyInstallRelease(root)).resolves.toEqual({
      ok: true,
      checked: ["docs/EMAIL_AGENT_SETUP.md", "installer/EzraMailSetup.ps1", "installer/install-ezra-ubuntu.sh"],
    });

    await fs.rm(root, { recursive: true, force: true });
  });
});
