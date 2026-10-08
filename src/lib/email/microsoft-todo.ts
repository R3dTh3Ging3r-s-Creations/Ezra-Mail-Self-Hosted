import { AgentReadError } from "./agent-safe-errors";
import { getConditionalWriteSupport, requireConditionalRevision, ProviderPreconditionError } from "./agent-provider-support";
import { canonicalJson } from "./agent-operation-schema";
import { z } from "zod";
import {providerBodyToPlainText as taskBodyToPlainText,graphTimezone as zone,graphDateTimeInstant as graphInstant,changedProviderFieldMatches} from "./microsoft-value-evidence";
export {providerBodyToPlainText as taskBodyToPlainText} from "./microsoft-value-evidence";
import { assertPersonalAccount, getAgentCapabilities } from "./agent-accounts";
import { getMicrosoftAccessToken, getMicrosoftProfile } from "./microsoft";
import { accountRefSchema, type AccountRef } from "./agent-types";
import { resourceRefSchema, taskFieldsSchema, taskReadFieldsSchema, type ResourceRef, type TaskFields, type TaskRecord, type TaskDue } from "./agent-resource-types";

const ROOT = "https://graph.microsoft.com/v1.0/me/todo/lists";
const graphId = z.string().min(1).max(1024).refine(value => !/[\x00-\x1f*]/.test(value));
const listSchema = z.object({ id: graphId, displayName: z.string().max(1000), isOwner: z.boolean(), isShared: z.boolean(), wellknownListName: z.string().optional() });
const graphTimeSchema = z.object({ dateTime: z.string().min(1).max(100), timeZone: z.string().min(1).max(100) });
const rawTaskSchema = z.object({
  id: graphId, title: z.string().max(4000), body: z.object({ contentType: z.string(), content: z.string().max(400_000) }),
  importance: z.enum(["low","normal","high"]), status: z.enum(["notStarted","inProgress","completed","waitingOnOthers","deferred"]),
  isReminderOn: z.boolean(), dueDateTime: graphTimeSchema.nullish(), reminderDateTime: graphTimeSchema.nullish(), recurrence: z.unknown().optional(),
  "@odata.etag": z.string().max(2048).optional(), lastModifiedDateTime: z.string().optional(),
}).passthrough();
export type RawMicrosoftTask = z.infer<typeof rawTaskSchema>;
type TaskContext = { token: string; account: AccountRef; signal: AbortSignal; identityVerifiedAt: string };
function taskSignal(parent?: AbortSignal) { return parent ? AbortSignal.any([parent, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000); }
async function context(input: AccountRef, write: boolean, parent?: AbortSignal): Promise<TaskContext> {
  const account = accountRefSchema.parse(input); const signal = taskSignal(parent);
  if (account.provider !== "microsoft") throw new Error("Microsoft To Do is unavailable for this provider.");
  await assertPersonalAccount(account);
  const caps = await getAgentCapabilities(account, false);
  if ((write ? caps.tasksWrite : caps.tasksRead) !== "available") throw new Error("Microsoft task permission is not granted.");
  const mode = caps.scopes.some(scope => scope.toLowerCase() === "tasks.readwrite") ? "tasks-write" : "tasks-readonly";
  const token = await getMicrosoftAccessToken(account.expectedEmail, mode, signal);
  const identity = await getMicrosoftProfile(token, signal);
  if (identity.email.trim().toLowerCase() !== account.expectedEmail.toLowerCase()) throw new Error("Microsoft task identity does not match the selected account.");
  signal.throwIfAborted();
  return { token, account, signal, identityVerifiedAt: new Date().toISOString() };
}
async function graph(ctx: TaskContext, url: string, init: RequestInit = {}, absent = false,beforeMutation?:()=>Promise<void>): Promise<Record<string,unknown> | null> {
  ctx.signal.throwIfAborted();
  await beforeMutation?.();
  const response = await fetch(url, { ...init, signal: ctx.signal, redirect: "error", headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/json", ...init.headers } });
  if (absent && response.status === 404) return null;
  if (response.status === 412) throw new ProviderPreconditionError();
  if (!response.ok) throw new AgentReadError(response.status === 401 || response.status === 403 ? "task_provider_denied" : "task_provider_unavailable");
  if (response.status === 204) return {};
  const reader = response.body?.getReader();
  if (!reader) throw new AgentReadError("task_provider_response_invalid");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 4_194_304) { await reader.cancel(); throw new AgentReadError("task_read_limit"); } chunks.push(item.value); }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AgentReadError("task_provider_response_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentReadError("task_provider_response_invalid");
  const result = value as Record<string,unknown>;
  if (!result["@odata.etag"] && response.headers.get("etag")) result["@odata.etag"] = response.headers.get("etag");
  return result;
}
async function pages(ctx: TaskContext, base: string): Promise<unknown[]> {
  let next: string | null = base; const seen = new Set<string>(); const values: unknown[] = [];
  for (let page = 0; next && page < 100; page++) {
    let url: URL;
    try { url = new URL(next); } catch { throw new AgentReadError("task_pagination_invalid"); }
    if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash || url.pathname !== new URL(base).pathname || [...url.searchParams.keys()].some(key => !["$skiptoken","$top","$select","$skip"].includes(key)) || seen.has(url.href)) throw new AgentReadError("task_pagination_invalid");
    seen.add(url.href);
    const payload = await graph(ctx,url.href);
    if (!payload || !Array.isArray(payload.value)) throw new AgentReadError("task_provider_response_invalid");
    values.push(...payload.value);
    if (values.length > 1000) throw new AgentReadError("task_read_limit");
    const continuation = payload["@odata.nextLink"];
    if (continuation !== undefined && (typeof continuation !== "string" || !continuation)) throw new AgentReadError("task_pagination_invalid");
    next = typeof continuation === "string" ? continuation : null;
  }
  if (next) throw new AgentReadError("task_read_limit");
  await assertPersonalAccount(ctx.account);
  return values;
}
function listTarget(input: ResourceRef) {
  const target = resourceRefSchema.parse(input);
  if (target.kind !== "task_list" || target.account.provider !== "microsoft") throw new Error("Exact Microsoft task list required.");
  return target;
}
function parseProviderList(value: unknown) {
  const parsed = listSchema.safeParse(value);
  if (!parsed.success) throw new AgentReadError("task_provider_response_invalid");
  return parsed.data;
}
async function privateList(ctx: TaskContext, target: ResourceRef) {
  const list = parseProviderList(await graph(ctx,`${ROOT}/${encodeURIComponent(target.id)}`));
  if (list.id !== target.id) throw new AgentReadError("task_identity_mismatch");
  if (!list.isOwner || list.isShared || list.wellknownListName === "flaggedEmails") throw new AgentReadError("task_list_not_private");
  return list;
}
export async function readMicrosoftTaskLists(account: AccountRef, signal?: AbortSignal) {
  const ctx = await context(account,false,signal);
  const values = (await pages(ctx,ROOT)).map(value => parseProviderList(value));
  if (new Set(values.map(value => value.id)).size !== values.length) throw new AgentReadError("task_identity_mismatch");
  return { complete: true as const, lists: values.map(list => ({ id: list.id, title: list.displayName, shared: list.isShared || !list.isOwner, supported: list.isOwner && !list.isShared && list.wellknownListName !== "flaggedEmails" })) };
}
function dueFromGraph(value: z.infer<typeof graphTimeSchema> | null | undefined): TaskDue | null {
  if (!value) return null;
  const timezone = zone(value.timeZone);
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?$/.test(value.dateTime)) return { kind:"date",date:value.dateTime.slice(0,10),timezone };
  return { kind:"instant",instant:graphInstant(value),timezone };
}
/** Only called with the fixed unprojected v1 task entity/response and account-bound qualification.
 * Omission remains an empirical inference, never a synthesized provider null. */
export function microsoftTaskRecurrenceEvidence(raw:RawMicrosoftTask,qualifiedFullEntity=false):NonNullable<TaskRecord["recurrenceEvidence"]>{
  if(Object.hasOwn(raw,"recurrence"))return raw.recurrence===null?"explicit_nonrecurring":raw.recurrence===undefined?"unknown":"recurring";
  if(!qualifiedFullEntity)return "unknown";
  if(["@odata.nextLink","@odata.deltaLink","@removed"].some(key=>Object.hasOwn(raw,key)))return "unknown";
  if(Object.hasOwn(raw,"@odata.context")){
    try{const context=new URL(String(raw["@odata.context"]));if(context.origin!=="https://graph.microsoft.com"||context.pathname!=="/v1.0/$metadata"||context.search||!(context.hash==="#tasks/$entity"||context.hash.endsWith("/tasks/$entity")))return "unknown";}catch{return "unknown";}
  }
  const complete=rawTaskSchema.extend({
    "@odata.etag":z.string().regex(/^(?:W\/)?"[^"\r\n]+"$/),
    createdDateTime:z.string().datetime({offset:true}),lastModifiedDateTime:z.string().datetime({offset:true}),
    categories:z.array(z.string()),hasAttachments:z.boolean(),body:z.object({contentType:z.enum(["text","html"]),content:z.string().max(400_000)}),
  }).safeParse(raw);
  return complete.success?"inferred_nonrecurring":"unknown";
}
const nonrecurring=(raw:RawMicrosoftTask)=>["explicit_nonrecurring","inferred_nonrecurring"].includes(microsoftTaskRecurrenceEvidence(raw,true));
function normalizedTask(raw: RawMicrosoftTask,target: ResourceRef): TaskRecord {
  const readWarnings: NonNullable<TaskRecord["readWarnings"]> = [];
  let due: TaskRecord["due"] = null;
  let reminder: TaskRecord["reminder"] = null;
  try { due = taskReadFieldsSchema.shape.due.parse(dueFromGraph(raw.dueDateTime)); }
  catch { readWarnings.push("due_normalization_unavailable"); }
  if (raw.isReminderOn) {
    try { reminder = { instant:graphInstant(graphTimeSchema.parse(raw.reminderDateTime)),timezone:zone(raw.reminderDateTime!.timeZone) }; }
    catch { readWarnings.push("reminder_normalization_unavailable"); }
  }
  let body: string;
  try { body = taskBodyToPlainText(raw.body); } catch { throw new AgentReadError("task_body_unsupported"); }
  const fields = taskReadFieldsSchema.parse({ title:raw.title,body,importance:raw.importance,due,reminder });
  return { ...fields,list:target,id:raw.id,revision:raw["@odata.etag"] || "",status:raw.status,fetchedAt:new Date().toISOString(),bodyFormat:"plain_text",recurring:raw.recurrence != null,recurrenceEvidence:microsoftTaskRecurrenceEvidence(raw),
    readWarnings,providerDates:{due:raw.dueDateTime ?? null,reminder:raw.reminderDateTime ?? null,isReminderOn:raw.isReminderOn} };
}
function parseProviderTask(value: unknown) {
  const parsed = rawTaskSchema.safeParse(value);
  if (!parsed.success) throw new AgentReadError("task_provider_response_invalid");
  return parsed.data;
}
export async function readMicrosoftTasks(input: ResourceRef,signal?: AbortSignal) {
  const target = listTarget(input); const ctx = await context(target.account,false,signal); await privateList(ctx,target);
  const rows = (await pages(ctx,`${ROOT}/${encodeURIComponent(target.id)}/tasks`)).map(value => parseProviderTask(value));
  if (new Set(rows.map(row=>row.id)).size !== rows.length) throw new AgentReadError("task_identity_mismatch");
  return { complete:true as const,tasks:rows.map(raw=>normalizedTask(raw,target)),fetchedAt:new Date().toISOString() };
}
export async function readMicrosoftTaskEvidence(input: ResourceRef,id: string,signal?: AbortSignal) {
  const target = listTarget(input); graphId.parse(id); const ctx = await context(target.account,false,signal); await privateList(ctx,target);
  const value = await graph(ctx,`${ROOT}/${encodeURIComponent(target.id)}/tasks/${encodeURIComponent(id)}`,{},true);
  await assertPersonalAccount(target.account);
  if (!value) return { status:"absent" as const };
  const raw = parseProviderTask(value); if (raw.id !== id) throw new Error("Task identity changed or moved.");
  return { status:"found" as const,task:normalizedTask(raw,target),raw,identityVerifiedAt:ctx.identityVerifiedAt };
}
export async function readMicrosoftTask(target: ResourceRef,id: string,signal?: AbortSignal) {
  const result = await readMicrosoftTaskEvidence(target,id,signal);
  return result.status === "absent" ? result : { status:"found" as const,task:result.task };
}
export async function verifyMicrosoftTaskList(target: ResourceRef,write: boolean,signal?: AbortSignal) {
  listTarget(target); const ctx = await context(target.account,write,signal); const list = await privateList(ctx,target);
  return { target,title:list.displayName,complete:true as const,fetchedAt:new Date().toISOString(),identityVerifiedAt:ctx.identityVerifiedAt };
}
export function taskFieldsToGraph(input: Partial<TaskFields>) {
  const fields = taskFieldsSchema.partial().strict().parse(input); const result: Record<string,unknown> = {};
  if (fields.title !== undefined) result.title = fields.title;
  if (fields.body !== undefined) { if (Buffer.byteLength(fields.body,"utf8")>65_536) throw new Error("Task body exceeds limit."); result.body = { contentType:"html",content:fields.body.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\r\n?/g,"\n").replace(/\n/g,"<br>") }; }
  if (fields.importance !== undefined) result.importance = fields.importance;
  if (fields.due !== undefined) result.dueDateTime = fields.due === null ? null : fields.due.kind === "date" ? { dateTime:`${fields.due.date}T00:00:00`,timeZone:fields.due.timezone } : { dateTime:new Date(fields.due.instant).toISOString().replace(/Z$/,""),timeZone:"UTC" };
  if (fields.reminder !== undefined) { result.isReminderOn = fields.reminder !== null; result.reminderDateTime = fields.reminder === null ? null : { dateTime:new Date(fields.reminder.instant).toISOString().replace(/Z$/,""),timeZone:"UTC" }; }
  return result;
}
export async function createMicrosoftTask(input: ResourceRef,fields: TaskFields,signal?: AbortSignal,beforeMutation?:()=>Promise<void>): Promise<{id:string}> {
  const target = listTarget(input); const parsed = taskFieldsSchema.parse(fields); const ctx = await context(target.account,true,signal); await privateList(ctx,target);
  const response = await graph(ctx,`${ROOT}/${encodeURIComponent(target.id)}/tasks`,{ method:"POST",body:JSON.stringify(taskFieldsToGraph(parsed)) },false,beforeMutation);
  return { id:graphId.parse(response?.id) };
}

export async function prepareMicrosoftTaskMutation(target: ResourceRef,id: string,revision: string,kind: "tasks.update"|"tasks.complete",signal?: AbortSignal) {
  if (!(await getConditionalWriteSupport("microsoft",kind,target.account)).available) throw new Error("Conditional task writes are not qualified.");
  requireConditionalRevision(revision);
  await verifyMicrosoftTaskList(target,true,signal);
  const current = await readMicrosoftTaskEvidence(target,id,signal);
  if (current.status !== "found" || current.task.revision !== revision) throw new Error("Task revision changed or task is unavailable.");
  if (!nonrecurring(current.raw) || (kind === "tasks.complete" && current.task.status === "completed")) throw new Error("Task recurrence or completion state is unsupported.");
  return { target,complete:true as const,providerRevision:revision,fetchedAt:current.task.fetchedAt,identityVerifiedAt:current.identityVerifiedAt,recurrenceEvidence:microsoftTaskRecurrenceEvidence(current.raw,true),before:current.raw };
}
async function mutateMicrosoftTask(target:ResourceRef,id:string,revision:string,kind:"tasks.update"|"tasks.complete",body:Record<string,unknown>,signal?:AbortSignal,beforeMutation?:()=>Promise<void>):Promise<void>{
  if (!(await getConditionalWriteSupport("microsoft",kind,target.account)).available) throw new Error("Conditional task writes are not qualified.");
  requireConditionalRevision(revision);listTarget(target);graphId.parse(id);
  const ctx=await context(target.account,true,signal);await privateList(ctx,target);
  const url=`${ROOT}/${encodeURIComponent(target.id)}/tasks/${encodeURIComponent(id)}`;
  const value=await graph(ctx,url,{},true);if(!value)throw new Error("Task is unavailable.");
  const before=parseProviderTask(value);
  if(before.id!==id||before["@odata.etag"]!==revision)throw new Error("Task identity or revision changed.");
  if(!nonrecurring(before)||(kind==="tasks.complete"&&before.status==="completed"))throw new Error("Task recurrence or completion state is unsupported.");
  // Repeat the qualified full-entity contract at every post-dispatch boundary.
  const matches=(raw:RawMicrosoftTask)=>nonrecurring(raw)&&raw.id===id&&["title","body","importance","dueDateTime","reminderDateTime","isReminderOn","status","recurrence","categories","hasAttachments","createdDateTime",...(kind==="tasks.update"?["completedDateTime"]:[])].every(key=>Object.hasOwn(body,key)?changedProviderFieldMatches(key,body[key],raw[key]):canonicalJson(raw[key]??null)===canonicalJson(before[key]??null));
  const response=rawTaskSchema.parse(await graph(ctx,url,{method:"PATCH",headers:{"if-match":revision},body:JSON.stringify(body)},false,beforeMutation));
  requireConditionalRevision(response["@odata.etag"]||"");
  if(response["@odata.etag"]===revision||!matches(response))throw new Error("Task update response did not verify the patch.");
  const current=rawTaskSchema.parse(await graph(ctx,url));
  if(current["@odata.etag"]!==response["@odata.etag"]||!matches(current))throw new Error("Task update readback mismatch.");
}
export async function updateMicrosoftTask(target:ResourceRef,id:string,revision:string,patch:Partial<TaskFields>,signal?:AbortSignal,beforeMutation?:()=>Promise<void>):Promise<void>{
  const body=taskFieldsToGraph(patch);if(!Object.keys(body).length)throw new Error("Task patch is empty.");
  return mutateMicrosoftTask(target,id,revision,"tasks.update",body,signal,beforeMutation);
}
export async function completeMicrosoftTask(target:ResourceRef,id:string,revision:string,signal?:AbortSignal,beforeMutation?:()=>Promise<void>):Promise<void>{
  return mutateMicrosoftTask(target,id,revision,"tasks.complete",{status:"completed"},signal,beforeMutation);
}
