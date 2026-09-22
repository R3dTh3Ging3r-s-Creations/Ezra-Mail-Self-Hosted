import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureEmailDatabaseForTests, execute } from "@/lib/email/database";
import { beginPasskeyRegistration, beginStepUp } from "@/lib/email/passkeys";

describe("owner passkeys", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./passkeys-${randomUUID()}.sqlite`);
    await execute(`SELECT 1`);
  });

  afterEach(() => {
    delete process.env.EZRA_WEBAUTHN_ORIGIN;
    delete process.env.EZRA_WEBAUTHN_RP_ID;
  });

  it("binds registration options to the exact HTTPS relying party", async () => {
    const started = await beginPasskeyRegistration(new Request("https://ezra.example.invalid:8450"), { deviceId: "device_1" });
    expect(started.options.rp.id).toBe("ezra.example.invalid");
    expect(started.options.authenticatorSelection?.userVerification).toBe("required");
    const challenge = await execute(`SELECT kind, action, device_id FROM auth_challenges WHERE id = ?`, [started.challengeId]);
    expect(challenge.rows[0]).toMatchObject({ kind: "passkey_registration", action: "register_passkey", device_id: "device_1" });
  });

  it("rejects a non-HTTPS production relying party", async () => {
    await expect(beginPasskeyRegistration(new Request("http://192.0.2.10"), {})).rejects.toMatchObject({ status: 400 });
  });

  it("does not offer step-up without an enrolled passkey", async () => {
    await expect(beginStepUp(new Request("https://ezra.example.invalid:8450"), {
      action: "change_auth_policy",
      deviceId: "device_1",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("lets a synced passkey manager discover its credential for step-up", async () => {
    const createdAt = "2026-08-04T16:20:55.680Z";
    await execute(
      `INSERT INTO owner_passkeys
        (id, name, credential_id, public_key, counter, transports, device_type,
         backed_up, created_at, last_used_at)
       VALUES ('passkey_synced', 'Microsoft Password Manager', 'synced-credential', ?, 0,
         '["hybrid","internal"]', 'multiDevice', 1, ?, ?)`,
      [Buffer.from([1]), createdAt, createdAt],
    );

    const started = await beginStepUp(
      new Request("https://ezra.example.invalid:8450"),
      { action: "change_auth_policy", deviceId: "device_1" },
    );

    expect(started.options.allowCredentials).toEqual([]);
  });

  it("keeps a targeted transport hint for a device-bound security key", async () => {
    const createdAt = "2026-08-04T16:20:55.680Z";
    await execute(
      `INSERT INTO owner_passkeys
        (id, name, credential_id, public_key, counter, transports, device_type,
         backed_up, created_at, last_used_at)
       VALUES ('passkey_security_key', 'Security key', 'security-key-credential', ?, 0,
         '["usb"]', 'singleDevice', 0, ?, ?)`,
      [Buffer.from([2]), createdAt, createdAt],
    );

    const started = await beginStepUp(
      new Request("https://ezra.example.invalid:8450"),
      { action: "change_auth_policy", deviceId: "device_1" },
    );

    expect(started.options.allowCredentials).toEqual([
      { id: "security-key-credential", type: "public-key", transports: ["usb"] },
    ]);
  });
});
