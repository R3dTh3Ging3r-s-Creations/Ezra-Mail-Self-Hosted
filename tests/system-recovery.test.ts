import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMAIL_SCHEMA_VERSION,
  configureEmailDatabaseForTests,
  closeEmailDatabaseForTests,
  execute,
  getSetting,
  setServiceState,
  setSetting,
} from "@/lib/email/database";
import {
  createVerifiedBackup,
  enforceManagedBackupRetention,
  getSafeSettingsExport,
  getSystemRecoveryStatus,
  pauseProviderPolling,
  rehearseLatestRestore,
  resumeProviderPolling,
  verifyLatestBackup,
} from "@/lib/email/system-recovery";

const execFileAsync = promisify(execFile);

describe("Safe Recovery operations", () => {
  let directory = "";
  let databasePath = "";
  let backupPath = "";

  beforeEach(async () => {
    directory = path.join(process.cwd(), "data", "tests", `system-recovery-${randomUUID()}`);
    databasePath = path.join(directory, "ezra-mail.sqlite");
    const backupDirectory = path.join(directory, "backups");
    await fs.mkdir(backupDirectory, { recursive: true });
    backupPath = path.join(backupDirectory, "ezra-mail-20260716T120000Z.sqlite");
    configureEmailDatabaseForTests(`file:${databasePath.replace(/\\/g, "/")}`);
    process.env.EZRA_DEPLOY_REVISION = "release-abc123";
    await execute(`SELECT 1`);
  });

  afterEach(async () => {
    delete process.env.EZRA_DEPLOY_REVISION;
    await closeEmailDatabaseForTests();
  });

  it("verifies the latest deployment backup and records durable integrity evidence", async () => {
    await execute(`PRAGMA wal_checkpoint(TRUNCATE)`);
    await fs.copyFile(databasePath, backupPath);

    const verified = await verifyLatestBackup();

    expect(verified.backup).toMatchObject({
      verified: true,
      latest: { fileName: "ezra-mail-20260716T120000Z.sqlite" },
    });
    expect(verified.backup.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await getSetting("last_backup_verified_at")).toBeTruthy();
    const auditRows = await execute(`SELECT action, target_id FROM audit_logs WHERE action = 'verify_backup'`);
    expect(auditRows.rows[0]).toMatchObject({
      action: "verify_backup",
      target_id: "ezra-mail-20260716T120000Z.sqlite",
    });
  });

  it("reports revision parity and requires an exact confirmation before pausing polling", async () => {
    await setServiceState("worker_revision", "release-abc123");
    await setServiceState("worker_heartbeat", new Date().toISOString());
    expect((await getSystemRecoveryStatus()).runtime).toMatchObject({
      webRevision: "release-abc123",
      workerRevision: "release-abc123",
      revisionsMatch: true,
      workerHealthy: true,
    });

    await expect(pauseProviderPolling({ confirmation: "pause" })).rejects.toThrow(/PAUSE POLLING/);
    const paused = await pauseProviderPolling({ confirmation: "PAUSE POLLING", reason: "Provider maintenance" });
    expect(paused.polling).toMatchObject({ paused: true, reason: "Provider maintenance" });

    const resumed = await resumeProviderPolling();
    expect(resumed.polling).toMatchObject({ paused: false, pausedAt: null, reason: null });
  });

  it("exports only the explicit non-secret settings allowlist", async () => {
    await setSetting("timezone", "America/Chicago");
    await setSetting("private_test_secret", "must-not-export");

    const exported = await getSafeSettingsExport();
    const keys = exported.settings.map((row) => String(row.key));

    expect(keys).toContain("timezone");
    expect(keys).not.toContain("private_test_secret");
    expect(JSON.stringify(exported)).not.toContain("must-not-export");
  });

  it("runs the deployment verification CLI through the CommonJS tsx loader", async () => {
    await execute(`PRAGMA wal_checkpoint(TRUNCATE)`);
    await fs.copyFile(databasePath, backupPath);

    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/verify-latest-backup.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          EZRA_EMAIL_DATABASE_URL: `file:${databasePath.replace(/\\/g, "/")}`,
        },
      },
    );

    expect(result.stdout).toContain("Verified ezra-mail-20260716T120000Z.sqlite");
    expect(result.stdout).toMatch(/SHA-256 [a-f0-9]{64}/);
  });

  it("runs the public migration entry point used by restore rehearsals", async () => {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/migrate-database.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          EZRA_EMAIL_DATABASE_URL: `file:${databasePath.replace(/\\/g, "/")}`,
        },
      },
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Ezra Mail database migration complete.");
    const schema = await execute(`PRAGMA user_version`);
    expect(Number(schema.rows[0]?.user_version)).toBe(EMAIL_SCHEMA_VERSION);
  });

  it("creates a verified managed backup with redacted inventory and rehearses its restore", async () => {
    await setSetting("timezone", "America/Chicago");
    await setSetting("private_test_secret", "never-copy-this");

    const created = await createVerifiedBackup({ now: new Date("2026-08-03T12:00:00Z") });
    expect(created.fileName).toBe("ezra-mail-daily-20260803T120000Z.sqlite");
    expect(created.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(created.integrityCheck).toBe("ok");
    const manifest = JSON.parse(await fs.readFile(created.manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      format: "ezra-mail-backup-manifest",
      schemaVersion: EMAIL_SCHEMA_VERSION,
      fileName: created.fileName,
      sha256: created.sha256,
    });
    expect(await fs.stat(path.join(directory, "backups", "managed", "ezra-mail-weekly-20260803T120000Z.sqlite"))).toBeTruthy();
    const inventory = await fs.readFile(created.inventoryPath, "utf8");
    expect(inventory).toContain("America/Chicago");
    expect(inventory).not.toContain("never-copy-this");

    const rehearsal = await rehearseLatestRestore();
    expect(rehearsal).toMatchObject({
      integrityCheck: "ok",
      sourceFile: created.fileName,
      schemaVersion: EMAIL_SCHEMA_VERSION,
      sourceSha256: created.sha256,
    });
    expect(await getSetting("last_restore_rehearsal_at")).toBeTruthy();
  }, 15_000);

  it("rejects a restored database newer than the exported supported schema", async () => {
    await execute(`PRAGMA user_version=${EMAIL_SCHEMA_VERSION + 1}`);
    await createVerifiedBackup({ now: new Date("2026-08-03T14:00:00Z") });
    await expect(rehearseLatestRestore()).rejects.toThrow(new RegExp(`does not match required version ${EMAIL_SCHEMA_VERSION}`));
  }, 15_000);

  it("refuses to rehearse a managed backup whose durable manifest no longer matches", async () => {
    const created = await createVerifiedBackup({ now: new Date("2026-08-03T13:00:00Z") });
    const manifest = JSON.parse(await fs.readFile(created.manifestPath, "utf8"));
    manifest.sha256 = "0".repeat(64);
    await fs.writeFile(created.manifestPath, JSON.stringify(manifest), "utf8");

    await expect(rehearseLatestRestore()).rejects.toThrow(/does not match its durable SHA-256 manifest/);
  });

  it("retains fourteen daily and eight weekly managed copies", async () => {
    const managed = path.join(directory, "backups", "managed");
    await fs.mkdir(managed, { recursive: true });
    for (let index = 1; index <= 17; index += 1) {
      const stamp = `202607${String(index).padStart(2, "0")}T120000Z`;
      await fs.writeFile(path.join(managed, `ezra-mail-daily-${stamp}.sqlite`), "daily");
      await fs.writeFile(path.join(managed, `ezra-mail-weekly-${stamp}.sqlite`), "weekly");
      await fs.writeFile(path.join(managed, `ezra-mail-daily-${stamp}.sqlite.manifest.json`), "manifest");
      await fs.writeFile(path.join(managed, `ezra-mail-weekly-${stamp}.sqlite.manifest.json`), "manifest");
    }
    await enforceManagedBackupRetention(managed);
    const names = await fs.readdir(managed);
    expect(names.filter((name) => name.includes("-daily-") && name.endsWith(".sqlite")).length).toBe(14);
    expect(names.filter((name) => name.includes("-weekly-") && name.endsWith(".sqlite")).length).toBe(8);
    expect(names.filter((name) => name.includes("-daily-") && name.endsWith(".manifest.json")).length).toBe(14);
    expect(names.filter((name) => name.includes("-weekly-") && name.endsWith(".manifest.json")).length).toBe(8);
  });
});
