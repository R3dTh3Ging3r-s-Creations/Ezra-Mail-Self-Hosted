import type { Transaction } from "@libsql/client";

/** Only the latest check-in answer applies; a hold always expires and never grants eligibility. */
export async function notificationCheckinHoldUntil(tx: Pick<Transaction, "execute">, now: Date): Promise<string | null> {
  const row = (await tx.execute({ sql: `SELECT f.kind,f.created_at FROM notification_feedback f JOIN notification_events e ON e.id=f.event_id
    WHERE e.kind='checkin' AND f.created_at<=? ORDER BY f.created_at DESC,CASE WHEN f.kind='too_noisy' THEN 0 ELSE 1 END,e.sequence DESC LIMIT 1`, args: [now.toISOString()] })).rows[0];
  if (!row || row.kind !== "too_noisy") return null;
  const at = Date.parse(String(row.created_at)), until = at + 7 * 86400000;
  return Number.isFinite(at) && at <= now.getTime() && until > now.getTime() ? new Date(until).toISOString() : null;
}
