import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ local: vi.fn(), actions: vi.fn(), provider: vi.fn(), sync: vi.fn(), dispatch: vi.fn() }));
vi.mock('@/lib/email/today-brief', () => ({ getLocalTodayBrief: mocks.local }));
vi.mock('@/lib/email/action-center', () => ({ getActionCenter: mocks.actions }));
vi.mock('@/lib/email/provider-adapter', () => ({ providerAdapterFor: mocks.provider }));
vi.mock('@/lib/email/calendar', () => ({ syncCalendarAccounts: mocks.sync }));
vi.mock('@/lib/email/notification-dispatch', () => ({ dispatchNotifications: mocks.dispatch }));
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, execute } from '@/lib/email/database';
import { collectMorningEvidence, lookupBriefSources } from '@/lib/email/morning-brief-facts';
import { reconcileBriefMemory, updateBriefItemMemory } from '@/lib/email/brief-memory';
import { evidence, NOW } from './fixtures/morning-brief';
const workspace = evidence().identity.workspaceId;
const old = '2026-09-17T14:00:00.000Z';
async function mail(id = 'message-1', account = 'gmail-1', thread = 'thread-1') {
    await execute('INSERT INTO email_messages (id,account_id,external_message_id,thread_id,sender_name,sender_email,subject,received_at,snippet,gmail_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [id, account, id, thread, 'Synthetic', 'sender@example.test', 'Question', old, 'Question summary', 'https://example.test', old, old]);
}
beforeEach(async () => {
    configureEmailDatabaseForTests('file:./morning-facts-' + randomUUID() + '.sqlite');
    for (const id of ['gmail-1', 'gmail-2'])
        await execute("INSERT INTO email_accounts(id,provider,email,label,status,created_at,updated_at) VALUES (?,'gmail',?,'Synthetic','connected',?,?)", [id, id + '@example.test', NOW, NOW]);
    mocks.local.mockReset().mockResolvedValue({ agenda: [], needsAttention: [], carryovers: [], completedSinceLastBrief: [], topics: [], sourceStatus: evidence().coverage, briefCandidates: [] });
    mocks.actions.mockReset().mockResolvedValue({ sections: [] });
    mocks.provider.mockClear();
    mocks.sync.mockClear();
    mocks.dispatch.mockClear();
    await mail();
});
afterEach(() => closeEmailDatabaseForTests());
it('looks up old urgent carryovers outside selected topics, using local sources only', async () => {
    await execute("INSERT INTO triage_decisions(id,message_id,model,attention,urgency,confidence,category,summary,reason,recommendation,needs_reply,created_at) VALUES ('triage','message-1','synthetic','interrupt',1,1,'work','Reply requested','synthetic','reply',1,?)", [NOW]);
    const memory = await reconcileBriefMemory({ workspaceId: workspace, now: old, candidates: [{ sourceType: 'mail_thread', sourceKey: 'mail:gmail-1:thread-1', sourceAccountId: 'gmail-1', provider: 'gmail', providerThreadId: 'thread-1', revisionAt: old, occurredAt: old, role: 'attention', title: 'Question', summary: 'Reply requested', target: { view: 'mail', messageId: 'message-1' } }] });
    mocks.local.mockResolvedValueOnce({ agenda: [], needsAttention: [], carryovers: memory.current, completedSinceLastBrief: [], topics: [], sourceStatus: evidence().coverage });
    const result = await collectMorningEvidence(workspace, NOW);
    expect(result.facts).toEqual([expect.objectContaining({ sourceKey: 'mail:gmail-1:thread-1', urgent: true, receivedAt: old, firstSeenAt: old, target: { view: 'mail', messageId: 'message-1' } })]);
    expect(mocks.local).toHaveBeenCalledWith({ workspaceId: workspace, now: NOW });
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
});
it('rejects foreign identities and excludes removed actual mail targets', async () => {
    await mail('foreign', 'gmail-2', 'thread-2');
    const keys = ['mail:gmail-1:thread-1', 'mail:gmail-2:thread-2'];
    expect([...(await lookupBriefSources(workspace, keys)).keys()]).toEqual([keys[0]]);
    await execute("DELETE FROM email_messages WHERE id='message-1'");
    expect((await lookupBriefSources(workspace, keys)).size).toBe(0);
});
it('finds explicit cancelled and moved calendar records outside the current agenda', async () => {
    await execute("INSERT INTO calendar_events (id,account_id,external_event_id,calendar_id,calendar_name,title,starts_at,ends_at,is_all_day,status,is_busy,attendees,synced_at,created_at,updated_at) VALUES ('event','gmail-1','external','primary','Primary','Meeting','2026-09-22T14:00:00Z','2026-09-22T15:00:00Z',0,'cancelled',1,'[]',?,?,?)", [NOW, old, NOW]);
    const result = await lookupBriefSources(workspace, ['calendar:gmail-1:external']);
    expect(result.get('calendar:gmail-1:external')).toMatchObject({ state: 'cancelled', startsAt: '2026-09-22T14:00:00.000Z', target: { view: 'calendar', eventId: 'event', date: '2026-09-22' } });
});
it('keeps stored handled state and reopens only when the actual source is newer', async () => {
    const memory = await reconcileBriefMemory({ workspaceId: workspace, now: old, candidates: [{ sourceType: 'mail_thread', sourceKey: 'mail:gmail-1:thread-1', sourceAccountId: 'gmail-1', provider: 'gmail', providerThreadId: 'thread-1', revisionAt: old, occurredAt: old, role: 'attention', title: 'Question', summary: 'Reply requested', target: { view: 'mail', messageId: 'message-1' } }] });
    await updateBriefItemMemory({ workspaceId: workspace, itemId: memory.current[0].id, action: 'complete', now: NOW });
    expect((await lookupBriefSources(workspace, ['mail:gmail-1:thread-1'])).values().next().value?.state).toBe('completed');
    await execute("UPDATE email_messages SET received_at=?,updated_at=? WHERE id='message-1'", ['2026-09-21T15:00:00.000Z', '2026-09-21T15:00:00.000Z']);
    expect((await lookupBriefSources(workspace, ['mail:gmail-1:thread-1'])).values().next().value?.state).toBe('open');
});
it('revalidates action targets against their account', async () => {
    await mail('foreign', 'gmail-2', 'thread-2');
    mocks.actions.mockResolvedValue({ sections: [{ id: 'approvals', items: [{ id: 'approval', accountId: 'gmail-1', title: 'Draft', detail: 'Review', updatedAt: NOW, target: { view: 'mail', messageId: 'foreign' } }] }] });
    expect((await lookupBriefSources(workspace, ['action:approval'])).size).toBe(0);
});
it('caps fact capture and discloses truncation', async () => {
    const facts = Array.from({ length: 201 }, (_, i) => ({ sourceKey: 'mail:gmail-1:thread-' + i }));
    mocks.local.mockResolvedValue({ agenda: [], needsAttention: facts, carryovers: [], completedSinceLastBrief: [], topics: [], sourceStatus: evidence().coverage });
    const current = await collectMorningEvidence(workspace, NOW);
    expect(current.facts.length).toBeLessThanOrEqual(200);
    expect(current.truncated).toBe(true);
});
it('keeps a selected FYI informational rather than promoting it to attention', async () => {
    mocks.local.mockResolvedValue({ agenda: [], needsAttention: [], carryovers: [], completedSinceLastBrief: [], topics: [{ id: 'message-1', kind: 'fyi' }], sourceStatus: evidence().coverage });
    expect((await collectMorningEvidence(workspace, NOW)).facts[0].role).toBe('fyi');
});
it('redacts a deleted exact message even when its thread survives, before publication and on read', async () => {
    const { captureMorningBrief, enqueueBriefJob, claimBriefJob, publishBriefJob } = await import('@/lib/email/morning-brief-store');
    const { deterministicBrief } = await import('@/lib/email/morning-brief-copy');
    const { redactBriefNarrative, getMorningBriefView } = await import('@/lib/email/morning-brief-view');
    await mail('newer');
    await execute("UPDATE email_messages SET subject='Private captured detail',received_at=? WHERE id='newer'", [NOW]);
    mocks.local.mockResolvedValue({ agenda: [], needsAttention: [{ sourceKey: 'mail:gmail-1:thread-1', role: 'attention' }], carryovers: [], completedSinceLastBrief: [], topics: [], sourceStatus: evidence().coverage });
    const baseline = await collectMorningEvidence(workspace, NOW);
    const snapshot = await captureMorningBrief(baseline);
    const narrative = deterministicBrief(baseline);
    await enqueueBriefJob(snapshot.id, 'morning', baseline, '0'.repeat(64), NOW);
    const job = await claimBriefJob('test', NOW);
    await publishBriefJob(job!.lease, narrative, NOW);
    await execute("DELETE FROM email_messages WHERE id='newer'");
    const live = await lookupBriefSources(workspace, baseline.facts.map(f => f.sourceKey), baseline);
    expect(JSON.stringify(redactBriefNarrative(narrative, live))).not.toContain('Private captured detail');
    const view = await getMorningBriefView(workspace, NOW);
    expect(view.status).toBe('limited');
    expect(JSON.stringify(view.narrative)).not.toContain('Private captured detail');
    expect(view.narrative?.overview.text).toMatch(/no longer available/i);
});
it('enriches urgent carryovers beyond a full baseline and admits new material sources', async () => {
    const { fact } = await import('./fixtures/morning-brief');
    const { getMorningBriefData } = await import('@/lib/email/morning-brief-view');
    const { captureMorningBrief } = await import('@/lib/email/morning-brief-store');
    const { groupTodayAttention } = await import('@/lib/email/today-attention');
    const baselineFacts = [];
    for (let i = 0; i < 200; i++) {
        await mail('cap-' + i, 'gmail-1', 'cap-' + i);
        baselineFacts.push(fact({ sourceKey: 'mail:gmail-1:cap-' + i, target: { view: 'mail', messageId: 'cap-' + i }, firstSeenAt: old, receivedAt: old, sourceRevisionAt: old, sourceOccurredAt: old }));
    }
    await mail('new-material', 'gmail-1', 'new-material');
    await execute("UPDATE email_messages SET received_at=? WHERE id='new-material'", [NOW]);
    await execute("INSERT INTO triage_decisions(id,message_id,model,attention,urgency,confidence,category,summary,reason,recommendation,needs_reply,created_at) VALUES ('cap-triage','cap-199','synthetic','interrupt',1,1,'work','Urgent old work','synthetic','reply',1,?)", [NOW]);
    const memory = await reconcileBriefMemory({ workspaceId: workspace, now: old, candidates: [{ sourceType: 'mail_thread', sourceKey: 'mail:gmail-1:cap-199', sourceAccountId: 'gmail-1', provider: 'gmail', providerThreadId: 'cap-199', revisionAt: old, occurredAt: old, role: 'attention', title: 'Urgent old work', summary: 'Needs action', target: { view: 'mail', messageId: 'cap-199' } }] });
    const page = { agenda: baselineFacts.slice(0, 199).map(f => ({ sourceKey: f.sourceKey, role: 'agenda' })), needsAttention: [{ sourceKey: 'mail:gmail-1:new-material', role: 'attention' }], carryovers: memory.current, completedSinceLastBrief: [], topics: [], sourceStatus: evidence().coverage } as unknown as import('@/lib/email/types').TodayBrief;
    const early = await getMorningBriefData(workspace, '2026-09-21T12:00:00.000Z', page);
    expect.soft(early.attentionMetadata['mail:gmail-1:cap-199']?.urgent).toBe(true);
    const baseline = evidence({ facts: baselineFacts });
    await captureMorningBrief(baseline);
    const current = await collectMorningEvidence(workspace, NOW, baseline, page);
    expect.soft(current.facts.some(f => f.sourceKey === 'mail:gmail-1:new-material')).toBe(true);
    expect(current.truncated).toBe(true);
    const data = await getMorningBriefData(workspace, NOW, page);
    const grouped = groupTodayAttention(memory.current, new Map(Object.entries(data.attentionMetadata)), NOW, 'America/Chicago');
    expect(grouped.current.map(i => i.sourceKey)).toContain('mail:gmail-1:cap-199');
    expect(grouped.earlier).toEqual([]);
});
it.each(['complete', 'dismiss'] as const)('preserves %s across delayed mail received before the owner decision', async (action) => {
    const memory = await reconcileBriefMemory({ workspaceId: workspace, now: old, candidates: [{ sourceType: 'mail_thread', sourceKey: 'mail:gmail-1:thread-1', sourceAccountId: 'gmail-1', provider: 'gmail', providerThreadId: 'thread-1', revisionAt: old, occurredAt: old, role: 'attention', title: 'Question', summary: 'Reply requested', target: { view: 'mail', messageId: 'message-1' } }] });
    await updateBriefItemMemory({ workspaceId: workspace, itemId: memory.current[0].id, action, now: NOW });
    const expected = action === 'complete' ? 'completed' : 'dismissed';
    for (const received of ['2026-09-21T13:00:00.000Z', NOW]) {
        await execute("UPDATE email_messages SET received_at=? WHERE id='message-1'", [received]);
        expect((await lookupBriefSources(workspace, ['mail:gmail-1:thread-1'])).get('mail:gmail-1:thread-1')?.state).toBe(expected);
    }
    await execute("UPDATE email_messages SET received_at='2026-09-21T15:00:00.000Z' WHERE id='message-1'");
    expect((await lookupBriefSources(workspace, ['mail:gmail-1:thread-1'])).get('mail:gmail-1:thread-1')?.state).toBe('open');
});
it('ignores unchanged calendar resyncs without a provider revision but detects meaningful edits', async () => {
    const { compareBriefEvidence, briefSemanticHash } = await import('@/lib/email/morning-brief-changes');
    await execute("INSERT INTO calendar_events (id,account_id,external_event_id,calendar_id,calendar_name,title,starts_at,ends_at,is_all_day,status,is_busy,attendees,synced_at,created_at,updated_at) VALUES ('stable-event','gmail-1','stable-external','primary','Primary','Meeting','2026-09-21T16:00:00Z','2026-09-21T17:00:00Z',0,'confirmed',1,'[]',?,?,?)", [NOW, old, NOW]);
    const read = async () => evidence({ facts: [...(await lookupBriefSources(workspace, ['calendar:gmail-1:stable-external'])).values()] });
    const baseline = await read();
    await execute("UPDATE calendar_events SET updated_at='2026-09-21T15:00:00.000Z',synced_at='2026-09-21T15:00:00.000Z' WHERE id='stable-event'");
    const synced = await read();
    expect(compareBriefEvidence(baseline, synced)).toEqual([]);
    expect(briefSemanticHash(synced)).toBe(briefSemanticHash(baseline));
    await execute("UPDATE calendar_events SET title='Rescheduled discussion',location='Room B' WHERE id='stable-event'");
    expect(compareBriefEvidence(baseline, await read())).toEqual([expect.objectContaining({ kind: 'changed' })]);
});
