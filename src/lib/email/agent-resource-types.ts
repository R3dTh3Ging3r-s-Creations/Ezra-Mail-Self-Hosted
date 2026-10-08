import { z } from "zod";
import { accountRefSchema, type AccountRef } from "./agent-types";
import { calendarCreateInputSchema, calendarCreateSchema, canonicalJson, type OperationStatus } from "./agent-operation-schema";

const exactId = z.string().min(1).max(1024).refine(value => !/[\x00-\x1f*]/.test(value));
const exactAccount = accountRefSchema.extend({ accountId: exactId.refine(value => value.length <= 200) });
export const resourceRefSchema = z.object({ account: exactAccount, kind: z.enum(["calendar", "task_list"]), id: exactId }).strict();
export type ResourceRef = z.infer<typeof resourceRefSchema>;
export const grantScopeSchema = z.enum(["accounts.read", "mail.read", "calendar.read", "calendar.create", "calendar.update", "calendar.delete", "tasks.read", "tasks.create", "tasks.update", "tasks.complete"]);
export type GrantScope = z.infer<typeof grantScopeSchema>;
export const accountKey = (account: AccountRef) => canonicalJson({ ...account, expectedEmail: account.expectedEmail.toLowerCase() });
export const resourceKey = (resource: ResourceRef) => canonicalJson({ ...resource, account: accountKey(resource.account) });
export const grantSpecSchema = z.object({
  label: z.string().trim().min(1).max(100), lifetimeDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
  accounts: z.array(exactAccount).min(1).max(2), resources: z.array(resourceRefSchema).max(100),
  scopes: z.array(grantScopeSchema).min(1).max(10),
}).strict().superRefine((spec, context) => {
  const accounts = new Set(spec.accounts.map(accountKey));
  if (accounts.size !== spec.accounts.length || new Set(spec.resources.map(resourceKey)).size !== spec.resources.length || new Set(spec.scopes).size !== spec.scopes.length) context.addIssue({ code: "custom", message: "Duplicate grant selection." });
  if (spec.resources.some(resource => !accounts.has(accountKey(resource.account)) || (resource.kind === "task_list" && resource.account.provider !== "microsoft"))) context.addIssue({ code: "custom", message: "Resource is outside selected account or provider." });
});
export function grantSpecForAccounts(accounts: AccountRef[]) {
  const allowed = new Set(accounts.map(accountKey));
  return grantSpecSchema.refine(spec => spec.accounts.every(account => allowed.has(accountKey(account))), "Account is outside the personal profile.");
}
export type GrantSpec = z.infer<typeof grantSpecSchema>;
export type GrantPrincipal = { keyId: string; revision: number };
export type OwnerActionAuthority = { source: "owner_ui"; principal: "authenticated-owner"; requestId: string; reviewHash: string };
export type GrantSummary = GrantSpec & GrantPrincipal & { createdAt: string; expiresAt: string; revokedAt: string | null };
const timezone = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } });
const instant = z.string().datetime({ offset: true });
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; });
export const taskDueSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("date"), date: localDate, timezone }).strict(), z.object({ kind: z.literal("instant"), instant, timezone }).strict()]);
export type TaskDue = z.infer<typeof taskDueSchema>;
export const taskFieldsSchema = z.object({ title: z.string().trim().min(1).max(300), body: z.string().max(65_536), importance: z.enum(["low", "normal", "high"]), due: taskDueSchema.nullable(), reminder: z.object({ instant, timezone }).strict().nullable() }).strict();
export type TaskFields = z.infer<typeof taskFieldsSchema>;
// Provider reads preserve existing content; create/update input rules remain strict.
export const taskReadFieldsSchema = taskFieldsSchema.extend({ title: z.string().max(4000) });
export const taskReadWarningSchema = z.enum(["due_normalization_unavailable", "reminder_normalization_unavailable"]);
export const taskProviderDatesSchema = z.object({
  due: z.object({ dateTime:z.string().max(100),timeZone:z.string().max(100) }).nullable(),
  reminder: z.object({ dateTime:z.string().max(100),timeZone:z.string().max(100) }).nullable(),
  isReminderOn:z.boolean(),
});
export type TaskRecord = z.infer<typeof taskReadFieldsSchema> & {
  recurrenceEvidence?: "explicit_nonrecurring" | "inferred_nonrecurring" | "recurring" | "unknown";
  readWarnings?: z.infer<typeof taskReadWarningSchema>[];
  providerDates?: z.infer<typeof taskProviderDatesSchema>; list: ResourceRef; id: string; revision: string; status: string; fetchedAt: string; bodyFormat: "plain_text"; recurring: boolean };
const calendarTime = z.object({ startsAt: instant, endsAt: instant, timezone, isAllDay: z.boolean() }).strict().refine(value => Date.parse(value.startsAt) < Date.parse(value.endsAt), "Calendar end must follow start.");
export const calendarPatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(), description: z.string().max(10_000).optional(), location: z.string().max(500).optional(), time: calendarTime.optional(),
  reminder: z.discriminatedUnion("mode", [z.object({ mode: z.literal("default") }).strict(), z.object({ mode: z.literal("none") }).strict(), z.object({ mode: z.literal("minutes"), minutes: z.number().int().min(0).max(40_320) }).strict()]).optional(),
  isBusy: z.boolean().optional(), privacy: z.enum(["default", "private", "public"]).optional(),
}).strict().refine(value => Object.values(value).some(item => item !== undefined), "Patch is empty.");
export type CalendarPatch = z.infer<typeof calendarPatchSchema>;
const calendarTarget = resourceRefSchema.extend({ kind: z.literal("calendar") });
const taskTarget = resourceRefSchema.extend({ kind: z.literal("task_list"), account: exactAccount.extend({ provider: z.literal("microsoft") }) });
const expectedRevision = z.string().min(1).max(2048);
export const resourceMutationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("calendar.create"), payload: calendarCreateInputSchema.extend({ attendees: z.array(z.string().email()).max(0), sendUpdates: z.literal(false) }).pipe(calendarCreateSchema) }).strict(),
  z.object({ kind: z.literal("calendar.update"), target: calendarTarget, eventId: exactId, expectedRevision, patch: calendarPatchSchema }).strict(),
  z.object({ kind: z.literal("calendar.delete"), target: resourceRefSchema.extend({ kind: z.literal("calendar") }), eventId: exactId, expectedRevision }).strict(),
  z.object({ kind: z.literal("tasks.create"), target: taskTarget, fields: taskFieldsSchema }).strict(),
  z.object({ kind: z.literal("tasks.update"), target: taskTarget, taskId: exactId, expectedRevision, patch: taskFieldsSchema.partial().strict().refine(value => Object.values(value).some(item => item !== undefined), "Patch is empty.") }).strict(),
  z.object({ kind: z.literal("tasks.complete"), target: taskTarget, taskId: exactId, expectedRevision }).strict(),
]).refine(value=>value.kind!=="calendar.update"||value.target.account.provider!=="microsoft"||value.patch.privacy!=="public","Microsoft public privacy is unsupported.");
export type ResourceMutation = z.infer<typeof resourceMutationSchema>;
export type OperationView = { id: string; kind: ResourceMutation["kind"]; payloadHash: string; status: OperationStatus; expiresAt: string; errorCode?: string; receipt?: { providerId: string; outcome: string; verifiedAt: string } };
