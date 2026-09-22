import { it,expect } from 'vitest';
import { attentionAge,groupTodayAttention } from '@/lib/email/today-attention';
import type { LivingBriefItem } from '@/lib/email/types';
import type { TodayAttentionMeta } from '@/lib/email/morning-brief-types';
const now='2026-09-21T14:00:00Z',timezone='America/Chicago';
function item(id:string,firstSeenAt='2026-09-17T14:00:00Z'):LivingBriefItem{return {id,sourceKey:'mail:gmail-1:'+id,sourceType:'mail_thread',sourceAccountId:'gmail-1',provider:'gmail',providerThreadId:id,revisionAt:firstSeenAt,occurredAt:firstSeenAt,role:'attention',title:id,summary:'',target:{view:'mail',messageId:id},workspaceId:'workspace:account:gmail:gmail-1',state:'open',firstSeenAt,lastSeenAt:now,completedAt:null,dismissedAt:null,restoredAt:null};}
it('measures ages by local civil dates across midnight and DST',()=>{
 expect(attentionAge({receivedAt:'2026-09-21T04:50:00Z',firstSeenAt:now,now:'2026-09-21T05:10:00Z',timezone}).received).toBe('Received yesterday');
 expect(attentionAge({receivedAt:'2026-03-08T06:30:00Z',firstSeenAt:'2026-03-08T06:30:00Z',now:'2026-03-09T05:10:00Z',timezone}).received).toBe('Received yesterday');
 expect(attentionAge({receivedAt:'2026-11-01T05:30:00Z',firstSeenAt:'2026-11-01T05:30:00Z',now:'2026-11-02T06:10:00Z',timezone}).received).toBe('Received yesterday');
});
it('separates receipt from when Ezra first surfaced an item',()=>{
 const age=attentionAge({receivedAt:'2026-09-17T14:00:00Z',firstSeenAt:'2026-09-18T14:00:00Z',now,timezone});
 expect(age.received).toBe('Received 4 days ago');expect(age.waiting).toBe('Waiting since Friday');expect(age.exact).toContain('Sep 17');expect(age.exact).toContain('Sep 18');
});
it('uses neutral copy for invalid and future timestamps',()=>{
 expect(attentionAge({receivedAt:'bad',firstSeenAt:'2099-01-01T00:00:00Z',now,timezone})).toMatchObject({received:'Received time unavailable',waiting:'Waiting time unavailable'});
 expect(attentionAge({receivedAt:null,firstSeenAt:now,now,timezone}).received).toBeNull();
});
it('keeps verified urgent, overdue, due-today and newly surfaced work prominent with no lost items',()=>{
 const items=['urgent','overdue','due-today','ordinary'].map(id=>item(id)).concat(item('new',now),item('older','2026-09-15T14:00:00Z'));
 const base:TodayAttentionMeta={receivedAt:null,deadline:null,urgent:false,evidenceCurrent:true};
 const facts=new Map<string,TodayAttentionMeta>([[items[0].sourceKey,{...base,urgent:true}],[items[1].sourceKey,{...base,deadline:'2026-09-20T14:00:00Z'}],[items[2].sourceKey,{...base,deadline:'2026-09-21T22:00:00Z'}]]);
 const groups=groupTodayAttention(items,facts,now,timezone);
 expect(groups.current.map(i=>i.id)).toEqual(['urgent','overdue','due-today','new']);expect(groups.earlier.map(i=>i.id)).toEqual(['older','ordinary']);
 expect(new Set([...groups.current,...groups.earlier].map(i=>i.id)).size).toBe(items.length);
});
it('does not promote stale priority metadata or reset waiting age after a refresh or restore',()=>{
 const original=item('old');const refreshed={...original,lastSeenAt:now,restoredAt:now};
 const stale=new Map([[original.sourceKey,{receivedAt:null,deadline:'2026-09-20T00:00:00Z',urgent:true,evidenceCurrent:false}]]);
 expect(groupTodayAttention([refreshed],stale,now,timezone).earlier).toEqual([refreshed]);
 expect(attentionAge({receivedAt:original.occurredAt,firstSeenAt:original.firstSeenAt,now,timezone})).toEqual(attentionAge({receivedAt:refreshed.occurredAt,firstSeenAt:refreshed.firstSeenAt,now,timezone}));
});
