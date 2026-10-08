import { randomUUID, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, execute, setSetting } from "@/lib/email/database";
import { createAuthChallenge } from "@/lib/email/auth";
import { issueAgentGrant, revokeAgentGrant, listAgentGrants, grantReviewHash, rotateAgentGrant, admitAgentRead } from "@/lib/email/agent-grants";
import { authenticateAgentRequest } from "@/lib/email/agent-api";
import type { GrantSpec } from "@/lib/email/agent-resource-types";

const personal = { accountId: "ms", provider: "microsoft" as const, expectedEmail: "owner@hotmail.test" };
const google = { accountId: "gg", provider: "gmail" as const, expectedEmail: "owner@gmail.test" };
const resource = { account: personal, kind: "calendar" as const, id: "primary" };
const spec: GrantSpec = { label: "Fixture", lifetimeDays: 7, accounts: [personal], resources: [resource], scopes: ["accounts.read", "calendar.read"] };
async function owner(action: unknown, deviceId = "device") {
  const receipt = await createAuthChallenge({ kind: "step_up_receipt", action: `manage_agent_grants:${grantReviewHash(action)}`, deviceId, challenge: "synthetic-test-receipt" });
  return { deviceId, stepUpReceiptId: receipt.id };
}
const request = (secret: string) => new Request("https://mail.example.test/api/agent/v1/capabilities", { headers: { authorization: `Bearer ${secret}` } });

describe("owner-issued scoped agent credentials", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./agent-grants-${randomUUID()}.sqlite`);
    await setSetting("agent_personal_accounts", JSON.stringify([personal, google]));
    for (const account of [personal, google]) await execute("INSERT INTO email_accounts(id,provider,email,label,status,created_at,updated_at) VALUES (?,?,?,?,'connected',?,?)", [account.accountId, account.provider, account.expectedEmail, "Fixture", new Date().toISOString(), new Date().toISOString()]);
  });
  afterEach(async () => { vi.restoreAllMocks(); await closeEmailDatabaseForTests(); });
  it("shows the key once, stores a digest, and consumes the exact review receipt", async () => {
    const authority = await owner({ action: "issue", spec });
    const issued = await issueAgentGrant(spec, authority);
    expect(issued.secret).toMatch(/^ezra_[a-f0-9-]+\.[A-Za-z0-9_-]{43}$/);
    const raw = issued.secret.split(".")[1];
    expect(Buffer.from(raw, "base64url")).toHaveLength(32);
    const row = (await execute("SELECT secret_digest FROM agent_grants")).rows[0];
    expect(row.secret_digest).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(JSON.stringify(await listAgentGrants())).not.toContain(raw);
    expect(JSON.stringify(await listAgentGrants())).not.toContain(String(row.secret_digest));
    await expect(issueAgentGrant(spec, authority)).rejects.toMatchObject({ status: 403 });
    expect(await authenticateAgentRequest(request(issued.secret))).toEqual({ keyId: issued.grant.keyId, revision: 1 });
  });
  it("rejects changed grant review and wrong device", async () => {
    await expect(issueAgentGrant({ ...spec, scopes: ["calendar.create"] }, await owner({ action: "issue", spec }))).rejects.toMatchObject({ status: 403 });
    const authority = await owner({ action: "issue", spec });
    await expect(issueAgentGrant(spec, { ...authority, deviceId: "other" })).rejects.toMatchObject({ status: 403 });
    expect(await listAgentGrants()).toEqual([]);
  });
  it("rejects work-account selection before issuing a key", async () => {
    const work = { ...personal, accountId: "work", expectedEmail: "worker@company.test" };
    const bad = { ...spec, accounts: [work], resources: [] };
    await expect(issueAgentGrant(bad, await owner({ action: "issue", spec: bad }))).rejects.toThrow();
    expect(await listAgentGrants()).toEqual([]);
  });
  it("denies missing scopes, wrong resources and revoked credentials", async () => {
    const issued = await issueAgentGrant(spec, await owner({ action: "issue", spec }));
    const principal = await authenticateAgentRequest(request(issued.secret));
    await expect(admitAgentRead(principal, "calendar.read", resource)).resolves.toMatchObject({ keyId: issued.grant.keyId });
    await expect(admitAgentRead(principal, "calendar.read", { ...resource, id: "other" })).rejects.toMatchObject({ status: 403 });
    await expect(admitAgentRead(principal, "mail.read", personal)).rejects.toMatchObject({ status: 403 });
    await revokeAgentGrant(issued.grant.keyId, await owner({ action: "revoke", keyId: issued.grant.keyId }));
    await expect(authenticateAgentRequest(request(issued.secret))).rejects.toMatchObject({ status: 401 });
    await expect(admitAgentRead(principal, "calendar.read", resource)).rejects.toMatchObject({ status: 401 });
  });
  it("atomically rotates to a fresh key and refuses repeated rotation", async () => {
    const old = await issueAgentGrant(spec, await owner({ action: "issue", spec }));
    const next = await rotateAgentGrant(old.grant.keyId, spec, await owner({ action: "rotate", keyId: old.grant.keyId, spec }));
    await expect(authenticateAgentRequest(request(old.secret))).rejects.toMatchObject({ status: 401 });
    await expect(authenticateAgentRequest(request(next.secret))).resolves.toMatchObject({ keyId: next.grant.keyId });
    await expect(rotateAgentGrant(old.grant.keyId, spec, await owner({ action: "rotate", keyId: old.grant.keyId, spec }))).rejects.toMatchObject({ status: 409 });
    expect(await listAgentGrants()).toHaveLength(2);
  });
  it("denies expired synthetic credentials", async () => {
    const fixtureSecret = "x".repeat(43);
    await execute("INSERT INTO agent_grants(key_id,secret_digest,grant_json,revision,created_at,expires_at) VALUES ('expired',?,?,1,'2000-01-01T00:00:00Z','2000-01-02T00:00:00Z')", [createHash("sha256").update(fixtureSecret).digest("hex"), JSON.stringify(spec)]);
    await expect(authenticateAgentRequest(request(`ezra_expired.${fixtureSecret}`))).rejects.toMatchObject({ status: 401 });
  });
  it("enforces persistent per-key limits", async () => {
    const fixedNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const issued = await issueAgentGrant(spec, await owner({ action: "issue", spec }));
    for (let index = 0; index < 60; index++) await authenticateAgentRequest(request(issued.secret));
    await closeEmailDatabaseForTests();
    await expect(authenticateAgentRequest(request(issued.secret))).rejects.toMatchObject({ status: 429 });
    clock.mockReturnValue(fixedNow + 60_000);
    await expect(authenticateAgentRequest(request(issued.secret))).resolves.toMatchObject({ keyId: issued.grant.keyId });
  });
  it("does not trust spoofed forwarded IPs to evade failed authentication limits", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (let index = 0; index < 10; index++) await expect(authenticateAgentRequest(new Request("https://mail.example.test", { headers: { "x-forwarded-for": `192.0.2.${index}` } }))).rejects.toMatchObject({ status: 401 });
    await expect(authenticateAgentRequest(new Request("https://mail.example.test", { headers: { "x-forwarded-for": "198.51.100.1" } }))).rejects.toMatchObject({ status: 429 });
  });
  it("owner cookies never authenticate agent API", async () => {
    await expect(authenticateAgentRequest(new Request("https://mail.example.test", { headers: { cookie: "mock-cookie" } }))).rejects.toMatchObject({ status: 401 });
  });
});

it("backup then revoke then restore denies the old bearer with HTTP 401", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { getEmailDatabasePath } = await import("@/lib/email/database");
  const { prepareRestoredAgentAccess } = await import("@/lib/email/system-recovery");
  const { agentJsonResponse } = await import("@/lib/email/agent-api");
  const directory = path.join(process.cwd(), "data", "tests", `grant-restore-auth-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  configureEmailDatabaseForTests(`file:${path.join(directory, "active.sqlite").replace(/\\/g, "/")}`);
  try {
    await execute("SELECT 1");
    const raw = "x".repeat(43);
    await execute("INSERT INTO agent_grants(key_id,secret_digest,grant_json,revision,created_at,expires_at) VALUES ('restored',?,?,1,'2026-10-01T00:00:00Z','2099-01-01T00:00:00Z')", [createHash("sha256").update(raw).digest("hex"), JSON.stringify(spec)]);
    await execute("INSERT INTO agent_key_bindings VALUES ('restored',1,'request','hash','legacy','historical')");
    await execute("PRAGMA wal_checkpoint(TRUNCATE)");
    const staged = path.join(directory, "staged.sqlite");
    await fs.copyFile(getEmailDatabasePath()!, staged);
    await execute("UPDATE agent_grants SET revoked_at='2026-10-05T00:00:00Z'");
    await prepareRestoredAgentAccess(staged);
    await closeEmailDatabaseForTests();
    configureEmailDatabaseForTests(`file:${staged.replace(/\\/g, "/")}`);
    const response = await agentJsonResponse(() => authenticateAgentRequest(request(`ezra_restored.${raw}`)));
    expect(response.status).toBe(401);
    expect((await execute("SELECT operation_id FROM agent_key_bindings")).rows).toEqual([{ operation_id: "historical" }]);
  } finally { await closeEmailDatabaseForTests(); }
}, 15_000);
