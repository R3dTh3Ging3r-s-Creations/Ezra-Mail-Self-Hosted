import { execute, getSetting, getServiceState, setServiceState } from './database';
import { resolveBriefWorkspace } from './workspaces';
import { briefIdentity, briefDue } from './morning-brief-time';
import { collectMorningEvidence, lookupBriefSources } from './morning-brief-facts';
import { captureMorningBrief, readMorningBrief, enqueueBriefJob, readBriefUpdate } from './morning-brief-store';
import { compareBriefEvidence, briefSemanticHash } from './morning-brief-changes';
import { BRIEF_GENERIC, deterministicBrief } from './morning-brief-copy';
import type { BriefNarrative, BriefFact, BriefEvidence, MorningBriefView, TodayAttentionMeta } from './morning-brief-types';
import type { TodayBrief } from './types';
export function unavailableMorningBrief(now: string, timezone = 'America/Chicago'): MorningBriefView {
    let day = '';
    try {
        day = briefDue(now, timezone, []).day;
    }
    catch {
        timezone = 'America/Chicago';
        day = briefDue(now, timezone, []).day;
    }
    return { day, timezone, status: 'unavailable', scheduledLocalTime: '08:30', preparedAt: null, checkedAt: now, narrative: null, changes: [], changeNarrative: null, sources: [], coverage: [], truncated: false };
}
export async function morningScope(workspaceId: string, now: string) {
    const workspace = await resolveBriefWorkspace(workspaceId);
    const timezone = (await getSetting('timezone')) || 'America/Chicago';
    const accounts = (await execute("SELECT id,provider FROM email_accounts WHERE status<>'disabled'")).rows.filter(r => workspace.accountIds.includes(String(r.id))).map(r => ({ id: String(r.id), provider: String(r.provider) }));
    let times: string[] = [];
    try {
        const value = JSON.parse((await getSetting('digest_times')) || '[]');
        if (Array.isArray(value))
            times = value.filter((v): v is string => typeof v === 'string');
    }
    catch { }
    return { identity: briefIdentity(workspace.id, accounts, timezone, now), ...briefDue(now, timezone, times) };
}
/** Capture/queue only: generation belongs to the independent worker lane. */
export async function prepareMorningBrief(workspaceId: string, now: string, localPage?: TodayBrief) {
    const scope = await morningScope(workspaceId, now);
    let snapshot = await readMorningBrief(scope.identity);
    const current = await collectMorningEvidence(workspaceId, now, snapshot?.evidence, localPage);
    const paused = Boolean(await getServiceState('polling_paused_at'));
    if (scope.due && !paused) {
        if (!snapshot)
            snapshot = await captureMorningBrief(current);
        if (!snapshot.narrative)
            await enqueueBriefJob(snapshot.id, 'morning', snapshot.evidence, briefSemanticHash(snapshot.evidence), now);
        else if (compareBriefEvidence(snapshot.evidence, current).length)
            await enqueueBriefJob(snapshot.id, 'changes', current, briefSemanticHash(current), now);
    }
    if (!paused && ['workspace:gmail', 'workspace:microsoft'].includes(workspaceId))
        await setServiceState('morning_brief_requested:' + workspaceId, now);
    return { scope, current, snapshot, paused };
}
export function redactBriefNarrative(narrative: BriefNarrative | null, live: Map<string, BriefFact>): BriefNarrative | null {
    if (!narrative)
        return null;
    const project = (block: BriefNarrative['overview']) => block.sourceKeys.every(k => live.has(k)) ? block : { text: BRIEF_GENERIC.unavailable, sourceKeys: [] };
    return { ...narrative, overview: project(narrative.overview), priorities: narrative.priorities.map(project) };
}
export function attentionMetadata(current: BriefEvidence): Record<string, TodayAttentionMeta> {
    return Object.fromEntries(current.facts.filter(f => f.role === 'attention').map(f => {
        const source = f.sourceType === 'mail_thread' ? 'mail' : f.sourceType === 'calendar_event' ? 'calendar' : 'action_center';
        const statuses = current.coverage.filter(c => c.source === source && (c.accountId === null || c.accountId === f.accountId));
        return [f.sourceKey, { receivedAt: f.receivedAt, deadline: f.deadline, urgent: f.urgent, evidenceCurrent: statuses.length > 0 && statuses.every(c => c.status === 'current') }];
    }));
}
export async function getMorningBriefData(workspaceId: string, now: string, localPage?: TodayBrief): Promise<{
    morningBrief: MorningBriefView;
    timezone: string;
    attentionMetadata: Record<string, TodayAttentionMeta>;
}> {
    let timezone = 'America/Chicago';
    try {
        const { scope, current, snapshot, paused } = await prepareMorningBrief(workspaceId, now, localPage);
        timezone = scope.identity.timezone;
        const value = { ...unavailableMorningBrief(now, timezone), day: scope.day, scheduledLocalTime: scope.scheduledLocalTime, coverage: current.coverage, truncated: current.truncated };
        // Every displayed attention item receives exact metadata independently of the
        // bounded prose evidence. Source queries remain capped to 200 per batch.
        const attentionKeys = localPage ? [...localPage.needsAttention, ...localPage.carryovers].filter(i => i.role === 'attention').map(i => i.sourceKey) : [];
        const attentionFacts = attentionKeys.length ? [...(await lookupBriefSources(workspaceId, attentionKeys)).values()].map(f => ({ ...f, role: 'attention' as const })) : current.facts;
        const metadata = attentionMetadata({ ...current, facts: attentionFacts });
        const metadataScope = await morningScope(workspaceId, now);
        if (metadataScope.identity.scopeHash !== scope.identity.scopeHash)
            throw new Error('Brief scope changed');
        if (!snapshot) {
            value.status = !scope.due ? 'scheduled' : paused ? 'unavailable' : 'pending';
            return { morningBrief: value, timezone, attentionMetadata: metadata };
        }
        const allKeys = [...new Set([...snapshot.evidence.facts.map(f => f.sourceKey), ...current.facts.map(f => f.sourceKey)])];
        const live = await lookupBriefSources(workspaceId, allKeys, current);
        const morningLive = await lookupBriefSources(workspaceId, snapshot.evidence.facts.map(f => f.sourceKey), snapshot.evidence);
        // Resolve membership again after source reads before exposing cached content.
        const finalScope = await morningScope(workspaceId, now);
        if (finalScope.identity.scopeHash !== scope.identity.scopeHash || finalScope.identity.timezone !== scope.identity.timezone)
            throw new Error('Brief scope changed');
        const missing = allKeys.some(k => !live.has(k)) || snapshot.evidence.facts.some(f => !morningLive.has(f.sourceKey));
        const limited = missing || current.truncated || current.coverage.some(c => c.status !== 'current') || snapshot.evidence.truncated || snapshot.evidence.coverage.some(c => c.status !== 'current');
        const fresh = { ...current, facts: current.facts.filter(f => live.has(f.sourceKey)).map(f => ({ ...live.get(f.sourceKey)!, role: f.role, observedAt: now })), truncated: current.truncated || missing };
        const changes = compareBriefEvidence(snapshot.evidence, fresh);
        const changeNarrative = snapshot.narrative ? (await readBriefUpdate(snapshot.id, briefSemanticHash(fresh))) || deterministicBrief(fresh, changes) : null;
        value.status = snapshot.narrative ? (limited ? 'limited' : 'available') : 'pending';
        value.preparedAt = snapshot.evidence.capturedAt;
        value.narrative = redactBriefNarrative(snapshot.narrative, morningLive);
        value.changeNarrative = redactBriefNarrative(changeNarrative, live);
        value.changes = changes.map(({ id, kind, sourceKey, text }) => ({ id, kind, sourceKey, text }));
        value.sources = [...new Map([...live, ...morningLive]).values()].map(f => ({ sourceKey: f.sourceKey, target: f.target, currentState: f.state, changed: changes.some(c => c.sourceKey === f.sourceKey) }));
        value.truncated = fresh.truncated;
        return { morningBrief: value, timezone, attentionMetadata: metadata };
    }
    catch {
        return { morningBrief: unavailableMorningBrief(now, timezone), timezone, attentionMetadata: {} };
    }
}
export async function getMorningBriefView(workspaceId: string, now: string): Promise<MorningBriefView> { return (await getMorningBriefData(workspaceId, now)).morningBrief; }
