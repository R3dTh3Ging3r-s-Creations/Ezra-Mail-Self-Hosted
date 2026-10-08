import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, createEmailDatabaseConnection, execute, setSetting } from "@/lib/email/database";
import { createAgentOperationStore } from "@/lib/email/agent-operation-store";
import { createAgentResourceStore, hashResourceMutation } from "@/lib/email/agent-resource-store";
import { createAgentDispatcher } from "@/lib/email/agent-dispatch";
import { calendarCreateSchema } from "@/lib/email/agent-operation-schema";
import type { ResourceMutation } from "@/lib/email/agent-resource-types";

const account = { accountId: "ms", provider: "microsoft" as const, expectedEmail: "owner@hotmail.test" };
const target = { account, kind: "calendar" as const, id: "cal" };
const mutation: ResourceMutation = { kind: "calendar.delete", target, eventId: "event", expectedRevision: "etag" };
const principal = { keyId: "fixture", revision: 1 };
const now = () => new Date().toISOString();
const evidence = () => ({ target, complete: true as const, fetchedAt: now(), identityVerifiedAt: now(), providerRevision: "etag" });
const payload = calendarCreateSchema.parse({ account, calendarId: "cal", title: "Fixture", description: "", location: "", startsAt: "2026-10-09T12:00:00Z", endsAt: "2026-10-09T12:10:00Z", timezone: "America/Chicago", isAllDay: false, reminder: { mode: "none" }, isBusy: false, privacy: "default", attendees: [], sendUpdates: false });

describe("atomic originating-grant dispatch", () => {
  const clients: ReturnType<typeof createEmailDatabaseConnection>[] = [];
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./dispatch-${randomUUID()}.sqlite`);
    await setSetting("agent_personal_accounts", JSON.stringify([account, { accountId: "gg", provider: "gmail", expectedEmail: "owner@gmail.test" }]));
    await execute("INSERT INTO email_accounts(id,provider,email,label,status,created_at,updated_at) VALUES ('ms','microsoft','owner@hotmail.test','Fixture','connected',?,?)", [now(), now()]);
    const spec = { label: "Fixture", lifetimeDays: 7, accounts: [account], resources: [target], scopes: ["calendar.create", "calendar.delete"] };
    await execute("INSERT INTO agent_grants(key_id,secret_digest,grant_json,revision,created_at,expires_at) VALUES ('fixture','synthetic',?,1,?,?)", [JSON.stringify(spec), now(), new Date(Date.now() + 86_400_000).toISOString()]);
  });
  afterEach(() => { clients.splice(0).forEach(client => client.close()); vi.restoreAllMocks(); });
  function connection() { const client = createEmailDatabaseConnection(); clients.push(client); return client; }
  async function resource() { const store = createAgentResourceStore(connection()); const op = await store.prepareKeyOperation(principal, randomUUID(), mutation, evidence()); return { store, op }; }
  async function legacy() {
    const store = createAgentOperationStore(connection());
    const op = await store.savePreparedOperation(payload, { account, scopes: ["Calendars.ReadWrite"], identityVerifiedAt: now(), calendarRead: "available", calendarWrite: "available", mailRead: "unknown", mailWrite: "unknown", mailSend: "unknown" }, { account, calendarId: "cal", range: { from: payload.startsAt, to: payload.endsAt }, fetchedAt: now(), complete: true, events: [] });
    await store.approveOperationFromTrustedTransport(op.id, op.payloadHash, { source: "owner_ui", principal: "owner", requestId: "review", account });
    return { store, op };
  }
  it("revocation wins before authorization with zero provider calls", async () => {
    const { store, op } = await resource(); const claim = (await store.claimOperation(op.id, op.payloadHash))!;
    const provider = vi.fn(); const other = connection();
    await other.execute({ sql: "UPDATE agent_grants SET revoked_at=? WHERE key_id='fixture'", args: [now()] });
    if (await createAgentDispatcher(connection()).authorizeAgentDispatch(principal, op.id, op.payloadHash, claim)) provider();
    expect(provider).not.toHaveBeenCalled();
    expect((await execute("SELECT dispatched_at FROM agent_resource_operation_attempts")).rows[0].dispatched_at).toBeNull();
  });
  it("an authorized dispatch remains recorded as in flight after revocation", async () => {
    const { store, op } = await resource(); const claim = (await store.claimOperation(op.id, op.payloadHash))!;
    expect(await createAgentDispatcher(connection()).authorizeAgentDispatch(principal, op.id, op.payloadHash, claim)).toBe(true);
    await connection().execute({ sql: "UPDATE agent_grants SET revoked_at=? WHERE key_id='fixture'", args: [now()] });
    expect((await execute("SELECT authorized_at,dispatched_at FROM agent_resource_operation_attempts")).rows[0]).toMatchObject({ authorized_at: expect.any(String), dispatched_at: expect.any(String) });
    expect(await createAgentDispatcher(connection()).authorizeAgentDispatch(principal, op.id, op.payloadHash, claim)).toBe(false);
  });
  it("legacy and generic operations share one calendar lock across connections", async () => {
    const a = await legacy(); const b = await resource();
    const claims = await Promise.all([a.store.claimOperation(a.op.id, a.op.payloadHash), b.store.claimOperation(b.op.id, b.op.payloadHash)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await execute("SELECT * FROM agent_resource_locks")).rows).toHaveLength(1);
  });
  it("unknown legacy blocks generic writes and retains its lock", async () => {
    const a = await legacy(); const claim = (await a.store.claimOperation(a.op.id, a.op.payloadHash))!;
    await a.store.markDispatched(a.op.id, claim);
    await a.store.recordOperationOutcome(a.op.id, claim, "unknown", undefined, "timeout");
    const b = await resource();
    expect(await b.store.claimOperation(b.op.id, b.op.payloadHash)).toBeNull();
  });
  it("another key cannot authorize an originating key's operation", async () => {
    const { store, op } = await resource(); const claim = (await store.claimOperation(op.id, op.payloadHash))!;
    expect(await createAgentDispatcher(connection()).authorizeAgentDispatch({ keyId: "other", revision: 1 }, op.id, op.payloadHash, claim)).toBe(false);
  });
  it("same idempotency key with changed payload conflicts", async () => {
    const store = createAgentResourceStore(connection());
    const first = await store.prepareKeyOperation(principal, "stable", mutation, evidence());
    expect((await store.prepareKeyOperation(principal, "stable", mutation, evidence())).id).toBe(first.id);
    await expect(store.prepareKeyOperation(principal, "stable", { ...mutation, eventId: "different" }, evidence())).rejects.toMatchObject({ status: 409 });
    expect(first.payloadHash).toBe(hashResourceMutation(mutation));
  });
  it("expired preparation never claims or dispatches", async () => {
    const { store, op } = await resource();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 60_000 + 1);
    expect(await store.claimOperation(op.id, op.payloadHash)).toBeNull();
  });
});
