import type { Client } from '@libsql/client';
/** Additive v10. Legacy briefs and owner decisions remain untouched. */
export async function migrateMorningBriefSchema(client: Client) {
    const tx = await client.transaction('write');
    try {
        await tx.execute(`CREATE TABLE IF NOT EXISTS morning_brief_snapshots (
   id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, local_day TEXT NOT NULL, timezone TEXT NOT NULL,
   scope_hash TEXT NOT NULL, evidence_json TEXT NOT NULL, narrative_json TEXT, captured_at TEXT NOT NULL,
   published_at TEXT, UNIQUE(workspace_id,local_day,timezone,scope_hash))`);
        await tx.execute(`CREATE TABLE IF NOT EXISTS morning_brief_jobs (
   id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES morning_brief_snapshots(id) ON DELETE CASCADE,
   kind TEXT NOT NULL CHECK(kind IN ('morning','changes')), semantic_hash TEXT NOT NULL,
   current_json TEXT NOT NULL, owner TEXT, generation INTEGER NOT NULL DEFAULT 0,
   expires_at TEXT, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done')),
   requested_at TEXT NOT NULL, UNIQUE(snapshot_id,kind,semantic_hash))`);
        await tx.execute(`CREATE TABLE IF NOT EXISTS morning_brief_updates (
   snapshot_id TEXT NOT NULL REFERENCES morning_brief_snapshots(id) ON DELETE CASCADE,
   semantic_hash TEXT NOT NULL, current_json TEXT NOT NULL, narrative_json TEXT NOT NULL,
   published_at TEXT NOT NULL, PRIMARY KEY(snapshot_id,semantic_hash))`);
        await tx.execute('CREATE INDEX IF NOT EXISTS morning_brief_due ON morning_brief_jobs(state,requested_at)');
        const version = Number((await tx.execute('PRAGMA user_version')).rows[0].user_version);
        if (version < 10)
            await tx.execute('PRAGMA user_version=10');
        await tx.commit();
    }
    catch (error) {
        await tx.rollback();
        throw error;
    }
    finally {
        tx.close();
    }
}
