import type { GrantPrincipal } from "./agent-resource-types";
import { assertConnectedAccount, assertPersonalAccount, getAgentCapabilities, type AccountPolicy } from "./agent-accounts";
import { readAgentCalendar, readAgentEvent } from "./agent-calendar";
import { agentOperationStore as store, DISPATCH_HEARTBEAT_MS, PROVIDER_DEADLINE_MS, type PreparedOperation } from "./agent-operation-store";
import { calendarCreateSchema, hashCalendarCreate, type CalendarCreate, type OperationReceipt } from "./agent-operation-schema";
import { createMicrosoftCalendarEvent } from "./microsoft";
import { assertGoogleCalendarReminderSupport, createGoogleCalendarEvent } from "./gmail";
import { allDayRangeFromInstants } from "./calendar-day";
import type { CalendarEvent } from "./types";

const stamp = () => new Date().toISOString();
function targetRange(payload: CalendarCreate) {
  return { from: new Date(Date.parse(payload.startsAt) - 86_400_000).toISOString(), to: new Date(Date.parse(payload.endsAt) + 86_400_000).toISOString() };
}
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stop = new Promise<never>((_resolve, reject) => {
    abort = () => { controller.abort(); reject(new Error("Provider execution was interrupted.")); };
    timer = setTimeout(abort, PROVIDER_DEADLINE_MS);
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
  });
  try { if (controller.signal.aborted) return await stop; return await Promise.race([work(controller.signal), stop]); }
  finally { clearTimeout(timer); if (abort) parent?.removeEventListener("abort", abort); }
}

/** Exact-field comparison; default may be resolved by the provider only for our own create. */
export function calendarEventMatches(payload: CalendarCreate, event: CalendarEvent, ownCreate = false) {
  const attendees = (values: string[]) => values.map(value => value.toLowerCase()).sort().join("\n");
  const reminder = payload.reminder.mode === "default" && ownCreate
    ? !!event.reminder && event.reminder.mode !== "unknown"
    : JSON.stringify(payload.reminder) === JSON.stringify(event.reminder);
  const visibility = event.visibility === "normal" || event.visibility === null ? "default" : event.visibility;
  const dates = payload.isAllDay ? allDayRangeFromInstants(payload.startsAt, payload.endsAt, payload.timezone) : null;
  const sameTime = payload.isAllDay ? !!dates && JSON.stringify(dates) === JSON.stringify(event.dateRange)
    : Date.parse(event.startsAt) === Date.parse(payload.startsAt) && Date.parse(event.endsAt) === Date.parse(payload.endsAt);
  return event.accountId === payload.account.accountId && event.accountProvider === payload.account.provider && event.calendarId === payload.calendarId
    && event.status === "confirmed" && event.title === payload.title && (event.description || "") === payload.description && (event.location || "") === payload.location
    && event.isAllDay === payload.isAllDay && sameTime && event.isBusy === payload.isBusy && visibility === payload.privacy && reminder
    && attendees(event.attendees.map(item => item.email)) === attendees(payload.attendees);
}
function receipt(op: PreparedOperation, event: CalendarEvent, outcome: OperationReceipt["outcome"]): OperationReceipt {
  return { operationId: op.id, payloadHash: op.payloadHash, account: op.payload.account, calendarId: op.payload.calendarId, providerEventId: event.externalEventId, outcome, verifiedAt: stamp(), event };
}
async function loadOperation(id: string) { const op = await store.getOperation(id); if (!op) throw new Error("Calendar operation was not found."); return op; }
async function verifiedWriteCapability(payload: CalendarCreate, policy: AccountPolicy, signal?: AbortSignal) {
  const evidence = await bounded(() => getAgentCapabilities(payload.account, true, policy), signal);
  if (evidence.calendarWrite !== "available" || !evidence.identityVerifiedAt) throw new Error("Calendar write permission or identity could not be verified.");
  return evidence;
}

export async function prepareCalendarCreate(input: unknown, operationId?: string, policy: AccountPolicy = "personal") {
  let payload = calendarCreateSchema.parse(input);
  // Resume the same immutable request without replacing its original evidence or authority.
  if (operationId) {
    const prior = await store.getOperation(operationId);
    if (prior) {
      await (policy === "owner_ui" ? assertConnectedAccount : assertPersonalAccount)(payload.account);
      if (payload.calendarId === "primary") payload = { ...payload, calendarId: prior.payload.calendarId };
      if (hashCalendarCreate(payload) !== prior.payloadHash) throw new Error("Operation content changed; a new review is required.");
      return prior;
    }
  }
  const evidence = await verifiedWriteCapability(payload, policy);
  if (payload.account.provider === "gmail" && payload.reminder.mode === "none") await bounded(signal => assertGoogleCalendarReminderSupport(signal));
  const snapshot = await bounded(() => readAgentCalendar(payload.account, payload.calendarId, targetRange(payload), policy));
  payload = { ...payload, calendarId: snapshot.calendarId };
  return store.savePreparedOperation(payload, evidence, snapshot, operationId);
}

export async function executeCalendarCreate(id: string, principal?: GrantPrincipal, parentSignal?: AbortSignal) {
  const op = await loadOperation(id);
  const policy: AccountPolicy = op.approvalSource === "owner_ui" ? "owner_ui" : "personal";
  if (op.status !== "approved" || (op.approvalSource === "agent_key" && !principal)) return op;
  // Claim first: all fresh checks and dispatch serialize against the same calendar.
  const claim = await store.claimOperation(id, op.payloadHash);
  if (!claim) return loadOperation(id);
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort();
  parentSignal?.addEventListener("abort", abortFromRequest, { once: true });
  if (parentSignal?.aborted) controller.abort();
  let heartbeatPending: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = store.heartbeat(id, claim).then(ok => { if (!ok) controller.abort(); }, () => controller.abort()).finally(() => { heartbeatPending = undefined; });
  }, DISPATCH_HEARTBEAT_MS);
  let dispatched = false;
  let failureCode = "preflight_failed";
  try {
    await verifiedWriteCapability(op.payload, policy, controller.signal);
    const snapshot = await bounded(() => readAgentCalendar(op.payload.account, op.payload.calendarId, targetRange(op.payload), policy), controller.signal);
    if (!snapshot.complete || snapshot.calendarId !== op.payload.calendarId) throw new Error("Incomplete calendar snapshot.");
    const candidates = snapshot.events.filter(event => event.status !== "cancelled" && event.title.trim().toLowerCase() === op.payload.title.trim().toLowerCase());
    if (candidates.length) {
      failureCode = "duplicate_conflict";
      if (candidates.length !== 1 || !calendarEventMatches(op.payload, candidates[0])) throw new Error("Calendar duplicate conflict.");
      failureCode = "match_changed";
      const current = await bounded(() => readAgentEvent(op.payload.account, op.payload.calendarId, candidates[0].externalEventId, policy), controller.signal);
      if (current.status !== "found" || !calendarEventMatches(op.payload, current.event)) throw new Error("Calendar match changed during verification.");
      await store.recordOperationOutcome(id, claim, "succeeded", receipt(op, current.event, "existing_match"));
    } else {
      const account = await (policy === "owner_ui" ? assertConnectedAccount : assertPersonalAccount)(op.payload.account);
      if (account.provider === "gmail" && op.payload.reminder.mode === "none") await bounded(signal => assertGoogleCalendarReminderSupport(signal), controller.signal);
      if (controller.signal.aborted || !await store.markDispatched(id, claim, principal)) throw new Error("Dispatch claim was lost.");
      dispatched = true;
      failureCode = "unverified_provider_outcome";
      const p = op.payload;
      const input = { ...p, reminderMode: p.reminder.mode, reminderMinutes: p.reminder.mode === "minutes" ? p.reminder.minutes : null };
      const created = await bounded(signal => account.provider === "microsoft"
        ? createMicrosoftCalendarEvent(account.email, { ...input, transactionId: op.id }, { signal })
        : createGoogleCalendarEvent({ ...input, account: account.email }, { signal }), controller.signal);
      if (!created?.externalEventId || created.calendarId !== p.calendarId) throw new Error("Provider create response did not identify the selected calendar/event.");
      if (!await store.recordProviderEventId(id, claim, created.externalEventId)) throw new Error("Dispatch claim was lost.");
      failureCode = "readback_mismatch";
      const current = await bounded(() => readAgentEvent(p.account, p.calendarId, created.externalEventId, policy), controller.signal);
      if (current.status !== "found" || !calendarEventMatches(p, current.event, true)) throw new Error("Provider readback did not match the reviewed event.");
      await store.recordOperationOutcome(id, claim, "succeeded", receipt(op, current.event, "created"));
    }
  } catch {
    await store.recordOperationOutcome(id, claim, dispatched ? "unknown" : "failed", undefined, failureCode);
  } finally { clearInterval(heartbeat); parentSignal?.removeEventListener("abort", abortFromRequest); await heartbeatPending; }
  return loadOperation(id);
}

/** Read-only reconciliation. No uncertain create is ever automatically redispatched. */
export async function reconcileCalendarCreate(id: string) {
  const op = await loadOperation(id);
  const policy: AccountPolicy = op.approvalSource === "owner_ui" ? "owner_ui" : "personal";
  if (op.status !== "unknown") return op;
  try {
    await verifiedWriteCapability(op.payload, policy);
    let candidate: CalendarEvent | undefined;
    if (op.providerEventId) {
      const current = await bounded(() => readAgentEvent(op.payload.account, op.payload.calendarId, op.providerEventId!, policy));
      if (current.status === "found") candidate = current.event;
    } else if (op.payload.account.provider === "microsoft") {
      const snapshot = await bounded(() => readAgentCalendar(op.payload.account, op.payload.calendarId, targetRange(op.payload), policy));
      const correlated = snapshot.events.filter(event => event.correlationId === op.id);
      if (snapshot.complete && correlated.length === 1) {
        const current = await bounded(() => readAgentEvent(op.payload.account, op.payload.calendarId, correlated[0].externalEventId, policy));
        if (current.status === "found" && current.event.correlationId === op.id) candidate = current.event;
      }
    }
    if (candidate && calendarEventMatches(op.payload, candidate, true)) await store.recordReconciledOutcome(id, receipt(op, candidate, "created"));
  } catch { /* Absence, denial and incomplete/unavailable evidence all remain unknown. */ }
  return loadOperation(id);
}
