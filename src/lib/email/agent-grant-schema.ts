import type { Client } from "@libsql/client";

/** Shared with the atomic v14 migration; this helper alone never advances the schema version. */
export const agentGrantStatements = [
  `CREATE TABLE IF NOT EXISTS agent_api_rate_limits (
    bucket TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL,
    PRIMARY KEY(bucket,window))`,
  `CREATE TABLE IF NOT EXISTS agent_grants (
    key_id TEXT PRIMARY KEY, secret_digest TEXT NOT NULL, grant_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, revoked_at TEXT)`,
  `CREATE TRIGGER IF NOT EXISTS agent_grant_immutable BEFORE UPDATE OF key_id,secret_digest,grant_json,revision,created_at,expires_at ON agent_grants
    BEGIN SELECT RAISE(ABORT, 'Grant identity is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS agent_grant_revocation_immutable BEFORE UPDATE OF revoked_at ON agent_grants WHEN OLD.revoked_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'Grant revocation is immutable'); END`,
];
export async function migrateAgentGrantSchema(client: Client): Promise<void> { await client.batch(agentGrantStatements, "write"); }
