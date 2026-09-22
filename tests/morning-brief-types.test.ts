import { describe, it, expect } from 'vitest';
import { briefEvidenceSchema, parseBriefNarrative } from '@/lib/email/morning-brief-types';
import { evidence, fact } from './fixtures/morning-brief';
describe('morning evidence boundary', () => {
    it('accepts scoped versioned evidence and rejects unknown versions and foreign identities', () => {
        expect(briefEvidenceSchema.safeParse(evidence()).success).toBe(true);
        for (const patch of [{ version: 2 }, { accountIds: ['another'] }, { facts: [fact({ accountId: 'another' })] }, { facts: [fact(), fact()] }, { facts: [fact({ sourceKey: 'mail:other:thread-1' })] }])
            expect(briefEvidenceSchema.safeParse({ ...evidence(), ...patch }).success).toBe(false);
    });
    it('rejects malformed dates, capture day mismatches, duplicate accounts and oversized data', () => {
        for (const patch of [{ capturedAt: 'bad' }, { identity: { ...evidence().identity, day: '2026-09-20' } }, { accountIds: ['gmail-1', 'gmail-1'] }, { facts: [fact({ summary: 'x'.repeat(701) })] }, { facts: Array.from({ length: 201 }, (_, i) => fact({ sourceKey: 'mail:gmail-1:' + i })) }])
            expect(briefEvidenceSchema.safeParse({ ...evidence(), ...patch }).success).toBe(false);
    });
    it('accepts known references but rejects foreign targets and model references', () => {
        expect(briefEvidenceSchema.safeParse(evidence({ facts: [fact({ target: { view: 'settings', accountId: 'other' } })] })).success).toBe(false);
        const copy = { version: 1, mode: 'deterministic', overview: { text: 'One item to review.', sourceKeys: [fact().sourceKey] }, priorities: [] };
        expect(parseBriefNarrative(copy, evidence()).overview.text).toBe('One item to review.');
        expect(() => parseBriefNarrative({ ...copy, overview: { text: 'Other', sourceKeys: ['mail:other:a'] } }, evidence())).toThrow();
    });
});
