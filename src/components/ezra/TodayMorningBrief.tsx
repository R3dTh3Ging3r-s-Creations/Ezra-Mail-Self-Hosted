"use client";

import { ExternalLink } from "lucide-react";
import { calendarDateInZone } from "@/lib/email/calendar-day";
import type { ActionCenterTarget } from "@/lib/email/types";
import type { MorningBriefView, BriefTextBlock } from "@/lib/email/morning-brief-types";
import styles from "./EzraMail.module.css";

export function TodayMorningBrief({value,onOpen}:{value:MorningBriefView;onOpen:(target:ActionCenterTarget)=>void}) {
  let sameDay=false;
  try { sameDay=calendarDateInZone(value.checkedAt,value.timezone)===value.day; } catch {}
  const status=sameDay?value.status:"unavailable";
  const narrative=sameDay?value.narrative:null;
  const ready=Boolean(narrative)&&(status==="available"||status==="limited");
  const limited=status==="limited"||value.truncated||!value.coverage.length||value.coverage.some(source=>source.status!=="current");
  const formatTime=(timestamp:string)=>{try{return new Intl.DateTimeFormat("en-US",{timeZone:value.timezone,hour:"numeric",minute:"2-digit"}).format(new Date(timestamp));}catch{return "time unavailable";}};
  const formatDate=()=>{try{return new Intl.DateTimeFormat("en-US",{timeZone:"UTC",weekday:"short",month:"short",day:"numeric"}).format(new Date(value.day+"T12:00:00Z"));}catch{return "Today";}};
  const sources=new Map(value.sources.map(source=>[source.sourceKey,source]));
  function sourceLinks(keys:string[],context:string) {
    return keys.length ? <span className={styles.morningBriefSources}>{keys.map((key,index)=>{
      const source=sources.get(key);if(!source)return null;
      const kind=source.target.view==="calendar"?"calendar":source.target.view==="mail"?"mail":"item";
      const state=source.currentState==="completed"?"Handled":source.currentState==="dismissed"?"Dismissed":source.currentState==="cancelled"?"Cancelled":source.changed?"Changed":null;
      return <span key={key}><button type="button" aria-label={"Open "+kind+" source "+(index+1)+" for "+context} onClick={()=>onOpen(source.target)}>
        {kind==="calendar"?"Calendar":kind==="mail"?"Mail":"Open item"}{keys.length>1?" "+(index+1):""}<ExternalLink aria-hidden="true"/>
      </button>{state?<span className={styles.morningSourceState}>{state}</span>:null}</span>;
    })}</span>:null;
  }
  const block=(item:BriefTextBlock)=> <><p>{item.text}</p>{sourceLinks(item.sourceKeys,item.text)}</>;
  const change=(item:MorningBriefView['changes'][number])=><li key={item.id}><p>{item.text}</p>{sourceLinks(item.sourceKey?[item.sourceKey]:[],item.text)}</li>;
  return <section className={styles.morningBrief} aria-labelledby="morning-brief-heading">
    <header className={styles.morningBriefHeader}><h2 id="morning-brief-heading">Daily brief</h2><span>{formatDate()}{ready&&value.preparedAt?" · Prepared at "+formatTime(value.preparedAt):""}</span></header>
    {ready&&narrative?<>
      <div className={styles.morningOverview}>{block(narrative.overview)}</div>
      {narrative.priorities.length?<ul className={styles.morningPriorities}>{narrative.priorities.slice(0,3).map((priority,index)=><li key={index}>{block(priority)}</li>)}</ul>:null}
      <section className={styles.morningChanges} aria-labelledby="morning-changes-heading">
        <header className={styles.morningBriefHeader}><h3 id="morning-changes-heading">Since your brief</h3><span>Checked at {formatTime(value.checkedAt)}</span></header>
        {limited?<p className={styles.morningCoverage}>Coverage is limited. Some changes may not be available yet.</p>:null}
        {value.changes.length?<>
          {value.changeNarrative?.mode==="local_model"?<p>{value.changeNarrative.overview.text}</p>:null}
          <ul className={styles.morningChangeList}>{value.changes.slice(0,3).map(change)}</ul>
          {value.changes.length>3?<details className={styles.morningMoreChanges}><summary>{value.changes.length-3} more changes</summary><ul className={styles.morningChangeList}>{value.changes.slice(3).map(change)}</ul></details>:null}
        </>:!limited?<p>No meaningful changes were found in the sources reviewed.</p>:null}
      </section>
    </>:<p className={styles.morningCoverage}>{status==="scheduled"?"Your daily brief will be prepared after "+value.scheduledLocalTime+" in Ezra’s timezone.":status==="pending"?"Your daily brief is being prepared. Your agenda and open work remain available.":"Your daily brief is unavailable right now. Your agenda and open work remain available."}</p>}
  </section>;
}
