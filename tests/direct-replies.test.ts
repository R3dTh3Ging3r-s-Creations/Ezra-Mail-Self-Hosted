import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createReplyOutgoingDraftFromMessage } from "@/lib/email/composition";
import {
  closeEmailDatabaseForTests,
  configureEmailDatabaseForTests,
  ensureEmailDatabase,
  execute,
  nowIso,
} from "@/lib/email/database";
import { resolveReplyRecipients } from "@/lib/email/reply-recipients";

describe("v0.7.1 direct replies", () => {
  let databaseUrl: string;
  let rootDatabasePath: string;

  beforeEach(() => {
    const filename = `direct-replies-${randomUUID()}.sqlite`;
    rootDatabasePath = path.join(process.cwd(), filename);
    databaseUrl = configureEmailDatabaseForTests(`file:./${filename}`);
  });

  it("resolves Reply-To and Reply all without self, duplicates, or Bcc", () => {
    const recipients = resolveReplyRecipients({
      from: { name: "Sender", email: "sender@example.test" },
      replyTo: [{ name: "Team", email: "team@example.test" }],
      to: [
        { email: "owner@example.test" },
        { email: "colleague@example.test" },
        { email: "TEAM@example.test" },
      ],
      cc: [{ email: "copy@example.test" }, { email: "colleague@example.test" }],
      subject: "Status",
    }, "owner@example.test", "all");

    expect(recipients).toEqual({
      to: [{ name: "Team", email: "team@example.test" }],
      cc: [
        { name: null, email: "colleague@example.test" },
        { name: null, email: "copy@example.test" },
      ],
      bcc: [],
    });
  });

  it("stores Reply and Reply all as distinct exact-review Outbox drafts", async () => {
    await seedMicrosoftMessage();
    const reply = await createReplyOutgoingDraftFromMessage({ messageId: "message-1", replyMode: "sender", body: "Thanks." });
    const replyAll = await createReplyOutgoingDraftFromMessage({ messageId: "message-1", replyMode: "all", body: "Thanks." });

    expect(reply).toMatchObject({ sourceType: "reply", replyMode: "sender", accountProvider: "microsoft", status: "draft" });
    expect(replyAll).toMatchObject({ sourceType: "reply", replyMode: "all", accountProvider: "microsoft", status: "draft" });
    expect(reply.contentHash).not.toBe(replyAll.contentHash);
    expect(reply.sendDisabledReason).toContain("Microsoft Mail.Send access");
  });

  it("migrates each active legacy Hotmail reply once while retaining the legacy row", async () => {
    await seedMicrosoftMessage();
    const now = nowIso();
    await execute(
      `INSERT INTO reply_drafts (id, message_id, content, content_hash, version, status, created_at, updated_at)
       VALUES ('legacy-reply-1', 'message-1', 'Preserve this exact text.', 'legacy-hash', 3, 'draft', ?, ?)`,
      [now, now],
    );

    await closeEmailDatabaseForTests();
    configureEmailDatabaseForTests(databaseUrl);
    await ensureEmailDatabase();
    await closeEmailDatabaseForTests();
    configureEmailDatabaseForTests(databaseUrl);
    await ensureEmailDatabase();

    const migrated = await execute(`SELECT * FROM outgoing_drafts WHERE legacy_reply_draft_id = 'legacy-reply-1'`);
    const legacy = await execute(`SELECT status, content FROM reply_drafts WHERE id = 'legacy-reply-1'`);
    expect(migrated.rows).toHaveLength(1);
    expect(migrated.rows[0]).toMatchObject({ source_type: "reply", reply_mode: "sender", version: 3, status: "draft" });
    expect(String(migrated.rows[0].body)).toBe("Preserve this exact text.");
    expect(legacy.rows[0]).toMatchObject({ status: "draft", content: "Preserve this exact text." });
  });

  it("upgrades a v0.7.0 outgoing table before creating indexes on new columns", async () => {
    const legacyClient = createClient({ url: databaseUrl });
    await legacyClient.execute(`CREATE TABLE outgoing_drafts (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_message_id TEXT,
      account_id TEXT NOT NULL,
      from_email TEXT NOT NULL,
      to_recipients TEXT NOT NULL DEFAULT '[]',
      cc_recipients TEXT NOT NULL DEFAULT '[]',
      bcc_recipients TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      approval_snapshot TEXT,
      provider_message_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    legacyClient.close();

    await ensureEmailDatabase();
    const columns = await execute(`PRAGMA table_info(outgoing_drafts)`);
    const names = columns.rows.map((row) => String(row.name));
    expect(names).toEqual(expect.arrayContaining(["reply_mode", "legacy_reply_draft_id", "provider_draft_id"]));
    const indexes = await execute(`PRAGMA index_list(outgoing_drafts)`);
    expect(indexes.rows.some((row) => row.name === "idx_outgoing_drafts_legacy_reply")).toBe(true);
    expect(databaseUrl.replace(/\\/g, "/")).toMatch(/\/data\/tests\/direct-replies-[0-9a-f-]+\.sqlite$/);
    await expect(fs.stat(rootDatabasePath)).rejects.toThrow();
  });
});

async function seedMicrosoftMessage() {
  const now = nowIso();
  await execute(
    `INSERT INTO email_accounts (id, provider, email, label, status, last_sync_at, created_at, updated_at)
     VALUES ('account-1', 'microsoft', 'owner@hotmail.test', 'Hotmail', 'connected', ?, ?, ?)`,
    [now, now, now],
  );
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
       received_at, snippet, gmail_url, has_attachments, gmail_labels, is_unread,
       ingest_source, status, created_at, updated_at)
     VALUES ('message-1', 'account-1', 'provider-message-1', 'thread-1', 'Taylor',
       'taylor@example.test', 'Status', ?, 'Please reply.', '#', 0, '["INBOX"]', 1,
       'live', 'triaged', ?, ?)`,
    [now, now, now],
  );
}
