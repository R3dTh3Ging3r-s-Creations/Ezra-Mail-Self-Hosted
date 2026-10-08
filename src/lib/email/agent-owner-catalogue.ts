import { getMicrosoftCalendarDeleteSupport } from "./microsoft-calendar-delete-policy";
import { z } from "zod";
import { getSetting } from "./database";
import { accountRefSchema, type AccountRef } from "./agent-types";
import { getAgentCapabilities } from "./agent-accounts";
import { getMicrosoftAccessToken, resolveMicrosoftCalendarId } from "./microsoft";
import { getGoogleCalendarIdentity } from "./gmail";
import { readMicrosoftTaskLists, readMicrosoftTasks } from "./microsoft-todo";
import { getConditionalWriteSupport } from "./agent-provider-support";
import { accountKey, type ResourceRef, type GrantScope } from "./agent-resource-types";
import { AuthError } from "./auth";
export type OwnerAccountChoice={account:AccountRef;availableScopes:GrantScope[];unavailable:string[]};
export type OwnerResourceChoice={target:ResourceRef;title:string};
export async function ownerAccountChoices():Promise<{accounts:OwnerAccountChoice[]}>{
 const profile=z.array(accountRefSchema).length(2).parse(JSON.parse(await getSetting("agent_personal_accounts")||"null"));
 const accounts:OwnerAccountChoice[]=[];
 for(const account of profile){
  try{const caps=await getAgentCapabilities(account,true);const availableScopes:GrantScope[]=["accounts.read"];const unavailable:string[]=[];
   if(caps.mailRead==="available")availableScopes.push("mail.read");
   if(caps.calendarRead==="available")availableScopes.push("calendar.read");
   if(caps.calendarWrite==="available")availableScopes.push("calendar.create");
   if(account.provider==="microsoft"){
    if(caps.tasksRead==="available")availableScopes.push("tasks.read");else unavailable.push("To Do needs explicit personal Microsoft task consent.");
    if(caps.tasksWrite==="available")availableScopes.push("tasks.create");
    for(const action of ["calendar.update","calendar.delete","tasks.update","tasks.complete"] as const){
     const permitted=action.startsWith("tasks.")?caps.tasksWrite==="available":caps.calendarWrite==="available";
     if(permitted&&(action==="calendar.delete" ? (await getMicrosoftCalendarDeleteSupport(account)).available : (await getConditionalWriteSupport("microsoft",action,account)).available))availableScopes.push(action);else unavailable.push(`${action} is unavailable until permission and provider checks pass.`);
    }
   }
   if(account.provider==="gmail"){
    if(caps.calendarWrite==="available"&&(await getConditionalWriteSupport("gmail","calendar.delete")).available)availableScopes.push("calendar.delete");
    else unavailable.push("calendar.delete is unavailable until permission and provider checks pass.");
   }
   accounts.push({account,availableScopes,unavailable});
  }catch{accounts.push({account,availableScopes:[],unavailable:["Personal identity or provider access could not be verified. Refresh after reconnecting."]});}
 }
 return {accounts};
}
export async function ownerResourceChoices(account:AccountRef,kind:ResourceRef["kind"]):Promise<{resources:OwnerResourceChoice[]}>{
 const caps=await getAgentCapabilities(account,true);
 if(kind==="task_list"){
  if(account.provider!=="microsoft"||caps.tasksRead!=="available")throw new AuthError("Personal To Do access required.",403);
  const result=await readMicrosoftTaskLists(account);
  return {resources:result.lists.filter(list=>list.supported).map(list=>({target:{account,kind,id:list.id},title:list.title}))};
 }
 if(caps.calendarRead!=="available")throw new AuthError("Calendar read access required.",403);
 const id=account.provider==="gmail"?await getGoogleCalendarIdentity(account.expectedEmail):await resolveMicrosoftCalendarId(await getMicrosoftAccessToken(account.expectedEmail,caps.calendarWrite==="available"?"calendar-write":"calendar-readonly"),"primary");
 return {resources:[{target:{account,kind,id},title:"Primary calendar"}]};
}
export async function readOwnerTasks(target:ResourceRef,signal?:AbortSignal){
 const result=await readMicrosoftTasks(target,signal);
 if(result.tasks.some(task=>accountKey(task.list.account)!==accountKey(target.account)||task.list.id!==target.id))throw new AuthError("Task account changed.",409);
 return result;
}
