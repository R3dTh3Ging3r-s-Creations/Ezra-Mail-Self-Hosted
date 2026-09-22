import type { Transaction } from "@libsql/client";
import { z } from "zod";
const timestamp = z.string().datetime({ offset: true });
function date(value: unknown) { return typeof value === "string" && timestamp.safeParse(value).success ? Date.parse(value) : NaN; }

/** Exact identity, all UI workspaces. Never reconciles Today or calls a provider. */
export async function notificationHandledEvidence(tx: Transaction, input: { accountId: string; provider: string; threadId: string; receivedAt: string }) {
  const rows = (await tx.execute({ sql: `SELECT sequence,kind,source_revision_at,effective_at,observed_at FROM brief_notification_actions
    WHERE source_type='mail_thread' AND source_account_id=? AND source_key=? AND provider=? AND provider_thread_id=? ORDER BY sequence`,
  args: [input.accountId, `mail:${input.accountId}:${input.threadId}`, input.provider, input.threadId] })).rows;
  if (!rows.length) return { handled: false, invalid: false };
  const revision = date(input.receivedAt);
  if (!Number.isFinite(revision)) return { handled: true, invalid: true };
  const actions = rows.map(row => ({ sequence: Number(row.sequence), kind: String(row.kind), revision: date(row.source_revision_at), effective: date(row.effective_at), observed: date(row.observed_at) }));
  // Invalid chronology must never manufacture permission, even if observed after restoration.
  if (actions.some(a => ![a.revision, a.effective, a.observed].every(Number.isFinite)
    || a.revision > a.effective || a.effective > a.observed || (a.kind === "external" && a.revision === a.effective))) return { handled: true, invalid: true };
  const restores = actions.filter(a => a.kind === "bring_back" && revision >= a.revision);
  let handled = false;
  for (const closure of actions.filter(a => a.kind !== "bring_back")) {
    if (revision > closure.revision && revision > closure.effective) continue;
    if (closure.kind === "external") {
      if (restores.some(a => a.effective === closure.effective)) return { handled: true, invalid: true };
      if (!restores.some(a => a.effective > closure.effective)) handled = true;
    } else if (!restores.some(a => a.sequence > closure.sequence)) handled = true;
  }
  return { handled, invalid: false };
}
