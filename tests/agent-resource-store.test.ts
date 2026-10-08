import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, execute, setSetting } from "@/lib/email/database";
import { agentOperationStore } from "@/lib/email/agent-operation-store";
import { createAgentResourceStore, prepareAgentOperation, getAgentOperation } from "@/lib/email/agent-resource-store";
import { authorizeAgentDispatch } from "@/lib/email/agent-dispatch";
import { calendarCreateSchema } from "@/lib/email/agent-operation-schema";
import type { ResourceMutation } from "@/lib/email/agent-resource-types";
const prepare = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/agent-actions", () => ({ prepareCalendarCreate: prepare }));
const account = { accountId: "ms", provider: "microsoft" as const, expectedEmail: "owner@hotmail.test" };
const calendar = { account, kind: "calendar" as const, id: "cal" };
const list = { account, kind: "task_list" as const, id: "list" };
const principal = { keyId: "fixture", revision: 1 };
const stamp = () => new Date().toISOString();
const task: ResourceMutation = { kind: "tasks.create", target: list, fields: { title: "Fixture", body: "", importance: "normal", due: null, reminder: null } };
const evidence = () => ({ target: list, complete: true as const, fetchedAt: stamp(), identityVerifiedAt: stamp() });
const payload = calendarCreateSchema.parse({ account, calendarId: "cal", title: "Fixture", description: "", location: "", startsAt: "2026-10-09T12:00:00Z", endsAt: "2026-10-09T12:10:00Z", timezone: "America/Chicago", isAllDay: false, reminder: { mode: "none" }, isBusy: false, privacy: "default", attendees: [], sendUpdates: false });
describe("durable keyed operations", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./resource-store-${randomUUID()}.sqlite`);
    await setSetting("agent_personal_accounts", JSON.stringify([account, { accountId: "gg", provider: "gmail", expectedEmail: "owner@gmail.test" }]));
    await execute("INSERT INTO email_accounts(id,provider,email,label,status,created_at,updated_at) VALUES ('ms','microsoft','owner@hotmail.test','Fixture','connected',?,?)", [stamp(), stamp()]);
    await execute("INSERT INTO agent_grants(key_id,secret_digest,grant_json,revision,created_at,expires_at) VALUES ('fixture','synthetic',?,1,?,?)", [JSON.stringify({ label: "Fixture", lifetimeDays: 7, accounts: [account], resources: [calendar,list], scopes: ["calendar.create","tasks.create"] }), stamp(), new Date(Date.now()+86_400_000).toISOString()]);
    prepare.mockReset().mockImplementation(async () => agentOperationStore.savePreparedOperation(payload, { account, scopes: ["Calendars.ReadWrite"], identityVerifiedAt: stamp(), calendarRead: "available", calendarWrite: "available", mailRead: "unknown", mailWrite: "unknown", mailSend: "unknown" }, { account, calendarId: "cal", range: { from: payload.startsAt, to: payload.endsAt }, fetchedAt: stamp(), complete: true, events: [] }));
  });
  it("binds legacy creates once and blocks access or dispatch through another authority", async () => {
    const mutation = { kind: "calendar.create" as const, payload };
    const op = await prepareAgentOperation(principal, "once", mutation);
    expect(await prepareAgentOperation(principal, "once", mutation)).toEqual(op);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(op)).not.toContain("approval");
    await expect(getAgentOperation({ keyId: "other", revision: 1 }, op.id)).rejects.toMatchObject({ status: 403 });
    const claim = (await agentOperationStore.claimOperation(op.id, op.payloadHash))!;
    expect(await agentOperationStore.markDispatched(op.id, claim)).toBe(false);
    expect(await agentOperationStore.markDispatched(op.id, claim, { keyId: "other", revision: 1 })).toBe(false);
    expect(await agentOperationStore.markDispatched(op.id, claim, principal)).toBe(true);
  });
  it("preserves unknown outcomes and refuses redispatch after restart", async () => {
    const store = createAgentResourceStore(); const op = await store.prepareKeyOperation(principal, "unknown", task, evidence());
    const claim = (await store.claimOperation(op.id, op.payloadHash))!;
    expect(await authorizeAgentDispatch(principal, op.id, op.payloadHash, claim)).toBe(true);
    expect(await store.recordOutcome(op.id, claim, "failed", undefined, "timeout")).toBe(false);
    expect(await store.recordOutcome(op.id, claim, "unknown", undefined, "timeout")).toBe(true);
    const restarted = createAgentResourceStore();
    expect((await restarted.getOperation(op.id))?.status).toBe("unknown");
    expect(await restarted.claimOperation(op.id, op.payloadHash)).toBeNull();
    expect((await execute("SELECT operation_id FROM agent_resource_locks")).rows).toEqual([{ operation_id: op.id }]);
  });
  it("releases pre-dispatch failures and requires provider-bound success receipts", async () => {
    const store = createAgentResourceStore(); const op = await store.prepareKeyOperation(principal, "before", task, evidence());
    const claim = (await store.claimOperation(op.id, op.payloadHash))!;
    expect(await store.recordOutcome(op.id, claim, "failed", undefined, "preflight_failed")).toBe(true);
    expect((await execute("SELECT * FROM agent_resource_locks")).rows).toHaveLength(0);
    const next = await store.prepareKeyOperation(principal, "next", task, evidence()); const nextClaim = (await store.claimOperation(next.id, next.payloadHash))!;
    await authorizeAgentDispatch(principal, next.id, next.payloadHash, nextClaim);
    await store.recordProviderId(next.id, nextClaim, "created-task");
    await expect(store.recordOutcome(next.id, nextClaim, "succeeded", { providerId: "wrong-task", outcome: "created", verifiedAt: stamp() })).rejects.toThrow(/receipt/i);
    expect(await store.recordOutcome(next.id, nextClaim, "succeeded", { providerId: "created-task", outcome: "created", verifiedAt: stamp() })).toBe(true);
    await expect(execute("UPDATE agent_resource_operations SET receipt_json='{}' WHERE id=?", [next.id])).rejects.toThrow(/immutable/i);
  });
  it("rejects mismatched or incomplete preparation evidence", async () => {
    const store = createAgentResourceStore();
    await expect(store.prepareKeyOperation(principal, "bad", task, { ...evidence(), target: calendar })).rejects.toThrow(/evidence/i);
    await expect(store.prepareKeyOperation(principal, "bad", task, { ...evidence(), fetchedAt: "2000-01-01T00:00:00Z" })).rejects.toThrow(/evidence/i);
  });
});
