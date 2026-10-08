import { randomUUID, createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, execute, setSetting } from "@/lib/email/database";
import { calendarCreateSchema, type CalendarCreate } from "@/lib/email/agent-operation-schema";
import { POST as prepare } from "@/app/api/agent/v1/operations/route";
import { POST as run } from "@/app/api/agent/v1/operations/[operationId]/execute/route";
import { POST as reconcile } from "@/app/api/agent/v1/operations/[operationId]/reconcile/route";
const service = vi.hoisted(() => ({ capabilities: vi.fn(), account: vi.fn(), read: vi.fn(), event: vi.fn(), msCreate: vi.fn(), ggCreate: vi.fn() }));
vi.mock("@/lib/email/agent-accounts", () => ({ getAgentCapabilities: service.capabilities, assertPersonalAccount: service.account, assertConnectedAccount: service.account }));
vi.mock("@/lib/email/agent-calendar", () => ({ readAgentCalendar: service.read, readAgentEvent: service.event }));
vi.mock("@/lib/email/microsoft", () => ({ createMicrosoftCalendarEvent: service.msCreate }));
vi.mock("@/lib/email/gmail", () => ({ createGoogleCalendarEvent: service.ggCreate, assertGoogleCalendarReminderSupport: vi.fn() }));
const microsoft = { accountId: "ms", provider: "microsoft" as const, expectedEmail: "owner@hotmail.test" };
const google = { accountId: "gg", provider: "gmail" as const, expectedEmail: "owner@gmail.test" };
const raw = "x".repeat(43);
const token = `ezra_fixture.${raw}`;
const request = (body: unknown, signal?: AbortSignal, key = token) => new Request("https://mail.example.test/api/agent/v1/test", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal });
let current: CalendarCreate;
function event() {
  return { id: "event", externalEventId: "event", accountId: current.account.accountId, accountProvider: current.account.provider, accountLabel: "Fixture", calendarId: "cal", calendarName: "Calendar", title: current.title, description: current.description, location: current.location, startsAt: current.startsAt, endsAt: current.endsAt, timezone: current.timezone, isAllDay: false, dateRange: null, status: "confirmed", visibility: "default", isBusy: false, reminder: current.reminder, attendees: [], organizerEmail: current.account.expectedEmail, organizerName: "Fixture", webLink: null, updatedAt: new Date().toISOString(), syncedAt: new Date().toISOString() };
}
const context = (id: string) => ({ params: Promise.resolve({ operationId: id }) });
async function prepared() {
  const response = await prepare(request({ idempotencyKey: randomUUID(), mutation: { kind: "calendar.create", payload: current } }));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ id: string; payloadHash: string }>;
}
describe("keyed calendar API using real authorization persistence", () => {
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./key-create-${randomUUID()}.sqlite`);
    await setSetting("agent_personal_accounts", JSON.stringify([microsoft, google]));
    for (const account of [microsoft, google]) await execute("INSERT INTO email_accounts(id,provider,email,label,status,created_at,updated_at) VALUES (?,?,?,'Fixture','connected',?,?)", [account.accountId,account.provider,account.expectedEmail,new Date().toISOString(),new Date().toISOString()]);
    const spec = { label: "Fixture", lifetimeDays: 7, accounts: [microsoft,google], resources: [microsoft,google].map(account => ({ account, kind: "calendar", id: "cal" })), scopes: ["accounts.read","calendar.read","calendar.create"] };
    await execute("INSERT INTO agent_grants(key_id,secret_digest,grant_json,revision,created_at,expires_at) VALUES ('fixture',?,?,1,?,?)", [createHash("sha256").update(raw).digest("hex"),JSON.stringify(spec),new Date().toISOString(),new Date(Date.now()+86_400_000).toISOString()]);
    for (const mock of Object.values(service)) mock.mockReset();
    service.account.mockImplementation(async ref => ({ id: ref.accountId, provider: ref.provider, email: ref.expectedEmail, label: "Fixture" }));
    service.capabilities.mockImplementation(async ref => ({ account: ref, scopes: ["Calendars.ReadWrite"], identityVerifiedAt: new Date().toISOString(), calendarRead: "available", calendarWrite: "available" }));
    service.read.mockImplementation(async (account,calendarId,range) => ({ account,calendarId,range,complete:true,events:[],fetchedAt:new Date().toISOString() }));
    service.event.mockImplementation(async () => ({ status: "found", event: event() }));
    service.msCreate.mockResolvedValue({ externalEventId: "event", calendarId: "cal" });
    service.ggCreate.mockResolvedValue({ externalEventId: "event", calendarId: "cal" });
    current = calendarCreateSchema.parse({ account: microsoft, calendarId: "cal", title: "Fixture", description: "", location: "", startsAt: "2026-11-06T13:00:00Z", endsAt: "2026-11-06T13:10:00Z", timezone: "America/Chicago", isAllDay: false, reminder: { mode: "minutes", minutes: 0 }, isBusy: false, privacy: "default", attendees: [], sendUpdates: false });
  });
  it.each([microsoft,google])("creates and verifies an exact event for $provider without duplicate dispatch", async account => {
    current = { ...current, account };
    const op = await prepared();
    const result = await run(request({ payloadHash: op.payloadHash }), context(op.id));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: "succeeded", receipt: { providerId: "event", outcome: "created" } });
    expect((await run(request({ payloadHash: op.payloadHash }), context(op.id))).status).toBe(200);
    expect(service.msCreate.mock.calls.length + service.ggCreate.mock.calls.length).toBe(1);
  });
  it("revocation during fresh preflight prevents provider dispatch", async () => {
    const op = await prepared();
    service.read.mockImplementationOnce(async (account,calendarId,range) => { await execute("UPDATE agent_grants SET revoked_at=? WHERE key_id='fixture'", [new Date().toISOString()]); return { account,calendarId,range,complete:true,events:[],fetchedAt:new Date().toISOString() }; });
    expect((await run(request({ payloadHash: op.payloadHash }), context(op.id))).status).toBe(401);
    expect(service.msCreate).not.toHaveBeenCalled();
  });
  it("disconnect after dispatch remains unknown and never blindly retries", async () => {
    const op = await prepared(); const controller = new AbortController();
    service.msCreate.mockImplementation(async (_email,_input,options) => new Promise((_resolve,reject) => { options.signal.addEventListener("abort", () => reject(new Error("interrupted"))); queueMicrotask(() => controller.abort()); }));
    const response = await run(request({ payloadHash: op.payloadHash }, controller.signal), context(op.id));
    expect(await response.json()).toMatchObject({ status: "unknown" });
    expect(await (await run(request({ payloadHash: op.payloadHash }), context(op.id))).json()).toMatchObject({ status: "unknown" });
    expect(await (await reconcile(request({}), context(op.id))).json()).toMatchObject({ status: "unknown" });
    expect(service.msCreate).toHaveBeenCalledOnce();
  });
  it("aborted requests and altered hashes never dispatch", async () => {
    const op = await prepared(); const controller = new AbortController(); controller.abort();
    expect((await run(request({ payloadHash: op.payloadHash },controller.signal),context(op.id))).status).toBe(409);
    expect((await run(request({ payloadHash: "a".repeat(64) }),context(op.id))).status).toBe(409);
    expect(service.msCreate).not.toHaveBeenCalled();
  });
});
