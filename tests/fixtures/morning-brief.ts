import type { BriefFact, BriefEvidence } from '@/lib/email/morning-brief-types';
import { briefIdentity } from '@/lib/email/morning-brief-time';
export const NOW = '2026-09-21T14:00:00.000Z';
export function fact(patch: Partial<BriefFact> = {}): BriefFact {
    return { sourceKey: 'mail:gmail-1:thread-1', sourceType: 'mail_thread',
        accountId: 'gmail-1', role: 'attention', state: 'open',
        title: 'Synthetic supplier question', summary: 'A reply is requested.',
        target: { view: 'mail', messageId: 'message-1' },
        sourceRevisionAt: NOW, sourceOccurredAt: NOW, observedAt: NOW,
        firstSeenAt: NOW, receivedAt: NOW, deadline: null,
        startsAt: null, endsAt: null, dateRange: null, urgent: false, ...patch };
}
export function evidence(patch: Partial<BriefEvidence> = {}): BriefEvidence {
    return { version: 1, identity: briefIdentity('workspace:account:gmail:gmail-1', [{ id: 'gmail-1', provider: 'gmail' }], 'America/Chicago', NOW),
        accountIds: ['gmail-1'], capturedAt: NOW, scheduledLocalTime: '08:30',
        facts: [fact()], coverage: [{ source: 'mail', status: 'current',
                accountId: 'gmail-1', checkedAt: NOW, detail: null }],
        truncated: false, ...patch };
}
