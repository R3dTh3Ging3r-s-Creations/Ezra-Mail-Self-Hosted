import { getMicrosoftCalendarDeleteSupport } from "./microsoft-calendar-delete-policy";
import { readAgentTaskLists, readAgentTasks } from "./agent-tasks";
import { z } from "zod";
import { AuthError } from "./auth";
import { execute } from "./database";
import { authenticateAgentRequest, agentJsonResponse, readAgentJson } from "./agent-api";
import { admitAgentRead, requireActiveGrantRow } from "./agent-grants";
import { accountRefSchema, calendarIdSchema, calendarRangeSchema } from "./agent-types";
import { getAgentCapabilities } from "./agent-accounts";
import { getConditionalWriteSupport } from "./agent-provider-support";
import { mailReadSchema, mailSearchSchema, readAgentMail, searchAgentMail } from "./agent-mail";
import { readAgentCalendar } from "./agent-calendar";
import { getAgentOperation, prepareAgentOperation } from "./agent-resource-store";
import { executeAgentOperation, reconcileAgentOperation } from "./agent-resource-operations";
import { resourceMutationSchema, resourceRefSchema, type GrantPrincipal } from "./agent-resource-types";

export type AgentRoute = "capabilities" | "mail/search" | "mail/read" | "calendar/read" | "operations/prepare" | "operations/status" | "operations/execute" | "operations/reconcile" | "tasks/lists" | "tasks/read";
const calendarReadSchema = z.object({ account: accountRefSchema, calendarId: calendarIdSchema, range: calendarRangeSchema }).strict();
const prepareSchema = z.object({ idempotencyKey: z.string().min(1).max(128), mutation: resourceMutationSchema }).strict();
const executeSchema = z.object({ payloadHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
async function capabilities(principal: GrantPrincipal) {
  const grant = requireActiveGrantRow((await execute("SELECT * FROM agent_grants WHERE key_id=?", [principal.keyId])).rows[0], principal);
  const accounts = [];
  for (const account of grant.accounts) {
    await admitAgentRead(principal, "accounts.read", account);
    const evidence = await getAgentCapabilities(account, true);
    const hasCalendar = grant.resources.some(resource => resource.account.accountId === account.accountId && resource.account.provider === account.provider && resource.kind === "calendar");
    const calendarRead = grant.scopes.includes("calendar.read") && hasCalendar && evidence.calendarRead === "available";
    const calendarCreate = grant.scopes.includes("calendar.create") && hasCalendar && evidence.calendarWrite === "available";
    const canConditional = async (kind: "calendar.update" | "calendar.delete") => hasCalendar && grant.scopes.includes(kind) && evidence.calendarWrite === "available" && (await getConditionalWriteSupport(account.provider, kind)).available;
    const calendarDelete = hasCalendar && grant.scopes.includes("calendar.delete") && evidence.calendarWrite === "available" && (account.provider === "microsoft" ? (await getMicrosoftCalendarDeleteSupport(account)).available : await canConditional("calendar.delete"));
    const calendarDeleteSafety = !calendarDelete ? "unavailable" : account.provider === "microsoft" ? "fresh_read_non_atomic" : "conditional_revision";
    const hasTasks = account.provider === "microsoft" && grant.resources.some(resource => resource.account.accountId === account.accountId && resource.kind === "task_list");
    accounts.push({ account, identityVerifiedAt: evidence.identityVerifiedAt, mailRead: grant.scopes.includes("mail.read") && evidence.mailRead === "available", calendarRead, calendarCreate, calendarUpdate: await canConditional("calendar.update"), calendarDelete, calendarDeleteSafety, tasksRead: hasTasks && grant.scopes.includes("tasks.read") && evidence.tasksRead === "available", tasksCreate: hasTasks && grant.scopes.includes("tasks.create") && evidence.tasksWrite === "available", tasksUpdate: hasTasks && grant.scopes.includes("tasks.update") && evidence.tasksWrite === "available" && (await getConditionalWriteSupport("microsoft","tasks.update",account)).available, tasksComplete: hasTasks && grant.scopes.includes("tasks.complete") && evidence.tasksWrite === "available" && (await getConditionalWriteSupport("microsoft","tasks.complete",account)).available });
  }
  return { accounts, resources: grant.resources, expiresAt: grant.expiresAt };
}
export function handleAgentRoute(request: Request, route: AgentRoute, operationId?: string): Promise<Response> {
  return agentJsonResponse(async () => {
    const principal = await authenticateAgentRequest(request);
    if (request.signal.aborted) throw new AuthError("Request interrupted.", 409);
    if (route === "capabilities") return capabilities(principal);
    if (route === "operations/status" || route === "operations/reconcile" || route === "operations/execute") {
      const id = z.string().min(1).max(200).parse(operationId);
      if (route === "operations/status") return getAgentOperation(principal, id);
      if (route === "operations/reconcile") { z.object({}).strict().parse(await readAgentJson(request)); return reconcileAgentOperation(principal, id); }
      const body = executeSchema.parse(await readAgentJson(request));
      return executeAgentOperation(principal, id, body.payloadHash, request.signal);
    }
    const input = await readAgentJson(request);
    if (route === "tasks/lists") { const args = z.object({account:accountRefSchema}).strict().parse(input); return readAgentTaskLists(principal,args.account,request.signal); }
    if (route === "tasks/read") { const args = z.object({target:resourceRefSchema}).strict().parse(input); return readAgentTasks(principal,args.target,request.signal); }
    if (route === "mail/search") { const args = mailSearchSchema.parse(input); await admitAgentRead(principal, "mail.read", args.account); return searchAgentMail(args); }
    if (route === "mail/read") { const args = mailReadSchema.parse(input); await admitAgentRead(principal, "mail.read", args.account); return readAgentMail(args); }
    if (route === "calendar/read") {
      const args = calendarReadSchema.parse(input);
      await admitAgentRead(principal, "calendar.read", { account: args.account, kind: "calendar", id: args.calendarId });
      const snapshot = await readAgentCalendar(args.account, args.calendarId, args.range);
      if (snapshot.calendarId !== args.calendarId) throw new AuthError("Resolved calendar differs from grant.", 403);
      return snapshot;
    }
    const args = prepareSchema.parse(input);
    return prepareAgentOperation(principal, args.idempotencyKey, args.mutation);
  });
}
