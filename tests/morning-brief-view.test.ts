import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ collect: vi.fn(), lookup: vi.fn(), generate: vi.fn() }));
vi.mock('@/lib/email/morning-brief-facts', () => ({ collectMorningEvidence: mocks.collect, lookupBriefSources: mocks.lookup }));
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, execute, setServiceState } from '@/lib/email/database';
import { getMorningBriefView } from '@/lib/email/morning-brief-view';
import { captureMorningBrief, enqueueBriefJob, claimBriefJob, publishBriefJob, readMorningBrief } from '@/lib/email/morning-brief-store';
import { deterministicBrief } from '@/lib/email/morning-brief-copy';
import { evidence, fact, NOW } from './fixtures/morning-brief';
import { briefIdentity } from '@/lib/email/morning-brief-time';
const workspace = evidence().identity.workspaceId;
beforeEach(async () => { configureEmailDatabaseForTests('file:./morning-view-' + randomUUID() + '.sqlite'); await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES ('gmail-1','gmail','owner@example.test','Synthetic','connected',?,?)", [NOW, NOW]); mocks.collect.mockReset().mockResolvedValue(evidence()); mocks.lookup.mockReset().mockResolvedValue(new Map([[fact().sourceKey, fact()]])); });
afterEach(() => closeEmailDatabaseForTests());
async function published() { const row = await captureMorningBrief(evidence()); await enqueueBriefJob(row.id, 'morning', evidence(), '0'.repeat(64), NOW); const job = await claimBriefJob('test', NOW); await publishBriefJob(job!.lease, deterministicBrief(evidence()), NOW); return row; }
it('queues a durable pending baseline without generating prose in the page request', async () => {
    const view = await getMorningBriefView(workspace, NOW);
    expect(view.status).toBe('pending');
    expect(view.narrative).toBeNull();
    expect((await execute('SELECT id FROM morning_brief_snapshots')).rows).toHaveLength(1);
    expect((await execute('SELECT id FROM morning_brief_jobs')).rows).toHaveLength(1);
});
it('does not capture before schedule or during operational pause', async () => {
    const early = '2026-09-21T12:00:00.000Z';
    mocks.collect.mockResolvedValue(evidence({ capturedAt: early }));
    expect((await getMorningBriefView(workspace, early)).status).toBe('scheduled');
    await setServiceState('polling_paused_at', NOW);
    mocks.collect.mockResolvedValue(evidence());
    expect((await getMorningBriefView(workspace, NOW)).status).toBe('unavailable');
    expect((await execute('SELECT id FROM morning_brief_snapshots')).rows).toHaveLength(0);
});
it('keeps published morning text fixed while later changes and exact state update', async () => {
    await published();
    const original = await getMorningBriefView(workspace, NOW);
    const handled = fact({ state: 'completed' });
    mocks.collect.mockResolvedValue(evidence({ facts: [handled] }));
    mocks.lookup.mockResolvedValue(new Map([[handled.sourceKey, handled]]));
    const view = await getMorningBriefView(workspace, '2026-09-21T15:00:00.000Z');
    expect(view.narrative).toEqual(original.narrative);
    expect(view.changes[0].kind).toBe('handled');
    expect(view.sources[0].currentState).toBe('completed');
    await getMorningBriefView(workspace, '2026-09-21T15:01:00.000Z');
    expect((await execute("SELECT id FROM morning_brief_jobs WHERE kind='changes'")).rows).toHaveLength(1);
});
it('redacts a whole cached paragraph when a referenced source disappears without mutating storage', async () => {
    const row = await published();
    mocks.lookup.mockResolvedValue(new Map());
    mocks.collect.mockResolvedValue(evidence({ facts: [] }));
    const view = await getMorningBriefView(workspace, NOW);
    expect(view.status).toBe('limited');
    expect(JSON.stringify(view)).not.toContain('Synthetic supplier');
    expect(view.narrative?.overview.text).toMatch(/no longer available/i);
    expect(view.sources).toEqual([]);
    expect((await readMorningBrief(row.evidence.identity))?.narrative?.priorities[0].text).toContain('Synthetic supplier');
});
it('fails closed when exact source lookup fails', async () => {
    await published();
    mocks.lookup.mockRejectedValue(new Error('Synthetic private failure'));
    const view = await getMorningBriefView(workspace, NOW);
    expect(view.status).toBe('unavailable');
    expect(JSON.stringify(view)).not.toContain('Synthetic');
});
it('clears old-day text and labels a late new baseline with the actual capture time', async () => {
    await published();
    const late = '2026-09-22T19:15:00.000Z';
    const next = evidence({ identity: briefIdentity(workspace, [{ id: 'gmail-1', provider: 'gmail' }], 'America/Chicago', late), capturedAt: late, facts: [] });
    mocks.collect.mockResolvedValue(next);
    mocks.lookup.mockResolvedValue(new Map());
    const view = await getMorningBriefView(workspace, late);
    expect(view.status).toBe('pending');
    expect(view.narrative).toBeNull();
    expect((await readMorningBrief(next.identity))?.evidence.capturedAt).toBe(late);
    expect((await execute('SELECT id FROM morning_brief_snapshots')).rows).toHaveLength(2);
});
it('replaces a changed account scope without exposing the old combined brief', async () => {
    const combined = evidence({ identity: briefIdentity('workspace:all', [{ id: 'gmail-1', provider: 'gmail' }], 'America/Chicago', NOW) });
    const row = await captureMorningBrief(combined);
    await enqueueBriefJob(row.id, 'morning', combined, '0'.repeat(64), NOW);
    const job = await claimBriefJob('test', NOW);
    await publishBriefJob(job!.lease, deterministicBrief(combined), NOW);
    await execute("UPDATE email_accounts SET status='disabled' WHERE id='gmail-1'");
    const empty = evidence({ identity: briefIdentity('workspace:all', [], 'America/Chicago', NOW), accountIds: [], facts: [], coverage: [] });
    mocks.collect.mockResolvedValue(empty);
    mocks.lookup.mockResolvedValue(new Map());
    const view = await getMorningBriefView('workspace:all', NOW);
    expect(view.status).toBe('pending');
    expect(view.narrative).toBeNull();
    expect(JSON.stringify(view)).not.toContain('Synthetic supplier');
});
