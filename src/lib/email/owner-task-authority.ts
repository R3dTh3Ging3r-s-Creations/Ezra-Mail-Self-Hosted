import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AuthError } from "./auth";
import { withAgentTransaction, assertTransactionPersonalAccount } from "./agent-dispatch";
import { canonicalJson } from "./agent-operation-schema";
import { PREPARATION_TTL_MS } from "./agent-operation-store";
import { agentResourceStore, hashResourceMutation, mutationTarget, operationView, type ResourceEvidence } from "./agent-resource-store";
import { resourceMutationSchema, resourceKey, type OwnerActionAuthority, type ResourceMutation } from "./agent-resource-types";

const authoritySchema=z.object({source:z.literal("owner_ui"),principal:z.literal("authenticated-owner"),requestId:z.string().uuid(),reviewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export function makeOwnerTaskAuthority(mutation:ResourceMutation):OwnerActionAuthority {
 return {source:"owner_ui",principal:"authenticated-owner",requestId:randomUUID(),reviewHash:hashResourceMutation(mutation)};
}
export async function ownerTaskOperation(id:string) {
 const op=await agentResourceStore.getOperation(id);
 if(!op||!op.kind.startsWith("tasks."))throw new AuthError("Owner task unavailable.",404);
 const authority=authoritySchema.parse(op.authority);
 if(authority.reviewHash!==op.payloadHash)throw new AuthError("Owner review changed.",409);
 return {...op,authority};
}
export async function storeOwnerTaskPreparation(input:OwnerActionAuthority,raw:ResourceMutation,evidence:ResourceEvidence) {
 const authority=authoritySchema.parse(input);const mutation=resourceMutationSchema.parse(raw);
 if(!mutation.kind.startsWith("tasks."))throw new AuthError("Owner task action required.",403);
 const target=mutationTarget(mutation);const hash=hashResourceMutation(mutation);
 const fresh=(value:string)=>Number.isFinite(Date.parse(value))&&Date.now()-Date.parse(value)>=0&&Date.now()-Date.parse(value)<=600_000;
 if(hash!==authority.reviewHash||!evidence.complete||resourceKey(target)!==resourceKey(evidence.target)||!fresh(evidence.fetchedAt)||!fresh(evidence.identityVerifiedAt)||("expectedRevision" in mutation&&mutation.expectedRevision!==evidence.providerRevision))throw new AuthError("Fresh exact review required.",409);
 const id=randomUUID();const now=new Date().toISOString();
 await withAgentTransaction(undefined,async tx=>{
  await assertTransactionPersonalAccount(tx,target);
  await tx.execute({sql:`INSERT INTO agent_resource_operations(id,kind,version,account_id,provider,expected_email,resource_kind,resource_id,payload_json,payload_hash,evidence_json,authority_json,created_at,expires_at,updated_at,status) VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,'prepared')`,args:[id,mutation.kind,target.account.accountId,target.account.provider,target.account.expectedEmail,target.kind,target.id,canonicalJson(mutation),hash,canonicalJson(evidence),canonicalJson(authority),now,new Date(Date.now()+PREPARATION_TTL_MS).toISOString(),now]});
 });
 return operationView(await ownerTaskOperation(id));
}
export async function approveOwnerTask(authority:OwnerActionAuthority,id:string,hash:string) {
 const op=await ownerTaskOperation(id);
 if(canonicalJson(authoritySchema.parse(authority))!==canonicalJson(op.authority)||hash!==op.payloadHash)throw new AuthError("Owner review changed.",409);
 await withAgentTransaction(undefined,async tx=>{await assertTransactionPersonalAccount(tx,mutationTarget(op.mutation));await tx.execute({sql:"UPDATE agent_resource_operations SET status='approved',updated_at=? WHERE id=? AND payload_hash=? AND status='prepared' AND expires_at>?",args:[new Date().toISOString(),id,hash,new Date().toISOString()]});});
 return operationView(await ownerTaskOperation(id));
}
export async function authorizeOwnerTaskDispatch(input:OwnerActionAuthority,id:string,hash:string,claim:string) {
 const authority=authoritySchema.parse(input);
 return withAgentTransaction(undefined,async tx=>{
  const now=new Date().toISOString();
  const op=(await tx.execute({sql:"SELECT * FROM agent_resource_operations WHERE id=? AND payload_hash=? AND authority_json=? AND status='executing' AND claim_id=? AND expires_at>? AND lease_expires_at>?",args:[id,hash,canonicalJson(authority),claim,now,now]})).rows[0];
  if(!op||!String(op.kind).startsWith("tasks.")||hash!==authority.reviewHash)return false;
  const mutation=resourceMutationSchema.parse(JSON.parse(String(op.payload_json)));if(hashResourceMutation(mutation)!==hash)return false;
  const target=mutationTarget(mutation);await assertTransactionPersonalAccount(tx,target);
  const lock=(await tx.execute({sql:"SELECT operation_id FROM agent_resource_locks WHERE operation_table='resource' AND operation_id=? AND account_id=? AND provider=? AND resource_kind=? AND resource_id=?",args:[id,target.account.accountId,target.account.provider,target.kind,target.id]})).rows[0];
  if(!lock)return false;
  return (await tx.execute({sql:"UPDATE agent_resource_operation_attempts SET authorized_at=?,dispatched_at=? WHERE id=? AND operation_id=? AND dispatched_at IS NULL AND finished_at IS NULL",args:[now,now,claim,id]})).rowsAffected===1;
 });
}
