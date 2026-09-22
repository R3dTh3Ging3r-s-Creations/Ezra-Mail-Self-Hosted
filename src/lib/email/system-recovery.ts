import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createClient } from "@libsql/client";
import {
  EMAIL_SCHEMA_VERSION,
  audit,
  execute,
  getEmailDatabasePath,
  getServiceState,
  getSetting,
  nowIso,
  setServiceState,
  setSetting,
} from "./database";
import type { SystemRecoveryStatus } from "./types";

const BACKUP_NAME = /^ezra-mail-\d{8}T\d{6}Z\.sqlite$/;
const MANAGED_BACKUP_NAME = /^ezra-mail-(daily|weekly)-(\d{8}T\d{6}Z)\.sqlite$/;
const PAUSE_CONFIRMATION = "PAUSE POLLING";
const execFileAsync = promisify(execFile);
const REQUIRED_RESTORE_TABLES = ["auth_challenges", "owner_passkeys", "trusted_devices"] as const;

type BackupManifest = {
  format: "ezra-mail-backup-manifest";
  version: 1;
  fileName: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  integrityCheck: "ok";
  schemaVersion: number;
};

type BackupFile = NonNullable<SystemRecoveryStatus["backup"]["latest"]> & {
  absolutePath: string;
};

export async function getSystemRecoveryStatus(): Promise<SystemRecoveryStatus> {
  const databasePath = getEmailDatabasePath();
  const [latest, webRevision, workerRevision, workerHeartbeatAt, pausedAt, pauseReason, verifiedAt, verifiedFile, verifiedSize, verifiedHash, managedAt, managedFile, managedHash, rehearsalAt, rehearsalFile] = await Promise.all([
    databasePath ? findLatestBackup(databasePath) : null,
    readDeploymentRevision(),
    getServiceState("worker_revision"),
    getServiceState("worker_heartbeat"),
    getServiceState("polling_paused_at"),
    getServiceState("polling_pause_reason"),
    getSetting("last_backup_verified_at"),
    getSetting("last_backup_verified_file"),
    getSetting("last_backup_verified_size_bytes"),
    getSetting("last_backup_verified_sha256"),
    getSetting("last_managed_backup_at"),
    getSetting("last_managed_backup_file"),
    getSetting("last_managed_backup_sha256"),
    getSetting("last_restore_rehearsal_at"),
    getSetting("last_restore_rehearsal_file"),
  ]);
  const databaseStats = databasePath ? await safeStat(databasePath) : null;
  const schemaResult = await execute(`PRAGMA user_version`);
  const schemaVersion = Number(schemaResult.rows[0]?.user_version ?? EMAIL_SCHEMA_VERSION);
  const workerHeartbeatMs = workerHeartbeatAt ? new Date(workerHeartbeatAt).getTime() : 0;
  const workerHealthy = Number.isFinite(workerHeartbeatMs) && Date.now() - workerHeartbeatMs < 180_000;
  const verified = Boolean(
    latest &&
    verifiedAt &&
    verifiedFile === latest.fileName &&
    Number(verifiedSize) === latest.sizeBytes &&
    verifiedHash,
  );
  const managedAgeHours = managedAt ? Math.max(0, (Date.now() - new Date(managedAt).getTime()) / 3_600_000) : null;
  const rehearsalAgeDays = rehearsalAt ? Math.max(0, (Date.now() - new Date(rehearsalAt).getTime()) / 86_400_000) : null;

  return {
    generatedAt: nowIso(),
    database: {
      kind: databasePath ? "file" : "remote",
      sizeBytes: databaseStats?.size ?? null,
      schemaVersion,
    },
    backup: {
      latest: latest ? withoutAbsolutePath(latest) : null,
      verified,
      verifiedAt: verified ? verifiedAt : null,
      sha256: verified ? verifiedHash : null,
      detail: !latest
        ? "No deployment backup was found beside the database."
        : verified
          ? "The latest deployment backup passed SQLite integrity verification and has a recorded SHA-256 fingerprint."
          : "The latest deployment backup has not been verified in this release.",
      managed: {
        lastCreatedAt: managedAt || null,
        fileName: managedFile || null,
        sha256: managedHash || null,
        ageHours: managedAgeHours,
        stale: managedAgeHours === null || managedAgeHours > 36,
        dailyRetention: 14,
        weeklyRetention: 8,
      },
      rehearsal: {
        lastCompletedAt: rehearsalAt || null,
        sourceFile: rehearsalFile || null,
        overdue: rehearsalAgeDays === null || rehearsalAgeDays > 35,
      },
    },
    runtime: {
      webRevision,
      workerRevision,
      revisionsMatch: webRevision && workerRevision ? webRevision === workerRevision : null,
      workerHeartbeatAt,
      workerHealthy,
    },
    polling: {
      paused: Boolean(pausedAt),
      pausedAt: pausedAt || null,
      reason: pauseReason || null,
    },
  };
}

export async function verifyLatestBackup() {
  const databasePath = getEmailDatabasePath();
  if (!databasePath) throw new Error("Backup verification requires a file-based SQLite database.");
  const latest = await findLatestBackup(databasePath);
  if (!latest) throw new Error("No Ezra Mail deployment backup is available to verify.");

  const before = await fs.stat(latest.absolutePath);
  const client = createClient({ url: libsqlFileUrl(latest.absolutePath) });
  try {
    const result = await client.execute(`PRAGMA integrity_check`);
    const checks = result.rows.map((row) => String(row.integrity_check ?? Object.values(row)[0] ?? ""));
    if (!checks.length || checks.some((value) => value.toLowerCase() !== "ok")) {
      throw new Error(`SQLite integrity verification failed: ${checks.join("; ") || "no result"}`);
    }
  } finally {
    await client.close();
  }

  const sha256 = await hashFile(latest.absolutePath);
  const after = await fs.stat(latest.absolutePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("The backup changed during verification; retry after the deployment finishes.");
  }
  const verifiedAt = nowIso();
  await Promise.all([
    setSetting("last_backup_verified_at", verifiedAt),
    setSetting("last_backup_verified_file", latest.fileName),
    setSetting("last_backup_verified_size_bytes", String(latest.sizeBytes)),
    setSetting("last_backup_verified_sha256", sha256),
    audit("verify_backup", "owner", "database_backup", latest.fileName, {
      sizeBytes: latest.sizeBytes,
      sha256,
      integrityCheck: "ok",
    }),
  ]);
  return getSystemRecoveryStatus();
}

export async function createVerifiedBackup(options: { now?: Date } = {}) {
  const databasePath = getEmailDatabasePath();
  if (!databasePath) throw new Error("Managed backups require a file-based SQLite database.");
  const now = options.now || new Date();
  const directory = path.join(path.dirname(databasePath), "backups", "managed");
  await fs.mkdir(directory, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const fileName = `ezra-mail-daily-${stamp}.sqlite`;
  const absolutePath = path.join(directory, fileName);
  await fs.rm(absolutePath, { force: true });
  await execute(`VACUUM INTO '${absolutePath.replace(/'/g, "''")}'`);
  const verified = await inspectBackup(absolutePath);
  const manifestPath = `${absolutePath}.manifest.json`;
  const manifest = await buildBackupManifest(absolutePath, fileName, now, verified);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const inventoryPath = `${absolutePath}.inventory.json`;
  const inventory = await buildRedactedConfigurationInventory(now);
  await fs.writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });

  if (await shouldCreateWeeklyBackup(directory, now)) {
    const weeklyPath = path.join(directory, `ezra-mail-weekly-${stamp}.sqlite`);
    await fs.copyFile(absolutePath, weeklyPath);
    await fs.copyFile(inventoryPath, `${weeklyPath}.inventory.json`);
    const weeklyManifest = { ...manifest, fileName: path.basename(weeklyPath) };
    await fs.writeFile(`${weeklyPath}.manifest.json`, `${JSON.stringify(weeklyManifest, null, 2)}\n`, { mode: 0o600 });
  }
  await enforceManagedBackupRetention(directory);
  await Promise.all([
    setSetting("last_managed_backup_at", now.toISOString()),
    setSetting("last_managed_backup_file", fileName),
    setSetting("last_managed_backup_sha256", verified.sha256),
    audit("backup.created", "system", "database_backup", fileName, {
      sha256: verified.sha256,
      integrityCheck: verified.integrityCheck,
    }),
  ]);
  return { fileName, absolutePath, inventoryPath, manifestPath, ...verified };
}

export async function rehearseLatestRestore() {
  const databasePath = getEmailDatabasePath();
  if (!databasePath) throw new Error("Restore rehearsal requires a file-based SQLite database.");
  const directory = path.join(path.dirname(databasePath), "backups", "managed");
  const latest = await findLatestManagedBackup(directory);
  if (!latest) throw new Error("No verified managed backup is available for a restore rehearsal.");
  const temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(databasePath), "restore-rehearsal-"));
  const restoredPath = path.join(temporaryDirectory, "ezra-mail-restored.sqlite");
  try {
    const manifest = await readBackupManifest(latest);
    const sourceHash = await hashFile(latest.absolutePath);
    const sourceStats = await fs.stat(latest.absolutePath);
    if (sourceHash !== manifest.sha256 || sourceStats.size !== manifest.sizeBytes) {
      throw new Error("The managed backup does not match its durable SHA-256 manifest.");
    }
    await fs.copyFile(latest.absolutePath, restoredPath);
    await migrateRestoredDatabase(restoredPath);
    const inspected = await inspectBackup(restoredPath);
    const client = createClient({ url: libsqlFileUrl(restoredPath) });
    let tableCount = 0;
    let schemaVersion = 0;
    try {
      const schema = await client.execute(
        `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      );
      tableCount = Number(schema.rows[0]?.count || 0);
      if (tableCount < 1) throw new Error("The restored database contains no application tables.");
      const version = await client.execute(`PRAGMA user_version`);
      schemaVersion = Number(version.rows[0]?.user_version || 0);
      if (schemaVersion !== EMAIL_SCHEMA_VERSION) {
        throw new Error(`Restored schema version ${schemaVersion} does not match required version ${EMAIL_SCHEMA_VERSION}.`);
      }
      const required = await client.execute({
        sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_RESTORE_TABLES.map(() => "?").join(", ")})`,
        args: [...REQUIRED_RESTORE_TABLES],
      });
      const restoredTables = new Set(required.rows.map((row) => String(row.name)));
      const missing = REQUIRED_RESTORE_TABLES.filter((name) => !restoredTables.has(name));
      const sessionColumns = await client.execute(`PRAGMA table_info(auth_sessions)`);
      if (!sessionColumns.rows.some((row) => String(row.name) === "device_id")) missing.push("auth_sessions.device_id" as never);
      if (missing.length) throw new Error(`Restored database is missing required v0.7.3 schema: ${missing.join(", ")}.`);
    } finally {
      await client.close();
    }
    const rehearsedAt = nowIso();
    await Promise.all([
      setSetting("last_restore_rehearsal_at", rehearsedAt),
      setSetting("last_restore_rehearsal_file", latest.fileName),
      audit("backup.restore_rehearsed", "system", "database_backup", latest.fileName, {
        sourceSha256: sourceHash,
        restoredSha256: inspected.sha256,
        integrityCheck: inspected.integrityCheck,
        tableCount,
        schemaVersion,
      }),
    ]);
    return { sourceFile: latest.fileName, rehearsedAt, tableCount, schemaVersion, sourceSha256: sourceHash, ...inspected };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export async function pauseProviderPolling(input: { confirmation: string; reason?: string }) {
  if (input.confirmation !== PAUSE_CONFIRMATION) {
    throw new Error(`Type ${PAUSE_CONFIRMATION} to confirm the emergency polling pause.`);
  }
  const pausedAt = nowIso();
  const reason = normalizeReason(input.reason);
  await Promise.all([
    setServiceState("polling_paused_at", pausedAt),
    setServiceState("polling_pause_reason", reason),
    audit("pause_polling", "owner", "email_worker", "provider_polling", { pausedAt, reason }),
  ]);
  return getSystemRecoveryStatus();
}

export async function resumeProviderPolling() {
  const resumedAt = nowIso();
  await Promise.all([
    setServiceState("polling_paused_at", ""),
    setServiceState("polling_pause_reason", ""),
    setServiceState("worker_polling_state", "running"),
    audit("resume_polling", "owner", "email_worker", "provider_polling", { resumedAt }),
  ]);
  return getSystemRecoveryStatus();
}

export async function getSafeSettingsExport() {
  const [settings, accounts, profiles, recovery] = await Promise.all([
    execute(
      `SELECT key, value, updated_at FROM settings
       WHERE key IN ('active_model', 'timezone', 'poll_minutes', 'digest_times', 'quiet_start',
         'quiet_end', 'notification_policy_version', 'notification_category_preferences')
       ORDER BY key`,
    ),
    execute(`SELECT id, provider, email, label, status, last_sync_at FROM email_accounts ORDER BY provider, email`),
    execute(`SELECT account_id, purpose_label, color, updated_at FROM account_profile_settings ORDER BY account_id`),
    getSystemRecoveryStatus(),
  ]);
  return {
    format: "ezra-mail-safe-settings",
    version: 1,
    exportedAt: nowIso(),
    schemaVersion: recovery.database.schemaVersion,
    settings: settings.rows,
    accounts: accounts.rows,
    accountProfiles: profiles.rows,
  };
}

export async function readDeploymentRevision() {
  try {
    return (await fs.readFile(path.join(process.cwd(), ".deploy-revision"), "utf8")).trim() || null;
  } catch {
    return process.env.EZRA_DEPLOY_REVISION?.trim() || null;
  }
}

async function findLatestBackup(databasePath: string): Promise<BackupFile | null> {
  const directory = path.join(path.dirname(databasePath), "backups");
  let names: string[];
  try {
    names = (await fs.readdir(directory)).filter((name) => BACKUP_NAME.test(name));
  } catch {
    return null;
  }
  const candidates = await Promise.all(names.map(async (fileName) => {
    const absolutePath = path.join(directory, fileName);
    const stats = await safeStat(absolutePath);
    if (!stats?.isFile()) return null;
    return {
      fileName,
      absolutePath,
      sizeBytes: stats.size,
      createdAt: stats.mtime.toISOString(),
      modifiedMs: stats.mtimeMs,
    };
  }));
  const latest = candidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((left, right) => right.modifiedMs - left.modifiedMs)[0];
  if (!latest) return null;
  return {
    fileName: latest.fileName,
    absolutePath: latest.absolutePath,
    sizeBytes: latest.sizeBytes,
    createdAt: latest.createdAt,
  };
}

async function findLatestManagedBackup(directory: string): Promise<BackupFile | null> {
  let names: string[];
  try {
    names = (await fs.readdir(directory)).filter((name) => MANAGED_BACKUP_NAME.test(name));
  } catch {
    return null;
  }
  const candidates = await Promise.all(names.map(async (fileName) => {
    const absolutePath = path.join(directory, fileName);
    const stats = await safeStat(absolutePath);
    const match = MANAGED_BACKUP_NAME.exec(fileName);
    return stats?.isFile() && match ? {
      fileName,
      absolutePath,
      sizeBytes: stats.size,
      createdAt: stats.mtime.toISOString(),
      stamp: match[2],
      cadence: match[1],
    } : null;
  }));
  const latest = candidates
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.stamp.localeCompare(a.stamp) || (a.cadence === "daily" ? -1 : 1))[0];
  return latest || null;
}

async function inspectBackup(filePath: string) {
  const client = createClient({ url: libsqlFileUrl(filePath) });
  try {
    const result = await client.execute(`PRAGMA integrity_check`);
    const checks = result.rows.map((row) => String(row.integrity_check ?? Object.values(row)[0] ?? ""));
    if (!checks.length || checks.some((value) => value.toLowerCase() !== "ok")) {
      throw new Error(`SQLite integrity verification failed: ${checks.join("; ") || "no result"}`);
    }
  } finally {
    await client.close();
  }
  return { integrityCheck: "ok" as const, sha256: await hashFile(filePath) };
}

async function buildRedactedConfigurationInventory(createdAt: Date) {
  const settings = await execute(
    `SELECT key, value FROM settings
     WHERE key IN ('active_model', 'timezone', 'poll_minutes', 'digest_times', 'quiet_start', 'quiet_end')
     ORDER BY key`,
  );
  const accounts = await execute(
    `SELECT provider, email, label, status FROM email_accounts ORDER BY provider, email`,
  );
  return {
    format: "ezra-mail-redacted-backup-inventory",
    version: 1,
    createdAt: createdAt.toISOString(),
    settings: settings.rows,
    accounts: accounts.rows,
  };
}

async function pruneManagedBackups(directory: string, cadence: "daily" | "weekly", retain: number) {
  const names = (await fs.readdir(directory)).filter((name) => name.startsWith(`ezra-mail-${cadence}-`) && name.endsWith(".sqlite")).sort().reverse();
  for (const name of names.slice(retain)) {
    const target = path.resolve(directory, name);
    if (path.dirname(target) !== path.resolve(directory) || !MANAGED_BACKUP_NAME.test(name)) continue;
    await fs.rm(target, { force: true });
    await fs.rm(`${target}.inventory.json`, { force: true });
    await fs.rm(`${target}.manifest.json`, { force: true });
  }
}

async function shouldCreateWeeklyBackup(directory: string, now: Date) {
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (weekStart.getUTCDay() + 6) % 7;
  weekStart.setUTCDate(weekStart.getUTCDate() - daysSinceMonday);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  return !names.some((name) => {
    const match = MANAGED_BACKUP_NAME.exec(name);
    if (!match || match[1] !== "weekly") return false;
    const timestamp = match[2];
    const createdAt = new Date(`${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}Z`);
    return createdAt >= weekStart && createdAt < weekEnd;
  });
}

export async function enforceManagedBackupRetention(directory: string) {
  await pruneManagedBackups(directory, "daily", 14);
  await pruneManagedBackups(directory, "weekly", 8);
}

function withoutAbsolutePath(backup: BackupFile) {
  return {
    fileName: backup.fileName,
    sizeBytes: backup.sizeBytes,
    createdAt: backup.createdAt,
  };
}

function safeStat(filePath: string) {
  return fs.stat(filePath).catch(() => null);
}

function libsqlFileUrl(filePath: string) {
  return `file:${filePath.replace(/\\/g, "/")}`;
}

function hashFile(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function buildBackupManifest(
  absolutePath: string,
  fileName: string,
  createdAt: Date,
  verified: { integrityCheck: "ok"; sha256: string },
): Promise<BackupManifest> {
  const stats = await fs.stat(absolutePath);
  const client = createClient({ url: libsqlFileUrl(absolutePath) });
  try {
    const version = await client.execute(`PRAGMA user_version`);
    return {
      format: "ezra-mail-backup-manifest",
      version: 1,
      fileName,
      createdAt: createdAt.toISOString(),
      sizeBytes: stats.size,
      sha256: verified.sha256,
      integrityCheck: verified.integrityCheck,
      schemaVersion: Number(version.rows[0]?.user_version || 0),
    };
  } finally {
    await client.close();
  }
}

async function readBackupManifest(backup: BackupFile): Promise<BackupManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(`${backup.absolutePath}.manifest.json`, "utf8"));
  } catch {
    throw new Error(`The managed backup ${backup.fileName} has no readable verification manifest.`);
  }
  const manifest = parsed as Partial<BackupManifest>;
  if (
    manifest.format !== "ezra-mail-backup-manifest" ||
    manifest.version !== 1 ||
    manifest.fileName !== backup.fileName ||
    !Number.isSafeInteger(manifest.sizeBytes) ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256 || "") ||
    manifest.integrityCheck !== "ok"
  ) {
    throw new Error(`The managed backup ${backup.fileName} has an invalid verification manifest.`);
  }
  return manifest as BackupManifest;
}

async function migrateRestoredDatabase(restoredPath: string) {
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/migrate-database.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EZRA_EMAIL_DATABASE_URL: libsqlFileUrl(restoredPath),
      },
      timeout: 120_000,
    },
  );
}

function normalizeReason(value: string | undefined) {
  return (value || "Emergency pause requested from Settings").replace(/\s+/g, " ").trim().slice(0, 240);
}
