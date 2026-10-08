import { createHash } from "node:crypto";
import { z } from "zod";
import { getSetting } from "./database";
import { accountRefSchema, type AccountRef } from "./agent-types";

export const MICROSOFT_CALENDAR_DELETE_POLICY_SETTING = "agent_microsoft_calendar_delete_policy";
/** Operator-installed owner acceptance, NOT evidence of conditional DELETE support.
 * No HTTP or MCP route may install this record. Changing it invalidates preparations.
 */
const policySchema = z.object({
  version: z.literal(1),
  policy: z.literal("graph-v1-owned-appointment-delete-v1"),
  account: accountRefSchema.extend({ provider: z.literal("microsoft") }),
  acceptedAt: z.string().datetime({ offset: true }),
  approvalId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  externalEditRaceAccepted: z.literal(true),
}).strict();

type DeletePolicySupport = { available: false; reason: string } | { available: true; reason: "ordinary_delete_race_accepted"; policyId: string };
export async function getMicrosoftCalendarDeleteSupport(account: AccountRef): Promise<DeletePolicySupport> {
  const denied = { available: false as const, reason: "ordinary_delete_policy_unavailable" };
  try {
    const selected = accountRefSchema.parse(account);
    const policy = policySchema.parse(JSON.parse(await getSetting(MICROSOFT_CALENDAR_DELETE_POLICY_SETTING) || "null"));
    if (selected.provider !== "microsoft" || selected.accountId !== policy.account.accountId || selected.expectedEmail.toLowerCase() !== policy.account.expectedEmail.toLowerCase() || Date.parse(policy.acceptedAt) > Date.now()) return denied;
    return { available: true, reason: "ordinary_delete_race_accepted", policyId: createHash("sha256").update(JSON.stringify(policy)).digest("hex") };
  } catch { return denied; }
}
