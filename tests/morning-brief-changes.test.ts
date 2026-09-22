import { describe, it, expect } from 'vitest';
import { compareBriefEvidence, briefSemanticHash } from '@/lib/email/morning-brief-changes';
import { evidence, fact, NOW } from './fixtures/morning-brief';
const later = '2026-09-21T15:00:00.000Z';
describe('meaningful differences from the frozen morning', () => {
    it('ignores refresh times, prose and incidental ordering', () => {
        const baseline = evidence({ facts: [fact(), fact({ sourceKey: 'mail:gmail-1:two' })] });
        const current = evidence({ capturedAt: later, facts: [fact({ sourceKey: 'mail:gmail-1:two', observedAt: later }), fact({ title: 'Reworded', summary: 'Different prose', firstSeenAt: later })], coverage: baseline.coverage.map(c => ({ ...c, checkedAt: later, detail: 'Refreshed' })) });
        expect(compareBriefEvidence(baseline, current)).toEqual([]);
        expect(briefSemanticHash(current)).toBe(briefSemanticHash(baseline));
    });
    it('distinguishes late discovery from new arrivals', () => {
        const baseline = evidence({ facts: [] });
        expect(compareBriefEvidence(baseline, evidence({ facts: [fact({ receivedAt: '2026-09-18T10:00:00Z', sourceOccurredAt: '2026-09-18T10:00:00Z' })] }))[0].kind).toBe('newly_found');
        expect(compareBriefEvidence(baseline, evidence({ facts: [fact({ receivedAt: later, sourceOccurredAt: later })] }))[0].kind).toBe('new');
    });
    it('reports one net state change and no repeated acknowledgement', () => {
        const handled = evidence({ facts: [fact({ state: 'completed', sourceRevisionAt: later })] });
        expect(compareBriefEvidence(evidence(), handled).map(c => c.kind)).toEqual(['handled']);
        expect(compareBriefEvidence(handled, handled)).toEqual([]);
        expect(compareBriefEvidence(handled, evidence()).map(c => c.kind)).toEqual(['restored']);
        expect(compareBriefEvidence(evidence(), evidence({ facts: [fact({ state: 'dismissed' })] }))[0].kind).toBe('dismissed');
    });
    it('requires explicit cancellation and sees meetings moved outside today', () => {
        const meeting = fact({ sourceType: 'calendar_event', sourceKey: 'calendar:gmail-1:event', target: { view: 'calendar', eventId: 'event' }, role: 'agenda', startsAt: NOW, endsAt: later });
        const baseline = evidence({ facts: [meeting] });
        expect(compareBriefEvidence(baseline, evidence({ facts: [{ ...meeting, startsAt: '2026-09-22T14:00:00Z' }] }))[0].kind).toBe('changed');
        expect(compareBriefEvidence(baseline, evidence({ facts: [{ ...meeting, state: 'cancelled' }] }))[0].kind).toBe('cancelled');
        expect(compareBriefEvidence(baseline, evidence({ facts: [] }))).toEqual([]);
    });
    it('does not infer completion from missing or truncated sources', () => {
        const current = evidence({ facts: [], truncated: true, coverage: [{ ...evidence().coverage[0], status: 'stale' }] });
        expect(compareBriefEvidence(evidence(), current).every(c => c.kind === 'coverage')).toBe(true);
        expect(briefSemanticHash(current)).not.toBe(briefSemanticHash(evidence()));
        expect(compareBriefEvidence(evidence(), current)).toEqual(compareBriefEvidence(evidence(), { ...current, capturedAt: later }));
    });
    it('rejects cross-scope and timezone comparisons', () => {
        for (const identity of [{ ...evidence().identity, scopeHash: 'b'.repeat(64) }, { ...evidence().identity, timezone: 'UTC' }])
            expect(() => compareBriefEvidence(evidence(), evidence({ identity }))).toThrow();
    });
});
