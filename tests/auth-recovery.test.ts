import { enrollNotificationDevice, createNotificationEvent, enqueueNotificationDeliveries } from "@/lib/email/notification-store";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordOwnerRecoveryStartup, recoverOwnerAccess } from "@/lib/email/auth-recovery";
import { closeEmailDatabaseForTests, configureEmailDatabaseForTests, execute, setSetting } from "@/lib/email/database";

describe("owner access recovery", () => {
  let directory: string;
  let envPath: string;
  let databaseUrl: string;

  beforeEach(async () => {
    vi.stubEnv("APP_BASE_URL", "https://ezra.example.test"); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "");
    vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "true");
    directory = path.join(process.cwd(), "data", "tests", `auth-recovery-${randomUUID()}`);
    envPath = path.join(directory, ".env.local");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(envPath, "KEEP_ME=unchanged\nEZRA_AUTH_SECRET=old-secret\n", "utf8");
    databaseUrl = `file:${path.join(directory, "mail.sqlite").replace(/\\/g, "/")}`;
    configureEmailDatabaseForTests(databaseUrl);
    await execute(`SELECT 1`);
    await execute(`INSERT INTO auth_sessions (id, token_hash, created_at, last_seen_at, expires_at) VALUES ('s1', 'h1', ?, ?, ?)`, [new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 10000).toISOString()]);
    await execute(`INSERT INTO trusted_devices (id, label, token_hash, created_at, last_used_at) VALUES ('d1', 'Browser', 'h2', ?, ?)`, [new Date().toISOString(), new Date().toISOString()]);
    await execute(`INSERT INTO auth_login_attempts (id, ip_address, succeeded, created_at) VALUES ('l1', 'local', 0, ?)`, [new Date().toISOString()]);
    await setSetting("auth_bypass_disabled", "true");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeEmailDatabaseForTests();
  });

  it("immediately scrubs notification secrets and pending work during owner recovery", async () => {
    const device = await enrollNotificationDevice({ expectedSetupEpoch: 0, trustedDeviceId: "d1", origin: "https://ezra.example.test", channel: "browser", platform: "windows", permission: "granted", capabilities: { foreground: true, push: false } });
    await execute("UPDATE notification_devices SET subscription_ciphertext='synthetic-envelope',subscription_fingerprint='synthetic-fingerprint',push=1 WHERE id=?", [device.id]);
    const event = await createNotificationEvent({ sourceKey: "synthetic-recovery", kind: "interrupt", target: "/?view=today", replacementTag: "synthetic-recovery", reasonCode: "attention", expiresAt: new Date(Date.now() + 60000).toISOString() });
    await enqueueNotificationDeliveries({ eventId: event.id });
    await recoverOwnerAccess({ envPath, newPassword: "synthetic recovery password" });
    const stored = (await execute("SELECT * FROM notification_devices WHERE id=?", [device.id])).rows[0];
    expect(stored.subscription_ciphertext).toBeNull(); expect(stored.subscription_fingerprint).toBeNull(); expect(stored.revoked_at).toBeTruthy();
    expect((await execute("SELECT state FROM notification_deliveries WHERE device_id=?", [device.id])).rows[0].state).toBe("cancelled");
  });

  it("rotates owner secrets, preserves unrelated configuration, and revokes access", async () => {
    await recoverOwnerAccess({ envPath, newPassword: "a much better owner password" });
    const env = await fs.readFile(envPath, "utf8");
    expect(env).toContain("KEEP_ME=unchanged");
    expect(env).toContain("EZRA_AUTH_PASSWORD_HASH_B64=");
    expect(env).not.toContain("a much better owner password");
    expect(env).not.toContain("old-secret");
    expect((await execute(`SELECT COUNT(*) AS count FROM auth_sessions WHERE revoked_at IS NULL`)).rows[0]?.count).toBe(0);
    expect((await execute(`SELECT COUNT(*) AS count FROM trusted_devices WHERE revoked_at IS NULL`)).rows[0]?.count).toBe(0);
    expect((await execute(`SELECT COUNT(*) AS count FROM auth_login_attempts`)).rows[0]?.count).toBe(0);
    expect((await execute(`SELECT value FROM settings WHERE key = 'auth_bypass_disabled'`)).rows[0]?.value).toBe("true");
    expect((await execute(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'auth.recovery.completed'`)).rows[0]?.count).toBe(0);
    await closeEmailDatabaseForTests();
    configureEmailDatabaseForTests(databaseUrl);
    await expect(recordOwnerRecoveryStartup("web")).resolves.toMatchObject({ pending: true, completed: false });
    expect((await execute(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'auth.recovery.completed'`)).rows[0]?.count).toBe(0);
    const secretLine = env.split(/\r?\n/).find((line) => line.startsWith("EZRA_AUTH_SECRET="));
    const previousSecret = process.env.EZRA_AUTH_SECRET;
    process.env.EZRA_AUTH_SECRET = secretLine?.slice("EZRA_AUTH_SECRET=".length);
    await expect(recordOwnerRecoveryStartup("web")).resolves.toMatchObject({ pending: true, completed: false });
    await expect(recordOwnerRecoveryStartup("worker")).resolves.toMatchObject({ pending: false, completed: true });
    await expect(recordOwnerRecoveryStartup("worker")).resolves.toMatchObject({ pending: false, completed: false });
    if (previousSecret === undefined) delete process.env.EZRA_AUTH_SECRET;
    else process.env.EZRA_AUTH_SECRET = previousSecret;
    const audit = await execute(`SELECT metadata FROM audit_logs WHERE action = 'auth.recovery.completed'`);
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain("a much better owner password");
  });

  it("requires the first-owner recovery code before using the normal local recovery path", async () => {
    const recoveryCode = "first-owner-recovery-code";
    await execute(
      `INSERT INTO first_owner_setup
        (id, challenge_hash, recovery_code_hash, origin, transport, created_at, expires_at, used_at)
       VALUES ('first-owner', 'challenge-hash', ?, 'https://ezra.local', 'local', ?, ?, ?)`,
      [
        crypto.createHash("sha256").update(recoveryCode).digest("hex"),
        new Date().toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
        new Date().toISOString(),
      ],
    );
    await setSetting("first_owner_recovery_code_required", "true");

    await expect(recoverOwnerAccess({ envPath, newPassword: "a much better owner password" }))
      .rejects.toThrow(/recovery code/i);
    await expect(recoverOwnerAccess({
      envPath,
      newPassword: "a much better owner password",
      recoveryCode,
    })).resolves.toMatchObject({ completedAt: expect.any(String) });
  });
});
