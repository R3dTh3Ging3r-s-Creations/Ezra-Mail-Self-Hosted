import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeEmailDatabaseForTests, configureEmailDatabaseForTests, execute } from "@/lib/email/database";
import { authIsConfigured } from "@/lib/email/auth";
import { cancelFirstOwnerSetup, completeFirstOwnerSetup, createFirstOwnerSetup, inspectFirstOwnerSetup } from "@/lib/email/first-owner-setup";

describe("first-owner setup", () => {
  beforeEach(() => {
    configureEmailDatabaseForTests(`file:./first-owner-setup-${randomUUID()}.sqlite`);
    delete process.env.EZRA_AUTH_SECRET;
    delete process.env.EZRA_AUTH_PASSWORD_HASH;
    delete process.env.EZRA_AUTH_PASSWORD_HASH_B64;
  });

  afterEach(async () => {
    await closeEmailDatabaseForTests();
  });

  it("stores only hashes for a short-lived one-time setup link", async () => {
    const created = await createFirstOwnerSetup({ origin: "https://ezra.local", transport: "local" });

    expect(created.setupUrl).toMatch(/^https:\/\/ezra\.local\/setup\/first-owner\?challenge=/);
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const rows = await execute(
      `SELECT challenge_hash, recovery_code_hash, transport, used_at, cancelled_at FROM first_owner_setup`,
    );
    expect(rows.rows).toEqual([{
      challenge_hash: expect.any(String),
      recovery_code_hash: expect.any(String),
      transport: "local",
      used_at: null,
      cancelled_at: null,
    }]);
    expect(JSON.stringify(rows.rows)).not.toContain(created.setupUrl.split("challenge=")[1]);
    expect(JSON.stringify(rows.rows)).not.toContain(created.recoveryCode);
  });

  it("shows and then cancels the active setup without retaining its raw challenge", async () => {
    await createFirstOwnerSetup({ origin: "https://ezra.local", transport: "tailscale" });

    await expect(inspectFirstOwnerSetup()).resolves.toEqual({
      active: true,
      expiresAt: expect.any(String),
      transport: "tailscale",
    });
    await expect(cancelFirstOwnerSetup("installer interrupted")).resolves.toEqual({ cancelled: true });
    await expect(inspectFirstOwnerSetup()).resolves.toEqual({ active: false, expiresAt: null, transport: null });
    await expect(execute(`SELECT cancellation_reason FROM first_owner_setup`))
      .resolves.toEqual(expect.objectContaining({ rows: [{ cancellation_reason: "installer_interrupted" }] }));
  });

  it("refuses to replace an existing owner or issue a second active setup link", async () => {
    await createFirstOwnerSetup({ origin: "https://ezra.local", transport: "local" });
    await expect(createFirstOwnerSetup({ origin: "https://ezra.local", transport: "local" }))
      .rejects.toThrow(/already active/i);

    await cancelFirstOwnerSetup("restart");
    process.env.EZRA_AUTH_SECRET = "test-secret-that-is-long-and-random-enough";
    process.env.EZRA_AUTH_PASSWORD_HASH = "scrypt$16384$8$1$salt$hash";
    await expect(createFirstOwnerSetup({ origin: "https://ezra.local", transport: "local" }))
      .rejects.toThrow(/already has an owner/i);
  });

  it("requires private HTTPS for a remote first-owner handoff", async () => {
    const tailnetHost = ["owner", "tailnet", "ts", "net"].join(".");
    await expect(createFirstOwnerSetup({ origin: "http://192.0.2.10", transport: "lan" }))
      .rejects.toThrow(/private HTTPS/i);
    await expect(createFirstOwnerSetup({ origin: `https://${tailnetHost}`, transport: "tailscale" }))
      .resolves.toMatchObject({ setupUrl: expect.stringContaining(`https://${tailnetHost}/setup/first-owner`) });
  });

  it("rolls back a failed device enrollment without consuming the setup link", async () => {
    process.env.EZRA_AUTH_SECRET = "test-secret-that-is-long-and-random-enough";
    const created = await createFirstOwnerSetup({ origin: "https://ezra.local", transport: "local" });
    const challenge = new URL(created.setupUrl).searchParams.get("challenge")!;
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-first-owner-rollback-"));
    const envPath = path.join(tempDirectory, ".env.local");

    await expect(completeFirstOwnerSetup({
      challenge,
      ownerPassword: "a-long-enough-owner-password",
      deviceLabel: "",
      ipAddress: "127.0.0.1",
      userAgent: "Vitest",
      envPath,
    })).rejects.toThrow(/device a name/i);

    expect(authIsConfigured()).toBe(false);
    await expect(inspectFirstOwnerSetup()).resolves.toMatchObject({ active: true });
    await expect(execute(`SELECT id FROM trusted_devices`)).resolves.toMatchObject({ rows: [] });
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });
});
