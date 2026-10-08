import { z } from "zod";
import { execute, getSetting, getServiceState, nowIso } from "./database";
import { getGmailAuthorizationCapabilities, getGoogleCalendarIdentity } from "./gmail";
import { getMicrosoftAccessToken, getMicrosoftProfile } from "./microsoft";
import { accountRefSchema, type AccountRef, type CapabilityEvidence, type CapabilityState } from "./agent-types";

const profileSchema = z.array(accountRefSchema).length(2).refine(
  accounts => new Set(accounts.map(a => a.provider)).size === 2 && new Set(accounts.map(a => a.accountId)).size === 2,
);
const emailKey = (email: string) => email.trim().toLowerCase();
/** Internal policy; never accepted from an MCP/tool request. */
export type AccountPolicy = "personal" | "owner_ui";

export async function assertConnectedAccount(input: AccountRef) {
  const ref = accountRefSchema.parse(input);
  const row = (await execute("SELECT id,provider,email,label,status FROM email_accounts WHERE id = ?", [ref.accountId])).rows[0];
  if (!row || row.provider !== ref.provider || emailKey(String(row.email)) !== emailKey(ref.expectedEmail) || row.status !== "connected") {
    throw new Error("Account is unavailable or its identity changed.");
  }
  return { id: String(row.id), provider: ref.provider, email: String(row.email), label: String(row.label) };
}

export async function assertPersonalAccount(input: AccountRef) {
  const ref = accountRefSchema.parse(input);
  let profile: AccountRef[];
  try { profile = profileSchema.parse(JSON.parse(await getSetting("agent_personal_accounts") || "null")); }
  catch { throw new Error("Personal account profile is not configured."); }
  if (!profile.some(a => a.accountId === ref.accountId && a.provider === ref.provider && emailKey(a.expectedEmail) === emailKey(ref.expectedEmail))) {
    throw new Error("Account is outside the personal profile.");
  }
  return assertConnectedAccount(ref);
}

export async function getAgentCapabilities(input: AccountRef, verifyIdentity = false, policy: AccountPolicy = "personal"): Promise<CapabilityEvidence> {
  const ref = accountRefSchema.parse(input);
  const guard = policy === "owner_ui" ? assertConnectedAccount : assertPersonalAccount;
  const account = await guard(ref);
  let scopes: string[] = [];
  if (account.provider === "gmail") {
    scopes = (await getGmailAuthorizationCapabilities(account.email)).scopes;
  } else {
    try {
      const stored: unknown = JSON.parse(await getServiceState(`microsoft_scopes:${emailKey(account.email)}`) || "[]");
      if (Array.isArray(stored) && stored.every(s => typeof s === "string")) scopes = stored;
    } catch { /* Missing/invalid metadata cannot grant authority. */ }
  }
  let identityVerifiedAt: string | null = null;
  if (verifyIdentity) {
    let identity: string;
    try {
      identity = account.provider === "gmail" ? await getGoogleCalendarIdentity(account.email)
        : (await getMicrosoftProfile(await getMicrosoftAccessToken(account.email, "profile"))).email;
    } catch { throw new Error("Provider identity could not be verified for this account."); }
    if (emailKey(identity) !== emailKey(account.email)) throw new Error("Provider identity does not match the personal account.");
    identityVerifiedAt = nowIso();
    await guard(ref);
  }
  const has = (names: string[]): CapabilityState => scopes.length === 0 ? "unknown"
    : names.some(n => scopes.some(s => s.toLowerCase() === n.toLowerCase())) ? "available" : "missing";
  const google = (names: string[]) => has(names.map(n => n === "full" ? "https://mail.google.com/" : `https://www.googleapis.com/auth/${n}`));
  const capabilities = account.provider === "gmail" ? {
    mailRead: google(["gmail.readonly", "gmail.modify", "full"]),
    mailWrite: google(["gmail.modify", "full"]), mailSend: google(["gmail.send", "gmail.modify", "full"]),
    calendarRead: google(["calendar", "calendar.readonly", "calendar.events", "calendar.events.readonly"]),
    calendarWrite: google(["calendar", "calendar.events"]),
    tasksRead: "missing" as CapabilityState, tasksWrite: "missing" as CapabilityState,
  } : {
    mailRead: has(["Mail.Read", "Mail.ReadWrite"]), mailWrite: has(["Mail.ReadWrite"]), mailSend: has(["Mail.Send"]),
    calendarRead: has(["Calendars.Read", "Calendars.ReadWrite"]), calendarWrite: has(["Calendars.ReadWrite"]),
    tasksRead: has(["Tasks.Read", "Tasks.ReadWrite"]), tasksWrite: has(["Tasks.ReadWrite"]),
  };
  return { account: { ...ref, expectedEmail: account.email }, scopes: [...scopes].sort(), identityVerifiedAt, ...capabilities };
}
