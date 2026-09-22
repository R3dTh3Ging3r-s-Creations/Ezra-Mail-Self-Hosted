import { createHash } from 'node:crypto';
import { calendarDateInZone } from './calendar-day';
import type { BriefIdentity } from './morning-brief-types';
function local(now: string, timezone: string) {
    if (!Number.isFinite(Date.parse(now)))
        throw new Error('Brief time is invalid');
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
    return { day: calendarDateInZone(now, timezone), time: parts.find(p => p.type === 'hour')!.value + ':' + parts.find(p => p.type === 'minute')!.value };
}
export function briefDue(now: string, timezone: string, digestTimes: string[]) {
    const times = [...new Set(digestTimes.filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort();
    const scheduledLocalTime = times[0] || '08:30';
    const value = local(now, timezone);
    return { day: value.day, due: value.time >= scheduledLocalTime, scheduledLocalTime };
}
export function briefIdentity(workspaceId: string, accounts: Array<{
    id: string;
    provider: string;
}>, timezone: string, now: string): BriefIdentity {
    const ids = new Set(accounts.map(a => a.id));
    if (ids.size !== accounts.length || !workspaceId.trim() || accounts.some(a => !a.id.trim() || !['gmail', 'microsoft'].includes(a.provider)))
        throw new Error('Brief scope is invalid');
    const canonical = accounts.map(a => [a.id, a.provider]).sort((a, b) => a[0].localeCompare(b[0]));
    return { workspaceId, day: local(now, timezone).day, timezone, scopeHash: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
}
export function retentionDay(now: string, timezone: string) { const date = new Date(local(now, timezone).day + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() - 30); return date.toISOString().slice(0, 10); }
