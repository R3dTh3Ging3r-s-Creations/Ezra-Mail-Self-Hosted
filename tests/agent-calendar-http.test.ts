import {createHash, randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {configureEmailDatabaseForTests, execute, setSetting} from "@/lib/email/database";
import {createAgentHttpClient} from "@/lib/email/agent-http-client";
import {POST as prepareRoute} from "@/app/api/agent/v1/operations/route";
import {POST as executeRoute} from "@/app/api/agent/v1/operations/[operationId]/execute/route";
import {GET as statusRoute} from "@/app/api/agent/v1/operations/[operationId]/route";
import type {OperationView, ResourceMutation} from "@/lib/email/agent-resource-types";

const provider = vi.hoisted(() => ({support: vi.fn(), prepare: vi.fn(), update: vi.fn()}));
vi.mock("@/lib/email/agent-provider-support", async original => ({...await original<typeof import("@/lib/email/agent-provider-support")>(), getConditionalWriteSupport: provider.support}));
vi.mock("@/lib/email/calendar-mutation-actions", () => ({prepareCalendarMutationEvidence: provider.prepare, updateCalendarEvent: provider.update}));
const accounts = [
  {accountId: "fixture-ms", provider: "microsoft" as const, expectedEmail: "owner@hotmail.test"},
  {accountId: "fixture-gg", provider: "gmail" as const, expectedEmail: "owner@gmail.test"},
];
const targets = accounts.map(account => ({account, kind: "calendar" as const, id: account.expectedEmail}));
const secret = "test-fixture".padEnd(43, "S"); // Synthetic credential; no live profile is loaded.
const key = `ezra_fixture.${secret}`;
const client = () => createAgentHttpClient({origin: "https://fixture.test", getKey: async () => key});
const mutation = (index: number): ResourceMutation => ({kind: "calendar.update", target: targets[index], eventId: "fixture-event", expectedRevision: '"fixture-revision"', patch: {title: "Fixture updated"}});

describe("calendar update through scoped HTTP routes and persisted operations", () => {
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    const request = new Request(url, init);
    const path = new URL(url).pathname;
    if (path === "/api/agent/v1/operations" && init.method === "POST") return prepareRoute(request);
    const match = /^\/api\/agent\/v1\/operations\/([^/]+)(\/execute)?$/.exec(path);
    if (!match) throw new Error("Unexpected fixture route");
    const context = {params: Promise.resolve({operationId: decodeURIComponent(match[1])})};
    if (match[2] && init.method === "POST") return executeRoute(request, context);
    if (!match[2] && init.method === "GET") return statusRoute(request, context);
    throw new Error("Unexpected fixture method");
  });
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./calendar-http-${randomUUID()}.sqlite`);
    vi.clearAllMocks();
    vi.stubGlobal("fetch", transport);
    await setSetting("agent_personal_accounts", JSON.stringify(accounts));
    const now = new Date().toISOString();
    for (const account of accounts) await execute("INSERT INTO email_accounts(id,provider,email,label,status,created_at,updated_at) VALUES (?,?,?,'Fixture','connected',?,?)", [account.accountId, account.provider, account.expectedEmail, now, now]);
    await execute("INSERT INTO agent_grants(key_id,secret_digest,grant_json,revision,created_at,expires_at) VALUES ('fixture',?,?,1,?,?)", [createHash("sha256").update(secret).digest("hex"), JSON.stringify({label: "Fixture", lifetimeDays: 7, accounts, resources: targets, scopes: ["calendar.update"]}), now, new Date(Date.now() + 86_400_000).toISOString()]);
    provider.support.mockResolvedValue({available: true});
    provider.prepare.mockImplementation(async (input: ResourceMutation) => ({target: "target" in input ? input.target : undefined, complete: true, providerRevision: '"fixture-revision"', fetchedAt: new Date().toISOString(), identityVerifiedAt: new Date().toISOString(), before: {}}));
    provider.update.mockImplementation(async (_target, _id, _revision, _patch, _signal, beforeMutation) => {await beforeMutation();});
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([0, 1])("executes provider %i once, preserves the exact hash, and reads the receipt after reconnect", async index => {
    const op = await client().call("operations/prepare", {idempotencyKey: "main-edit", mutation: mutation(index)}) as OperationView;
    const result = await client().call("operations/execute", {operationId: op.id, payloadHash: op.payloadHash});
    expect(result).toMatchObject({id: op.id, payloadHash: op.payloadHash, status: "succeeded", receipt: {providerId: "fixture-event", outcome: "updated"}});
    const request = transport.mock.calls.find(([url]) => url.endsWith("/execute"))!;
    expect(JSON.parse(String(request[1].body))).toEqual({payloadHash: op.payloadHash});
    expect(provider.update).toHaveBeenCalledWith(targets[index], "fixture-event", '"fixture-revision"', {title: "Fixture updated"}, expect.any(AbortSignal), expect.any(Function));
    expect(await client().call("operations/execute", {operationId: op.id, payloadHash: op.payloadHash})).toEqual(result);
    expect(await client().call("operations/status", {operationId: op.id})).toEqual(result);
    expect(provider.update).toHaveBeenCalledOnce();
    expect((await execute("SELECT COUNT(*) AS n FROM agent_resource_operation_attempts WHERE operation_id=? AND dispatched_at IS NOT NULL", [op.id])).rows[0].n).toBe(1);
  });

  it("rejects a mismatched hash before claiming or dispatching, preserving the approved operation", async () => {
    const op = await client().call("operations/prepare", {idempotencyKey: "hash-check", mutation: mutation(0)}) as OperationView;
    await expect(client().call("operations/execute", {operationId: op.id, payloadHash: "0".repeat(64)})).rejects.toThrow("Agent request failed");
    expect(await client().call("operations/status", {operationId: op.id})).toMatchObject({status: "approved", payloadHash: op.payloadHash});
    expect(provider.update).not.toHaveBeenCalled();
    expect((await execute("SELECT * FROM agent_resource_operation_attempts")).rows).toHaveLength(0);
    expect((await execute("SELECT * FROM agent_resource_locks")).rows).toHaveLength(0);
  });

  it("preserves zero-dispatch evidence when qualification disappears before execution", async () => {
    const op = await client().call("operations/prepare", {idempotencyKey: "qualification-check", mutation: mutation(0)}) as OperationView;
    provider.support.mockResolvedValue({available: false});
    await expect(client().call("operations/execute", {operationId: op.id, payloadHash: op.payloadHash})).rejects.toThrow("Agent request failed");
    expect(await client().call("operations/status", {operationId: op.id})).toMatchObject({status: "approved"});
    expect(provider.update).not.toHaveBeenCalled();
    expect((await execute("SELECT * FROM agent_resource_operation_attempts")).rows).toHaveLength(0);
    expect((await execute("SELECT * FROM agent_resource_locks")).rows).toHaveLength(0);
  });
});
