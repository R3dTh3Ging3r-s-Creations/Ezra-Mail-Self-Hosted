import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Ubuntu guided installer", () => {
  it("supports desktop and headless modes with a Tailscale-first, expiring setup handoff", async () => {
    const installer = await fs.readFile(path.join(process.cwd(), "installer", "install-ezra-ubuntu.sh"), "utf8");
    const services = await fs.readFile(path.join(process.cwd(), "scripts", "install-ezra-systemd.sh"), "utf8");

    expect(installer).toContain("--desktop|--headless");
    expect(installer).toContain("tailscale");
    expect(installer).toContain('transport="lan"');
    expect(installer).toContain("auth:bootstrap");
    expect(installer).toContain("first-owner setup link expires");
    expect(installer).toContain("owner is already configured; skipping first-owner setup");
    expect(installer).toContain("caddy validate");
    expect(installer).toContain("bind $host");
    expect(services).toContain("ezra-mail-web.service");
    expect(services).toContain("ezra-mail-worker.service");
  });

  it("installs backup timers from a public installer dependency", async () => {
    const installer = await fs.readFile(path.join(process.cwd(), "installer", "install-ezra-ubuntu.sh"), "utf8");
    const backupInstaller = path.join(process.cwd(), "scripts", "install-ezra-backup-timers.sh");

    await expect(fs.readFile(backupInstaller, "utf8")).resolves.toContain("ezra-mail-backup.timer");
    expect(installer).toContain('scripts/install-ezra-backup-timers.sh');
    expect(installer).not.toContain('scripts/install-thing1-backup-timers.sh');
  });
});
