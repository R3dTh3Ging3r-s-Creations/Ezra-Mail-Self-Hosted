import { z } from "zod";
import { accountRefSchema, type AccountRef } from "./agent-types";
import { getSetting } from "./database";

export const conditionalActionSchema = z.enum(["calendar.update", "calendar.delete", "tasks.update", "tasks.complete"]);
export type ConditionalAction = z.infer<typeof conditionalActionSchema>;
/** Increment when changing the conditional request/response contract. Evidence is not portable across revisions. */
export const MICROSOFT_CONDITIONAL_ADAPTER_REVISION = 1;
export const MICROSOFT_TASK_ADAPTER_REVISION = 2;
export const MICROSOFT_TASK_RECURRENCE_CONTRACT = "graph-v1-full-task-omission-v1";
export const GOOGLE_CONDITIONAL_HELPER_REVISION = "ezra-event-v1";
export const GOOGLE_UPDATE_HELPER_REVISION = "ezra-event-update-v1";
const microsoftQualification = z.object({
  version: z.literal(1), provider: z.literal("microsoft"), apiVersion: z.literal("v1.0"),
  adapterRevision: z.literal(MICROSOFT_CONDITIONAL_ADAPTER_REVISION), action: conditionalActionSchema,
  verifiedAt: z.string().datetime({ offset: true }), evidenceId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  source: z.literal("live_authorized_probe"), staleRevisionRejected: z.literal(true),
}).strict();

const googleQualification = microsoftQualification.extend({ provider: z.literal("gmail"), apiVersion: z.literal("v3"), action: z.enum(["calendar.delete","calendar.update"]), helperRevision: z.enum([GOOGLE_CONDITIONAL_HELPER_REVISION,GOOGLE_UPDATE_HELPER_REVISION]) });
const taskQualification = microsoftQualification.extend({
  adapterRevision: z.literal(MICROSOFT_TASK_ADAPTER_REVISION), action:z.enum(["tasks.update","tasks.complete"]),
  account:accountRefSchema.extend({provider:z.literal("microsoft")}),
  recurrenceContract:z.literal(MICROSOFT_TASK_RECURRENCE_CONTRACT),
});
const qualification = z.discriminatedUnion("provider", [microsoftQualification, googleQualification]);

/** Protected operator evidence only. No HTTP/MCP tool may write this setting. */
export async function getConditionalWriteSupport(provider: "microsoft" | "gmail", action: ConditionalAction, account?: AccountRef): Promise<{ available: boolean; reason: string }> {
  const denied = { available: false, reason: "conditional_write_unqualified" };
  if ((provider !== "microsoft" && provider !== "gmail") || (provider === "gmail" && action !== "calendar.delete" && action !== "calendar.update") || !conditionalActionSchema.safeParse(action).success) return denied;
  try {
    const raw = await getSetting(`agent_conditional_support:${provider}:${action}`);
    if (!raw) return denied;
    const taskAction = action === "tasks.update" || action === "tasks.complete";
    const evidence = taskAction ? taskQualification.parse(JSON.parse(raw)) : qualification.parse(JSON.parse(raw));
    if (taskAction) {
      const qualified = taskQualification.parse(evidence);
      const selected = accountRefSchema.parse(account);
      if (selected.provider !== qualified.account.provider || selected.accountId !== qualified.account.accountId || selected.expectedEmail.toLowerCase() !== qualified.account.expectedEmail.toLowerCase()) return denied;
    }
    if(evidence.provider==="gmail"&&evidence.helperRevision!==(action==="calendar.delete"?GOOGLE_CONDITIONAL_HELPER_REVISION:GOOGLE_UPDATE_HELPER_REVISION))return denied;
    if (evidence.provider !== provider || evidence.action !== action || Date.parse(evidence.verifiedAt) > Date.now()) return denied;
    return { available: true, reason: "qualified" };
  } catch { return denied; }
}

export class ProviderPreconditionError extends Error {
  readonly code = "provider_precondition_failed";
  constructor() { super("Provider rejected the stale revision."); }
}
/** Only a real opaque provider ETag is usable, never a synthesized change key. */
export function requireConditionalRevision(value: string): string {
  return z.string().max(2048).regex(/^(?:W\/)?"[^"\r\n]+"$/).parse(value);
}

/** A structured helper result guarantees that no provider mutation was dispatched. */
export class ProviderNotDispatchedError extends Error {
  constructor() { super("Provider mutation was not dispatched."); }
}
