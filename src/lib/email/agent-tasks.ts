import { AuthError } from "./auth";
import { execute } from "./database";
import { admitAgentRead, requireActiveGrantRow } from "./agent-grants";
import { accountKey, resourceKey, type GrantPrincipal, type ResourceRef, type ResourceMutation, type TaskFields, type TaskRecord } from "./agent-resource-types";
import type { AccountRef } from "./agent-types";
import { readMicrosoftTasks, verifyMicrosoftTaskList, prepareMicrosoftTaskMutation } from "./microsoft-todo";
import { calendarDayBounds } from "./calendar-day";

export async function readAgentTaskLists(principal: GrantPrincipal, account: AccountRef, signal?: AbortSignal) {
  const grant = requireActiveGrantRow((await execute("SELECT * FROM agent_grants WHERE key_id=?",[principal.keyId])).rows[0],principal);
  if (!grant.scopes.includes("tasks.read") || !grant.accounts.some(selected=>accountKey(selected)===accountKey(account))) throw new AuthError("Task lists are outside this grant.",403);
  const lists = [];
  for (const target of grant.resources.filter(resource=>resource.kind === "task_list" && accountKey(resource.account)===accountKey(account))) {
    await admitAgentRead(principal,"tasks.read",target);
    const evidence = await verifyMicrosoftTaskList(target,false,signal);
    lists.push({ id:target.id,title:evidence.title,shared:false });
  }
  return { complete:true as const,lists };
}
export async function readAgentTasks(principal: GrantPrincipal,target: ResourceRef,signal?: AbortSignal) {
  await admitAgentRead(principal,"tasks.read",target);
  return readMicrosoftTasks(target,signal);
}
export async function prepareTaskEvidence(mutation: ResourceMutation,signal?: AbortSignal) {
  if (mutation.kind === "tasks.update" || mutation.kind === "tasks.complete") return prepareMicrosoftTaskMutation(mutation.target,mutation.taskId,mutation.expectedRevision,mutation.kind,signal);
  if (mutation.kind !== "tasks.create") throw new AuthError("Task mutation is unavailable.",503);
  return verifyMicrosoftTaskList(mutation.target,true,signal);
}
export function taskMatches(fields: TaskFields,task: TaskRecord,target: ResourceRef) {
  // Readback keeps the provider content unchanged. For creation verification only,
  // allow one provider-added terminal line ending on otherwise exact nonempty text.
  // Do not trim spaces, blank lines, or requested trailing newlines.
  const requested = fields.body.replace(/\r\n?/g,"\n");
  const returned = task.body.replace(/\r\n?/g,"\n");
  const bodyMatches = requested === "" ? returned.trim() === "" : returned === requested ||
    (requested.trim().length > 0 && !requested.endsWith("\n") && returned === requested + "\n");
  if (task.readWarnings?.length) return false;
  if (resourceKey(task.list)!==resourceKey(target) || task.recurring || task.status !== "notStarted" || task.title !== fields.title || !bodyMatches || task.importance !== fields.importance) return false;
  const instant = (due: NonNullable<TaskFields["due"]>) => due.kind === "date" ? Date.parse(calendarDayBounds(due.date,due.timezone).startIso) : Date.parse(due.instant);
  if ((fields.due === null) !== (task.due === null)) return false;
  if (fields.due && task.due && instant(fields.due)!==instant(task.due)) return false;
  if ((fields.reminder === null) !== (task.reminder === null)) return false;
  return !fields.reminder || (!!task.reminder && Date.parse(fields.reminder.instant)===Date.parse(task.reminder.instant));
}
