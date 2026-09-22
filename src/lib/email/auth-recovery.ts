import { purgeRevokedNotificationDevices } from "./notification-store";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { audit, execute, executeBatch, getServiceState, getSetting, newId, nowIso, setServiceState } from "./database";
import { hashPassword } from "./auth";

export async function recoverOwnerAccess(input: { envPath: string; newPassword: string; recoveryCode?: string }) {
  if (input.newPassword.length < 12) throw new Error("The recovery password must be at least 12 characters.");
  await verifyFirstOwnerRecoveryCode(input.recoveryCode);
  const passwordHash = await hashPassword(input.newPassword);
  const authSecret = crypto.randomBytes(32).toString("base64url");
  const current = await fs.readFile(input.envPath, "utf8").catch(() => "");
  let next = setEnvValue(current, "EZRA_AUTH_PASSWORD_HASH_B64", Buffer.from(passwordHash).toString("base64"));
  next = removeEnvValue(next, "EZRA_AUTH_PASSWORD_HASH");
  next = setEnvValue(next, "EZRA_AUTH_SECRET", authSecret);
  await writeProtectedEnvFile(input.envPath, next);

  const timestamp = nowIso();
  await execute(`UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL`, [timestamp]);
  await execute(`UPDATE trusted_devices SET revoked_at = ? WHERE revoked_at IS NULL`, [timestamp]);
  await purgeRevokedNotificationDevices({ now: timestamp });
  await execute(`DELETE FROM auth_login_attempts`);
  await audit("auth.recovery.prepared", "local_recovery", "owner", "owner", {
    preparedAt: timestamp,
    sessionsRevoked: true,
    devicesRevoked: true,
    lockoutsCleared: true,
  });
  await setServiceState("auth_recovery_expected_secret_sha256", secretFingerprint(authSecret));
  await setServiceState("auth_recovery_web_started_at", "");
  await setServiceState("auth_recovery_worker_started_at", "");
  await setServiceState("auth_recovery_pending_at", timestamp);
  return { completedAt: timestamp };
}

export async function persistOwnerPasswordHash(input: { envPath: string; passwordHash: string }) {
  const current = await fs.readFile(input.envPath, "utf8").catch(() => "");
  let next = setEnvValue(current, "EZRA_AUTH_PASSWORD_HASH_B64", Buffer.from(input.passwordHash).toString("base64"));
  next = removeEnvValue(next, "EZRA_AUTH_PASSWORD_HASH");
  await writeProtectedEnvFile(input.envPath, next);
}

export async function restoreOwnerPasswordEnvironment(input: { envPath: string; contents?: string }) {
  if (input.contents === undefined) {
    await fs.rm(input.envPath, { force: true });
    return;
  }
  await writeProtectedEnvFile(input.envPath, input.contents);
}

export async function recordOwnerRecoveryStartup(component: "web" | "worker") {
  const preparedAt = await getServiceState("auth_recovery_pending_at");
  if (!preparedAt) return { pending: false, completed: false };
  const expectedFingerprint = await getServiceState("auth_recovery_expected_secret_sha256");
  const currentSecret = process.env.EZRA_AUTH_SECRET?.trim() || "";
  if (!expectedFingerprint || !currentSecret || secretFingerprint(currentSecret) !== expectedFingerprint) {
    await audit("auth.recovery.startup_rejected", "system", "owner", "owner", { component });
    return { pending: true, completed: false };
  }

  const startedAt = nowIso();
  await setServiceState(`auth_recovery_${component}_started_at`, startedAt);
  const [webStartedAt, workerStartedAt] = await Promise.all([
    getServiceState("auth_recovery_web_started_at"),
    getServiceState("auth_recovery_worker_started_at"),
  ]);
  if (!webStartedAt || !workerStartedAt) return { pending: true, completed: false };

  const claim = `claim:${crypto.randomUUID()}`;
  const metadata = JSON.stringify({
    preparedAt,
    completedAt: startedAt,
    webStartedAt,
    workerStartedAt,
  });
  const results = await executeBatch([
    {
      sql: `UPDATE service_state SET value = ?, updated_at = ?
        WHERE key = 'auth_recovery_pending_at' AND value = ?`,
      args: [claim, startedAt, preparedAt],
    },
    {
      sql: `INSERT INTO audit_logs
        (id, action, actor, target_type, target_id, metadata, created_at)
       SELECT ?, 'auth.recovery.completed', 'system', 'owner', 'owner', ?, ?
       WHERE (SELECT value FROM service_state WHERE key = 'auth_recovery_pending_at') = ?`,
      args: [newId("audit"), metadata, startedAt, claim],
    },
    {
      sql: `DELETE FROM service_state
        WHERE key IN ('auth_recovery_expected_secret_sha256', 'auth_recovery_web_started_at', 'auth_recovery_worker_started_at')
          AND (SELECT value FROM service_state WHERE key = 'auth_recovery_pending_at') = ?`,
      args: [claim],
    },
    {
      sql: `DELETE FROM service_state WHERE key = 'auth_recovery_pending_at' AND value = ?`,
      args: [claim],
    },
  ], "write");
  const completed = results[0].rowsAffected === 1;
  return { pending: !completed, completed };
}

function setEnvValue(source: string, key: string, value: string) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const updated = pattern.test(source) ? source.replace(pattern, line) : `${source.replace(/\s*$/, "")}\n${line}\n`;
  return updated.startsWith("\n") ? updated.slice(1) : updated;
}

function removeEnvValue(source: string, key: string) {
  return source.replace(new RegExp(`^${key}=.*(?:\r?\n|$)`, "m"), "");
}

async function writeProtectedEnvFile(envPath: string, contents: string) {
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  const temporaryPath = path.join(path.dirname(envPath), `.${path.basename(envPath)}.${process.pid}.tmp`);
  await fs.writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, envPath);
  await fs.chmod(envPath, 0o600).catch(() => undefined);
}

function secretFingerprint(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function verifyFirstOwnerRecoveryCode(recoveryCode?: string) {
  if ((await getSetting("first_owner_recovery_code_required")) !== "true") return;
  const supplied = recoveryCode?.trim() || "";
  if (!supplied) throw new Error("Enter the first-owner recovery code to continue.");
  const candidateHash = crypto.createHash("sha256").update(supplied).digest("hex");
  const result = await execute(
    `SELECT 1 FROM first_owner_setup
     WHERE recovery_code_hash = ? AND used_at IS NOT NULL AND cancelled_at IS NULL
     LIMIT 1`,
    [candidateHash],
  );
  if (!result.rows.length) throw new Error("The first-owner recovery code is incorrect.");
}
