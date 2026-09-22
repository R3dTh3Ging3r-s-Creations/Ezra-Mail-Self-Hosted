import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { configureEmailDatabaseForTests, ensureEmailDatabase, execute, nowIso } from "@/lib/email/database";
import {
  getWritingSettings,
  setRemoteImagesForSender,
  updateWritingSettings,
} from "@/lib/email/writing-settings";

describe("account writing settings", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:writing-${crypto.randomUUID()}.sqlite`);
    await ensureEmailDatabase();
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-a', 'gmail', 'a@example.test', 'A', 'connected', ?, ?),
              ('acct-b', 'microsoft', 'b@example.test', 'B', 'connected', ?, ?)`,
      [now, now, now, now],
    );
  });

  it("returns calm defaults without creating a row", async () => {
    await expect(getWritingSettings("acct-a")).resolves.toMatchObject({
      accountId: "acct-a",
      signature: "",
      signatureEnabled: false,
      defaultTone: "professional",
      preferredLength: "balanced",
    });
  });

  it("updates one account without leaking preferences to another", async () => {
    await updateWritingSettings({
      accountId: "acct-a",
      signature: "Eric\nEzra Mail",
      signatureEnabled: true,
      defaultTone: "warmer",
      preferredLength: "brief",
    });

    expect(await getWritingSettings("acct-a")).toMatchObject({ signatureEnabled: true, defaultTone: "warmer" });
    expect(await getWritingSettings("acct-b")).toMatchObject({ signatureEnabled: false, defaultTone: "professional" });
  });

  it("normalizes sender addresses for account-scoped image permission", async () => {
    await setRemoteImagesForSender("acct-a", " Sender@Example.COM ", true);

    expect((await getWritingSettings("acct-a", "sender@example.com")).remoteImagesAllowed).toBe(true);
    expect((await getWritingSettings("acct-b", "sender@example.com")).remoteImagesAllowed).toBe(false);
  });

  it("rejects unknown accounts", async () => {
    await expect(updateWritingSettings({ accountId: "missing", signature: "" })).rejects.toThrow(/account/i);
  });
});
