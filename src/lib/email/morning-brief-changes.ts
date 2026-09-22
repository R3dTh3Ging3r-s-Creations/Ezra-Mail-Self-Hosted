import { createHash } from 'node:crypto';
import type { BriefEvidence, BriefFact, BriefChange } from './morning-brief-types';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function semanticFact(f: BriefFact) { return [f.sourceKey, f.sourceType, f.accountId, f.target, f.role, f.state, f.sourceRevisionAt, f.sourceOccurredAt, f.receivedAt, f.deadline, f.startsAt, f.endsAt, f.dateRange, f.urgent, ...(f.sourceType === 'calendar_event' ? [f.title, f.summary] : [])]; }
function coverage(e: BriefEvidence) { return e.coverage.map(c => [c.source, c.accountId, c.status]).sort((a, b) => order(JSON.stringify(a), JSON.stringify(b))); }
export function briefSemanticHash(current: BriefEvidence) { return hash([current.identity, current.facts.map(semanticFact).sort((a, b) => order(String(a[0]), String(b[0]))), coverage(current), current.truncated]); }
export function compareBriefEvidence(baseline: BriefEvidence, current: BriefEvidence): BriefChange[] {
    if (['workspaceId', 'day', 'timezone', 'scopeHash'].some(k => baseline.identity[k as keyof typeof baseline.identity] !== current.identity[k as keyof typeof current.identity]))
        throw new Error('Brief identities differ');
    const previous = new Map(baseline.facts.map(f => [f.sourceKey, f]));
    const changes: BriefChange[] = [];
    for (const after of [...current.facts].sort((a, b) => order(a.sourceKey, b.sourceKey))) {
        const before = previous.get(after.sourceKey) || null;
        let kind: BriefChange['kind'] | null = null;
        if (!before) {
            if (after.state === 'open')
                kind = Date.parse(after.sourceOccurredAt) < Date.parse(baseline.capturedAt) ? 'newly_found' : 'new';
        }
        else if (before.state !== after.state)
            kind = after.state === 'completed' ? 'handled' : after.state === 'dismissed' ? 'dismissed' : after.state === 'cancelled' ? 'cancelled' : 'restored';
        else if (hash(semanticFact(before)) !== hash(semanticFact(after)))
            kind = 'changed';
        if (kind) {
            const labels = { new: 'New', newly_found: 'Newly found', changed: 'Changed', handled: 'Marked handled', dismissed: 'Dismissed', restored: 'Brought back', cancelled: 'Cancelled', coverage: 'Coverage' };
            changes.push({ id: hash([current.identity, after.sourceKey, kind, semanticFact(after)]), kind, sourceKey: after.sourceKey, before, after, text: labels[kind] + ': ' + after.title });
        }
    }
    const oldCoverage = new Map(baseline.coverage.map(c => [c.source + ':' + (c.accountId || ''), c.status]));
    for (const c of [...current.coverage].sort((a, b) => order(a.source + ':' + a.accountId, b.source + ':' + b.accountId))) {
        const key = c.source + ':' + (c.accountId || '');
        if (oldCoverage.get(key) !== c.status)
            changes.push({ id: hash([current.identity, 'coverage', key, c.status]), kind: 'coverage', sourceKey: null, before: null, after: null, text: c.source.replace('_', ' ') + (c.status === 'current' ? ' is current.' : ' coverage is ' + c.status + '.') });
    }
    if (baseline.truncated !== current.truncated)
        changes.push({ id: hash([current.identity, 'truncated', current.truncated]), kind: 'coverage', sourceKey: null, before: null, after: null, text: current.truncated ? 'Some sources exceed the brief limit.' : 'The brief is no longer truncated.' });
    return changes;
}
