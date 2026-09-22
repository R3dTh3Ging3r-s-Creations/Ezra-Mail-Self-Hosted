import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";

vi.mock("@libsql/client", async importOriginal => {
  const actual = await importOriginal<typeof import("@libsql/client")>();
  return { ...actual, createClient: vi.fn(actual.createClient) };
});
import { configureEmailDatabaseForTests, EMAIL_SCHEMA_VERSION, ensureEmailDatabase, execute, getEmailClient, getEmailDatabasePath } from "@/lib/email/database";
import { reconcileBriefMemory } from "@/lib/email/brief-memory";

describe("SQLite runtime configuration", () => {
  it("places relative test databases under the private data/tests subtree", () => {
    configureEmailDatabaseForTests(`file:./database-runtime-${randomUUID()}.sqlite`);

    expect(getEmailDatabasePath()?.replace(/\\/g, "/")).toMatch(/\/data\/tests\/database-runtime-[0-9a-f-]+\.sqlite$/);
  });

  it("uses WAL mode so web reads and worker writes can overlap", async () => {
    configureEmailDatabaseForTests(`file:./database-runtime-${randomUUID()}.sqlite`);

    const result = await execute(`PRAGMA journal_mode`);

    expect(String(result.rows[0]?.journal_mode).toLowerCase()).toBe("wal");
  });

  it("persists provider-confirmed Pin and Flag state with each message", async () => {
    configureEmailDatabaseForTests(`file:./database-runtime-${randomUUID()}.sqlite`);

    const result = await execute(`PRAGMA table_info(email_messages)`);
    const columns = new Set(result.rows.map((row) => String(row.name)));

    expect(columns.has("is_pinned")).toBe(true);
    expect(columns.has("is_flagged")).toBe(true);
    expect(columns.has("organization_confirmed_at")).toBe(true);
  });

  it("creates the workspace-safe current-state briefing memory table", async () => {
    configureEmailDatabaseForTests(`file:./database-runtime-${randomUUID()}.sqlite`);

    const result = await execute(`PRAGMA table_info(brief_item_memory)`);
    const columns = new Set(result.rows.map((row) => String(row.name)));

    expect(columns.has("workspace_id")).toBe(true);
    expect(columns.has("source_key")).toBe(true);
    expect(columns.has("source_revision_at")).toBe(true);
    expect(columns.has("completion_evidence_json")).toBe(true);
    const indexes = await execute(`PRAGMA index_list(brief_item_memory)`);
    const unique = indexes.rows.find((row) => Number(row.unique) === 1);
    const indexColumns = await execute(`PRAGMA index_info(${String(unique?.name)})`);
    expect(indexColumns.rows.map((row) => String(row.name))).toEqual(["workspace_id", "source_key"]);
  });

  it("creates append-only reply evidence and per-account provider health with enforced keys", async () => {
    configureEmailDatabaseForTests(`file:./database-runtime-${randomUUID()}.sqlite`);

    const evidence = await execute(`PRAGMA table_info(reply_completion_evidence)`);
    expect(evidence.rows.map((row) => String(row.name))).toEqual([
      "id", "brief_item_id", "source_key", "account_id", "provider", "provider_message_id",
      "provider_thread_id", "provider_sent_at", "observed_at", "created_at",
    ]);
    const evidenceIndexes = await execute(`PRAGMA index_list(reply_completion_evidence)`);
    const evidenceUnique = evidenceIndexes.rows.find((row) => Number(row.unique) === 1);
    expect(evidenceUnique).toBeTruthy();
    expect((await execute(`PRAGMA index_info(${String(evidenceUnique?.name)})`)).rows.map((row) => String(row.name))).toEqual(["account_id", "provider", "provider_message_id"]);
    expect((await execute(`PRAGMA foreign_key_list(reply_completion_evidence)`)).rows.map((row) => String(row.table)).sort()).toEqual(["brief_item_memory", "email_accounts"]);

    const sync = await execute(`PRAGMA table_info(sent_evidence_sync_state)`);
    expect(sync.rows.map((row) => String(row.name))).toEqual([
      "account_id", "provider", "status", "last_attempted_at", "last_successful_at", "last_error_code",
      "truncated", "created_at", "updated_at",
    ]);
    expect(sync.rows.filter((row) => Number(row.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((row) => String(row.name))).toEqual(["account_id", "provider"]);
    expect((await execute(`PRAGMA foreign_key_list(sent_evidence_sync_state)`)).rows.map((row) => String(row.table))).toEqual(["email_accounts"]);
    await execute(`INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at) VALUES ('schema-account', 'gmail', 'schema@example.test', 'Schema', 'connected', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')`);
    await expect(execute(`INSERT INTO sent_evidence_sync_state (account_id, provider, status, last_attempted_at, truncated, created_at, updated_at) VALUES ('schema-account', 'gmail', 'stale', '2026-08-30T00:00:00.000Z', 0, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')`)).rejects.toThrow();
  });

  it("migrates v3 with unique proof associations, foreign keys, item lookup and nullable calendar dates", async () => {
    configureEmailDatabaseForTests(`file:./database-runtime-${randomUUID()}.sqlite`);
    expect((await execute("PRAGMA user_version")).rows[0].user_version).toBe(EMAIL_SCHEMA_VERSION);
    const links = (await execute("PRAGMA table_info(reply_completion_evidence_links)")).rows;
    expect(links.map((row) => row.name)).toEqual(["id", "evidence_id", "brief_item_id", "source_revision_at", "created_at"]);
    expect((await execute("PRAGMA foreign_key_list(reply_completion_evidence_links)")).rows.map((row) => row.table).sort()).toEqual(["brief_item_memory", "reply_completion_evidence"]);
    const indexes = (await execute("PRAGMA index_list(reply_completion_evidence_links)")).rows;
    expect(await Promise.all(indexes.filter((row) => row.unique).map(async (row) => (await execute(`PRAGMA index_info(${row.name})`)).rows.map((column) => column.name)))).toContainEqual(["evidence_id", "brief_item_id"]);
    expect((await execute("PRAGMA index_info(idx_reply_completion_evidence_links_item)")).rows.map((row) => row.name)).toEqual(["brief_item_id", "created_at"]);
    const dates = (await execute("PRAGMA table_info(calendar_events)")).rows.filter((row) => ["start_date", "end_date"].includes(String(row.name)));
    expect(dates.map((row) => ({ name: row.name, nullable: !row.notnull }))).toEqual([{ name: "start_date", nullable: true }, { name: "end_date", nullable: true }]);
  });

  it("backfills only valid legacy proof, leaves version 2 on failure and safely retries initialization", async () => {
    const url = configureEmailDatabaseForTests(`file:./database-runtime-${randomUUID()}.sqlite`);
    await execute("INSERT INTO email_accounts (id, provider, email, label, status, created_at, updated_at) VALUES ('legacy', 'gmail', 'legacy@example.test', 'Legacy', 'connected', '2026-08-30', '2026-08-30')");
    const item = (await reconcileBriefMemory({ workspaceId: "workspace:all", candidates: [{ sourceType: "mail_thread", sourceKey: "mail:legacy:thread", sourceAccountId: "legacy", provider: "gmail", providerThreadId: "thread", revisionAt: "2026-08-30T12:00:00.000Z", occurredAt: "2026-08-30T12:00:00.000Z", role: "attention", title: "Reply", summary: "", target: { view: "mail", messageId: "message" } }] })).current[0];
    for (const [id, sourceKey, sentAt] of [["valid", item.sourceKey, "2026-08-30T13:00:00.000Z"], ["wrong-source", "other-source", "2026-08-30T13:00:00.000Z"], ["old", item.sourceKey, "2026-08-30T11:00:00.000Z"], ["malformed", item.sourceKey, "not-a-date"]]) {
      await execute("INSERT INTO reply_completion_evidence VALUES (?, ?, ?, 'legacy', 'gmail', ?, 'thread', ?, '2026-08-30T14:00:00.000Z', '2026-08-30T14:00:00.000Z')", [id, item.id, sourceKey, id, sentAt]);
    }
    await execute("PRAGMA user_version = 2");
    await execute("ALTER TABLE calendar_events DROP COLUMN start_date");
    await execute("ALTER TABLE calendar_events DROP COLUMN end_date");
    await execute("CREATE TABLE IF NOT EXISTS reply_completion_evidence_links (id TEXT PRIMARY KEY, evidence_id TEXT NOT NULL, brief_item_id TEXT NOT NULL, source_revision_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(evidence_id, brief_item_id), FOREIGN KEY(evidence_id) REFERENCES reply_completion_evidence(id), FOREIGN KEY(brief_item_id) REFERENCES brief_item_memory(id))");
    await execute("CREATE TRIGGER fail_backfill BEFORE INSERT ON reply_completion_evidence_links BEGIN SELECT RAISE(ABORT, 'backfill interrupted'); END");
    configureEmailDatabaseForTests(url);
    await expect(ensureEmailDatabase()).rejects.toThrow("backfill interrupted");
    expect((await getEmailClient().execute("PRAGMA user_version")).rows[0].user_version).toBe(2);
    expect((await getEmailClient().execute("PRAGMA table_info(calendar_events)")).rows.map((row) => row.name)).not.toContain("start_date");
    await getEmailClient().execute("DROP TRIGGER fail_backfill");
    await ensureEmailDatabase();
    expect((await execute("PRAGMA user_version")).rows[0].user_version).toBe(EMAIL_SCHEMA_VERSION);
    const links = (await execute("SELECT * FROM reply_completion_evidence_links")).rows;
    expect(links).toEqual([expect.objectContaining({ evidence_id: "valid", brief_item_id: item.id, source_revision_at: item.revisionAt, created_at: "2026-08-30T14:00:00.000Z" })]);
    configureEmailDatabaseForTests(url);
    expect((await execute("SELECT * FROM reply_completion_evidence_links")).rows).toEqual(links);
    expect((await execute("SELECT COUNT(*) AS n FROM reply_completion_evidence")).rows[0].n).toBe(4);
  });

  it("creates durable notification decisions with unique message ids and a timestamp index", async () => {
    configureEmailDatabaseForTests(`file:./database-runtime-${randomUUID()}.sqlite`);

    const columns = await execute(`PRAGMA table_info(notification_decisions)`);
    expect(columns.rows.map((row) => String(row.name))).toEqual([
      "sequence", "id", "message_id", "reason", "decided_at",
    ]);
    expect(columns.rows[0]).toMatchObject({ pk: 1, type: "INTEGER" });
    await expect(execute(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_decisions'`,
    )).resolves.toMatchObject({
      rows: [expect.objectContaining({ sql: expect.stringMatching(/sequence\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i) })],
    });
    const uniqueIndexes = (await execute(`PRAGMA index_list(notification_decisions)`)).rows
      .filter((row) => Number(row.unique) === 1);
    expect(await Promise.all(uniqueIndexes.map(async (index) => (
      (await execute(`PRAGMA index_info(${String(index.name)})`)).rows.map((row) => String(row.name))
    )))).toEqual(expect.arrayContaining([["id"], ["message_id"]]));
    expect((await execute(`PRAGMA foreign_key_list(notification_decisions)`)).rows).toEqual([
      expect.objectContaining({ table: "email_messages", from: "message_id", to: "id" }),
    ]);
    const indexes = await execute(`PRAGMA index_list(notification_decisions)`);
    const timestampIndex = indexes.rows.find((row) => String(row.name) === "idx_notification_decisions_decided");
    expect(timestampIndex).toBeTruthy();
    expect((await execute(`PRAGMA index_xinfo(idx_notification_decisions_decided)`)).rows[0]).toMatchObject({ name: "decided_at", desc: 1 });
  });
});

describe("initialization connection recovery", () => {
  function observeClients(fail: (client: Client) => Error | undefined) {
    const factory = vi.mocked(createClient).getMockImplementation()!;
    const clients: Client[] = [];
    vi.mocked(createClient).mockImplementation(config => {
      const client = factory(config);
      clients.push(client);
      const batch = client.batch.bind(client);
      vi.spyOn(client, "batch").mockImplementation((...args) => {
        const failure = fail(client);
        return failure ? Promise.reject(failure) : batch(...args);
      });
      return client;
    });
    return { clients, restore: () => { vi.mocked(createClient).mockImplementation(factory); for (const client of clients) client.close(); vi.restoreAllMocks(); } };
  }

  it("replaces a poisoned initialization connection while preserving runtime identity and concurrent callers", async () => {
    configureEmailDatabaseForTests(`file:./database-recovery-${randomUUID()}.sqlite`);
    let poisoned: Client | undefined;
    const observed = observeClients(client => {
      poisoned ??= client;
      return client === poisoned ? new Error("SQLITE_BUSY: cannot commit transaction - SQL statements in progress") : undefined;
    });
    try {
      const runtime = getEmailClient();
      await Promise.all([ensureEmailDatabase(), ensureEmailDatabase()]);
      expect(poisoned).not.toBe(runtime);
      expect(poisoned!.closed).toBe(true);
      expect(poisoned!.batch).toHaveBeenCalledTimes(1);
      expect(observed.clients).toHaveLength(3);
      expect(observed.clients.filter(client => client !== runtime).every(client => client.closed)).toBe(true);
      expect(getEmailClient()).toBe(runtime);
      expect(runtime.closed).toBe(false);
      expect((await runtime.execute("PRAGMA user_version")).rows[0].user_version).toBe(EMAIL_SCHEMA_VERSION);
      expect((await runtime.execute("PRAGMA busy_timeout")).rows[0].timeout).toBe(10000);
      expect((await runtime.execute("PRAGMA foreign_keys")).rows[0].foreign_keys).toBe(1);
      expect((await runtime.execute("PRAGMA journal_mode")).rows[0].journal_mode).toBe("wal");
      expect((await runtime.execute("SELECT value FROM settings WHERE key='poll_minutes'")).rows[0].value).toBe("5");
    } finally { observed.restore(); }
  }, 15000);

  it("closes a failed initialization connection without retrying a non-busy error or closing runtime", async () => {
    configureEmailDatabaseForTests(`file:./database-failure-${randomUUID()}.sqlite`);
    const observed = observeClients(() => new Error("Synthetic schema failure"));
    try {
      const runtime = getEmailClient();
      await expect(ensureEmailDatabase()).rejects.toThrow("Synthetic schema failure");
      expect(observed.clients).toHaveLength(2);
      expect(observed.clients[1].closed).toBe(true);
      expect(observed.clients[1].batch).toHaveBeenCalledTimes(1);
      expect(getEmailClient()).toBe(runtime);
      expect(runtime.closed).toBe(false);
      expect((await runtime.execute("SELECT 1 AS usable")).rows[0].usable).toBe(1);
    } finally { observed.restore(); }
  });

  it("preserves schema and data on the cached shared-memory connection", async () => {
    const url = "file::memory:?cache=shared";
    configureEmailDatabaseForTests(url);
    const runtime = getEmailClient();
    await Promise.all([ensureEmailDatabase(), ensureEmailDatabase()]);
    await execute("INSERT INTO settings VALUES ('synthetic_memory', 'retained', '2026-09-15')");
    await ensureEmailDatabase();
    expect(getEmailClient()).toBe(runtime);
    expect(runtime.closed).toBe(false);
    expect((await execute("SELECT value FROM settings WHERE key='synthetic_memory'")).rows[0].value).toBe("retained");
  });
});
