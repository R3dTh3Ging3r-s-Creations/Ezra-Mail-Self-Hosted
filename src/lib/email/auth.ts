import { purgeRevokedNotificationDevices } from "./notification-store";
import crypto from "node:crypto";
import { audit, execute, getSetting, newId, nowIso } from "./database";
import type { AuthSessionState, TrustedDeviceSummary } from "./types";

const COOKIE_NAME = "ezra_session";
const DEVICE_COOKIE_NAME = "ezra_device";
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICE_COOKIE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const AUTH_CHALLENGE_TIMEOUT_MS = 5 * 60 * 1000;

export class AuthError extends Error {
  constructor(
    message: string,
    public status = 401,
  ) {
    super(message);
  }
}

export function authIsConfigured() {
  return Boolean(configuredPasswordHash() && runtimeEnv("EZRA_AUTH_SECRET"));
}

export async function authBypassIsActive() {
  const configured = authIsConfigured();
  const bypassDisabled = (await getSetting("auth_bypass_disabled")) === "true";
  return (
    (!bypassDisabled && runtimeEnv("EZRA_AUTH_ALLOW_UNCONFIGURED") === "true") ||
    (!configured && runtimeEnv("NODE_ENV") !== "production")
  );
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const parameters = { N: 16_384, r: 8, p: 1 };
  const derived = await deriveScrypt(password, salt, parameters);
  return [
    "scrypt",
    parameters.N,
    parameters.r,
    parameters.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function login(input: {
  password: string;
  ipAddress: string;
  userAgent: string;
  trustedDeviceId?: string | null;
}) {
  if (!authIsConfigured()) {
    throw new AuthError("Ezra Mail authentication has not been configured.", 503);
  }
  await enforceLoginRateLimit(input.ipAddress);
  const valid = await verifyPassword(input.password, configuredPasswordHash());
  await execute(
    `INSERT INTO auth_login_attempts (id, ip_address, succeeded, created_at)
     VALUES (?, ?, ?, ?)`,
    [newId("login"), input.ipAddress, valid ? 1 : 0, nowIso()],
  );
  if (!valid) {
    await audit("auth.login.failed", "anonymous", "ip", input.ipAddress);
    throw new AuthError("The password is incorrect.");
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ABSOLUTE_TIMEOUT_MS);
  await execute(
    `INSERT INTO auth_sessions
      (id, token_hash, created_at, last_seen_at, expires_at, user_agent, ip_address, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId("session"),
      tokenHash(token),
      createdAt.toISOString(),
      createdAt.toISOString(),
      expiresAt.toISOString(),
      input.userAgent.slice(0, 500),
      input.ipAddress,
      input.trustedDeviceId || null,
    ],
  );
  await audit("auth.login.succeeded", "owner", "ip", input.ipAddress, {
    deviceId: input.trustedDeviceId || null,
  });
  return {
    cookie: serializeSessionCookie(signToken(token), ABSOLUTE_TIMEOUT_MS / 1000),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function enrollTrustedDevice(input: {
  password: string;
  label: string;
  ipAddress: string;
  userAgent: string;
}) {
  if (!authIsConfigured()) {
    throw new AuthError("Ezra Mail authentication has not been configured.", 503);
  }
  await enforceLoginRateLimit(input.ipAddress);
  const valid = await verifyPassword(input.password, configuredPasswordHash());
  await execute(
    `INSERT INTO auth_login_attempts (id, ip_address, succeeded, created_at)
     VALUES (?, ?, ?, ?)`,
    [newId("login"), input.ipAddress, valid ? 1 : 0, nowIso()],
  );
  if (!valid) {
    await audit("auth.device.enrollment_failed", "anonymous", "ip", input.ipAddress);
    throw new AuthError("The password is incorrect.");
  }

  return issueTrustedDevice(input);
}

export async function beginTrustedDeviceEnrollment(input: {
  password: string;
  ipAddress: string;
}) {
  if (!authIsConfigured()) {
    throw new AuthError("Ezra Mail authentication has not been configured.", 503);
  }
  await enforceLoginRateLimit(input.ipAddress);
  const valid = await verifyPassword(input.password, configuredPasswordHash());
  await execute(
    `INSERT INTO auth_login_attempts (id, ip_address, succeeded, created_at)
     VALUES (?, ?, ?, ?)`,
    [newId("login"), input.ipAddress, valid ? 1 : 0, nowIso()],
  );
  if (!valid) throw new AuthError("The password is incorrect.");
  return createAuthChallenge({
    kind: "device_enrollment",
    action: "enroll_trusted_device",
    challenge: crypto.randomBytes(32).toString("base64url"),
  });
}

export async function finishTrustedDeviceEnrollment(input: {
  challengeId: string;
  label: string;
  ipAddress: string;
  userAgent: string;
}) {
  await consumeAuthChallenge({
    id: input.challengeId,
    kind: "device_enrollment",
    action: "enroll_trusted_device",
  });
  return issueTrustedDevice(input);
}

async function issueTrustedDevice(input: {
  label: string;
  ipAddress: string;
  userAgent: string;
}) {
  const label = input.label.trim().replace(/\s+/g, " ");
  if (!label || label.length > 80) {
    throw new AuthError("Give this device a name between 1 and 80 characters.", 400);
  }

  const id = newId("device");
  const token = crypto.randomBytes(32).toString("base64url");
  const timestamp = nowIso();
  await execute(
    `INSERT INTO trusted_devices
      (id, label, token_hash, created_at, last_used_at, last_user_agent, last_ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      label,
      tokenHash(token),
      timestamp,
      timestamp,
      input.userAgent.slice(0, 500),
      input.ipAddress.slice(0, 100),
    ],
  );
  await audit("auth.device.enrolled", "owner", "trusted_device", id, { label });
  return {
    device: { id, label },
    cookie: serializeCookie(
      DEVICE_COOKIE_NAME,
      signToken(token),
      DEVICE_COOKIE_MAX_AGE_SECONDS,
    ),
  };
}

export async function listTrustedDevices(
  currentDeviceId?: string | null,
): Promise<TrustedDeviceSummary[]> {
  const result = await execute(
    `SELECT id, label, created_at, last_used_at, last_user_agent, last_ip_address, revoked_at
     FROM trusted_devices
     ORDER BY CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END, last_used_at DESC`,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    current: Boolean(currentDeviceId && row.id === currentDeviceId),
    createdAt: String(row.created_at),
    lastUsedAt: String(row.last_used_at),
    lastUserAgent: row.last_user_agent ? String(row.last_user_agent) : null,
    lastIpAddress: row.last_ip_address ? String(row.last_ip_address) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  }));
}

export async function revokeTrustedDevice(deviceId: string, source: string) {
  const timestamp = nowIso();
  const result = await execute(
    `UPDATE trusted_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    [timestamp, deviceId],
  );
  const sessions = await execute(
    `UPDATE auth_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL`,
    [timestamp, deviceId],
  );
  await purgeRevokedNotificationDevices({ now: timestamp });
  await audit("auth.device.revoked", "owner", "trusted_device", deviceId, {
    source,
    changed: result.rowsAffected > 0,
    revokedSessions: sessions.rowsAffected,
  });
  return { revoked: result.rowsAffected > 0 };
}

export async function linkCurrentSessionToDevice(request: Request, deviceId: string) {
  const token = verifiedCookieToken(request, COOKIE_NAME);
  if (!token) return { linked: false };
  const result = await execute(
    `UPDATE auth_sessions SET device_id = ?
     WHERE token_hash = ? AND revoked_at IS NULL`,
    [deviceId, tokenHash(token)],
  );
  return { linked: result.rowsAffected > 0 };
}

export async function createAuthChallenge(input: {
  kind: string;
  action: string;
  deviceId?: string | null;
  challenge: string;
  expiresAt?: string;
}) {
  const id = newId("challenge");
  const createdAt = nowIso();
  const expiresAt = input.expiresAt || new Date(Date.now() + AUTH_CHALLENGE_TIMEOUT_MS).toISOString();
  await execute(
    `INSERT INTO auth_challenges
      (id, kind, challenge, action, device_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.kind, input.challenge, input.action, input.deviceId || null, createdAt, expiresAt],
  );
  return { id, expiresAt };
}

export async function consumeAuthChallenge(input: {
  id: string;
  kind: string;
  action: string;
  deviceId?: string | null;
}) {
  const result = await execute(
    `SELECT challenge, expires_at FROM auth_challenges
     WHERE id = ? AND kind = ? AND action = ?
       AND COALESCE(device_id, '') = COALESCE(?, '') AND used_at IS NULL
     LIMIT 1`,
    [input.id, input.kind, input.action, input.deviceId || null],
  );
  const row = result.rows[0];
  if (!row || new Date(String(row.expires_at)).getTime() <= Date.now()) {
    throw new AuthError("This security confirmation is invalid or expired. Start again.", 403);
  }
  const consumedAt = nowIso();
  const consumed = await execute(
    `UPDATE auth_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL`,
    [consumedAt, input.id],
  );
  if (consumed.rowsAffected !== 1) {
    throw new AuthError("This security confirmation has already been used.", 403);
  }
  return { challenge: String(row.challenge), consumedAt };
}

export async function logout(request: Request) {
  const token = verifiedCookieToken(request, COOKIE_NAME);
  if (token) {
    await execute(
      `UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
      [nowIso(), tokenHash(token)],
    );
  }
  const deviceToken = verifiedCookieToken(request, DEVICE_COOKIE_NAME);
  if (deviceToken) {
    await execute(
      `UPDATE trusted_devices SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
      [nowIso(), tokenHash(deviceToken)],
    );
  }
  await purgeRevokedNotificationDevices({});
  await audit("auth.logout", "owner", "session", token ? tokenHash(token).slice(0, 12) : "none");
  return serializeSessionCookie("", 0);
}

export function clearTrustedDeviceCookie() {
  return serializeCookie(DEVICE_COOKIE_NAME, "", 0);
}

export async function getAuthSession(request: Request): Promise<AuthSessionState> {
  const configured = authIsConfigured();
  const developmentBypass = await authBypassIsActive();
  if (!configured) {
    return {
      authenticated: developmentBypass,
      configured: false,
      developmentBypass,
      expiresAt: null,
      authenticationMethod: developmentBypass ? "bypass" : null,
      trustedDevice: null,
    };
  }

  const deviceToken = verifiedCookieToken(request, DEVICE_COOKIE_NAME);
  if (deviceToken) {
    const result = await execute(
      `SELECT id, label, last_used_at FROM trusted_devices
       WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
      [tokenHash(deviceToken)],
    );
    const row = result.rows[0];
    if (row) {
      const lastUsedAt = new Date(String(row.last_used_at)).getTime();
      if (Date.now() - lastUsedAt > 5 * 60 * 1000) {
        const identity = requestIdentity(request);
        await execute(
          `UPDATE trusted_devices
           SET last_used_at = ?, last_user_agent = ?, last_ip_address = ? WHERE id = ?`,
          [nowIso(), identity.userAgent.slice(0, 500), identity.ipAddress.slice(0, 100), row.id],
        );
      }
      return {
        authenticated: true,
        configured: true,
        developmentBypass: false,
        expiresAt: null,
        authenticationMethod: "trusted_device",
        trustedDevice: { id: String(row.id), label: String(row.label) },
      };
    }
  }

  const token = verifiedCookieToken(request, COOKIE_NAME);
  if (token) {
    const result = await execute(
      `SELECT s.id, s.last_seen_at, s.expires_at, s.device_id,
              d.id AS active_device_id
       FROM auth_sessions s
       LEFT JOIN trusted_devices d ON d.id = s.device_id AND d.revoked_at IS NULL
       WHERE s.token_hash = ? AND s.revoked_at IS NULL LIMIT 1`,
      [tokenHash(token)],
    );
    const row = result.rows[0];
    if (row) {
      if (row.device_id && !row.active_device_id) {
        await execute(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ?`, [nowIso(), row.id]);
      } else {
        const now = Date.now();
        const expiresAt = new Date(String(row.expires_at)).getTime();
        const lastSeenAt = new Date(String(row.last_seen_at)).getTime();
        if (expiresAt > now && now - lastSeenAt <= IDLE_TIMEOUT_MS) {
          if (now - lastSeenAt > 5 * 60 * 1000) {
            await execute(`UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?`, [nowIso(), row.id]);
          }
          return {
            authenticated: true,
            configured: true,
            developmentBypass: false,
            expiresAt: new Date(expiresAt).toISOString(),
            authenticationMethod: "session",
            trustedDevice: null,
          };
        }
        await execute(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ?`, [nowIso(), row.id]);
      }
    }
  }
  if (developmentBypass) {
    return {
      authenticated: true,
      configured: true,
      developmentBypass: true,
      expiresAt: null,
      authenticationMethod: "bypass",
      trustedDevice: null,
    };
  }
  return unauthenticatedState();
}

export async function requireAuth(request: Request) {
  const session = await getAuthSession(request);
  if (!session.authenticated) throw new AuthError("Authentication is required.");
  return session;
}

export function requestIdentity(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ipAddress: forwarded || request.headers.get("x-real-ip") || "unknown",
    userAgent: request.headers.get("user-agent") || "unknown",
  };
}

function unauthenticatedState(): AuthSessionState {
  return {
    authenticated: false,
    configured: true,
    developmentBypass: false,
    expiresAt: null,
    authenticationMethod: null,
    trustedDevice: null,
  };
}

async function enforceLoginRateLimit(ipAddress: string) {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString();
  const result = await execute(
    `SELECT COUNT(*) AS count FROM auth_login_attempts
     WHERE ip_address = ? AND succeeded = 0 AND created_at >= ?`,
    [ipAddress, since],
  );
  if (Number(result.rows[0]?.count || 0) >= MAX_LOGIN_FAILURES) {
    await audit("auth.login.rate_limited", "anonymous", "ip", ipAddress);
    throw new AuthError("Too many failed attempts. Try again in 15 minutes.", 429);
  }
}

async function verifyPassword(password: string, encoded: string) {
  const [kind, nValue, rValue, pValue, saltValue, hashValue] = encoded.split("$");
  if (kind !== "scrypt" || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64url");
  const actual = await deriveScrypt(password, Buffer.from(saltValue, "base64url"), {
    N: Number(nValue),
    r: Number(rValue),
    p: Number(pValue),
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function deriveScrypt(
  password: string,
  salt: Buffer,
  parameters: { N: number; r: number; p: number },
) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      64,
      { ...parameters, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function signToken(token: string) {
  const signature = crypto
    .createHmac("sha256", runtimeEnv("EZRA_AUTH_SECRET") || "")
    .update(token)
    .digest("base64url");
  return `${token}.${signature}`;
}

function verifiedCookieToken(request: Request, cookieName = COOKIE_NAME) {
  const cookie = request.headers.get("cookie") || "";
  const encoded = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!encoded) return null;
  const [token, supplied] = decodeURIComponent(encoded).split(".");
  if (!token || !supplied) return null;
  const expected = signToken(token).split(".")[1];
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return null;
  }
  return token;
}

function tokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function serializeSessionCookie(value: string, maxAgeSeconds: number) {
  return serializeCookie(COOKIE_NAME, value, maxAgeSeconds);
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number) {
  const secure =
    runtimeEnv("NODE_ENV") === "production" && runtimeEnv("EZRA_AUTH_SECURE_COOKIE") !== "false";
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ]
    .filter(Boolean)
    .join("; ");
}

function runtimeEnv(name: string) {
  return Reflect.get(process.env, name) as string | undefined;
}

function configuredPasswordHash() {
  const encoded = runtimeEnv("EZRA_AUTH_PASSWORD_HASH_B64");
  if (encoded) {
    try {
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.toString("base64") === encoded) {
        return decoded.toString("utf8");
      }
    } catch {
      // Fall through to the plain hash when a restored Base64 value is corrupt.
    }
  }
  return runtimeEnv("EZRA_AUTH_PASSWORD_HASH") || "";
}
