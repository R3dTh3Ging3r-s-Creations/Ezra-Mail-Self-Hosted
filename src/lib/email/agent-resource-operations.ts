import { getMicrosoftCalendarDeleteSupport } from "./microsoft-calendar-delete-policy";
import { storeOwnerTaskPreparation, approveOwnerTask, authorizeOwnerTaskDispatch, ownerTaskOperation } from "./owner-task-authority";
import { AuthError } from "./auth";
import { executeCalendarCreate, reconcileCalendarCreate } from "./agent-actions";
import { agentResourceStore, getAgentOperation, operationView } from "./agent-resource-store";
import { authorizeAgentDispatch } from "./agent-dispatch";
import { DISPATCH_HEARTBEAT_MS, PROVIDER_DEADLINE_MS } from "./agent-operation-store";
import { prepareTaskEvidence, taskMatches } from "./agent-tasks";
import { createMicrosoftTask, readMicrosoftTask, updateMicrosoftTask, completeMicrosoftTask } from "./microsoft-todo";
import { prepareCalendarMutationEvidence, readCalendarEventMutationEvidence, deleteCalendarEvent,updateCalendarEvent } from "./calendar-mutation-actions";
import { getConditionalWriteSupport,ProviderPreconditionError,ProviderNotDispatchedError } from "./agent-provider-support";
import type { GrantPrincipal, OperationView,ResourceMutation, OwnerActionAuthority } from "./agent-resource-types";

async function assertMutationAvailable(mutation:ResourceMutation, deletePolicyId?:string) {
  if(mutation.kind==="calendar.create"||mutation.kind==="tasks.create")return;
  if (mutation.kind === "calendar.delete" && mutation.target.account.provider === "microsoft") {
    const policy = await getMicrosoftCalendarDeleteSupport(mutation.target.account);
    if (!policy.available || policy.policyId !== deletePolicyId) throw new AuthError("Microsoft deletion policy unavailable or preparation policy changed.",503);
    return;
  }
  if(!(await getConditionalWriteSupport(mutation.target.account.provider,mutation.kind,mutation.target.account)).available)throw new AuthError("Conditional action is unavailable.",503);
}
async function executeResourceOperation(principal:GrantPrincipal | OwnerActionAuthority,id:string,hash:string,parent?:AbortSignal) {
  const op=await agentResourceStore.getOperation(id);
  if(!op||op.mutation.kind==="calendar.create")throw new AuthError("Provider action unavailable.",503);
  const mutation=op.mutation;
  await assertMutationAvailable(mutation,op.evidence.deletePolicyId);
  const claim=await agentResourceStore.claimOperation(id,hash);if(!claim)return;
  const controller=new AbortController();
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(PROVIDER_DEADLINE_MS),...(parent?[parent]:[])]);
  let pending:Promise<void>|undefined;
  const heartbeat=setInterval(()=>{if(!pending)pending=agentResourceStore.heartbeat(id,claim).then(ok=>{if(!ok)controller.abort();},()=>controller.abort()).finally(()=>{pending=undefined;});},DISPATCH_HEARTBEAT_MS);
  let dispatched=false;
  const beforeMutation=async()=>{
    signal.throwIfAborted();
    await assertMutationAvailable(mutation,op.evidence.deletePolicyId);
    signal.throwIfAborted();
    if(dispatched||!await ("source" in principal ? authorizeOwnerTaskDispatch(principal,id,hash,claim) : authorizeAgentDispatch(principal,id,hash,claim)))throw new Error("Dispatch authority changed.");
    dispatched=true;
  };
  try {
    if(mutation.kind==="calendar.update"||mutation.kind==="calendar.delete")await prepareCalendarMutationEvidence(mutation,signal);
    else await prepareTaskEvidence(mutation,signal);

    let providerId:string;let outcome:string;
    if(mutation.kind==="tasks.create"){
      const created=await createMicrosoftTask(mutation.target,mutation.fields,signal,beforeMutation);providerId=created.id;outcome="created";
      if(!await agentResourceStore.recordProviderId(id,claim,created.id))throw new Error("Operation claim changed.");
      const current=await readMicrosoftTask(mutation.target,created.id,signal);
      if(current.status!=="found"||current.task.id!==created.id||!taskMatches(mutation.fields,current.task,mutation.target))throw new Error("Task readback mismatch.");
    }else if(mutation.kind==="calendar.update"){
      await updateCalendarEvent(mutation.target,mutation.eventId,mutation.expectedRevision,mutation.patch,signal,beforeMutation);providerId=mutation.eventId;outcome="updated";
    }else if(mutation.kind==="calendar.delete"){
      await deleteCalendarEvent(mutation.target,mutation.eventId,mutation.expectedRevision,signal,beforeMutation);providerId=mutation.eventId;outcome="deleted";
    }else if(mutation.kind==="tasks.update"){
      await updateMicrosoftTask(mutation.target,mutation.taskId,mutation.expectedRevision,mutation.patch,signal,beforeMutation);providerId=mutation.taskId;outcome="updated";
    }else{
      await completeMicrosoftTask(mutation.target,mutation.taskId,mutation.expectedRevision,signal,beforeMutation);providerId=mutation.taskId;outcome="completed";
    }
    await agentResourceStore.recordOutcome(id,claim,"succeeded",{providerId,outcome,verifiedAt:new Date().toISOString()});
  }catch(error){
    if(dispatched&&error instanceof ProviderPreconditionError)await agentResourceStore.recordProviderRejection(id,claim);
    else if(dispatched&&error instanceof ProviderNotDispatchedError)await agentResourceStore.recordProviderRejection(id,claim,"provider_not_dispatched");
    else await agentResourceStore.recordOutcome(id,claim,dispatched?"unknown":"failed",undefined,dispatched?"unverified_provider_outcome":"preflight_failed");
  }finally{clearInterval(heartbeat);await pending;}
}
export async function executeAgentOperation(principal:GrantPrincipal,id:string,hash:string,signal?:AbortSignal):Promise<OperationView>{
  const op=await getAgentOperation(principal,id);
  if(op.payloadHash!==hash)throw new AuthError("Operation hash changed.",409);
  if(op.status!=="approved")return op;
  if(signal?.aborted)throw new AuthError("Request interrupted.",409);
  if(op.kind==="calendar.create")await executeCalendarCreate(id,principal,signal);
  else await executeResourceOperation(principal,id,hash,signal);
  return getAgentOperation(principal,id);
}
export async function reconcileAgentOperation(principal:GrantPrincipal,id:string):Promise<OperationView>{
  const view=await getAgentOperation(principal,id);if(view.status!=="unknown")return view;
  if(view.kind==="calendar.create")await reconcileCalendarCreate(id);
  else{
    const op=await agentResourceStore.getOperation(id);
    if(op?.mutation.kind==="tasks.create"&&op.providerId){
      try{const current=await readMicrosoftTask(op.mutation.target,op.providerId,AbortSignal.timeout(PROVIDER_DEADLINE_MS));
        if(current.status==="found"&&current.task.id===op.providerId&&taskMatches(op.mutation.fields,current.task,op.mutation.target))await agentResourceStore.recordReconciledOutcome(id,{providerId:op.providerId,outcome:"created",verifiedAt:new Date().toISOString()});
      }catch{/* Unavailable or changed readback remains unknown. */}
    }else if(op?.mutation.kind==="calendar.delete"){
      try{const current=await readCalendarEventMutationEvidence(op.mutation.target,op.mutation.eventId,AbortSignal.timeout(PROVIDER_DEADLINE_MS));
        if(current.status==="absent")await agentResourceStore.recordReconciledOutcome(id,{providerId:op.mutation.eventId,outcome:"deleted",verifiedAt:new Date().toISOString()});
      }catch{/* Initial denial/moved/shared resource cannot become absence. */}
    }
    // Updates/completions without a durable verified response cannot be attributed
    // to this dispatch merely because a later read has matching contents.
  }
  return getAgentOperation(principal,id);
}

export async function prepareOwnerTaskOperation(authority:OwnerActionAuthority,mutation:ResourceMutation):Promise<OperationView>{
  if(!mutation.kind.startsWith("tasks."))throw new AuthError("Owner task action required.",403);
  await assertMutationAvailable(mutation);
  return storeOwnerTaskPreparation(authority,mutation,await prepareTaskEvidence(mutation));
}
export async function executeOwnerTaskOperation(authority:OwnerActionAuthority,id:string,hash:string,signal?:AbortSignal):Promise<OperationView>{
  if(signal?.aborted)throw new AuthError("Request interrupted.",409);
  const view=await approveOwnerTask(authority,id,hash);
  if(view.status==="approved")await executeResourceOperation(authority,id,hash,signal);
  return operationView(await ownerTaskOperation(id));
}
