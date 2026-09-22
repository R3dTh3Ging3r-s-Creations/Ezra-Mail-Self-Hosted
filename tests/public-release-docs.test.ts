import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isAuthoritativePublicMirror } from "../scripts/build-public-mirror";

const read = (path: string) => readFileSync(path, "utf8");
const isExportedWorkspace = await isAuthoritativePublicMirror(process.cwd());

describe("public release legal documents", () => {
  it("uses one owner and one public license consistently", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.license).toBe("AGPL-3.0-only");
    expect(pkg.author).toBe("Eric Michael Mathews");
    expect(read("NOTICE")).toContain("Copyright (c) 2026 Eric Michael Mathews");
    expect(read("LICENSE")).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(read("COMMERCIAL-LICENSING.md")).toContain("separate commercial license");
  });

  it("preserves contributor ownership while permitting relicensing", () => {
    const cla = read("CLA.md");
    expect(cla).toContain("You retain ownership");
    expect(cla).toContain("sublicense and relicense");
    expect(cla).toContain("patent");
    expect(cla).toContain("not confidential");
    expect(cla).toContain("without warranty");
  });

  it("keeps public support links on exported documentation", () => {
    const support = read("SUPPORT.md");
    expect(support).not.toContain("docs/TRUST_TRIAL_RUNBOOK.md");
    expect(support).toContain("[Security policy](SECURITY.md)");
  });

  it("records the private/public repository split without advancing future milestones", () => {
    const privateDocuments = [
      "docs/EZRA_MAIL_ROADMAP.md",
      "docs/PUBLIC_RELEASE_READINESS.md",
      "docs/VERSION_EXECUTION_LOG.md",
      "SERVER_HANDOFF.md",
    ];
    const publicDocuments = ["README.md", "SECURITY.md", "SUPPORT.md"];
    const roadmap = read(
      isExportedWorkspace ? "docs/EZRA_MAIL_ROADMAP.md" : "public-release/EZRA_MAIL_ROADMAP.md",
    );

    if (isExportedWorkspace) {
      expect(roadmap).not.toContain("Ezra-Mail-Private");
      expect(roadmap).not.toContain("PRIVATE_OWNER_RECOVERY");
    } else {
      for (const document of privateDocuments) {
        expect(read(document)).toContain("Ezra-Mail-Private");
      }
    }
    for (const document of publicDocuments) {
      const contents = read(document);
      expect(contents).toMatch(/Ezra[ -]Mail/);
      expect(contents).not.toContain("Ezra-Mail-Private");
    }

    expect(roadmap).toContain("v0.8.0 — Notifications and installable clients");
    expect(roadmap).toContain("Telegram");
    for (const milestone of ["v0.8.0", "v0.9.0", "v0.9.9", "v1.0.0", "Ezra Cloud"]) {
      expect(roadmap).toContain(`- [ ] **${milestone}`);
    }
  });
});
