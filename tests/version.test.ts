import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EZRA_MAIL_PRODUCT_VERSION } from "@/components/ezra/version";

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
    expect(publicRoadmap).toContain("experimental source release");
    expect(publicRoadmap).not.toMatch(/actions\/runs\/|\b[a-f0-9]{40}\b|\.sqlite/);
  });

});
