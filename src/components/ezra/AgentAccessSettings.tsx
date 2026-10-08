"use client";
import {useEffect,useRef,useState} from "react";
import {api,post,confirmGrantReview} from "./api";
import type {GrantSpec,GrantSummary,GrantScope,ResourceRef} from "@/lib/email/agent-resource-types";
import type {OwnerAccountChoice,OwnerResourceChoice} from "@/lib/email/agent-owner-catalogue";
import styles from "./EzraMail.module.css";
type Action={action:"issue";spec:GrantSpec}|{action:"rotate";keyId:string;spec:GrantSpec}|{action:"revoke";keyId:string};
const scopes:GrantScope[]=["accounts.read","mail.read","calendar.read","calendar.create","calendar.update","calendar.delete","tasks.read","tasks.create","tasks.update","tasks.complete"];
const key=(r:ResourceRef)=>`${r.account.accountId}:${r.kind}:${r.id}`;
export function AgentAccessSettings(){
 const [choices,setChoices]=useState<OwnerAccountChoice[]>([]),[grants,setGrants]=useState<GrantSummary[]>([]),[resources,setResources]=useState<OwnerResourceChoice[]>([]);
 const [label,setLabel]=useState("Personal Ezra"),[days,setDays]=useState<1|7|30>(7),[accounts,setAccounts]=useState<string[]>([]),[selected,setSelected]=useState<string[]>([]),[allowed,setAllowed]=useState<GrantScope[]>(["accounts.read"]);
 const [review,setReview]=useState<{action:Action;hash:string}|null>(null),[secret,setSecret]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState("");
 const [copyState,setCopyState]=useState<"idle"|"copying"|"copied"|"failed">("idle");
 const copyRequest=useRef(0);
 const generation=useRef(0),pending=useRef(0),reviewPanel=useRef<HTMLElement>(null),errorPanel=useRef<HTMLParagraphElement>(null);
 useEffect(()=>{if(error)errorPanel.current?.focus();else if(review)reviewPanel.current?.focus();},[error,review]);
 useEffect(()=>{let active=true;const initialRequest=pending.current;Promise.all([api<{accounts:OwnerAccountChoice[]}>("/api/auth/agent-grants/resources"),api<{grants:GrantSummary[]}>("/api/auth/agent-grants")]).then(([catalogue,list])=>{if(active&&initialRequest===pending.current){setChoices(catalogue.accounts);setGrants(list.grants);}},()=>{if(active&&initialRequest===pending.current)setError("Agent access could not be loaded. A trusted owner session is required.");});const clear=()=>{generation.current++;pending.current++;clearSecret();setReview(null);setError("");setBusy("");};window.addEventListener("ezra:before-navigate",clear);window.addEventListener("pagehide",clear);return()=>{active=false;generation.current++;pending.current++;copyRequest.current++;window.removeEventListener("ezra:before-navigate",clear);window.removeEventListener("pagehide",clear);};},[]);
 const invalidate=()=>{setReview(null);clearSecret();setError("");generation.current++;};
 function clearSecret(){copyRequest.current++;setSecret("");setCopyState("idle");}
 async function copyKey(){
  if(!secret||copyState==="copying")return;
  const request=++copyRequest.current;
  setCopyState("copying");
  try{
   await navigator.clipboard.writeText(secret);
   if(request===copyRequest.current)setCopyState("copied");
  }catch{
   if(request===copyRequest.current)setCopyState("failed");
  }
 }
 async function run(work:()=>Promise<void>, reviewing=false){
  const request=++pending.current,current=generation.current;
  setBusy(reviewing?"Preparing access review...":"Completing request...");setError("");
  try{await work();}
  catch(failure){
   if(request!==pending.current||current!==generation.current)return;
   const status=failure instanceof Error&&"status" in failure?failure.status:undefined;
   setError(reviewing
    ?status===403?"Review was denied. Open Ezra Mail at its configured owner/passkey address, then try again. No key was issued."
     :status===401?"Sign in on a trusted owner device, then review access again. No key was issued."
     :"Access review could not be prepared. Your selections are retained; try Review access again. No key was issued."
    :"The request was not completed. Refresh access before trying again; a key is never shown twice.");
  }finally{if(request===pending.current)setBusy("");}
 }
 async function load(choice:OwnerAccountChoice,kind:ResourceRef["kind"]){const current=generation.current;await run(async()=>{const result=await post<{resources:OwnerResourceChoice[]}>("/api/auth/agent-grants/resources",{account:choice.account,kind});if(current!==generation.current)return;setResources(old=>[...old.filter(r=>r.target.account.accountId!==choice.account.accountId||r.target.kind!==kind),...result.resources]);invalidate();});}
 async function startReview(action:Action){invalidate();const current=generation.current;await run(async()=>{const result=await post<{reviewHash:string}>("/api/auth/agent-grants/review",action);if(current===generation.current)setReview({action,hash:result.reviewHash});},true);}
 async function confirm(){if(!review)return;const current=generation.current;const exact=review;await run(async()=>{const stepUpReceiptId=await confirmGrantReview(exact.hash);if(current!==generation.current)return;const result=exact.action.action==="issue"?await post<{secret:string}>("/api/auth/agent-grants",{spec:exact.action.spec,stepUpReceiptId}):await post<{secret?:string}>(`/api/auth/agent-grants/${encodeURIComponent(exact.action.keyId)}`,{action:exact.action.action,...("spec" in exact.action?{spec:exact.action.spec}:{}),stepUpReceiptId});if(current!==generation.current)return;clearSecret();setSecret(result.secret||"");setReview(null);const list=await api<{grants:GrantSummary[]}>("/api/auth/agent-grants");if(current===generation.current)setGrants(list.grants);});}
 const spec:GrantSpec={label:label.trim(),lifetimeDays:days,accounts:choices.filter(c=>accounts.includes(c.account.accountId)).map(c=>c.account),resources:resources.filter(r=>accounts.includes(r.target.account.accountId)&&selected.includes(key(r.target))).map(r=>r.target),scopes:allowed};
 return <section aria-label="Agent access" className={styles.permissionAccountCard}>
  <h2>Agent access</h2><p>Choose personal accounts, exact resources and actions. Writes start unchecked. Access expires automatically.</p>
  {error&&<p role="alert" ref={errorPanel} tabIndex={-1}>{error}</p>}
  {busy&&<p role="status">{busy}</p>}
  <fieldset disabled={Boolean(busy)}><legend>New scoped access</legend>
   <label>Key label<input aria-label="Key label" value={label} onChange={e=>{invalidate();setLabel(e.target.value);}} maxLength={100}/></label>
   <label>Key lifetime<select aria-label="Key lifetime" value={days} onChange={e=>{invalidate();setDays(Number(e.target.value) as 1|7|30);}}>{[1,7,30].map(day=><option key={day} value={day}>{day} days</option>)}</select></label>
   {choices.map(choice=><div key={choice.account.accountId}><label><input type="checkbox" checked={accounts.includes(choice.account.accountId)} disabled={!choice.availableScopes.length} onChange={e=>{invalidate();setAccounts(old=>e.target.checked?[...old,choice.account.accountId]:old.filter(id=>id!==choice.account.accountId));}}/>{choice.account.expectedEmail}</label>
    <button type="button" disabled={!accounts.includes(choice.account.accountId)||!choice.availableScopes.includes("calendar.read")} onClick={()=>load(choice,"calendar")}>Load calendars</button>
    {choice.account.provider==="microsoft"&&<button type="button" disabled={!accounts.includes(choice.account.accountId)||!choice.availableScopes.includes("tasks.read")} onClick={()=>load(choice,"task_list")}>Load task lists</button>}
    {choice.unavailable.map(message=><p key={message}>{message}</p>)}
    {resources.filter(r=>r.target.account.accountId===choice.account.accountId).map(resource=><label key={key(resource.target)}><input type="checkbox" disabled={!accounts.includes(choice.account.accountId)} checked={selected.includes(key(resource.target))} onChange={e=>{invalidate();setSelected(old=>e.target.checked?[...old,key(resource.target)]:old.filter(id=>id!==key(resource.target)));}}/>{resource.title} — {resource.target.id}</label>)}
   </div>)}
   <fieldset><legend>Allowed actions</legend>{scopes.map(scope=><label key={scope}><input type="checkbox" checked={allowed.includes(scope)} disabled={!choices.some(c=>c.availableScopes.includes(scope))} onChange={e=>{invalidate();setAllowed(old=>e.target.checked?[...old,scope]:old.filter(item=>item!==scope));}}/>{scope}</label>)}</fieldset>
   <button type="button" className={styles.primaryButton} disabled={!spec.accounts.length||!label.trim()||!allowed.length} onClick={()=>startReview({action:"issue",spec})}>Review access</button>
  </fieldset>
  {review&&<section aria-label="Exact access review" ref={reviewPanel} tabIndex={-1}><h3>Review {review.action.action}</h3>{review.action.action!=="revoke"&&<p>This key can run these selected actions repeatedly without another confirmation until expiry or revocation.</p>}{"spec" in review.action?<><p>{review.action.spec.label} · {review.action.spec.lifetimeDays} days</p><ul>{review.action.spec.accounts.map(a=><li key={a.accountId}>{a.expectedEmail}</li>)}{review.action.spec.resources.map(r=><li key={key(r)}>{r.account.expectedEmail} · {r.kind} · {r.id}</li>)}</ul><p>{review.action.spec.scopes.join(", ")}</p>{review.action.spec.scopes.includes("calendar.delete")&&review.action.spec.accounts.some(a=>a.provider==="microsoft")&&<p>Microsoft calendar deletion requires the separately enabled owner policy. Ezra checks the event again before deleting it, but another app could change it between that check and deletion. Only owned appointments without repeats, attendees or online meetings are supported.</p>}</>:<p>Revoke key {review.action.keyId}. An already authorized write may finish.</p>}<button type="button" disabled={Boolean(busy)} onClick={confirm}>{review.action.action==="issue"?"Issue key with passkey":review.action.action==="rotate"?"Rotate key with passkey":"Revoke key with passkey"}</button><button type="button" disabled={Boolean(busy)} onClick={invalidate}>Cancel review</button></section>}
  {secret&&<section><p>Shown once. Use the secure local key setup, then dismiss.</p><input aria-label="Once-only agent key" type="password" readOnly value={secret} autoComplete="off"/><button type="button" disabled={copyState==="copying"} onClick={copyKey}>{copyState==="copying"?"Copying key...":"Copy key"}</button><button type="button" onClick={clearSecret}>Dismiss key</button>{copyState==="copied"&&<p role="status">Key copied. Paste it into the secure local key setup.</p>}{copyState==="failed"&&<p role="alert">Could not copy the key. Check your browser clipboard permission, then try Copy key again. Keep this page open.</p>}</section>}
  <h3>Existing access</h3>{grants.map(grant=><article key={grant.keyId}><strong>{grant.label}</strong><p>{grant.revokedAt?"Revoked":Date.parse(grant.expiresAt)<=Date.now()?"Expired":`Expires ${grant.expiresAt}`}</p><p>{grant.accounts.map(a=>a.expectedEmail).join(", ")} · {grant.scopes.join(", ")}</p>{!grant.revokedAt&&<><button type="button" disabled={Boolean(busy)} onClick={()=>startReview({action:"revoke",keyId:grant.keyId})}>Review revoke</button><button type="button" disabled={Boolean(busy)} onClick={()=>startReview({action:"rotate",keyId:grant.keyId,spec:{label:grant.label,lifetimeDays:grant.lifetimeDays,accounts:grant.accounts,resources:grant.resources,scopes:grant.scopes}})}>Review rotation</button></>}</article>)}
 </section>;
}
