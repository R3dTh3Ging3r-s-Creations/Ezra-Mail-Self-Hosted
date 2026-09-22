import { describe, it, expect } from 'vitest';
import { briefDue, briefIdentity, retentionDay } from '@/lib/email/morning-brief-time';
describe('morning brief civil time', () => {
    it('uses the first configured local time and does not prepare early', () => {
        expect(briefDue('2026-09-21T13:29:00Z', 'America/Chicago', ['16:30', '08:30']).due).toBe(false);
        expect(briefDue('2026-09-21T13:30:00Z', 'America/Chicago', ['16:30', '08:30']).due).toBe(true);
        expect(briefDue('2026-09-21T19:30:00Z', 'America/Chicago', [])).toMatchObject({ day: '2026-09-21', due: true, scheduledLocalTime: '08:30' });
    });
    it('uses one day across repeated hours and skips a missing spring hour honestly', () => {
        expect(briefDue('2026-11-01T06:30:00Z', 'America/Chicago', ['01:30']).day).toBe(briefDue('2026-11-01T07:30:00Z', 'America/Chicago', ['01:30']).day);
        expect(briefDue('2026-03-08T08:00:00Z', 'America/Chicago', ['02:30']).due).toBe(true);
        expect(retentionDay('2026-11-15T17:00:00Z', 'America/Chicago')).toBe('2026-10-16');
    });
    it('canonicalizes scope order but separates membership, timezone and day', () => {
        const accounts = [{ id: 'a', provider: 'gmail' }, { id: 'b', provider: 'microsoft' }];
        const one = briefIdentity('workspace:all', accounts, 'America/Chicago', '2026-09-21T14:00:00Z');
        expect(briefIdentity('workspace:all', [...accounts].reverse(), 'America/Chicago', '2026-09-21T16:00:00Z')).toEqual(one);
        expect(briefIdentity('workspace:all', accounts.slice(1), 'America/Chicago', '2026-09-21T14:00:00Z').scopeHash).not.toBe(one.scopeHash);
        expect(briefIdentity('workspace:all', accounts, 'UTC', '2026-09-21T14:00:00Z')).not.toEqual(one);
        expect(briefIdentity('workspace:all', accounts, 'America/Chicago', '2026-09-22T14:00:00Z').day).not.toBe(one.day);
    });
    it('rejects invalid zones, dates and duplicate account identities', () => {
        expect(() => briefDue('broken', 'America/Chicago', [])).toThrow();
        expect(() => briefDue('2026-09-21T14:00:00Z', 'Not/AZone', [])).toThrow();
        expect(() => briefIdentity('workspace:all', [{ id: 'a', provider: 'gmail' }, { id: 'a', provider: 'gmail' }], 'UTC', '2026-09-21T14:00:00Z')).toThrow();
    });
});
