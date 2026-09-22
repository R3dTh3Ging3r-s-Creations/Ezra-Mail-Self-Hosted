import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/setup/first-owner/route";
import { closeEmailDatabaseForTests, configureEmailDatabaseForTests, execute } from "@/lib/email/database";
import { createFirstOwnerSetup } from "@/lib/email/first-owner-setup";
import { login } from "@/lib/email/auth";

describe("first-owner setup API", () => {
  let envPath: string;
  let challenge: string;

  beforeEach(async () => {
    const directory = path.join(process.cwd(), "data", "tests", `first-owner-api-${randomUUID()}`);
    envPath = path.join(directory, ".env.local");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(envPath, "EZRA_AUTH_SECRET=test-first-owner-signing-secret-that-is-long-enough\n", "utf8");
    configureEmailDatabaseForTests(`file:${path.join(directory, "mail.sqlite").replace(/\\/g, "/")}`);
    process.env.EZRA_ENV_FILE = envPath;
    process.env.EZRA_AUTH_SECRET = "test-first-owner-signing-secret-that-is-long-enough";
    delete process.env.EZRA_AUTH_PASSWORD_HASH;
    delete process.env.EZRA_AUTH_PASSWORD_HASH_B64;
    const created = await createFirstOwnerSetup({ origin: "https://ezra.local", transport: "local" });
    challenge = new URL(created.setupUrl).searchParams.get("challenge") || "";
  });

  afterEach(async () => {
    await closeEmailDatabaseForTests();
    delete process.env.EZRA_ENV_FILE;
    delete process.env.EZRA_AUTH_SECRET;
    delete process.env.EZRA_AUTH_PASSWORD_HASH;
    delete process.env.EZRA_AUTH_PASSWORD_HASH_B64;
  });

  it("completes a valid setup exactly once with a trusted-device cookie and redacted recovery material", async () => {
    const status = await GET(new Request(`https://ezra.local/api/setup/first-owner?challenge=${challenge}`));
    await expect(status.json()).resolves.toEqual({ active: true, expiresAt: expect.any(String), passkeyAvailable: true });

    const response = await POST(new Request("https://ezra.local/api/setup/first-owner", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Vitest", "x-forwarded-for": "192.0.2.10" },
      body: JSON.stringify({
        challenge,
        ownerPassword: "a much better owner password",
        confirmPassword: "a much better owner password",
        deviceLabel: "First owner browser",
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("ezra_device=");
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      ownerCreated: true,
      device: { id: expect.any(String), label: "First owner browser" },
      recoveryKit: { code: expect.any(String), saveOnce: true },
    });
    expect(JSON.stringify(body)).not.toContain("a much better owner password");
    await expect(login({ password: "a much better owner password", ipAddress: "192.0.2.10", userAgent: "Vitest" }))
      .resolves.toMatchObject({ expiresAt: expect.any(String) });
    const replay = await POST(new Request("https://ezra.local/api/setup/first-owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge, ownerPassword: "a much better owner password", confirmPassword: "a much better owner password", deviceLabel: "First owner browser" }),
    }));
    expect(replay.status).toBe(403);
  });

  it("does not create an owner from an expired setup link", async () => {
    await execute(`UPDATE first_owner_setup SET expires_at = ?`, [new Date(Date.now() - 1_000).toISOString()]);

    const response = await POST(new Request("https://ezra.local/api/setup/first-owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge, ownerPassword: "a much better owner password", confirmPassword: "a much better owner password", deviceLabel: "First owner browser" }),
    }));

    expect(response.status).toBe(403);
    await expect(login({ password: "a much better owner password", ipAddress: "192.0.2.10", userAgent: "Vitest" }))
      .rejects.toMatchObject({ status: 503 });
  });
});
