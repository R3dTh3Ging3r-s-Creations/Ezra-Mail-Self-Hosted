import { randomUUID } from 'node:crypto';
import { execute, getServiceState, setServiceState, nowIso } from './database';
import { claimBriefJob, publishBriefJob, pruneMorningBriefs, releaseBriefLease } from './morning-brief-store';
import { prepareMorningBrief, redactBriefNarrative } from './morning-brief-view';
import { lookupBriefSources } from './morning-brief-facts';
import { createBriefNarrative } from './morning-brief-copy';
import { compareBriefEvidence } from './morning-brief-changes';
import type { BriefLease } from './morning-brief-types';
let active: {
    controller: AbortController;
    lease: BriefLease | null;
} | null = null;
export function stopMorningBriefWork() { active?.controller.abort(); if (active?.lease)
    void releaseBriefLease(active.lease).catch(() => { }); }
export async function runMorningBriefWork(now = nowIso()): Promise<void> {
    if (active)
        return;
    const run = { controller: new AbortController(), lease: null as BriefLease | null };
    active = run;
    const started = Date.now();
    const clock = () => new Date(Date.parse(now) + Math.max(0, Date.now() - started)).toISOString();
    try {
        if (await getServiceState('polling_paused_at'))
            return;
        const accounts = (await execute("SELECT id,provider FROM email_accounts WHERE status<>'disabled' ORDER BY created_at,id LIMIT 100")).rows;
        const requests = (await execute("SELECT key,value FROM service_state WHERE key LIKE 'morning_brief_requested:%' OR key LIKE 'morning_brief_checked:%'")).rows;
        const states = new Map(requests.map(r => [String(r.key), String(r.value)]));
        const workspaces = [...new Set([...accounts.map(r => 'workspace:account:' + r.provider + ':' + r.id), 'workspace:all', ...['workspace:gmail', 'workspace:microsoft'].filter(w => states.has('morning_brief_requested:' + w))])];
        workspaces.sort((a, b) => (states.get('morning_brief_checked:' + a) || '').localeCompare(states.get('morning_brief_checked:' + b) || '') || a.localeCompare(b));
        for (const workspace of workspaces.slice(0, 4)) {
            if (run.controller.signal.aborted || await getServiceState('polling_paused_at'))
                return;
            try {
                await prepareMorningBrief(workspace, clock());
            }
            catch { /* A removed workspace must not starve other requests. */ }
            await setServiceState('morning_brief_checked:' + workspace, clock());
        }
        if (run.controller.signal.aborted || await getServiceState('polling_paused_at'))
            return;
        const job = await claimBriefJob(randomUUID(), clock());
        if (!job) {
            await pruneMorningBriefs(clock());
            return;
        }
        run.lease = job.lease;
        const evidence = job.kind === 'morning' ? job.snapshot.evidence : job.current;
        const narrative = await createBriefNarrative(evidence, { signal: run.controller.signal, ...(job.kind === 'changes' ? { changes: compareBriefEvidence(job.snapshot.evidence, job.current) } : {}) });
        if (run.controller.signal.aborted || await getServiceState('polling_paused_at'))
            return;
        const live = await lookupBriefSources(evidence.identity.workspaceId, evidence.facts.map(f => f.sourceKey), evidence);
        if (run.controller.signal.aborted)
            return;
        await publishBriefJob(job.lease, redactBriefNarrative(narrative, live)!, clock());
    }
    catch {
        process.stderr.write('Ezra morning brief is unavailable; retrying on the next interval.\n');
    }
    finally {
        if (run.lease)
            await releaseBriefLease(run.lease).catch(() => { });
        if (active === run)
            active = null;
    }
}
