import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readWorkflow = (name: string) => fs.readFile(
  path.join(process.cwd(), ".github", "workflows", name),
  "utf8",
);

const isPublishedPublicMirror = async () => {
  const packageJson = JSON.parse(await fs.readFile(
    path.join(process.cwd(), "package.json"),
    "utf8",
  )) as { private?: unknown };
  return packageJson.private === false;
};

describe("Thing2 workflow contract", () => {
  it("keeps the private and published CI contracts distinct", async () => {
    const [releaseGate, secretScan] = await Promise.all([
      readWorkflow("release-gate.yml"),
      readWorkflow("secret-scan.yml"),
    ]);

    if (await isPublishedPublicMirror()) {
      for (const workflow of [releaseGate, secretScan]) {
        expect(workflow).toContain("runs-on: ubuntu-24.04");
        expect(workflow).toContain("contents: read");
        expect(workflow).toContain("persist-credentials: false");
        expect(workflow).not.toContain("self-hosted");
        expect(workflow).not.toMatch(/uses:.*Ezra-Mail\//);
      }
      expect(releaseGate).toContain("cancel-in-progress: true");
      expect(secretScan).toContain("cancel-in-progress: false");
      return;
    }

    for (const workflow of [releaseGate, secretScan]) {
      expect(workflow).toContain("cancel-in-progress: false");
    }
    expect(releaseGate).toContain("runs-on: [self-hosted, linux, x64, ci]");
    expect(releaseGate).toContain("timeout-minutes: 45");
    expect(releaseGate).toContain("rm -rf -- node_modules .next test-results playwright-report coverage");
  });

  it("runs writable unit and browser qualification in the pinned disposable container", async () => {
    const releaseGate = await readWorkflow("release-gate.yml");

    if (await isPublishedPublicMirror()) {
      expect(releaseGate).toMatch(/^\s*- run: npm run test$/m);
      expect(releaseGate).toMatch(/^\s*- run: npm run build$/m);
      expect(releaseGate).toContain("npm run build && npm run test:e2e");
      return;
    }

    expect(releaseGate).not.toMatch(/^\s*- run: npm run test$/m);
    expect(releaseGate).not.toMatch(/^\s*- run: npm run build$/m);
    expect(releaseGate).toContain('--volume "$GITHUB_WORKSPACE:/source:ro"');
    expect(releaseGate).toContain("npm run test && npm run build && npm run test:e2e");
  });

  it("keeps private Codex operating guidance out of the sanitized public mirror", async () => {
    const policy = JSON.parse(await fs.readFile(
      path.join(process.cwd(), "config", "public-export.json"),
      "utf8",
    ));

    expect(policy.privateRoots).toContain("AGENTS.md");
  });
});
