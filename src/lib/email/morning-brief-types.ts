import { z } from 'zod';
import type { ActionCenterTarget, TodayBriefSourceStatus, CalendarDateRange, BriefSourceType } from './types';
import { calendarDateInZone, validCalendarDate } from './calendar-day';
export type BriefIdentity = {
    workspaceId: string;
    day: string;
    timezone: string;
    scopeHash: string;
};
export type BriefFact = {
    sourceKey: string;
    sourceType: BriefSourceType;
    accountId: string | null;
    role: 'agenda' | 'attention' | 'fyi';
    state: 'open' | 'completed' | 'dismissed' | 'cancelled';
    title: string;
    summary: string;
    target: ActionCenterTarget;
    sourceRevisionAt: string;
    sourceOccurredAt: string;
    observedAt: string;
    firstSeenAt: string;
    receivedAt: string | null;
    deadline: string | null;
    startsAt: string | null;
    endsAt: string | null;
    dateRange: CalendarDateRange | null;
    urgent: boolean;
};
export type TodayAttentionMeta = Pick<BriefFact, 'receivedAt' | 'deadline' | 'urgent'> & {
    evidenceCurrent: boolean;
};
export type BriefEvidence = {
    version: 1;
    identity: BriefIdentity;
    accountIds: string[];
    capturedAt: string;
    scheduledLocalTime: string;
    facts: BriefFact[];
    coverage: TodayBriefSourceStatus[];
    truncated: boolean;
};
export type BriefTextBlock = {
    text: string;
    sourceKeys: string[];
};
export type BriefNarrative = {
    version: 1;
    mode: 'local_model' | 'deterministic';
    overview: BriefTextBlock;
    priorities: BriefTextBlock[];
};
export type BriefChange = {
    id: string;
    kind: 'new' | 'newly_found' | 'changed' | 'handled' | 'dismissed' | 'restored' | 'cancelled' | 'coverage';
    sourceKey: string | null;
    before: BriefFact | null;
    after: BriefFact | null;
    text: string;
};
export type StoredMorningBrief = {
    id: string;
    evidence: BriefEvidence;
    narrative: BriefNarrative | null;
    publishedAt: string | null;
};
export type BriefLease = {
    jobId: string;
    owner: string;
    generation: number;
};
export type BriefJob = {
    lease: BriefLease;
    kind: 'morning' | 'changes';
    snapshot: StoredMorningBrief;
    current: BriefEvidence;
    semanticHash: string;
};
export type MorningBriefView = {
    day: string;
    timezone: string;
    status: 'scheduled' | 'pending' | 'available' | 'limited' | 'unavailable';
    scheduledLocalTime: string;
    preparedAt: string | null;
    checkedAt: string;
    narrative: BriefNarrative | null;
    changes: Array<Pick<BriefChange, "id" | "kind" | "sourceKey" | "text">>;
    changeNarrative: BriefNarrative | null;
    sources: Array<{
        sourceKey: string;
        target: ActionCenterTarget;
        currentState: BriefFact['state'];
        changed: boolean;
    }>;
    coverage: TodayBriefSourceStatus[];
    truncated: boolean;
};
const iso = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)));
const id = z.string().trim().min(1).max(240);
const day = z.string().refine(validCalendarDate);
export const briefIdentitySchema = z.object({ workspaceId: id, day, timezone: z.string().min(1).max(100).refine(v => { try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return true;
    }
    catch {
        return false;
    } }), scopeHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const target = z.discriminatedUnion('view', [
    z.object({ view: z.literal('mail'), messageId: id }).strict(),
    z.object({ view: z.literal('drafts'), draftId: id.optional(), messageId: id.optional() }).strict(),
    z.object({ view: z.literal('outbox'), draftId: id.optional() }).strict(),
    z.object({ view: z.literal('calendar'), draftId: id.optional(), eventId: id.optional(), date: day.optional() }).strict(),
    z.object({ view: z.literal('today'), messageId: id.optional() }).strict(),
    z.object({ view: z.literal('settings'), accountId: id.optional() }).strict()
]);
export const briefFactSchema = z.object({ sourceKey: id, sourceType: z.enum(['mail_thread', 'calendar_event', 'action_center']), accountId: id.nullable(), role: z.enum(['agenda', 'attention', 'fyi']), state: z.enum(['open', 'completed', 'dismissed', 'cancelled']), title: z.string().max(300), summary: z.string().max(700), target, sourceRevisionAt: iso, sourceOccurredAt: iso, observedAt: iso, firstSeenAt: iso, receivedAt: iso.nullable(), deadline: iso.nullable(), startsAt: iso.nullable(), endsAt: iso.nullable(), dateRange: z.object({ startDate: day, endDate: day }).strict().refine(v => v.startDate < v.endDate).nullable(), urgent: z.boolean() }).strict();
export const briefCoverageSchema = z.object({ source: z.enum(['mail', 'calendar', 'action_center', 'activity', 'freshness', 'sent']), status: z.enum(['current', 'stale', 'unavailable', 'truncated', 'error']), accountId: id.nullable(), checkedAt: iso.nullable(), detail: z.string().max(2000).nullable() }).strict();
export const briefEvidenceSchema = z.object({ version: z.literal(1), identity: briefIdentitySchema, accountIds: z.array(id).max(100), capturedAt: iso, scheduledLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), facts: z.array(briefFactSchema).max(200), coverage: z.array(briefCoverageSchema).max(700), truncated: z.boolean() }).strict().superRefine((value, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 262144)
        invalid('Evidence is too large');
    try {
        if (calendarDateInZone(value.capturedAt, value.identity.timezone) !== value.identity.day)
            invalid('Capture day differs');
    }
    catch {
        invalid('Capture time or timezone is invalid');
    }
    if (new Set(value.accountIds).size !== value.accountIds.length)
        invalid('Duplicate account');
    if (new Set(value.facts.map(f => f.sourceKey)).size !== value.facts.length)
        invalid('Duplicate source');
    const allowed = new Set(value.accountIds);
    for (const f of value.facts) {
        if (f.accountId !== null && !allowed.has(f.accountId))
            invalid('Foreign account');
        if (f.accountId === null && (f.sourceType !== 'action_center' || value.identity.workspaceId !== 'workspace:all'))
            invalid('Unscoped source');
        if (f.sourceType === 'mail_thread' && (!f.sourceKey.startsWith('mail:' + f.accountId + ':') || f.target.view !== 'mail'))
            invalid('Mail source mismatch');
        if (f.sourceType === 'calendar_event' && (!f.sourceKey.startsWith('calendar:' + f.accountId + ':') || f.target.view !== 'calendar' || !f.target.eventId))
            invalid('Calendar source mismatch');
        if (f.sourceType === 'action_center' && !f.sourceKey.startsWith('action:'))
            invalid('Action source mismatch');
        if (f.target.view === 'settings' && f.target.accountId && !allowed.has(f.target.accountId))
            invalid('Foreign target');
    }
    for (const c of value.coverage)
        if (c.accountId && !allowed.has(c.accountId))
            invalid('Foreign coverage');
});
const block = z.object({ text: z.string().min(1).max(1200), sourceKeys: z.array(id).max(24).refine(v => new Set(v).size === v.length) }).strict();
export const briefNarrativeSchema = z.object({ version: z.literal(1), mode: z.enum(['local_model', 'deterministic']), overview: block, priorities: z.array(block.extend({ text: z.string().min(1).max(500) })).max(3) }).strict();
export function parseBriefNarrative(value: unknown, evidence: BriefEvidence): BriefNarrative {
    const parsed = briefNarrativeSchema.parse(value);
    const allowed = new Set(evidence.facts.map(f => f.sourceKey));
    for (const b of [parsed.overview, ...parsed.priorities])
        if (b.sourceKeys.some(k => !allowed.has(k)))
            throw new Error('Unknown brief reference');
    return parsed;
}
