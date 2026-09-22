import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webauthn = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

vi.mock("@simplewebauthn/server", () => webauthn);

import { closeEmailDatabaseForTests, configureEmailDatabaseForTests, execute } from "@/lib/email/database";
import {
  beginPasskeyRegistration,
  beginStepUp,
  consumeStepUpReceipt,
  finishPasskeyRegistration,
  finishStepUp,
} from "@/lib/email/passkeys";

const origin = "https://ezra.example.invalid:8450";
const request = new Request(origin);

describe("owner passkey verification", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    configureEmailDatabaseForTests(`file:./passkey-verification-${randomUUID()}.sqlite`);
    await execute(`SELECT 1`);
    webauthn.generateRegistrationOptions.mockResolvedValue({
      challenge: "registration-challenge",
      rp: { id: "ezra.example.invalid", name: "Ezra Mail" },
    });
    webauthn.generateAuthenticationOptions.mockResolvedValue({ challenge: "authentication-challenge" });
  });

  afterEach(async () => {
    await closeEmailDatabaseForTests();
  });

  it("binds registration verification to the exact origin and RP and rejects challenge replay", async () => {
    webauthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "credential-1",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ["internal"],
        },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });
    const started = await beginPasskeyRegistration(request, { deviceId: "device-1" });
    const response = { id: "credential-1", response: { transports: ["internal"] } } as never;

    await finishPasskeyRegistration(request, {
      challengeId: started.challengeId,
      deviceId: "device-1",
      name: "Windows Hello",
      response,
    });

    expect(webauthn.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: "registration-challenge",
      expectedOrigin: origin,
      expectedRPID: "ezra.example.invalid",
      requireUserVerification: true,
    }));
    await expect(finishPasskeyRegistration(request, {
      challengeId: started.challengeId,
      deviceId: "device-1",
      name: "Replay",
      response,
    })).rejects.toThrow(/already been used|invalid or expired/);
  });

  it("updates the authenticator counter and issues a single-use action-bound receipt", async () => {
    await execute(
      `INSERT INTO owner_passkeys
        (id, name, credential_id, public_key, counter, transports, device_type, backed_up, created_at, last_used_at)
       VALUES ('passkey-1', 'Windows Hello', 'credential-1', ?, 4, '["internal"]', 'singleDevice', 0, ?, ?)`,
      [Buffer.from([1, 2, 3]), new Date().toISOString(), new Date().toISOString()],
    );
    webauthn.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { userVerified: true, newCounter: 5 },
    });
    const started = await beginStepUp(request, { action: "change_auth_policy", deviceId: "device-1" });
    const result = await finishStepUp(request, {
      challengeId: started.challengeId,
      action: "change_auth_policy",
      deviceId: "device-1",
      response: { id: "credential-1" } as never,
    });

    expect(webauthn.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: "authentication-challenge",
      expectedOrigin: origin,
      expectedRPID: "ezra.example.invalid",
      requireUserVerification: true,
      credential: expect.objectContaining({ id: "credential-1", counter: 4 }),
    }));
    expect((await execute(`SELECT counter FROM owner_passkeys WHERE id = 'passkey-1'`)).rows[0]?.counter).toBe(5);
    await expect(consumeStepUpReceipt({
      receiptId: result.receiptId,
      action: "enroll_trusted_device",
      deviceId: "device-1",
    })).rejects.toThrow(/invalid or expired/);
    await consumeStepUpReceipt({
      receiptId: result.receiptId,
      action: "change_auth_policy",
      deviceId: "device-1",
    });
    await expect(consumeStepUpReceipt({
      receiptId: result.receiptId,
      action: "change_auth_policy",
      deviceId: "device-1",
    })).rejects.toThrow(/already been used|invalid or expired/);
  });
});
