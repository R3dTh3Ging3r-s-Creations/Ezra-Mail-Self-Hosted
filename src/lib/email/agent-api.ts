import { AgentReadError, isAgentReadErrorCode } from "./agent-safe-errors";
import { createHash, timingSafeEqual } from "node:crypto";
import { authority, matchesHost } from "./notification-origin";
import { AuthError, getAuthSession } from "./auth";
import { ensureEmailDatabase, execute, getEmailClient } from "./database";
import { withEmailDatabaseAccess } from "./database-access";
import { requireActiveGrantRow } from "./agent-grants";
import type { GrantPrincipal } from "./agent-resource-types";

async function consumeRate(bucket: string, limit: number): Promise<void> {
  await ensureEmailDatabase();
  const now = Date.now();
  const window = Math.floor(now / 60_000);
  const admitted = await withEmailDatabaseAccess(async () => {
    const result = await getEmailClient().batch([
      { sql: "DELETE FROM agent_api_rate_limits WHERE window < ?", args: [window - 1440] },
      { sql: `INSERT INTO agent_api_rate_limits(bucket,window,count) VALUES (?,?,1)
          ON CONFLICT(bucket,window) DO UPDATE SET count=count+1 WHERE count<?`, args: [bucket, window, limit] },
    ], "write");
    return result[1].rowsAffected === 1;
  });
  if (!admitted) throw new AuthError("Request limit reached.", 429);
}
/** Next's standard Request has no authenticated peer address. Never trust caller-supplied forwarding headers. */
async function failedAuthentication(): Promise<never> {
  await consumeRate("failed:unattributed-peer", 10);
  throw new AuthError("Agent authentication required.");
}
export async function authenticateAgentRequest(request: Request): Promise<GrantPrincipal> {
  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > 200) return failedAuthentication();
  const match = /^Bearer ezra_([a-zA-Z0-9-]{1,64})\.([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match) return failedAuthentication();
  const row = (await execute("SELECT * FROM agent_grants WHERE key_id=?", [match[1]])).rows[0];
  const actual = createHash("sha256").update(match[2]).digest();
  const stored = row && /^[a-f0-9]{64}$/.test(String(row.secret_digest)) ? Buffer.from(String(row.secret_digest), "hex") : Buffer.alloc(32);
  if (!timingSafeEqual(actual, stored) || !row) return failedAuthentication();
  let grant;
  try { grant = requireActiveGrantRow(row); } catch { return failedAuthentication(); }
  await consumeRate(`key:${grant.keyId}`, 60);
  return { keyId: grant.keyId, revision: grant.revision };
}
export async function readAgentJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new AuthError("JSON required.", 400);
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 65_536)) throw new AuthError("Request too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError("JSON required.", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65_536) { await reader.cancel(); throw new AuthError("Request too large.", 413); }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
export async function requireGrantOwner(request: Request): Promise<{ deviceId: string }> {
  if (request.headers.has("authorization")) throw new AuthError("Owner session required.", 401);
  // Next.js uses its internal listener URL behind a proxy. Bind owner actions to
  // the existing passkey origin, never to caller-supplied forwarding headers.
  const configured = process.env.EZRA_WEBAUTHN_ORIGIN?.trim();
  let expected: URL;
  try {
    expected = new URL(configured || new URL(request.url).origin);
    authority(expected.host);
    if ((configured && configured !== expected.origin && configured !== expected.origin + "/") ||
        expected.username || expected.password ||
        (expected.protocol !== "https:" && !(expected.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname)))) {
      throw new Error("Invalid owner origin");
    }
  } catch { throw new AuthError("Owner origin configuration unavailable.", 503); }
  const origin = request.headers.get("origin"), host = request.headers.get("host");
  let matchingHost = false;
  try {
    matchingHost = host !== null ? matchesHost(authority(host), expected) : new URL(request.url).origin === expected.origin;
  } catch { /* Invalid Host is denied below. */ }
  if (!matchingHost || (request.method !== "GET" && !origin) ||
      (origin !== null && origin !== expected.origin) ||
      (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")) {
    throw new AuthError("Same-origin owner request required.", 403);
  }
  const session = await getAuthSession(request);
  if (!session.authenticated || !session.trustedDevice || session.authenticationMethod === "bypass") throw new AuthError("Trusted owner session required.", 401);
  return { deviceId: session.trustedDevice.id };
}
export async function agentJsonResponse(handler: () => Promise<unknown>): Promise<Response> {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  try { return new Response(JSON.stringify(await handler()), { status: 200, headers }); }
  catch (error) {
    if (error instanceof AgentReadError && isAgentReadErrorCode(error.code)) return new Response(JSON.stringify({ ok: false, error: error.code }), { status: 503, headers });
    const status = error instanceof AuthError && [400, 401, 403, 404, 409, 413, 429, 503].includes(error.status) ? error.status : 400;
    return new Response(JSON.stringify({ ok: false, error: status === 401 ? "authentication_required" : status === 403 ? "access_denied" : status === 429 ? "rate_limited" : "request_unavailable" }), { status, headers });
  }
}
