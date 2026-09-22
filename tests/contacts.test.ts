import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createNewEmailDraft } from "@/lib/email/composition";
import { getContactSuggestions, upsertManualContact } from "@/lib/email/contacts";
import { configureEmailDatabaseForTests, execute, nowIso } from "@/lib/email/database";

describe("account-scoped contact suggestions", () => {
  beforeEach(() => {
    configureEmailDatabaseForTests(`file:./contacts-${randomUUID()}.sqlite`);
  });

  it("builds Gmail suggestions from senders and prior draft recipients without leaking Hotmail contacts", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await seedMessage("gmail-target", "acct-gmail", "Jennifer Ortiz", "jennifer.ortiz@target.test", "2026-07-03T12:00:00.000Z");
    await seedMessage("hotmail-target", "acct-hotmail", "Hotmail Recruiter", "recruiter@company.test", "2026-07-03T13:00:00.000Z");
    await createNewEmailDraft({
      accountId: "acct-gmail",
      to: [{ name: "Mentor", email: "mentor@example.test" }],
      cc: [],
      bcc: [],
      subject: "Draft",
      body: "Body",
    });

    const gmailSender = await getContactSuggestions({ workspaceId: "workspace:gmail", q: "target" });
    expect(gmailSender.items).toHaveLength(1);
    expect(gmailSender.items[0]).toMatchObject({
      accountId: "acct-gmail",
      accountProvider: "gmail",
      email: "jennifer.ortiz@target.test",
      source: "sender",
    });

    const gmailRecipient = await getContactSuggestions({ workspaceId: "workspace:gmail", q: "mentor" });
    expect(gmailRecipient.items[0]).toMatchObject({
      accountId: "acct-gmail",
      email: "mentor@example.test",
      source: "recipient",
    });

    const hotmailSearch = await getContactSuggestions({ workspaceId: "workspace:microsoft", q: "target" });
    expect(hotmailSearch.items).toEqual([]);
  });

  it("keeps the same email separate by account and narrows All accounts by selected sending account", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await seedMessage("gmail-alex", "acct-gmail", "Alex Gmail", "alex@example.test", "2026-07-03T12:00:00.000Z");
    await seedMessage("hotmail-alex", "acct-hotmail", "Alex Hotmail", "alex@example.test", "2026-07-03T13:00:00.000Z");

    const all = await getContactSuggestions({ workspaceId: "workspace:all", q: "alex" });
    expect(all.items.map((item) => item.accountId).sort()).toEqual(["acct-gmail", "acct-hotmail"]);

    const selectedGmail = await getContactSuggestions({ workspaceId: "workspace:all", accountId: "acct-gmail", q: "alex" });
    expect(selectedGmail.items).toHaveLength(1);
    expect(selectedGmail.items[0]).toMatchObject({
      accountId: "acct-gmail",
      accountLabel: "Gmail",
      name: "Alex Gmail",
    });
  });

  it("returns user-approved manual contacts ahead of derived contacts", async () => {
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await seedMessage("hotmail-manual", "acct-hotmail", "Generic Person", "pat@example.test", "2026-07-03T12:00:00.000Z");
    await upsertManualContact({
      accountId: "acct-hotmail",
      email: "pat@example.test",
      name: "Pat Professional",
    });

    const page = await getContactSuggestions({ workspaceId: "workspace:microsoft", q: "pat" });
    expect(page.items[0]).toMatchObject({
      accountId: "acct-hotmail",
      email: "pat@example.test",
      name: "Pat Professional",
      source: "mixed",
    });
    expect(page.items[0].relationship).toMatch(/mail and drafts|touch/);
  });
});

async function seedAccount(id: string, provider: "gmail" | "microsoft", email: string, label: string) {
  const now = nowIso();
  await execute(
    `INSERT INTO email_accounts
      (id, provider, email, label, status, last_sync_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'connected', ?, ?, ?)`,
    [id, provider, email, label, now, now, now],
  );
}

async function seedMessage(id: string, accountId: string, senderName: string, senderEmail: string, receivedAt: string) {
  const now = nowIso();
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, sender_name, sender_email,
       subject, received_at, snippet, gmail_url, has_attachments, gmail_labels,
       is_unread, ingest_source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '#', 0, '["INBOX"]', 1, 'live', 'triaged', ?, ?)`,
    [
      id,
      accountId,
      `external-${id}`,
      `thread-${id}`,
      senderName,
      senderEmail,
      "Contact test",
      receivedAt,
      "Hello",
      now,
      now,
    ],
  );
}
