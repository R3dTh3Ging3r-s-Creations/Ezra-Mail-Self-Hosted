import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureEmailDatabaseForTests,
  execute,
  nowIso,
} from "@/lib/email/database";
import { listAuthorizedGmailAccounts, searchGmailMessages } from "@/lib/email/gmail";
import { pollGmail, syncAuthorizedGmailAccounts } from "@/lib/email/service";

vi.mock("@/lib/email/gmail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/gmail")>();
  return {
    ...actual,
    listAuthorizedGmailAccounts: vi.fn(async () => ["owner@gmail.test"]),
    searchGmailMessages: vi.fn(async () => []),
  };
});

describe("disabled account polling safety", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./account-polling-${randomUUID()}.sqlite`);
    vi.clearAllMocks();
    const now = nowIso();
    await execute(
      `INSERT INTO email_accounts
        (id, provider, email, label, status, created_at, updated_at)
       VALUES ('acct-gmail', 'gmail', 'owner@gmail.test', 'Gmail', 'disabled', ?, ?)`,
      [now, now],
    );
  });

  it("does not poll or silently reactivate a locally disconnected Gmail account", async () => {
    expect(await listAuthorizedGmailAccounts()).toEqual(["owner@gmail.test"]);
    await expect(pollGmail()).resolves.toMatchObject({ accounts: 0, gmailAccounts: 0 });
    expect(searchGmailMessages).not.toHaveBeenCalled();

    await expect(syncAuthorizedGmailAccounts()).resolves.toEqual({ accounts: 0 });
    const account = await execute(`SELECT status FROM email_accounts WHERE id = 'acct-gmail'`);
    expect(account.rows[0].status).toBe("disabled");
  });
});
