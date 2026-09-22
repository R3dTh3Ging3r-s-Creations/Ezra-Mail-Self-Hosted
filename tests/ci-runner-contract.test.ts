import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readWorkflow = (name: string) => fs.readFile(
  path.join(process.cwd(), ".github", "workflows", name), "utf8",
);

describe("Public workflow contract", () => {
  it("uses isolated hosted jobs without privileged triggers or credentials", async () => {
    for (const name of ["release-gate.yml", "secret-scan.yml"]) {
      const workflow = await readWorkflow(name);
      expect(workflow).toContain("runs-on: ubuntu-24.04");
      expect(workflow).toContain("contents: read");
      expect(workflow).toContain("persist-credentials: false");
      expect(workflow).not.toMatch(/self-hosted|secrets\.|pull_request_target|workflow_run/);
    }
    const scanner = await readWorkflow("secret-scan.yml");
    expect(scanner).toContain("fetch-depth: 0");
    expect(scanner).toContain("sha256sum --check --strict");
    expect(scanner).toContain("--log-opts='--all'");
    expect(scanner).toContain("dir --redact");
  });

  it("runs unit and browser qualification with a pinned browser image", async () => {
    const workflow = await readWorkflow("release-gate.yml");
    expect(workflow).toMatch(/^\s*- run: npm run test$/m);
    expect(workflow).toMatch(/^\s*- run: npm run build$/m);
    expect(workflow).toContain("npm run build && npm run test:e2e");
    expect(workflow).toMatch(/mcr\.microsoft\.com\/playwright:[^\s]+@sha256:[a-f0-9]{64}/);
  });

  it("excludes private operating guidance from the source snapshot", async () => {
    const policy = JSON.parse(await fs.readFile("config/public-export.json", "utf8"));
    expect(policy.privateRoots).toContain("AGENTS.md");
  });
});
