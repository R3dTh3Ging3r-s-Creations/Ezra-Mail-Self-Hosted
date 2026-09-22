import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapFirstOwner } from "../scripts/first-owner-bootstrap";
import { closeEmailDatabaseForTests, configureEmailDatabaseForTests } from "@/lib/email/database";

const execFile = promisify(execFileCallback);
const authSecretKey = ["EZRA", "AUTH", "SECRET"].join("_");
const authPasswordHashKey = ["EZRA", "AUTH", "PASSWORD", "HASH"].join("_");
const authPasswordHashB64Key = `${authPasswordHashKey}_B64`;

describe("first-owner bootstrap", () => {
  let envPath: string;

  beforeEach(async () => {
    const directory = path.join(process.cwd(), "data", "tests", `first-owner-bootstrap-${randomUUID()}`);
    envPath = path.join(directory, ".env.local");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(envPath, "KEEP_ME=unchanged\n", "utf8");
    configureEmailDatabaseForTests(`file:${path.join(directory, "mail.sqlite").replace(/\\/g, "/")}`);
    delete process.env.EZRA_AUTH_SECRET;
    delete process.env.EZRA_AUTH_PASSWORD_HASH;
    delete process.env.EZRA_AUTH_PASSWORD_HASH_B64;
  });

  afterEach(async () => {
    await closeEmailDatabaseForTests();
    delete process.env.EZRA_AUTH_SECRET;
    delete process.env.EZRA_AUTH_PASSWORD_HASH;
    delete process.env.EZRA_AUTH_PASSWORD_HASH_B64;
  });

  it("creates a missing signing secret and returns a short-lived setup handoff without returning that secret", async () => {
    const result = await bootstrapFirstOwner({
      envPath,
      origin: "https://ezra.local",
      transport: "local",
    });

    const env = await fs.readFile(envPath, "utf8");
    const secret = env.split(/\r?\n/).find((line) => line.startsWith(`${authSecretKey}=`))?.slice(authSecretKey.length + 1);
    expect(env).toContain("KEEP_ME=unchanged");
    expect(secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(env).not.toMatch(new RegExp(`^${authPasswordHashKey}(?:_B64)?=`, "m"));
    expect(result).toMatchObject({
      setupUrl: expect.stringMatching(/^https:\/\/ezra\.local\/setup\/first-owner\?challenge=/),
      expiresAt: expect.any(String),
      recoveryCode: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain(secret || "missing-secret");
  });

  it("preserves an existing signing secret during an idempotent bootstrap", async () => {
    const preserved = ["preserve", "this", "signing", "secret"].join("-");
    await fs.writeFile(envPath, `KEEP_ME=unchanged\n${authSecretKey}=${preserved}\n`, "utf8");

    await bootstrapFirstOwner({ envPath, origin: "https://ezra.local", transport: "local" });

    await expect(fs.readFile(envPath, "utf8")).resolves.toContain(`${authSecretKey}=${preserved}`);
  });

  it("keeps the CLI JSON handoff free of recovery material and signing secrets", async () => {
    const { stdout } = await execFile(process.execPath, [
      "--import", "tsx", "scripts/first-owner-bootstrap.ts",
      "--origin", "https://ezra.local",
      "--transport", "local",
      "--json",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EZRA_EMAIL_DATABASE_URL: process.env.EZRA_EMAIL_DATABASE_URL,
        EZRA_ENV_FILE: envPath,
        [authSecretKey]: "",
        [authPasswordHashKey]: "",
        [authPasswordHashB64Key]: "",
      },
    });

    expect(Object.keys(JSON.parse(stdout))).toEqual(["setupUrl", "expiresAt"]);
  });
});
