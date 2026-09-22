import { execute, getSetting, nowIso } from './database';
import { resolveBriefWorkspace, ALL_WORKSPACE_ID } from './workspaces';
import { getLocalTodayBrief } from './today-brief';
import { getActionCenter } from './action-center';
import { calendarDateInZone, calendarDateRange } from './calendar-day';
import { briefDue, briefIdentity } from './morning-brief-time';
import { briefEvidenceSchema, briefFactSchema, type BriefEvidence, type BriefFact } from './morning-brief-types';
import type { ActionCenterTarget, TodayBrief } from './types';
const marks = (values: unknown[]) => values.map(() => '?').join(',');
const iso = (v: unknown): string | null => {
    if (typeof v !== 'string' || !v || !Number.isFinite(Date.parse(v)))
        return null;
    return new Date(v).toISOString();
};
const text = (v: unknown, max: number) => String(v || '').slice(0, max);
export async function collectMorningEvidence(workspaceId: string, now: string, baseline?: BriefEvidence, localPage?: TodayBrief): Promise<BriefEvidence> {
    const workspace = await resolveBriefWorkspace(workspaceId);
    const timezone = (await getSetting('timezone')) || 'America/Chicago';
    const accounts = (await execute("SELECT id,provider FROM email_accounts WHERE status <> 'disabled'")).rows.filter(r => workspace.accountIds.includes(String(r.id))).map(r => ({ id: String(r.id), provider: String(r.provider) }));
    const identity = briefIdentity(workspace.id, accounts, timezone, now);
    if (baseline && ['workspaceId', 'day', 'timezone', 'scopeHash'].some(k => identity[k as keyof typeof identity] !== baseline.identity[k as keyof typeof identity]))
        throw new Error('Brief baseline scope differs');
    const page = localPage || await getLocalTodayBrief({ workspaceId: workspace.id, now });
    const items = [...page.agenda, ...page.needsAttention, ...page.carryovers, ...page.completedSinceLastBrief];
    const keys = new Set([...items.map(i => i.sourceKey), ...(baseline?.facts.map(f => f.sourceKey) || [])]);
    const topicIds = page.topics.map(t => t.id).slice(0, 200);
    if (topicIds.length) {
        const rows = await execute('SELECT account_id,thread_id FROM email_messages WHERE id IN (' + marks(topicIds) + ')', topicIds);
        for (const r of rows.rows)
            if (workspace.accountIds.includes(String(r.account_id)))
                keys.add('mail:' + r.account_id + ':' + r.thread_id);
    }
    const allKeys = [...keys];
    // Admit new material sources even when the immutable morning baseline is full.
    // Baseline citations are independently checked at publication/projection.
    const baselineKeys = new Set(baseline?.facts.map(f => f.sourceKey) || []);
    const selected = [...allKeys.filter(k => !baselineKeys.has(k)), ...allKeys.filter(k => baselineKeys.has(k))].slice(0, 200);
    const found = await lookupBriefSources(workspace.id, selected);
    const roles = new Map(items.map(i => [i.sourceKey, i.role]));
    const facts = [...found.values()].map(f => ({ ...f, role: roles.get(f.sourceKey) || baseline?.facts.find(b => b.sourceKey === f.sourceKey)?.role || (f.target.view === 'mail' && page.topics.some(t => t.id === (f.target as {
            messageId: string;
        }).messageId && t.kind === 'fyi') ? 'fyi' as const : f.role), observedAt: now }));
    let times: string[] = [];
    try {
        const value = JSON.parse((await getSetting('digest_times')) || '[]');
        if (Array.isArray(value))
            times = value.filter((v): v is string => typeof v === 'string');
    }
    catch { }
    const coverage = page.sourceStatus.filter(c => c.source !== 'sent' && (c.accountId === null || workspace.accountIds.includes(c.accountId)));
    let truncated = allKeys.length > 200 || coverage.some(c => c.status === 'truncated');
    const result = { version: 1 as const, identity, accountIds: accounts.map(a => a.id).sort(), capturedAt: now, scheduledLocalTime: briefDue(now, timezone, times).scheduledLocalTime, facts, coverage, truncated };
    while (Buffer.byteLength(JSON.stringify(result), 'utf8') > 262144 && result.facts.length) {
        result.facts.pop();
        truncated = true;
        result.truncated = true;
    }
    return briefEvidenceSchema.parse(result);
}
/** Exact source identity lookup, including calendar rows omitted from the live agenda. */
export async function lookupBriefSources(workspaceId: string, keys: string[], support?: BriefEvidence): Promise<Map<string, BriefFact>> {
    const workspace = await resolveBriefWorkspace(workspaceId);
    const requested = [...new Set(keys)];
    if (requested.length > 200) {
        const combined = new Map<string, BriefFact>();
        for (let offset = 0; offset < requested.length; offset += 200) {
            const batch = await lookupBriefSources(workspace.id, requested.slice(offset, offset + 200), support);
            for (const [key, value] of batch)
                combined.set(key, value);
        }
        const finalScope = await resolveBriefWorkspace(workspace.id);
        return [...finalScope.accountIds].sort().join('|') === [...workspace.accountIds].sort().join('|') ? combined : new Map();
    }
    const result = new Map<string, BriefFact>();
    if (!requested.length)
        return result;
    const timezone = (await getSetting('timezone')) || 'America/Chicago';
    const now = nowIso();
    const memories = (await execute('SELECT * FROM brief_item_memory WHERE workspace_id=? AND source_key IN (' + marks(requested) + ')', [workspace.id, ...requested])).rows;
    const memory = new Map(memories.map(r => [String(r.source_key), r]));
    function add(raw: BriefFact) {
        const stored = memory.get(raw.sourceKey);
        if (stored && (stored.source_account_id === raw.accountId || (stored.source_account_id === null && raw.accountId === null))) {
            raw.firstSeenAt = iso(stored.first_seen_at) || raw.firstSeenAt;
            const state = String(stored.state);
            const newerRevision = Date.parse(raw.sourceRevisionAt) > Date.parse(String(stored.source_revision_at));
            const decisionAt = state === 'completed' ? stored.completed_at : stored.dismissed_at;
            const newerDecision = state === 'open' || Date.parse(raw.sourceRevisionAt) > Date.parse(String(decisionAt));
            // Match brief-memory: delayed synchronization cannot undo an owner decision.
            if (raw.state !== 'cancelled' && ['open', 'completed', 'dismissed'].includes(state) && !(newerRevision && newerDecision))
                raw.state = state as BriefFact['state'];
        }
        const parsed = briefFactSchema.safeParse(raw);
        if (parsed.success)
            result.set(raw.sourceKey, parsed.data);
    }
    function base(key: string, accountId: string | null): BriefFact { return { sourceKey: key, accountId, sourceType: 'mail_thread', role: 'attention', state: 'open', title: '', summary: '', target: { view: 'today' }, sourceRevisionAt: now, sourceOccurredAt: now, observedAt: now, firstSeenAt: now, receivedAt: null, deadline: null, startsAt: null, endsAt: null, dateRange: null, urgent: false }; }
    if (workspace.accountIds.length) {
        const args = [...workspace.accountIds, ...requested];
        const mail = await execute("SELECT m.*,t.summary AS triage_summary,t.deadline,COALESCE(t.user_corrected_attention,t.attention) AS current_attention FROM email_messages m LEFT JOIN triage_decisions t ON t.id=(SELECT t2.id FROM triage_decisions t2 WHERE t2.message_id=m.id ORDER BY t2.created_at DESC,t2.id DESC LIMIT 1) WHERE m.account_id IN (" + marks(workspace.accountIds) + ") AND ('mail:'||m.account_id||':'||m.thread_id) IN (" + marks(requested) + ") AND m.id=(SELECT m2.id FROM email_messages m2 WHERE m2.account_id=m.account_id AND m2.thread_id=m.thread_id ORDER BY m2.received_at DESC,m2.id DESC LIMIT 1)", args);
        for (const row of mail.rows) {
            const received = iso(row.received_at);
            if (!received)
                continue;
            const key = 'mail:' + row.account_id + ':' + row.thread_id;
            add({ ...base(key, String(row.account_id)), title: text(row.subject, 300), summary: text(row.triage_summary || row.snippet, 700), target: { view: 'mail', messageId: String(row.id) }, sourceRevisionAt: received, sourceOccurredAt: received, receivedAt: received, deadline: iso(row.deadline), urgent: row.current_attention === 'interrupt' });
        }
        const calendar = await execute("SELECT * FROM calendar_events WHERE account_id IN (" + marks(workspace.accountIds) + ") AND ('calendar:'||account_id||':'||external_event_id) IN (" + marks(requested) + ")", args);
        for (const row of calendar.rows) {
            const startsAt = iso(row.starts_at), endsAt = iso(row.ends_at), revision = iso(row.provider_updated_at) || iso(row.created_at) || startsAt;
            if (!startsAt || !endsAt || !revision)
                continue;
            const dateRange = Number(row.is_all_day) ? calendarDateRange(row.start_date, row.end_date) : null;
            add({ ...base('calendar:' + row.account_id + ':' + row.external_event_id, String(row.account_id)), sourceType: 'calendar_event', role: 'agenda', state: row.status === 'cancelled' ? 'cancelled' : 'open', title: text(row.title, 300), summary: text(row.location, 700), target: { view: 'calendar', eventId: String(row.id), date: dateRange?.startDate || calendarDateInZone(startsAt, timezone) }, sourceRevisionAt: revision, sourceOccurredAt: startsAt, startsAt, endsAt, dateRange });
        }
    }
    if (requested.some(k => k.startsWith('action:'))) {
        const actions = await getActionCenter({ workspaceId: workspace.id, includeCleanup: false });
        for (const section of actions.sections) {
            if (!['approvals', 'repairs'].includes(section.id))
                continue;
            for (const item of section.items) {
                const key = 'action:' + item.id;
                if (!requested.includes(key) || !(item.accountId === null ? workspace.id === ALL_WORKSPACE_ID : workspace.accountIds.includes(item.accountId)))
                    continue;
                const revision = iso(item.updatedAt);
                if (!revision || !await validTarget(item.target, item.accountId))
                    continue;
                add({ ...base(key, item.accountId), sourceType: 'action_center', title: text(item.title, 300), summary: text(item.detail || item.subtitle, 700), target: item.target, sourceRevisionAt: revision, sourceOccurredAt: revision });
            }
        }
    }
    // A thread can survive deletion of the exact message that supported cached prose.
    // Keep the thread's current state, but validate and retain the original citation.
    if (support) {
        for (const fact of support.facts) {
            const live = result.get(fact.sourceKey);
            if (!live)
                continue;
            if (!await validTarget(fact.target, fact.accountId))
                result.delete(fact.sourceKey);
            else
                result.set(fact.sourceKey, { ...live, target: fact.target });
        }
    }
    // Resolve scope again after asynchronous readers, including account removal during a read.
    const finalScope = await resolveBriefWorkspace(workspace.id);
    if ([...finalScope.accountIds].sort().join('|') !== [...workspace.accountIds].sort().join('|'))
        return new Map();
    return result;
}
async function validTarget(target: ActionCenterTarget, accountId: string | null): Promise<boolean> {
    if (target.view === 'settings')
        return !target.accountId || target.accountId === accountId;
    if ('messageId' in target && target.messageId) {
        if (!accountId || !(await execute('SELECT id FROM email_messages WHERE id=? AND account_id=?', [target.messageId, accountId])).rows.length)
            return false;
    }
    if ('eventId' in target && target.eventId) {
        if (!accountId || !(await execute('SELECT id FROM calendar_events WHERE id=? AND account_id=?', [target.eventId, accountId])).rows.length)
            return false;
    }
    if ('draftId' in target && target.draftId) {
        if (!accountId)
            return false;
        const table = target.view === 'calendar' ? 'calendar_drafts' : 'outgoing_drafts';
        const match = await execute('SELECT id FROM ' + table + ' WHERE id=? AND account_id=?', [target.draftId, accountId]);
        if (!match.rows.length) {
            if (target.view === 'calendar')
                return false;
            const legacy = await execute('SELECT d.id FROM reply_drafts d JOIN email_messages m ON m.id=d.message_id WHERE d.id=? AND m.account_id=?', [target.draftId, accountId]);
            if (!legacy.rows.length)
                return false;
        }
    }
    return true;
}
