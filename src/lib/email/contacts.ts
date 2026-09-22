import { audit, execute, newId, nowIso } from "./database";
import type {
  AccountProvider,
  ContactSuggestion,
  ContactSuggestionPage,
  ContactSuggestionSource,
  EmailRecipient,
} from "./types";
import { accountWorkspaceIdentity, providerForWorkspace } from "./workspaces";

type Row = Awaited<ReturnType<typeof execute>>["rows"][number];

type AccountRow = {
  id: string;
  label: string;
  email: string;
  provider: AccountProvider;
};

type ContactAggregate = ContactSuggestion & {
  score: number;
  sourceSet: Set<Exclude<ContactSuggestionSource, "mixed">>;
};

export async function getContactSuggestions(input: {
  workspaceId?: string | null;
  accountId?: string | null;
  q?: string | null;
  limit?: number;
} = {}): Promise<ContactSuggestionPage> {
  const query = normalizeQuery(input.q);
  const limit = clampLimit(input.limit);
  const accounts = await getAllowedAccounts(input.workspaceId, input.accountId);
  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  const contacts = new Map<string, ContactAggregate>();

  if (accounts.length) {
    await addManualContacts(contacts, accountMap, query);
    await addSenderContacts(contacts, accountMap, query);
    await addOutgoingRecipientContacts(contacts, accountMap, query);
  }

  const items = Array.from(contacts.values())
    .map(finalizeContact)
    .sort((left, right) => right.score - left.score || compareLatest(right.lastSeenAt, left.lastSeenAt) || left.email.localeCompare(right.email))
    .slice(0, limit)
    .map(({ score: _score, sourceSet: _sourceSet, ...contact }) => contact);

  return {
    generatedAt: nowIso(),
    query,
    workspaceId: input.workspaceId || null,
    accountId: input.accountId || null,
    items,
  };
}

export async function upsertManualContact(input: {
  accountId: string;
  email: string;
  name?: string | null;
  note?: string | null;
}, source = "cockpit") {
  const account = await getAccount(input.accountId);
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw new Error(`Invalid contact email: ${input.email || "(blank)"}`);
  const name = cleanName(input.name);
  const now = nowIso();
  const existing = await execute(
    `SELECT id FROM contact_index WHERE account_id = ? AND email = ? AND source = 'manual'`,
    [account.id, email],
  );
  const id = existing.rows[0]?.id ? String(existing.rows[0].id) : newId("contact");
  await execute(
    `INSERT INTO contact_index
      (id, account_id, email, name, source, note, use_count, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'manual', ?, 1, ?, ?, ?)
     ON CONFLICT(account_id, email, source) DO UPDATE SET
       name = excluded.name,
       note = excluded.note,
       use_count = contact_index.use_count + 1,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`,
    [id, account.id, email, name, input.note || null, now, now, now],
  );
  await audit("contact.upserted", source, "contact", id, { accountId: account.id, email });
  const page = await getContactSuggestions({ accountId: account.id, q: email, limit: 1 });
  return page.items[0];
}

async function getAllowedAccounts(workspaceId?: string | null, accountId?: string | null) {
  const workspaceAccount = accountWorkspaceIdentity(workspaceId);
  const provider = providerForWorkspace(workspaceId);
  const args: string[] = [];
  const where = ["status <> 'disabled'"];
  if (workspaceAccount) {
    where.push("id = ? AND provider = ?");
    args.push(workspaceAccount.accountId, workspaceAccount.provider);
  } else if (provider !== "all") {
    where.push("provider = ?");
    args.push(provider);
  }
  if (accountId) {
    where.push("id = ?");
    args.push(accountId);
  }
  const result = await execute(
    `SELECT id, label, email, provider FROM email_accounts WHERE ${where.join(" AND ")} ORDER BY provider, label, email`,
    args,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    email: normalizeEmail(row.email),
    provider: accountProvider(row.provider),
  }));
}

async function getAccount(accountId: string) {
  const result = await execute(
    `SELECT id, label, email, provider FROM email_accounts WHERE id = ? AND status <> 'disabled'`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Contact account was not found.");
  return {
    id: String(row.id),
    label: String(row.label),
    email: normalizeEmail(row.email),
    provider: accountProvider(row.provider),
  };
}

async function addManualContacts(contacts: Map<string, ContactAggregate>, accounts: Map<string, AccountRow>, query: string) {
  const rows = await execute(
    `SELECT account_id, email, name, source, use_count, last_seen_at, updated_at
     FROM contact_index
     WHERE account_id IN (${placeholders(accounts.size)})
     ORDER BY updated_at DESC
     LIMIT 500`,
    Array.from(accounts.keys()),
  );
  for (const row of rows.rows) {
    const account = accounts.get(String(row.account_id));
    if (!account) continue;
    recordContact(contacts, {
      account,
      email: row.email,
      name: row.name,
      source: "manual",
      count: Number(row.use_count || 1),
      lastSeenAt: String(row.last_seen_at || row.updated_at || ""),
      query,
    });
  }
}

async function addSenderContacts(contacts: Map<string, ContactAggregate>, accounts: Map<string, AccountRow>, query: string) {
  const rows = await execute(
    `SELECT account_id, sender_email, sender_name, received_at
     FROM email_messages
     WHERE account_id IN (${placeholders(accounts.size)})
       AND sender_email <> ''
     ORDER BY received_at DESC
     LIMIT 2000`,
    Array.from(accounts.keys()),
  );
  for (const row of rows.rows) {
    const account = accounts.get(String(row.account_id));
    if (!account) continue;
    recordContact(contacts, {
      account,
      email: row.sender_email,
      name: row.sender_name,
      source: "sender",
      count: 1,
      lastSeenAt: String(row.received_at || ""),
      query,
    });
  }
}

async function addOutgoingRecipientContacts(contacts: Map<string, ContactAggregate>, accounts: Map<string, AccountRow>, query: string) {
  const rows = await execute(
    `SELECT account_id, to_recipients, cc_recipients, bcc_recipients, updated_at
     FROM outgoing_drafts
     WHERE account_id IN (${placeholders(accounts.size)})
     ORDER BY updated_at DESC
     LIMIT 1000`,
    Array.from(accounts.keys()),
  );
  for (const row of rows.rows) {
    const account = accounts.get(String(row.account_id));
    if (!account) continue;
    for (const recipient of [
      ...parseRecipients(row.to_recipients),
      ...parseRecipients(row.cc_recipients),
      ...parseRecipients(row.bcc_recipients),
    ]) {
      recordContact(contacts, {
        account,
        email: recipient.email,
        name: recipient.name,
        source: "recipient",
        count: 1,
        lastSeenAt: String(row.updated_at || ""),
        query,
      });
    }
  }
}

function recordContact(contacts: Map<string, ContactAggregate>, input: {
  account: AccountRow;
  email: unknown;
  name: unknown;
  source: Exclude<ContactSuggestionSource, "mixed">;
  count: number;
  lastSeenAt: string;
  query: string;
}) {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return;
  if (email === input.account.email) return;
  const name = cleanName(input.name);
  if (!matchesQuery(input.query, email, name)) return;
  const key = `${input.account.id}:${email}`;
  const existing = contacts.get(key);
  if (!existing) {
    contacts.set(key, {
      id: `contact:${input.account.id}:${email}`,
      accountId: input.account.id,
      accountLabel: input.account.label,
      accountProvider: input.account.provider,
      name,
      email,
      source: input.source,
      sourceSet: new Set([input.source]),
      messageCount: Math.max(1, input.count),
      lastSeenAt: input.lastSeenAt || null,
      relationship: relationshipLabel(input.source, Math.max(1, input.count)),
      score: baseScore(input.source, input.query, email, name, input.lastSeenAt) + Math.min(25, input.count),
    });
    return;
  }

  existing.sourceSet.add(input.source);
  existing.source = existing.sourceSet.size > 1 ? "mixed" : input.source;
  existing.messageCount += Math.max(1, input.count);
  existing.name = preferredName(existing.name, name, input.source === "manual");
  existing.lastSeenAt = latestIso(existing.lastSeenAt, input.lastSeenAt);
  existing.score += baseScore(input.source, input.query, email, name, input.lastSeenAt) + Math.min(10, input.count);
}

function finalizeContact(contact: ContactAggregate): ContactAggregate {
  contact.relationship = contact.source === "mixed"
    ? `Seen in mail and drafts · ${contact.messageCount} touch${contact.messageCount === 1 ? "" : "es"}`
    : relationshipLabel(contact.source, contact.messageCount);
  return contact;
}

function relationshipLabel(source: ContactSuggestionSource, count: number) {
  if (source === "manual") return "Saved contact";
  if (source === "recipient") return `Used in ${count} draft${count === 1 ? "" : "s"}`;
  if (source === "sender") return `${count} received message${count === 1 ? "" : "s"}`;
  return `${count} contact touch${count === 1 ? "" : "es"}`;
}

function baseScore(source: ContactSuggestionSource, query: string, email: string, name: string | null, lastSeenAt: string | null) {
  const sourceWeight = source === "manual" ? 1000 : source === "recipient" ? 500 : 250;
  const queryWeight = query && (email.startsWith(query) || String(name || "").toLowerCase().startsWith(query)) ? 200 : 0;
  const recentWeight = lastSeenAt ? Math.max(0, 90 - Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 86_400_000)) : 0;
  return sourceWeight + queryWeight + recentWeight;
}

function preferredName(current: string | null, next: string | null, preferNext: boolean) {
  if (!next) return current;
  if (!current || preferNext) return next;
  return next.length > current.length ? next : current;
}

function latestIso(current: string | null, next: string | null) {
  if (!next) return current;
  if (!current) return next;
  return new Date(next).getTime() > new Date(current).getTime() ? next : current;
}

function compareLatest(left: string | null, right: string | null) {
  return (left ? new Date(left).getTime() : 0) - (right ? new Date(right).getTime() : 0);
}

function matchesQuery(query: string, email: string, name: string | null) {
  if (!query) return true;
  return email.includes(query) || String(name || "").toLowerCase().includes(query);
}

function normalizeQuery(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function cleanName(value: unknown) {
  const name = String(value || "").trim().replace(/^"|"$/g, "");
  if (!name || isValidEmail(name)) return null;
  return name;
}

function parseRecipients(value: unknown): EmailRecipient[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        email: normalizeEmail(item?.email),
        name: cleanName(item?.name),
      }))
      .filter((item) => isValidEmail(item.email));
  } catch {
    return [];
  }
}

function placeholders(count: number) {
  return Array.from({ length: Math.max(1, count) }, () => "?").join(", ");
}

function clampLimit(value: unknown) {
  const parsed = Number(value || 12);
  if (!Number.isFinite(parsed)) return 12;
  return Math.max(1, Math.min(50, Math.floor(parsed)));
}

function isValidEmail(value: string) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

function accountProvider(value: unknown): AccountProvider {
  return value === "microsoft" ? "microsoft" : "gmail";
}
