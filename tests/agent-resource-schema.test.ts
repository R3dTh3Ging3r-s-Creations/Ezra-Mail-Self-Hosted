import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { resourceMutationSchema } from "@/lib/email/agent-resource-types";
import { migrateAgentOperationSchema } from "@/lib/email/agent-operation-schema";
import { migrateAgentResourceSchema } from "@/lib/email/agent-resource-schema";

const account = { accountId: "personal", provider: "microsoft", expectedEmail: "owner@hotmail.test" };
const target = { account, kind: "task_list", id: "list" };
const update = { kind: "tasks.update", target, taskId: "task", expectedRevision: "etag", patch: { title: "Changed" } };
describe("strict resource mutations", () => {
  it("preserves omission and explicit clears", () => {
    expect(resourceMutationSchema.parse(update)).toEqual(update);
    expect(resourceMutationSchema.parse({ ...update, patch: { due: null } })).toEqual({ ...update, patch: { due: null } });
  });
  it.each([
    { ...update, patch: {} }, { ...update, approved: true }, { ...update, patch: { status: "completed" } },
    { ...update, target: { ...target, kind: "calendar" } },
    { ...update, target: { ...target, account: { ...account, provider: "gmail" } } },
    { ...update, expectedRevision: "" }, { ...update, taskId: "*" },
    { ...update, patch: { due: { kind: "date", date: "2026-02-30", timezone: "America/Chicago" } } },
    { kind: "calendar.update", target: { ...target, kind: "calendar" }, eventId: "event", expectedRevision: "etag", patch: { attendees: [] } },
    { kind: "calendar.update", target: { ...target, kind: "calendar" }, eventId: "event", expectedRevision: "etag", patch: { time: { startsAt: "2026-10-01T00:00:00Z" } } },
  ])("rejects authority injection or unsafe mutation %#", value => expect(resourceMutationSchema.safeParse(value).success).toBe(false));
});

describe("additive resource persistence", () => {
  it("preserves populated legacy operations, evidence, attempts and triggers while seeding locks", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
      await migrateAgentOperationSchema(client);
      await client.batch([
        `INSERT INTO agent_operations(id,kind,version,account_id,provider,expected_email,calendar_id,payload_json,payload_hash,evidence_json,snapshot_json,created_at,expires_at,updated_at,status,approval_json,receipt_json) VALUES ('legacy','calendar.create',1,'personal','microsoft','owner@hotmail.test','cal','{"original":1}','hash','{"evidence":true}','{"events":[]}','created','expires','updated','unknown','{"approved":"original"}',NULL)`,
        `INSERT INTO agent_operation_attempts(id,operation_id,started_at,dispatched_at) VALUES ('attempt','legacy','start','dispatch')`,
        "PRAGMA user_version=13",
      ], "write");
      const before = (await client.execute("SELECT * FROM agent_operations")).rows;
      const attempts = (await client.execute("SELECT * FROM agent_operation_attempts")).rows;
      await migrateAgentResourceSchema(client); await migrateAgentResourceSchema(client);
      expect((await client.execute("PRAGMA user_version")).rows[0].user_version).toBe(14);
      expect((await client.execute("SELECT * FROM agent_operations")).rows).toEqual(before);
      expect((await client.execute("SELECT * FROM agent_operation_attempts")).rows).toEqual(attempts);
      expect((await client.execute("SELECT account_id,provider,resource_kind,resource_id,operation_table,operation_id FROM agent_resource_locks")).rows).toEqual([{ account_id: "personal", provider: "microsoft", resource_kind: "calendar", resource_id: "cal", operation_table: "legacy", operation_id: "legacy" }]);
      await expect(client.execute("UPDATE agent_operations SET approval_json='{}'")).rejects.toThrow(/immutable/i);
      await expect(client.execute("UPDATE agent_operations SET payload_json='{}'")).rejects.toThrow(/immutable/i);
      for (const table of ["agent_grants", "agent_resource_operations", "agent_resource_operation_attempts", "agent_key_bindings"]) {
        expect((await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [table] })).rows).toHaveLength(1);
      }
    } finally { client.close(); }
  });
  it("rolls back the entire migration when legacy lock seeding fails", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
      await client.batch(["CREATE TABLE agent_operations(id TEXT)", "PRAGMA user_version=13"], "write");
      await expect(migrateAgentResourceSchema(client)).rejects.toThrow();
      expect((await client.execute("PRAGMA user_version")).rows[0].user_version).toBe(13);
      expect((await client.execute("SELECT name FROM sqlite_master WHERE name LIKE 'agent_resource_%' OR name='agent_grants'")).rows).toHaveLength(0);
    } finally { client.close(); }
  });
});
