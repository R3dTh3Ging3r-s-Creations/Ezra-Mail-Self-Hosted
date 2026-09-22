import { randomUUID } from 'node:crypto';
import type { Transaction, Row } from '@libsql/client';
import { withNotificationStoreWrite } from './notification-store';
import { accountWorkspaceIdentity, ALL_WORKSPACE_ID, GMAIL_WORKSPACE_ID, MICROSOFT_WORKSPACE_ID } from './workspaces';
import { briefIdentity, retentionDay } from './morning-brief-time';
import { briefEvidenceSchema, briefIdentitySchema, parseBriefNarrative } from './morning-brief-types';
import type { BriefIdentity, BriefEvidence, StoredMorningBrief, BriefJob, BriefLease, BriefNarrative } from './morning-brief-types';
function instant(value: string) { if (!Number.isFinite(Date.parse(value)))
    throw new Error('Invalid brief time'); return new Date(value).toISOString(); }
function hash(value: string) { if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error('Invalid brief hash'); return value; }
function decode(row: Row | undefined): StoredMorningBrief | null {
    try {
        if (!row || typeof row.evidence_json !== 'string' || row.evidence_json.length > 262144)
            return null;
        const evidence = briefEvidenceSchema.parse(JSON.parse(row.evidence_json));
        if (row.workspace_id !== evidence.identity.workspaceId || row.local_day !== evidence.identity.day || row.timezone !== evidence.identity.timezone || row.scope_hash !== evidence.identity.scopeHash || row.captured_at !== evidence.capturedAt)
            return null;
        const narrative = row.narrative_json === null ? null : parseBriefNarrative(JSON.parse(String(row.narrative_json)), evidence);
        if (Boolean(narrative) !== Boolean(row.published_at))
            return null;
        return { id: String(row.id), evidence, narrative, publishedAt: row.published_at ? instant(String(row.published_at)) : null };
    }
    catch {
        return null;
    }
}
async function scopeValid(tx: Transaction, identity: BriefIdentity, accountIds?: string[]) {
    const account = accountWorkspaceIdentity(identity.workspaceId);
    let sql = "SELECT id,provider FROM email_accounts WHERE status<>'disabled'", args: string[] = [];
    if (account) {
        sql += ' AND id=? AND provider=?';
        args = [account.accountId, account.provider];
    }
    else if (identity.workspaceId === GMAIL_WORKSPACE_ID || identity.workspaceId === MICROSOFT_WORKSPACE_ID) {
        sql += ' AND provider=?';
        args = [identity.workspaceId === GMAIL_WORKSPACE_ID ? 'gmail' : 'microsoft'];
    }
    else if (identity.workspaceId !== ALL_WORKSPACE_ID)
        return false;
    const rows = (await tx.execute({ sql, args })).rows;
    if (account && !rows.length)
        return false;
    const accounts = rows.map(r => ({ id: String(r.id), provider: String(r.provider) }));
    const actual = briefIdentity(identity.workspaceId, accounts, identity.timezone, identity.day + 'T12:00:00Z');
    return actual.scopeHash === identity.scopeHash && (!accountIds || JSON.stringify([...accountIds].sort()) === JSON.stringify(accounts.map(a => a.id).sort()));
}
async function scoped(tx: Transaction, id: string) { const row = decode((await tx.execute({ sql: 'SELECT * FROM morning_brief_snapshots WHERE id=?', args: [id] })).rows[0]); return row && await scopeValid(tx, row.evidence.identity, row.evidence.accountIds) ? row : null; }
export async function captureMorningBrief(input: BriefEvidence): Promise<StoredMorningBrief> {
    const evidence = briefEvidenceSchema.parse(input);
    return withNotificationStoreWrite(async (tx) => {
        if (!await scopeValid(tx, evidence.identity, evidence.accountIds))
            throw new Error('Brief scope changed');
        const i = evidence.identity;
        await tx.execute({ sql: 'INSERT INTO morning_brief_snapshots (id,workspace_id,local_day,timezone,scope_hash,evidence_json,captured_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,local_day,timezone,scope_hash) DO NOTHING', args: [randomUUID(), i.workspaceId, i.day, i.timezone, i.scopeHash, JSON.stringify(evidence), evidence.capturedAt] });
        const result = decode((await tx.execute({ sql: 'SELECT * FROM morning_brief_snapshots WHERE workspace_id=? AND local_day=? AND timezone=? AND scope_hash=?', args: [i.workspaceId, i.day, i.timezone, i.scopeHash] })).rows[0]);
        if (!result)
            throw new Error('Stored morning brief is invalid');
        return result;
    });
}
export async function readMorningBrief(input: BriefIdentity): Promise<StoredMorningBrief | null> {
    const i = briefIdentitySchema.parse(input);
    return withNotificationStoreWrite(async (tx) => {
        if (!await scopeValid(tx, i))
            return null;
        const result = decode((await tx.execute({ sql: 'SELECT * FROM morning_brief_snapshots WHERE workspace_id=? AND local_day=? AND timezone=? AND scope_hash=?', args: [i.workspaceId, i.day, i.timezone, i.scopeHash] })).rows[0]);
        return result && await scopeValid(tx, result.evidence.identity, result.evidence.accountIds) ? result : null;
    });
}
export async function enqueueBriefJob(snapshotId: string, kind: BriefJob['kind'], input: BriefEvidence, semanticHash: string, value: string): Promise<void> {
    const current = briefEvidenceSchema.parse(input), now = instant(value);
    hash(semanticHash);
    if (!['morning', 'changes'].includes(kind))
        throw new Error('Invalid brief job kind');
    return withNotificationStoreWrite(async (tx) => {
        const snapshot = await scoped(tx, snapshotId);
        if (!snapshot)
            throw new Error('Brief scope changed');
        if (JSON.stringify(snapshot.evidence.identity) !== JSON.stringify(current.identity) || !await scopeValid(tx, current.identity, current.accountIds))
            throw new Error('Brief identity changed');
        if (kind === 'morning' && snapshot.publishedAt)
            return;
        const key = kind === 'morning' ? '0'.repeat(64) : semanticHash;
        if (kind === 'changes' && (await tx.execute({ sql: 'SELECT 1 FROM morning_brief_updates WHERE snapshot_id=? AND semantic_hash=?', args: [snapshotId, key] })).rows.length)
            return;
        if (kind === 'changes')
            await tx.execute({ sql: "DELETE FROM morning_brief_jobs WHERE snapshot_id=? AND kind='changes' AND state='pending' AND semantic_hash<>?", args: [snapshotId, key] });
        await tx.execute({ sql: 'INSERT INTO morning_brief_jobs (id,snapshot_id,kind,semantic_hash,current_json,requested_at) VALUES (?,?,?,?,?,?) ON CONFLICT(snapshot_id,kind,semantic_hash) DO NOTHING', args: [randomUUID(), snapshotId, kind, key, JSON.stringify(kind === 'morning' ? snapshot.evidence : current), now] });
        await tx.execute({ sql: "DELETE FROM morning_brief_jobs WHERE snapshot_id=? AND state='done' AND id NOT IN (SELECT id FROM morning_brief_jobs WHERE snapshot_id=? AND state='done' ORDER BY requested_at DESC LIMIT 16)", args: [snapshotId, snapshotId] });
    });
}
export async function claimBriefJob(owner: string, value: string): Promise<BriefJob | null> {
    const now = instant(value);
    if (!owner.trim() || owner.length > 200)
        throw new Error('Invalid brief owner');
    return withNotificationStoreWrite(async (tx) => {
        const rows = (await tx.execute({ sql: "SELECT * FROM morning_brief_jobs WHERE state='pending' OR (state='running' AND expires_at<=?) ORDER BY requested_at,id LIMIT 16", args: [now] })).rows;
        for (const row of rows) {
            const snapshot = await scoped(tx, String(row.snapshot_id));
            let current: BriefEvidence | undefined;
            try {
                current = briefEvidenceSchema.parse(JSON.parse(String(row.current_json)));
            }
            catch { /* Invalid persisted evidence is never used. */ }
            if (!snapshot || !current || !await scopeValid(tx, current.identity, current.accountIds) || JSON.stringify(current.identity) !== JSON.stringify(snapshot.evidence.identity) || briefIdentity(snapshot.evidence.identity.workspaceId, [], snapshot.evidence.identity.timezone, now).day !== snapshot.evidence.identity.day) {
                await tx.execute({ sql: "UPDATE morning_brief_jobs SET state='done',owner=NULL,expires_at=NULL WHERE id=?", args: [String(row.id)] });
                continue;
            }
            const generation = Number(row.generation) + 1;
            await tx.execute({ sql: "UPDATE morning_brief_jobs SET state='running',owner=?,generation=?,expires_at=? WHERE id=?", args: [owner, generation, new Date(Date.parse(now) + 30000).toISOString(), String(row.id)] });
            return { lease: { jobId: String(row.id), owner, generation }, kind: row.kind as BriefJob['kind'], snapshot, current, semanticHash: String(row.semantic_hash) };
        }
        return null;
    });
}
export async function publishBriefJob(lease: BriefLease, narrative: BriefNarrative, value: string): Promise<boolean> {
    const now = instant(value);
    return withNotificationStoreWrite(async (tx) => {
        const row = (await tx.execute({ sql: "SELECT * FROM morning_brief_jobs WHERE id=? AND owner=? AND generation=? AND state='running' AND expires_at>?", args: [lease.jobId, lease.owner, lease.generation, now] })).rows[0];
        if (!row)
            return false;
        const snapshot = await scoped(tx, String(row.snapshot_id));
        if (!snapshot)
            return false;
        if (briefIdentity(snapshot.evidence.identity.workspaceId, [], snapshot.evidence.identity.timezone, now).day !== snapshot.evidence.identity.day)
            return false;
        const current = briefEvidenceSchema.parse(JSON.parse(String(row.current_json)));
        if (JSON.stringify(current.identity) !== JSON.stringify(snapshot.evidence.identity) || !await scopeValid(tx, current.identity, current.accountIds)) return false;
        const copy = parseBriefNarrative(narrative, row.kind === 'morning' ? snapshot.evidence : current);
        let changed = false;
        if (row.kind === 'morning')
            changed = (await tx.execute({ sql: 'UPDATE morning_brief_snapshots SET narrative_json=?,published_at=? WHERE id=? AND published_at IS NULL', args: [JSON.stringify(copy), now, snapshot.id] })).rowsAffected === 1;
        else {
            await tx.execute({ sql: 'INSERT INTO morning_brief_updates (snapshot_id,semantic_hash,current_json,narrative_json,published_at) VALUES (?,?,?,?,?) ON CONFLICT(snapshot_id,semantic_hash) DO NOTHING', args: [snapshot.id, String(row.semantic_hash), JSON.stringify(current), JSON.stringify(copy), now] });
            changed = true;
            await tx.execute({ sql: 'DELETE FROM morning_brief_updates WHERE snapshot_id=? AND semantic_hash NOT IN (SELECT semantic_hash FROM morning_brief_updates WHERE snapshot_id=? ORDER BY published_at DESC,semantic_hash LIMIT 8)', args: [snapshot.id, snapshot.id] });
        }
        await tx.execute({ sql: "UPDATE morning_brief_jobs SET state='done',owner=NULL,expires_at=NULL WHERE id=?", args: [lease.jobId] });
        return changed;
    });
}
export async function readBriefUpdate(snapshotId: string, semanticHash: string): Promise<BriefNarrative | null> {
    hash(semanticHash);
    return withNotificationStoreWrite(async (tx) => {
        const snapshot = await scoped(tx, snapshotId);
        if (!snapshot) return null;
        const row = (await tx.execute({ sql: 'SELECT * FROM morning_brief_updates WHERE snapshot_id=? AND semantic_hash=?', args: [snapshotId, semanticHash] })).rows[0];
        try {
            if (!row) return null;
            const current = briefEvidenceSchema.parse(JSON.parse(String(row.current_json)));
            if (JSON.stringify(current.identity) !== JSON.stringify(snapshot.evidence.identity) || !await scopeValid(tx, current.identity, current.accountIds)) return null;
            return parseBriefNarrative(JSON.parse(String(row.narrative_json)), current);
        }
        catch {
            return null;
        }
    });
}
export async function releaseBriefLease(lease: BriefLease): Promise<void> { await withNotificationStoreWrite(async (tx) => { await tx.execute({ sql: "UPDATE morning_brief_jobs SET state='pending',owner=NULL,expires_at=NULL WHERE id=? AND owner=? AND generation=? AND state='running'", args: [lease.jobId, lease.owner, lease.generation] }); }); }
export async function pruneMorningBriefs(value: string): Promise<number> {
    const now = instant(value);
    return withNotificationStoreWrite(async (tx) => {
        const rows = (await tx.execute("SELECT id,local_day,timezone FROM morning_brief_snapshots ORDER BY local_day,id LIMIT 100")).rows;
        let count = 0;
        for (const row of rows) {
            let cutoff: string;
            try {
                cutoff = retentionDay(now, String(row.timezone));
            }
            catch {
                continue;
            }
            if (String(row.local_day) >= cutoff)
                continue;
            if ((await tx.execute({ sql: "SELECT 1 FROM morning_brief_jobs WHERE snapshot_id=? AND state='running' AND expires_at>?", args: [String(row.id), now] })).rows.length)
                continue;
            count += (await tx.execute({ sql: 'DELETE FROM morning_brief_snapshots WHERE id=?', args: [String(row.id)] })).rowsAffected;
        }
        return count;
    });
}
