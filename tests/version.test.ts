import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EZRA_MAIL_PRODUCT_VERSION } from "@/components/ezra/version";

const privateExecutionLogPath = path.join(process.cwd(), "docs", "VERSION_EXECUTION_LOG.md");
const isPrivateWorkspace = existsSync(privateExecutionLogPath);
const publicRoadmapPath = existsSync(path.join(process.cwd(), "public-release", "EZRA_MAIL_ROADMAP.md"))
  ? path.join(process.cwd(), "public-release", "EZRA_MAIL_ROADMAP.md")
  : path.join(process.cwd(), "docs", "EZRA_MAIL_ROADMAP.md");

describe("Ezra Mail release version", () => {
  it("keeps every release version source at v0.8.2", () => {
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    const packageLockJson = JSON.parse(readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8")) as {
      version?: string;
      packages?: Record<string, { version?: string }>;
    };
    const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    const releaseBadges = Array.from(
      readme.matchAll(/<img alt="Version (v[^"]+)" src="https:\/\/img\.shields\.io\/badge\/version-(v[^"-]+)-168e92" \/>/g),
      ([, altVersion, sourceVersion]) => ({ altVersion, sourceVersion }),
    );

    expect(EZRA_MAIL_PRODUCT_VERSION).toBe("0.8.2");
    expect(packageJson.version).toBe(EZRA_MAIL_PRODUCT_VERSION);
    expect(packageLockJson.version).toBe("0.8.2");
    expect(packageLockJson.packages?.[""]?.version).toBe("0.8.2");
    expect(releaseBadges).toEqual([{ altVersion: "v0.8.2", sourceVersion: "v0.8.2" }]);

    const publicReadmePath = path.join(process.cwd(), "public-release", "README.md");
    if (existsSync(publicReadmePath)) {
      const publicReadme = readFileSync(publicReadmePath, "utf8");
      const publicVersionMarkers = Array.from(publicReadme.matchAll(/\bEzra Mail v(\d+\.\d+\.\d+)\b/g), ([, version]) => version);
      const publicReleaseBadges = Array.from(
        publicReadme.matchAll(/<img alt="Version (v[^"]+)" src="https:\/\/img\.shields\.io\/badge\/version-(v[^"-]+)-168e92" \/>/g),
        ([, altVersion, sourceVersion]) => ({ altVersion, sourceVersion }),
      );

      expect(publicVersionMarkers).toEqual(["0.8.2"]);
      expect(publicReleaseBadges).toEqual([{ altVersion: "v0.8.2", sourceVersion: "v0.8.2" }]);
    }
  });

  it("keeps the public roadmap at v0.8.2 and gates v1.0 behind the UI/UX audit", () => {
    const publicRoadmap = readFileSync(publicRoadmapPath, "utf8");
    const currentVersion = publicRoadmap.match(/Current app version: \*\*v(\d+\.\d+\.\d+)\*\*\./)?.[1];
    const uiAuditMilestone = publicRoadmap.indexOf("**v0.9.9");
    const generalAvailabilityMilestone = publicRoadmap.indexOf("**v1.0.0");

    expect(currentVersion).toBe("0.8.2");
    expect(publicRoadmap).not.toMatch(/- \[ \] \*\*v0\.7\.5\b/);
    expect(uiAuditMilestone).toBeGreaterThan(-1);
    expect(generalAvailabilityMilestone).toBeGreaterThan(uiAuditMilestone);
    expect(publicRoadmap).toContain("potentially incomplete local index");
    expect(publicRoadmap).toContain("not atomic revision");
    expect(publicRoadmap).toContain("Guided public plugin onboarding");
    expect(publicRoadmap).toContain("expiry, outage, restart and uncertain-outcome acceptance");
    expect(publicRoadmap).toContain("not exposed");
  });

  it.skipIf(!isPrivateWorkspace)("records the deployed v0.7.7 production checkpoint", () => {
    const executionLog = readFileSync(privateExecutionLogPath, "utf8");

    expect(executionLog).toMatch(/\*\*Active version:\*\* v0\.8\.0\b/);
    expect(executionLog).toMatch(/\*\*Last exact repository-recorded Thing1 revision:\*\* v0\.7\.7\b[^\n]*`4f533de`/);
    expect(executionLog).toMatch(/exact\s+deployed revision and matching health evidence were not recorded/);
    expect(executionLog).toContain("32707261292");
    expect(executionLog).toContain("32707260801");
    expect(executionLog).toContain("ezra-mail-20260824T090244Z.sqlite");
    expect(executionLog).toContain("95a451fc67d77fb619fbc3d89046cc87403cbcda5ad4e2ab3d41778a5ff3a82b");
    expect(executionLog).not.toContain("does not qualify the corrected bytes");
    expect(executionLog).not.toContain("refreshed final evidence remains required");
    expect(executionLog).not.toContain("no combined-tree export/test has run");
    expect(executionLog).not.toContain("combined-tree public-mirror qualification remains required");
    expect(executionLog).not.toMatch(/v0\.7\.7 is not deployed to\s+Thing1/i);
    expect(executionLog).toMatch(/no\s+live-provider\s+mutation/i);
    expect(executionLog).toMatch(/Windows gate\s+was\s+deferred and never passed/);
    expect(executionLog).toMatch(/Ubuntu rehearsal remains unperformed/);
  });

  it.skipIf(!isPrivateWorkspace)("marks the detailed safe-preview slice locally complete", () => {
    const roadmap = readFileSync(path.join(process.cwd(), "docs", "EZRA_MAIL_ROADMAP.md"), "utf8");
    const previewSection = roadmap.match(/## Safe In-App Attachment Viewing\s+([\s\S]*?)(?=\n## )/)?.[1] ?? "";

    expect(previewSection).toContain("v0.7.7 local implementation is complete.");
    expect(previewSection).not.toContain("v0.7.7 is in progress.");
  });

  it.skipIf(!isPrivateWorkspace)("records the approved clean-history reconciliation provenance", () => {
    const plan = readFileSync(
      path.join(process.cwd(), "docs", "superpowers", "plans", "2026-08-22-v0.7.7-release-reconciliation.md"),
      "utf8",
    );
    const executionLog = readFileSync(privateExecutionLogPath, "utf8");

    for (const record of [plan, executionLog]) {
      expect(record).toContain("Clean-history reconstruction");
      expect(record).toMatch(/`c17713c` is not an ancestor/);
      expect(record).toMatch(/not a merge commit/i);
    }
  });
});
