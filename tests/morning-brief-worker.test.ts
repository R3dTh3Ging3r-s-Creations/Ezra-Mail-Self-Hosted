import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ collect: vi.fn(), lookup: vi.fn(), generate: vi.fn() }));
vi.mock('@/lib/email/morning-brief-facts', () => ({ collectMorningEvidence: mocks.collect, lookupBriefSources: mocks.lookup }));
vi.mock('@/lib/email/morning-brief-copy', async (original) => ({ ...await original<typeof import('@/lib/email/morning-brief-copy')>(), createBriefNarrative: mocks.generate }));
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, execute, setServiceState } from '@/lib/email/database';
import { runMorningBriefWork, stopMorningBriefWork } from '@/lib/email/morning-brief-worker';
import { captureMorningBrief, readMorningBrief } from '@/lib/email/morning-brief-store';
import { deterministicBrief } from '@/lib/email/morning-brief-copy';
import { evidence, fact, NOW } from './fixtures/morning-brief';
import { briefIdentity } from '@/lib/email/morning-brief-time';
beforeEach(async () => {
    configureEmailDatabaseForTests('file:./morning-worker-' + randomUUID() + '.sqlite');
    await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES ('gmail-1','gmail','owner@example.test','Synthetic','connected',?,?)", [NOW, NOW]);
    mocks.collect.mockReset().mockImplementation(async (workspace: string, now: string) => evidence({ identity: briefIdentity(workspace, [{ id: 'gmail-1', provider: 'gmail' }], 'America/Chicago', now), capturedAt: now }));
    mocks.lookup.mockReset().mockResolvedValue(new Map([[fact().sourceKey, fact()]]));
    mocks.generate.mockReset().mockImplementation(async (e) => deterministicBrief(e));
});
afterEach(async () => { stopMorningBriefWork(); await closeEmailDatabaseForTests(); });
it('captures before generation, drains one job per tick and never regenerates unchanged morning text', async () => {
    mocks.generate.mockImplementation(async (e) => { expect((await readMorningBrief(e.identity))?.evidence).toEqual(e); return deterministicBrief(e); });
    await runMorningBriefWork(NOW);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    await runMorningBriefWork(NOW);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    await runMorningBriefWork(NOW);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect((await execute('SELECT id FROM morning_brief_snapshots')).rows).toHaveLength(2);
});
it('does no capture or generation during emergency pause or before schedule', async () => {
    await runMorningBriefWork('2026-09-21T12:00:00.000Z');
    expect(mocks.generate).not.toHaveBeenCalled();
    await setServiceState('polling_paused_at', NOW);
    await runMorningBriefWork(NOW);
    expect((await execute('SELECT id FROM morning_brief_snapshots')).rows).toHaveLength(0);
});
it('cannot publish after account removal during generation', async () => {
    mocks.generate.mockImplementation(async (e) => { await execute("UPDATE email_accounts SET status='disabled' WHERE id='gmail-1'"); return deterministicBrief(e); });
    await runMorningBriefWork(NOW);
    expect((await execute('SELECT id FROM morning_brief_snapshots WHERE published_at IS NOT NULL')).rows).toHaveLength(0);
});
it('aborts and relinquishes its lease on stop without discarding the baseline', async () => {
    let entered!: () => void;
    const ready = new Promise<void>(r => entered = r);
    mocks.generate.mockImplementation(async (e, options) => { entered(); await new Promise<void>(r => options.signal.addEventListener('abort', () => r(), { once: true })); return deterministicBrief(e); });
    const work = runMorningBriefWork(NOW);
    await ready;
    stopMorningBriefWork();
    await work;
    expect((await execute("SELECT id FROM morning_brief_jobs WHERE state='running'")).rows).toHaveLength(0);
    expect((await execute('SELECT id FROM morning_brief_snapshots')).rows.length).toBeGreaterThan(0);
    expect((await execute('SELECT id FROM morning_brief_snapshots WHERE published_at IS NOT NULL')).rows).toHaveLength(0);
});
it('bounds discovery to four workspaces and revisits the least recently checked scopes', async () => {
    for (let i = 2; i <= 6; i++)
        await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES (?,'gmail',?,'Synthetic','connected',?,?)", ['gmail-' + i, 'owner' + i + '@example.test', NOW, NOW]);
    mocks.collect.mockImplementation(async (workspace: string, now: string) => {
        const accounts = workspace === 'workspace:all' ? Array.from({ length: 6 }, (_, i) => ({ id: 'gmail-' + (i + 1), provider: 'gmail' })) : [{ id: workspace.split(':').at(-1)!, provider: 'gmail' }];
        return evidence({ identity: briefIdentity(workspace, accounts, 'America/Chicago', now), accountIds: accounts.map(a => a.id), capturedAt: now, facts: [], coverage: [] });
    });
    await runMorningBriefWork(NOW);
    expect(mocks.collect).toHaveBeenCalledTimes(4);
    await runMorningBriefWork('2026-09-21T14:01:00.000Z');
    expect(new Set(mocks.collect.mock.calls.map(c => c[0])).size).toBe(7);
});
