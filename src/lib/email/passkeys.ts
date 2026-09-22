import crypto from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { audit, execute, getSetting, newId, nowIso, setSetting } from "./database";
import { AuthError, consumeAuthChallenge, createAuthChallenge } from "./auth";

const OWNER_ID_SETTING = "owner_webauthn_user_id";
const ALLOWED_STEP_UP_ACTIONS = new Set([
  "enroll_trusted_device",
  "change_owner_credentials",
  "change_auth_policy",
  "view_recovery_material",
  "regenerate_recovery_material",
  "export_private_archive",
]);

export async function beginPasskeyRegistration(request: Request, input: {
  deviceId?: string | null;
}) {
  const config = webAuthnConfig(request);
  const existing = await execute(
    `SELECT credential_id, transports FROM owner_passkeys WHERE revoked_at IS NULL`,
  );
  let ownerId = await getSetting(OWNER_ID_SETTING);
  if (!ownerId) {
    ownerId = crypto.randomBytes(32).toString("base64url");
    await setSetting(OWNER_ID_SETTING, ownerId);
  }
  const options = await generateRegistrationOptions({
    rpName: "Ezra Mail",
    rpID: config.rpID,
    userName: "owner",
    userDisplayName: "Ezra Mail owner",
    userID: Buffer.from(ownerId, "base64url"),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
    excludeCredentials: existing.rows.map((row) => ({
      id: String(row.credential_id),
      transports: parseTransports(row.transports),
    })),
  });
  const challenge = await createAuthChallenge({
    kind: "passkey_registration",
    action: "register_passkey",
    deviceId: input.deviceId,
    challenge: options.challenge,
  });
  return { challengeId: challenge.id, options, expiresAt: challenge.expiresAt };
}

export async function finishPasskeyRegistration(request: Request, input: {
  challengeId: string;
  deviceId?: string | null;
  name: string;
  response: RegistrationResponseJSON;
}) {
  const name = normalizeName(input.name, "Passkey");
  const pending = await consumeAuthChallenge({
    id: input.challengeId,
    kind: "passkey_registration",
    action: "register_passkey",
    deviceId: input.deviceId,
  });
  const config = webAuthnConfig(request);
  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: pending.challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new AuthError("The passkey could not be verified.", 403);
  }
  const credential = verification.registrationInfo.credential;
  const id = newId("passkey");
  await execute(
    `INSERT INTO owner_passkeys
      (id, name, credential_id, public_key, counter, transports, device_type,
       backed_up, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      name,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports || input.response.response.transports || []),
      verification.registrationInfo.credentialDeviceType,
      verification.registrationInfo.credentialBackedUp ? 1 : 0,
      nowIso(),
      nowIso(),
    ],
  );
  await audit("auth.passkey.registered", "owner", "passkey", id, { name });
  return { id, name };
}

export async function beginStepUp(request: Request, input: {
  action: string;
  deviceId?: string | null;
}) {
  assertStepUpAction(input.action);
  const config = webAuthnConfig(request);
  const passkeys = await execute(
    `SELECT credential_id, transports, device_type, backed_up
     FROM owner_passkeys WHERE revoked_at IS NULL`,
  );
  if (!passkeys.rows.length) {
    throw new AuthError("Add an owner passkey before using this security control.", 409);
  }
  const syncedPasskeysOnly = passkeys.rows.every(
    (row) => String(row.device_type) === "multiDevice" || Number(row.backed_up) === 1,
  );
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    userVerification: "required",
    allowCredentials: syncedPasskeysOnly
      ? []
      : passkeys.rows.map((row) => ({
          id: String(row.credential_id),
          ...(
            String(row.device_type) === "multiDevice" || Number(row.backed_up) === 1
              ? {}
              : { transports: parseTransports(row.transports) }
          ),
        })),
  });
  const challenge = await createAuthChallenge({
    kind: "step_up",
    action: input.action,
    deviceId: input.deviceId,
    challenge: options.challenge,
  });
  return { challengeId: challenge.id, options, expiresAt: challenge.expiresAt };
}

export async function finishStepUp(request: Request, input: {
  challengeId: string;
  action: string;
  deviceId?: string | null;
  response: AuthenticationResponseJSON;
}) {
  assertStepUpAction(input.action);
  const pending = await consumeAuthChallenge({
    id: input.challengeId,
    kind: "step_up",
    action: input.action,
    deviceId: input.deviceId,
  });
  const stored = await execute(
    `SELECT id, credential_id, public_key, counter, transports
     FROM owner_passkeys WHERE credential_id = ? AND revoked_at IS NULL LIMIT 1`,
    [input.response.id],
  );
  const row = stored.rows[0];
  if (!row) throw new AuthError("This passkey is not registered with Ezra Mail.", 403);
  const config = webAuthnConfig(request);
  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: pending.challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpID,
    requireUserVerification: true,
    credential: {
      id: String(row.credential_id),
      publicKey: new Uint8Array(asUint8Array(row.public_key)),
      counter: Number(row.counter),
      transports: parseTransports(row.transports),
    },
  });
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    throw new AuthError("The passkey confirmation failed.", 403);
  }
  await execute(
    `UPDATE owner_passkeys SET counter = ?, last_used_at = ? WHERE id = ?`,
    [verification.authenticationInfo.newCounter, nowIso(), row.id],
  );
  const receipt = await createAuthChallenge({
    kind: "step_up_receipt",
    action: input.action,
    deviceId: input.deviceId,
    challenge: crypto.randomBytes(32).toString("base64url"),
  });
  await audit("auth.step_up.succeeded", "owner", "passkey", String(row.id), {
    action: input.action,
    deviceId: input.deviceId || null,
  });
  return { receiptId: receipt.id, expiresAt: receipt.expiresAt };
}

export async function consumeStepUpReceipt(input: {
  receiptId: string;
  action: string;
  deviceId?: string | null;
}) {
  assertStepUpAction(input.action);
  await consumeAuthChallenge({
    id: input.receiptId,
    kind: "step_up_receipt",
    action: input.action,
    deviceId: input.deviceId,
  });
}

export async function listOwnerPasskeys() {
  const result = await execute(
    `SELECT id, name, created_at, last_used_at, revoked_at
     FROM owner_passkeys ORDER BY created_at DESC`,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  }));
}

function webAuthnConfig(request: Request) {
  const url = new URL(request.url);
  const origin = process.env.EZRA_WEBAUTHN_ORIGIN?.trim() || url.origin;
  const rpID = process.env.EZRA_WEBAUTHN_RP_ID?.trim() || new URL(origin).hostname;
  if (new URL(origin).protocol !== "https:" && !["localhost", "127.0.0.1"].includes(rpID)) {
    throw new AuthError("Passkeys require Ezra Mail's HTTPS address.", 400);
  }
  return { origin, rpID };
}

function normalizeName(value: string, fallback: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80) throw new AuthError(`${fallback} name must be 1 to 80 characters.`, 400);
  return normalized;
}

function assertStepUpAction(action: string) {
  if (!ALLOWED_STEP_UP_ACTIONS.has(action)) throw new AuthError("Unknown security action.", 400);
}

function parseTransports(value: unknown) {
  try {
    return JSON.parse(String(value || "[]"));
  } catch {
    return [];
  }
}

function asUint8Array(value: unknown) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(Buffer.from(String(value), "base64"));
}
