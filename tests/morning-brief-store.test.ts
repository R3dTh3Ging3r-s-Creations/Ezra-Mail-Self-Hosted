import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, execute } from '@/lib/email/database';
import { captureMorningBrief, readMorningBrief, enqueueBriefJob, claimBriefJob, publishBriefJob, pruneMorningBriefs } from '@/lib/email/morning-brief-store';
import { briefIdentity } from '@/lib/email/morning-brief-time';
import { evidence, fact, NOW } from './fixtures/morning-brief';
const hash = 'a'.repeat(64);
const copy = { version: 1 as const, mode: 'deterministic' as const, overview: { text: 'One question needs a reply.', sourceKeys: [fact().sourceKey] }, priorities: [] };
beforeEach(async () => { configureEmailDatabaseForTests('file:./morning-store-' + randomUUID() + '.sqlite'); await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES ('gmail-1','gmail','owner@example.test','Synthetic','connected',?,?)", [NOW, NOW]); });
afterEach(() => closeEmailDatabaseForTests());
describe('immutable morning snapshots', () => {
 it('rejects a forged update account list and does not read a forged persisted envelope',async()=>{
  const row=await captureMorningBrief(evidence());
  const forged=evidence({accountIds:['other'],facts:[fact({accountId:'other',sourceKey:'mail:other:thread-1'})],coverage:[]});
  await expect(enqueueBriefJob(row.id,'changes',forged,hash,NOW)).rejects.toThrow();
  await execute('UPDATE morning_brief_snapshots SET evidence_json=? WHERE id=?',[JSON.stringify(forged),row.id]);
  expect(await readMorningBrief(row.evidence.identity)).toBeNull();
 });
    it('captures one baseline across concurrent requests and preserves it after reopening', async () => {
        const [a, b] = await Promise.all([captureMorningBrief(evidence()), captureMorningBrief(evidence({ facts: [fact({ title: 'Later' })] }))]);
        expect(a.id).toBe(b.id);
        expect(a.evidence).toEqual(b.evidence);
        await closeEmailDatabaseForTests();
        expect((await readMorningBrief(a.evidence.identity))?.evidence).toEqual(a.evidence);
    });
    it('publishes once and recovers the original evidence after an expired claim', async () => {
        const row = await captureMorningBrief(evidence());
        await enqueueBriefJob(row.id, 'morning', evidence(), hash, NOW);
        const one = await claimBriefJob('worker-one', NOW);
        expect(one).not.toBeNull();
        expect(await claimBriefJob('worker-two', NOW)).toBeNull();
        const later = '2026-09-21T14:00:31.000Z';
        const two = await claimBriefJob('worker-two', later);
        expect(two?.snapshot.evidence).toEqual(row.evidence);
        expect(await publishBriefJob(one!.lease, copy, later)).toBe(false);
        expect(await publishBriefJob(two!.lease, copy, later)).toBe(true);
        expect(await publishBriefJob(two!.lease, { ...copy, overview: { ...copy.overview, text: 'Replacement' } }, later)).toBe(false);
        expect((await readMorningBrief(row.evidence.identity))?.narrative).toEqual(copy);
    });
    it('rejects revoked account scope and hides malformed persisted records', async () => {
        const row = await captureMorningBrief(evidence());
        await enqueueBriefJob(row.id, 'morning', evidence(), hash, NOW);
        const job = await claimBriefJob('worker', NOW);
        await execute("UPDATE email_accounts SET status='disabled' WHERE id='gmail-1'");
        expect(await publishBriefJob(job!.lease, copy, NOW)).toBe(false);
        expect(await readMorningBrief(row.evidence.identity)).toBeNull();
        await execute("UPDATE email_accounts SET status='connected' WHERE id='gmail-1'");
        await execute("UPDATE morning_brief_snapshots SET evidence_json='broken' WHERE id=?", [row.id]);
        expect(await readMorningBrief(row.evidence.identity)).toBeNull();
    });
    it('prunes only expired owned snapshots, preserving current snapshots and mail tables', async () => {
        const old = '2026-08-01T14:00:00.000Z';
        const stale = evidence({ capturedAt: old, identity: briefIdentity(evidence().identity.workspaceId, [{ id: 'gmail-1', provider: 'gmail' }], 'America/Chicago', old) });
        const row = await captureMorningBrief(stale);
        const today = await captureMorningBrief(evidence());
        expect(await pruneMorningBriefs(NOW)).toBe(1);
        expect(await readMorningBrief(stale.identity)).toBeNull();
        expect((await readMorningBrief(today.evidence.identity))?.id).toBe(today.id);
        expect((await execute('SELECT id FROM email_accounts')).rows).toHaveLength(1);
        expect((await execute('SELECT id FROM morning_brief_snapshots WHERE id=?', [row.id])).rows).toHaveLength(0);
    });
});

it('captures one baseline and grants one live lease across two independent processes',async()=>{
 const {spawn}=await import('node:child_process');
 const workers=[1,2].map(index=>{
  const script=`
   const db=require('./src/lib/email/database.ts');
   const store=require('./src/lib/email/morning-brief-store.ts');
   const fixture=require('./tests/fixtures/morning-brief.ts');
   db.ensureEmailDatabase().then(()=>{
    process.once('message',async()=>{try{
     const e=fixture.evidence();const snapshot=await store.captureMorningBrief(e);
     await store.enqueueBriefJob(snapshot.id,'morning',e,'0'.repeat(64),fixture.NOW);
     const claim=await store.claimBriefJob('process-'+${index},fixture.NOW);
     process.send({id:snapshot.id,winner:Boolean(claim)});
     await db.closeEmailDatabaseForTests();process.disconnect();
    }catch{process.exit(1);}});process.send({ready:true});
   }).catch(()=>process.exit(1));`;
  const child=spawn(process.execPath,['--import','tsx','-e',script],{env:{...process.env},stdio:['ignore','ignore','pipe','ipc']});
  let readyResolve!:()=>void,readyReject!:(error:Error)=>void;
  const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  let outcome:{id:string;winner:boolean}|undefined;let diagnostics='';child.stderr!.on('data',chunk=>{diagnostics+=String(chunk).slice(0,2000);});
  child.on('message',message=>{const value=message as {ready?:boolean;id?:string;winner?:boolean};if(value.ready)readyResolve();else if(value.id)outcome={id:value.id,winner:Boolean(value.winner)};});
  const closed=new Promise<{id:string;winner:boolean}>(resolve=>{child.on('error',error=>{readyReject(error);resolve({id:'error',winner:false});});child.on('close',code=>{if(code!==0||!outcome){readyReject(new Error('Brief subprocess failed '+diagnostics));resolve({id:'error',winner:false});}else resolve(outcome);});});
  return {child,ready,closed};
 });
 try{await Promise.all(workers.map(w=>w.ready));workers.forEach(w=>w.child.send({go:true}));const results=await Promise.all(workers.map(w=>w.closed));expect(results.some(r=>r.id==='error')).toBe(false);expect(new Set(results.map(r=>r.id)).size).toBe(1);expect(results.filter(r=>r.winner)).toHaveLength(1);expect((await execute('SELECT id FROM morning_brief_snapshots')).rows).toHaveLength(1);}
 finally{workers.forEach(w=>{if(w.child.exitCode===null&&w.child.signalCode===null)w.child.kill();});await Promise.all(workers.map(w=>w.closed));}
},20000);
