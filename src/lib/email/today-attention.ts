import { calendarDateInZone } from './calendar-day';
import type { LivingBriefItem } from './types';
import type { TodayAttentionMeta } from './morning-brief-types';
function ageDays(value:string,now:string,timezone:string):number|null{
 if(!Number.isFinite(Date.parse(value))||!Number.isFinite(Date.parse(now))||Date.parse(value)>Date.parse(now))return null;
 try{return Math.round((Date.parse(calendarDateInZone(now,timezone)+'T00:00:00Z')-Date.parse(calendarDateInZone(value,timezone)+'T00:00:00Z'))/86400000);}catch{return null;}
}
export function attentionAge(input:{receivedAt:string|null;firstSeenAt:string;now:string;timezone:string}):{received:string|null;waiting:string;exact:string}{
 const {receivedAt,firstSeenAt,now,timezone}=input;
 const receipt=receivedAt===null?null:ageDays(receivedAt,now,timezone),waiting=ageDays(firstSeenAt,now,timezone);
 const date=(value:string)=>new Intl.DateTimeFormat('en-US',{timeZone:timezone,month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value));
 const received=receivedAt===null?null:receipt===null?'Received time unavailable':receipt===0?'Received today':receipt===1?'Received yesterday':'Received '+receipt+' days ago';
 const wait=waiting===null?'Waiting time unavailable':waiting===0?'Waiting since today':waiting===1?'Waiting since yesterday':'Waiting since '+new Intl.DateTimeFormat('en-US',waiting<7?{timeZone:timezone,weekday:'long'}:{timeZone:timezone,month:'short',day:'numeric'}).format(new Date(firstSeenAt));
 return {received,waiting:wait,exact:[receivedAt&&receipt!==null?'Received '+date(receivedAt):received,waiting!==null?'First surfaced '+date(firstSeenAt):wait].filter(Boolean).join('. ')};
}
export function groupTodayAttention(items:LivingBriefItem[],facts:Map<string,TodayAttentionMeta>,now:string,timezone:string):{current:LivingBriefItem[];earlier:LivingBriefItem[]}{
 const current:LivingBriefItem[]=[],earlier:LivingBriefItem[]=[];
 const today=calendarDateInZone(now,timezone);
 for(const item of items){
  const meta=facts.get(item.sourceKey);let due=false;
  if(meta?.evidenceCurrent&&meta.deadline&&Number.isFinite(Date.parse(meta.deadline)))due=calendarDateInZone(meta.deadline,timezone)<=today;
  const age=ageDays(item.firstSeenAt,now,timezone);
  if(age===null||age===0||meta?.evidenceCurrent&&(meta.urgent||due))current.push(item);else earlier.push(item);
 }
 earlier.sort((a,b)=>Date.parse(a.firstSeenAt)-Date.parse(b.firstSeenAt)||a.sourceKey.localeCompare(b.sourceKey));
 return {current,earlier};
}
