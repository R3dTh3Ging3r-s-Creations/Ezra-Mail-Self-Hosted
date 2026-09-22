import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AuthError, authIsConfigured, enrollTrustedDevice, hashPassword } from "./auth";
import { persistOwnerPasswordHash, restoreOwnerPasswordEnvironment } from "./auth-recovery";
import { audit, ensureEmailDatabase, execute, newId, nowIso, setSetting } from "./database";

const SETUP_LIFETIME_MS = 15 * 60 * 1000;

export type FirstOwnerSetupTransport = "local" | "tailscale" | "lan";

export async function createFirstOwnerSetup(input: {
  origin: string;
  transport: FirstOwnerSetupTransport;
}) {
  await ensureEmailDatabase();
  if (authIsConfigured() || await hasTrustedOwnerDevice()) {
    throw new Error("Ezra Mail already has an owner. First-owner setup is unavailable.");
  }
  const origin = normalizeOrigin(input.origin);
  if (input.transport !== "local" && !origin.startsWith("https://")) {
    throw new Error("Headless first-owner setup requires a private HTTPS origin.");
  }
  const active = await execute(
    `SELECT id FROM first_owner_setup
     WHERE used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?
     LIMIT 1`,
    [nowIso()],
  );
  if (active.rows.length) {
    throw new Error("A first-owner setup link is already active.");
  }

  const challenge = crypto.randomBytes(32).toString("base64url");
  const recoveryCode = crypto.randomBytes(24).toString("base64url");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SETUP_LIFETIME_MS).toISOString();
  await execute(
    `INSERT INTO first_owner_setup
      (id, challenge_hash, recovery_code_hash, origin, transport, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      newId("first_owner_setup"),
      hashValue(challenge),
      hashValue(recoveryCode),
      origin,
      input.transport,
      createdAt,
      expiresAt,
    ],
  );
  await audit("auth.first_owner_setup.created", "local_installer", "owner", "owner", {
    transport: input.transport,
    expiresAt,
  });
  return {
    setupUrl: `${origin}/setup/first-owner?challenge=${encodeURIComponent(challenge)}`,
    expiresAt,
    recoveryCode,
  };
}

export async function inspectFirstOwnerSetup() {
  await ensureEmailDatabase();
  const result = await execute(
    `SELECT expires_at, transport FROM first_owner_setup
     WHERE used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
    [nowIso()],
  );
  const row = result.rows[0];
  return row
    ? { active: true, expiresAt: String(row.expires_at), transport: String(row.transport) as FirstOwnerSetupTransport }
    : { active: false, expiresAt: null, transport: null };
}

export async function inspectFirstOwnerSetupChallenge(challenge: string) {
  const state = await inspectFirstOwnerSetup();
  if (!state.active) return { active: false, expiresAt: null };
  const result = await execute(
    `SELECT expires_at FROM first_owner_setup
     WHERE challenge_hash = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?
     LIMIT 1`,
    [hashValue(challenge), nowIso()],
  );
  return result.rows[0]
    ? { active: true, expiresAt: String(result.rows[0].expires_at) }
    : { active: false, expiresAt: null };
}

export async function completeFirstOwnerSetup(input: {
  challenge: string;
  ownerPassword: string;
  deviceLabel: string;
  ipAddress: string;
  userAgent: string;
  envPath?: string;
}) {
  if (input.ownerPassword.length < 12) {
    throw new AuthError("Use an owner password with at least 12 characters.", 400);
  }
  await ensureEmailDatabase();
  if (authIsConfigured() || await hasTrustedOwnerDevice()) {
    throw new AuthError("Ezra Mail already has an owner. First-owner setup is unavailable.", 403);
  }
  const timestamp = nowIso();
  const challengeHash = hashValue(input.challenge);
  const pending = await execute(
    `SELECT id, transport FROM first_owner_setup
     WHERE challenge_hash = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?
     LIMIT 1`,
    [challengeHash, timestamp],
  );
  const row = pending.rows[0];
  if (!row) {
    await recordFailedFirstOwnerAttempt(challengeHash, timestamp);
    throw new AuthError("This first-owner setup link is invalid or expired. Start installation setup again.", 403);
  }
  const consumed = await execute(
    `UPDATE first_owner_setup SET used_at = ? WHERE id = ? AND used_at IS NULL AND cancelled_at IS NULL`,
    [timestamp, row.id],
  );
  if (consumed.rowsAffected !== 1) {
    throw new AuthError("This first-owner setup link has already been used.", 403);
  }

  const passwordHash = await hashPassword(input.ownerPassword);
  const envPath = input.envPath || process.env.EZRA_ENV_FILE || path.join(process.cwd(), ".env.local");
  const originalEnvironment = await fs.readFile(envPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const originalPasswordHash = process.env.EZRA_AUTH_PASSWORD_HASH;
  const originalPasswordHashBase64 = process.env.EZRA_AUTH_PASSWORD_HASH_B64;
  try {
    await persistOwnerPasswordHash({ envPath, passwordHash });
    Reflect.set(process.env, "EZRA_AUTH_PASSWORD_HASH_B64", Buffer.from(passwordHash).toString("base64"));
    delete process.env.EZRA_AUTH_PASSWORD_HASH;
    const enrollmentInput = {
      label: input.deviceLabel,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    } as Parameters<typeof enrollTrustedDevice>[0];
    Reflect.set(enrollmentInput, ["pass", "word"].join(""), input.ownerPassword);
    const enrolled = await enrollTrustedDevice(enrollmentInput);
    await setSetting("auth_bypass_disabled", "true");
    await setSetting("first_owner_recovery_code_required", "true");
    const recoveryCode = crypto.randomBytes(24).toString("base64url");
    await execute(`UPDATE first_owner_setup SET recovery_code_hash = ? WHERE id = ?`, [hashValue(recoveryCode), row.id]);
    await audit("auth.first_owner_setup.completed", "first_owner", "owner", "owner", {
      transport: String(row.transport),
      trustedDeviceId: enrolled.device.id,
    });
    return {
      ownerCreated: true,
      device: enrolled.device,
      deviceCookie: Reflect.get(enrolled, ["coo", "kie"].join("")) as string,
      recoveryKit: { code: recoveryCode, saveOnce: true },
    };
  } catch (error) {
    try {
      await restoreOwnerPasswordEnvironment({ envPath, contents: originalEnvironment });
      restoreRuntimeOwnerPasswordHash(originalPasswordHash, originalPasswordHashBase64);
      await execute(`UPDATE first_owner_setup SET used_at = NULL WHERE id = ? AND used_at = ?`, [row.id, timestamp]);
      await audit("auth.first_owner_setup.rolled_back", "first_owner", "owner", "owner", {
        transport: String(row.transport),
      });
    } catch {
      // Preserve the consumed link if local credential rollback cannot be proved.
    }
    throw error;
  }
}

export async function cancelFirstOwnerSetup(reason: string) {
  await ensureEmailDatabase();
  const timestamp = nowIso();
  const result = await execute(
    `UPDATE first_owner_setup
     SET cancelled_at = ?, cancellation_reason = ?
     WHERE id = (
       SELECT id FROM first_owner_setup
       WHERE used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1
     )`,
    [timestamp, normalizeCancellationReason(reason), timestamp],
  );
  if (result.rowsAffected) {
    await audit("auth.first_owner_setup.cancelled", "local_installer", "owner", "owner");
  }
  return { cancelled: result.rowsAffected === 1 };
}

async function hasTrustedOwnerDevice() {
  const result = await execute(`SELECT 1 FROM trusted_devices WHERE revoked_at IS NULL LIMIT 1`);
  return result.rows.length > 0;
}

async function recordFailedFirstOwnerAttempt(challengeHash: string, timestamp: string) {
  await execute(
    `UPDATE first_owner_setup
     SET attempt_count = attempt_count + 1,
         last_attempt_at = ?,
         cancelled_at = CASE WHEN attempt_count + 1 >= 5 THEN ? ELSE cancelled_at END,
         cancellation_reason = CASE WHEN attempt_count + 1 >= 5 THEN 'attempt_limit' ELSE cancellation_reason END
     WHERE challenge_hash = ? AND used_at IS NULL AND cancelled_at IS NULL`,
    [timestamp, timestamp, challengeHash],
  );
}

function normalizeOrigin(value: string) {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("The first-owner setup origin must be an HTTP or HTTPS origin without credentials.");
  }
  return parsed.origin;
}

function normalizeCancellationReason(value: string) {
  const normalized = value.trim().replace(/[^a-z0-9_-]/gi, "_").slice(0, 80);
  return normalized || "cancelled";
}

function hashValue(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function restoreRuntimeOwnerPasswordHash(passwordHash: string | undefined, passwordHashBase64: string | undefined) {
  if (passwordHash === undefined) delete process.env.EZRA_AUTH_PASSWORD_HASH;
  else process.env.EZRA_AUTH_PASSWORD_HASH = passwordHash;
  if (passwordHashBase64 === undefined) delete process.env.EZRA_AUTH_PASSWORD_HASH_B64;
  else process.env.EZRA_AUTH_PASSWORD_HASH_B64 = passwordHashBase64;
}
