import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_SCHEMA_VERSION, configureEmailDatabaseForTests, createEmailDatabaseConnection, execute } from "@/lib/email/database";
import { createAgentOperationStore } from "@/lib/email/agent-operation-store";
import { calendarCreateSchema } from "@/lib/email/agent-operation-schema";
import type { CapabilityEvidence, CalendarSnapshot } from "@/lib/email/agent-types";

const payload = calendarCreateSchema.parse({ account: { accountId: "ms", provider: "microsoft", expectedEmail: "owner@hotmail.test" }, calendarId: "cal", title: "Reminder", description: "", location: "", startsAt: "2026-10-09T12:00:00.000Z", endsAt: "2026-10-09T12:10:00.000Z", timezone: "America/Chicago", isAllDay: false, reminder: { mode: "minutes", minutes: 0 }, isBusy: false, privacy: "default", attendees: [], sendUpdates: false });
const evidence = (): CapabilityEvidence => ({ account: payload.account, scopes: ["Calendars.ReadWrite"], identityVerifiedAt: new Date(Date.now()).toISOString(), calendarRead: "available", calendarWrite: "available", mailRead: "unknown", mailWrite: "unknown", mailSend: "unknown" });
const snapshot = (): CalendarSnapshot => ({ account: payload.account, calendarId: payload.calendarId, fetchedAt: new Date(Date.now()).toISOString(), range: { from: payload.startsAt, to: payload.endsAt }, complete: true, events: [] });
describe("durable operation claims", () => {
  const clients: ReturnType<typeof createEmailDatabaseConnection>[] = [];
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./operations-${randomUUID()}.sqlite`);
    await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES ('ms','microsoft','owner@hotmail.test','Personal','connected',?,?)", [new Date().toISOString(),new Date().toISOString()]);
  });
  afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.restoreAllMocks(); });
  const store = () => { const client = createEmailDatabaseConnection(); clients.push(client); return createAgentOperationStore(client); };
  async function prepared(id: string = randomUUID()) { return createAgentOperationStore().savePreparedOperation(payload, evidence(), snapshot(), id); }
  async function approved(id: string = randomUUID()) {
    const op = await prepared(id); await createAgentOperationStore().approveOperationFromTrustedTransport(op.id, op.payloadHash, { source: "owner_ui", principal: "owner", requestId: randomUUID(), account: payload.account }); return op;
  }
  it("adds schema 12 without altering existing account rows and preserves immutable prepared content", async () => {
    const op = await prepared("same");
    expect((await execute("PRAGMA user_version")).rows[0].user_version).toBe(EMAIL_SCHEMA_VERSION);
    expect((await execute("SELECT label FROM email_accounts WHERE id='ms'")).rows[0].label).toBe("Personal");
    expect((await prepared("same")).payloadHash).toBe(op.payloadHash);
    await expect(createAgentOperationStore().savePreparedOperation({ ...payload, title: "Changed" }, evidence(), snapshot(), "same")).rejects.toThrow(/immutable/i);
    await expect(execute("UPDATE agent_operations SET payload_json='{}' WHERE id='same'")).rejects.toThrow(/immutable/i);
  });
  it("rejects missing authority, stale approval and a changed account/hash", async () => {
    const op = await prepared(); const db = store();
    expect(await db.claimOperation(op.id, op.payloadHash)).toBeNull();
    await expect(db.approveOperationFromTrustedTransport(op.id, "bad", { source: "owner_ui", principal: "owner", requestId: "r", account: payload.account })).rejects.toThrow();
    await expect(db.approveOperationFromTrustedTransport(op.id, op.payloadHash, { source: "owner_ui", principal: "owner", requestId: "r", account: { ...payload.account, accountId: "other" } })).rejects.toThrow();
    const future = Date.now() + 30 * 60_000 + 1; vi.spyOn(Date, "now").mockReturnValue(future);
    await expect(db.approveOperationFromTrustedTransport(op.id, op.payloadHash, { source: "owner_ui", principal: "owner", requestId: "r", account: payload.account })).rejects.toThrow();
    expect((await db.getOperation(op.id))?.status).toBe("expired");
  });
  it("lets only one of two connections claim an operation and persists the attempt first", async () => {
    const op = await approved(); const a = store(); const b = store();
    const claims = await Promise.all([a.claimOperation(op.id, op.payloadHash), b.claimOperation(op.id, op.payloadHash)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const rows = (await execute("SELECT * FROM agent_operation_attempts WHERE operation_id=?", [op.id])).rows;
    expect(rows).toHaveLength(1); expect(rows[0].dispatched_at).toBeNull();
  });
  it("serializes different operation ids on one calendar and leaves crashed attempts unknown", async () => {
    const one = await approved(); const two = await approved(); const a = store(); const b = store();
    const claims = await Promise.all([a.claimOperation(one.id, one.payloadHash), b.claimOperation(two.id, two.payloadHash)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims[0] ? one : two; const loser = claims[0] ? two : one; const claim = claims.find(Boolean)!;
    expect(await a.markDispatched(winner.id, claim)).toBe(true);
    const future = Date.now() + 180_001; vi.spyOn(Date, "now").mockReturnValue(future);
    expect((await b.getOperation(winner.id))?.status).toBe("unknown");
    expect(await b.claimOperation(loser.id, loser.payloadHash)).toBeNull();
    expect(await a.heartbeat(winner.id, claim)).toBe(false);
    expect(await a.recordOperationOutcome(winner.id, claim, "failed", undefined, "late")).toBe(false);
    expect(await a.claimOperation(winner.id, winner.payloadHash)).toBeNull();
  });
  it("releases a known pre-dispatch failure but rejects an unsafe failure after dispatch", async () => {
    const one = await approved(); const db = store(); const claim = (await db.claimOperation(one.id, one.payloadHash))!;
    expect(await db.recordOperationOutcome(one.id, claim, "failed", undefined, "conflict")).toBe(true);
    const two = await approved(); const second = (await db.claimOperation(two.id, two.payloadHash))!;
    expect(await db.markDispatched(two.id, second)).toBe(true);
    expect(await db.recordOperationOutcome(two.id, second, "failed", undefined, "timeout")).toBe(false);
    expect(await db.recordOperationOutcome(two.id, second, "unknown", undefined, "timeout")).toBe(true);
  });
  it("persists restart state, renews only the current lease and never dispatches an attempt twice", async () => {
    const op = await approved(); const a = store(); const claim = (await a.claimOperation(op.id, op.payloadHash))!;
    const b = store();
    expect(await b.getOperation(op.id)).toMatchObject({ status: "executing", claimId: claim, attemptCount: 1 });
    expect(await b.heartbeat(op.id, "wrong-claim")).toBe(false);
    expect(await b.heartbeat(op.id, claim)).toBe(true);
    expect(await b.markDispatched(op.id, claim)).toBe(true);
    expect(await b.markDispatched(op.id, claim)).toBe(false);
    expect(await b.recordProviderEventId(op.id, claim, "event")).toBe(true);
    expect(await b.recordProviderEventId(op.id, claim, "other")).toBe(false);
    expect(await a.getOperation(op.id)).toMatchObject({ providerEventId: "event" });
    await expect(b.recordOperationOutcome(op.id, claim, "succeeded")).rejects.toThrow(/receipt/i);
  });
  it("rejects incomplete preflight evidence instead of preparing an operation", async () => {
    const db = store();
    await expect(db.savePreparedOperation(payload, { ...evidence(), identityVerifiedAt: null }, snapshot())).rejects.toThrow(/evidence/i);
    await expect(db.savePreparedOperation(payload, evidence(), { ...snapshot(), calendarId: "other" })).rejects.toThrow(/evidence/i);
  });
});
