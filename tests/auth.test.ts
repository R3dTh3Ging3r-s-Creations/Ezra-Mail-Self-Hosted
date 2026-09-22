import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureEmailDatabaseForTests, execute, setSetting } from "@/lib/email/database";
import {
  consumeAuthChallenge,
  createAuthChallenge,
  enrollTrustedDevice,
  getAuthSession,
  hashPassword,
  listTrustedDevices,
  linkCurrentSessionToDevice,
  login,
  logout,
  revokeTrustedDevice,
} from "@/lib/email/auth";

describe("single-user authentication", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./auth-${randomUUID()}.sqlite`);
    process.env.EZRA_AUTH_SECRET = "test-secret-that-is-long-and-random-enough";
    const passwordHash = await hashPassword("correct horse battery staple");
    process.env.EZRA_AUTH_PASSWORD_HASH = "dotenv-expanded-value";
    process.env.EZRA_AUTH_PASSWORD_HASH_B64 = Buffer.from(passwordHash).toString("base64");
    await execute(`SELECT 1`);
  });

  afterEach(() => {
    delete process.env.EZRA_AUTH_SECRET;
    delete process.env.EZRA_AUTH_PASSWORD_HASH;
    delete process.env.EZRA_AUTH_PASSWORD_HASH_B64;
    delete process.env.EZRA_AUTH_ALLOW_UNCONFIGURED;
  });

  it("keeps the explicit private-install bypass active while the first device is enrolled", async () => {
    process.env.EZRA_AUTH_ALLOW_UNCONFIGURED = "true";
    const session = await getAuthSession(new Request("https://ezra.local"));
    expect(session).toMatchObject({ authenticated: true, configured: true, developmentBypass: true });
    const enrolled = await enrollTrustedDevice({
      password: "correct horse battery staple",
      label: "First owner browser",
      ipAddress: "192.0.2.10",
      userAgent: "Vitest",
    });
    expect(enrolled).toMatchObject({ device: { label: "First owner browser" } });
    const trusted = await getAuthSession(new Request("https://ezra.local", { headers: { cookie: enrolled.cookie.split(";")[0] } }));
    expect(trusted).toMatchObject({ authenticationMethod: "trusted_device", developmentBypass: false });
  });

  it("honors an explicit post-enrollment bypass disable policy", async () => {
    process.env.EZRA_AUTH_ALLOW_UNCONFIGURED = "true";
    await setSetting("auth_bypass_disabled", "true");
    await expect(getAuthSession(new Request("https://ezra.local"))).resolves.toMatchObject({
      authenticated: false,
      configured: true,
      developmentBypass: false,
    });
  });

  it("creates an HttpOnly strict session and revokes it on logout", async () => {
    const created = await login({ password: "correct horse battery staple", ipAddress: "192.0.2.10", userAgent: "Vitest" });
    const request = new Request("http://ezra.local", { headers: { cookie: created.cookie.split(";")[0] } });

    expect(created.cookie).toContain("HttpOnly");
    expect(created.cookie).toContain("SameSite=Strict");
    expect((await getAuthSession(request)).authenticated).toBe(true);

    await logout(request);
    expect((await getAuthSession(request)).authenticated).toBe(false);
  });

  it("signing out explicitly forgets the current trusted device", async () => {
    const enrolled = await enrollTrustedDevice({
      password: "correct horse battery staple",
      label: "Office browser",
      ipAddress: "192.0.2.10",
      userAgent: "Vitest",
    });
    const request = new Request("https://ezra.local", { headers: { cookie: enrolled.cookie.split(";")[0] } });
    expect((await getAuthSession(request)).authenticated).toBe(true);
    await logout(request);
    expect((await getAuthSession(request)).authenticated).toBe(false);
  });

  it("falls back to the plain hash when the restored Base64 hash is malformed", async () => {
    const encoded = process.env.EZRA_AUTH_PASSWORD_HASH_B64 || "";
    process.env.EZRA_AUTH_PASSWORD_HASH = Buffer.from(encoded, "base64").toString("utf8");
    process.env.EZRA_AUTH_PASSWORD_HASH_B64 = `${encoded}n`;

    await expect(login({
      password: "correct horse battery staple",
      ipAddress: "192.0.2.10",
      userAgent: "Vitest",
    })).resolves.toMatchObject({ expiresAt: expect.any(String) });
  });

  it("rate limits the sixth failed login within fifteen minutes", async () => {
    for (let index = 0; index < 5; index += 1) {
      await expect(login({ password: "wrong password", ipAddress: "192.0.2.10", userAgent: "Vitest" })).rejects.toMatchObject({ status: 401 });
    }
    await expect(login({ password: "wrong password", ipAddress: "192.0.2.10", userAgent: "Vitest" })).rejects.toMatchObject({ status: 429 });
  });

  it("expires an idle server-side session", async () => {
    const created = await login({ password: "correct horse battery staple", ipAddress: "192.0.2.10", userAgent: "Vitest" });
    await execute(`UPDATE auth_sessions SET last_seen_at = ?`, [new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString()]);
    const request = new Request("http://ezra.local", { headers: { cookie: created.cookie.split(";")[0] } });
    expect((await getAuthSession(request)).authenticated).toBe(false);
  });

  it("keeps an explicitly enrolled device trusted until it is revoked", async () => {
    const enrolled = await enrollTrustedDevice({
      password: "correct horse battery staple",
      label: "Office computer",
      ipAddress: "192.0.2.10",
      userAgent: "Initial browser",
    });
    const browserCookie = enrolled.cookie.split(";")[0];
    const request = new Request("https://ezra.local", {
      headers: {
        cookie: browserCookie,
        "user-agent": "Updated browser",
        "x-forwarded-for": "100.64.0.42",
      },
    });

    const stored = await execute(`SELECT token_hash FROM trusted_devices WHERE id = ?`, [enrolled.device.id]);
    expect(String(stored.rows[0]?.token_hash)).not.toContain(browserCookie.split("=")[1]);
    await expect(getAuthSession(request)).resolves.toMatchObject({
      authenticated: true,
      authenticationMethod: "trusted_device",
      trustedDevice: { id: enrolled.device.id, label: "Office computer" },
    });

    await revokeTrustedDevice(enrolled.device.id, "owner");
    await expect(getAuthSession(request)).resolves.toMatchObject({ authenticated: false });
  });

  it("prefers the trusted device when both cookies exist and revokes its linked sessions", async () => {
    const loggedIn = await login({ password: "correct horse battery staple", ipAddress: "192.0.2.10", userAgent: "Vitest" });
    const enrolled = await enrollTrustedDevice({ password: "correct horse battery staple", label: "Linked browser", ipAddress: "192.0.2.10", userAgent: "Vitest" });
    const sessionCookie = loggedIn.cookie.split(";")[0];
    const deviceCookie = enrolled.cookie.split(";")[0];
    await linkCurrentSessionToDevice(new Request("https://ezra.local", { headers: { cookie: sessionCookie } }), enrolled.device.id);
    const both = new Request("https://ezra.local", { headers: { cookie: `${sessionCookie}; ${deviceCookie}` } });
    await expect(getAuthSession(both)).resolves.toMatchObject({
      authenticationMethod: "trusted_device",
      trustedDevice: { id: enrolled.device.id },
    });

    await revokeTrustedDevice(enrolled.device.id, "owner");
    await expect(getAuthSession(both)).resolves.toMatchObject({ authenticated: false });
    const linked = await execute(`SELECT revoked_at FROM auth_sessions WHERE device_id = ?`, [enrolled.device.id]);
    expect(linked.rows[0]?.revoked_at).toBeTruthy();
  });

  it("lists redacted device context without returning its token hash", async () => {
    const enrolled = await enrollTrustedDevice({
      password: "correct horse battery staple",
      label: "Living room tablet",
      ipAddress: "192.0.2.10",
      userAgent: "Tablet browser",
    });

    const devices = await listTrustedDevices(enrolled.device.id);
    expect(devices).toEqual([
      expect.objectContaining({
        id: enrolled.device.id,
        label: "Living room tablet",
        current: true,
        lastIpAddress: "192.0.2.10",
        lastUserAgent: "Tablet browser",
        revokedAt: null,
      }),
    ]);
    expect(JSON.stringify(devices)).not.toContain("token_hash");
  });

  it("binds security challenges to one action and rejects replay", async () => {
    const created = await createAuthChallenge({
      kind: "step_up",
      action: "export_private_archive",
      deviceId: "device_test",
      challenge: "signed-browser-challenge",
    });

    await expect(consumeAuthChallenge({
      id: created.id,
      kind: "step_up",
      action: "change_owner_credentials",
      deviceId: "device_test",
    })).rejects.toMatchObject({ status: 403 });
    await expect(consumeAuthChallenge({
      id: created.id,
      kind: "step_up",
      action: "export_private_archive",
      deviceId: "device_test",
    })).resolves.toMatchObject({ challenge: "signed-browser-challenge" });
    await expect(consumeAuthChallenge({
      id: created.id,
      kind: "step_up",
      action: "export_private_archive",
      deviceId: "device_test",
    })).rejects.toMatchObject({ status: 403 });
  });

  it("rejects expired security challenges", async () => {
    const created = await createAuthChallenge({
      kind: "passkey_registration",
      action: "register_passkey",
      deviceId: "device_test",
      challenge: "expired-browser-challenge",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await expect(consumeAuthChallenge({
      id: created.id,
      kind: "passkey_registration",
      action: "register_passkey",
      deviceId: "device_test",
    })).rejects.toMatchObject({ status: 403 });
  });
});
