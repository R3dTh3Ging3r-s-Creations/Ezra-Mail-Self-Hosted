import type { Client } from "@libsql/client";
import { agentGrantStatements } from "./agent-grant-schema";

/** Atomic additive v14: no partial advertised version or discarded legacy provenance. */
export async function migrateAgentResourceSchema(client: Client): Promise<void> {
  const statements = [...agentGrantStatements,
    `CREATE TABLE IF NOT EXISTS agent_resource_operations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('calendar.update','calendar.delete','tasks.create','tasks.update','tasks.complete')),
      version INTEGER NOT NULL, account_id TEXT NOT NULL, provider TEXT NOT NULL, expected_email TEXT NOT NULL,
      resource_kind TEXT NOT NULL CHECK(resource_kind IN ('calendar','task_list')), resource_id TEXT NOT NULL,
      payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, evidence_json TEXT NOT NULL,
      authority_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared','approved','executing','succeeded','failed','cancelled','expired','unknown')),
      claim_id TEXT, lease_expires_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
      provider_id TEXT, receipt_json TEXT, error_code TEXT)`,
    `CREATE TABLE IF NOT EXISTS agent_resource_operation_attempts (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES agent_resource_operations(id),
      started_at TEXT NOT NULL, authorized_at TEXT, dispatched_at TEXT, finished_at TEXT, outcome TEXT, error_code TEXT)`,
    `CREATE TABLE IF NOT EXISTS agent_key_bindings (
      grant_id TEXT NOT NULL REFERENCES agent_grants(key_id), grant_revision INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
      operation_table TEXT NOT NULL CHECK(operation_table IN ('legacy','resource')), operation_id TEXT NOT NULL,
      PRIMARY KEY(grant_id,idempotency_key), UNIQUE(operation_table,operation_id))`,
    `CREATE TABLE IF NOT EXISTS agent_resource_locks (
      account_id TEXT NOT NULL, provider TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL,
      operation_table TEXT NOT NULL CHECK(operation_table IN ('legacy','resource')), operation_id TEXT NOT NULL,
      PRIMARY KEY(account_id,provider,resource_kind,resource_id))`,
    `CREATE TRIGGER IF NOT EXISTS agent_resource_content_immutable BEFORE UPDATE OF id,kind,version,account_id,provider,expected_email,resource_kind,resource_id,payload_json,payload_hash,evidence_json,authority_json,created_at,expires_at ON agent_resource_operations
      BEGIN SELECT RAISE(ABORT, 'Operation content is immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_resource_receipt_immutable BEFORE UPDATE OF receipt_json ON agent_resource_operations WHEN OLD.receipt_json IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'Operation receipt is immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_resource_attempt_immutable BEFORE UPDATE ON agent_resource_operation_attempts WHEN OLD.finished_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'Operation attempt receipt is immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_key_binding_immutable BEFORE UPDATE ON agent_key_bindings
      BEGIN SELECT RAISE(ABORT, 'Operation key binding is immutable'); END`,
    `INSERT OR IGNORE INTO agent_resource_locks(account_id,provider,resource_kind,resource_id,operation_table,operation_id)
      SELECT account_id,provider,'calendar',calendar_id,'legacy',id FROM agent_operations WHERE status IN ('executing','unknown')`,
  ];
  statements.push(...sharedResourceLockStatements());
  const version = Number((await client.execute("PRAGMA user_version")).rows[0].user_version);
  if (version < 14) statements.push("PRAGMA user_version=14");
  await client.batch(statements, "write");
}

function sharedResourceLockStatements(): string[] {
  return [
    { table: "agent_operations", source: "legacy", kind: "'calendar'", resource: "calendar_id" },
    { table: "agent_resource_operations", source: "resource", kind: "NEW.resource_kind", resource: "resource_id" },
  ].flatMap(({ table, source, kind, resource }) => {
    const held = "NEW.status IN ('executing','unknown')";
    const columns = "account_id,provider,resource_kind,resource_id,operation_table,operation_id";
    const values = `NEW.account_id,NEW.provider,${kind},NEW.${resource},'${source}',NEW.id`;
    const conflict = `EXISTS (SELECT 1 FROM agent_resource_locks WHERE account_id=NEW.account_id AND provider=NEW.provider AND resource_kind=${kind} AND resource_id=NEW.${resource} AND (operation_table<>'${source}' OR operation_id<>NEW.id))`;
    return [
      ...["INSERT", "UPDATE"].flatMap(action => [
        `CREATE TRIGGER IF NOT EXISTS ${source}_shared_lock_guard_${action.toLowerCase()} BEFORE ${action} ON ${table} WHEN ${held} AND ${conflict} BEGIN SELECT RAISE(ABORT, 'Resource is locked by an unresolved operation'); END`,
        `CREATE TRIGGER IF NOT EXISTS ${source}_shared_lock_hold_${action.toLowerCase()} AFTER ${action} ON ${table} WHEN ${held} BEGIN INSERT OR IGNORE INTO agent_resource_locks(${columns}) VALUES (${values}); END`,
      ]),
      `CREATE TRIGGER IF NOT EXISTS ${source}_shared_lock_release AFTER UPDATE ON ${table} WHEN NEW.status NOT IN ('executing','unknown') BEGIN DELETE FROM agent_resource_locks WHERE operation_table='${source}' AND operation_id=NEW.id; END`,
    ];
  });
}
