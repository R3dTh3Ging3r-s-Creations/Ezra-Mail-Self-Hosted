import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import playwrightConfig from "../playwright.config";
import { isAuthoritativePublicMirror } from "../scripts/build-public-mirror";

const isExportedWorkspace = await isAuthoritativePublicMirror(process.cwd());
const publicWorkflowPath = isExportedWorkspace
  ? path.join(process.cwd(), ".github", "workflows", "release-gate.yml")
  : path.join(process.cwd(), "public-release", "release-gate.yml");

describe("v0.7.3 release operations", () => {
  it("starts Playwright without Windows-only npm.cmd or prestart hooks", () => {
    const command = typeof playwrightConfig.webServer === "object" && !Array.isArray(playwrightConfig.webServer)
      ? playwrightConfig.webServer.command
      : "";
    expect(command).toBe("node node_modules/next/dist/bin/next start");
    expect(command).not.toMatch(/npm\.cmd|powershell/i);
  });

  it("does not reuse a local web server in CI", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "playwright.config.ts"), "utf8");
    expect(source).toContain("reuseExistingServer: !process.env.CI");
  });

  it("uses the matching digest-pinned Playwright image on the Linux runner", async () => {
    const workflow = await fs.readFile(publicWorkflowPath, "utf8");
    expect(workflow).toContain("mcr.microsoft.com/playwright:v1.60.0-noble@sha256:");
    expect(workflow).toContain('--volume "$GITHUB_WORKSPACE:/source:ro"');
    expect(workflow).toContain("npm ci --ignore-scripts && node scripts/apply-dependency-patches.mjs && npm run build && npm run test:e2e");
    expect(workflow).not.toContain('--user "$(id -u):$(id -g)"');
    expect(workflow).not.toContain("playwright install chromium");
    expect(workflow).not.toContain("docker.sock");
  });

  it("applies the verified ExcelJS compatibility patch after script-free installs", async () => {
    const workflowPaths = isExportedWorkspace
      ? [publicWorkflowPath]
      : [publicWorkflowPath, path.join(process.cwd(), ".github", "workflows", "release-gate.yml")];

    for (const workflowPath of workflowPaths) {
      const workflow = await fs.readFile(workflowPath, "utf8");
      expect(workflow).toContain("node scripts/apply-dependency-patches.mjs");
    }
  });

  it.skipIf(isExportedWorkspace)("does not mark deployment complete before recovery timers pass validation", async () => {
    const deploy = await fs.readFile(path.join(process.cwd(), "scripts", "deploy-thing1.ps1"), "utf8");
    const installAt = deploy.indexOf("install-thing1-backup-timers.sh");
    const completeAt = deploy.indexOf("deployment_complete=1");
    expect(installAt).toBeGreaterThan(0);
    expect(completeAt).toBeGreaterThan(installAt);
  });

  it.skipIf(isExportedWorkspace)("restores prior timer units if installation fails partway", async () => {
    const installer = await fs.readFile(path.join(process.cwd(), "scripts", "install-thing1-backup-timers.sh"), "utf8");
    expect(installer).toContain("restoring the previous timer configuration");
    expect(installer).toContain("restore_file");
    expect(installer).toContain("trap finish EXIT");
    expect(installer).toContain("committed=1");
  });
});
