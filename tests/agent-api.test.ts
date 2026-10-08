import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as search } from "@/app/api/agent/v1/mail/search/route";
import { POST as calendar } from "@/app/api/agent/v1/calendar/read/route";
import { POST as prepare } from "@/app/api/agent/v1/operations/route";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), admit: vi.fn(), search: vi.fn(), calendar: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/email/agent-api", async original => ({ ...await original<typeof import("@/lib/email/agent-api")>(), authenticateAgentRequest: mocks.auth }));
vi.mock("@/lib/email/agent-grants", async original => ({ ...await original<typeof import("@/lib/email/agent-grants")>(), admitAgentRead: mocks.admit }));
vi.mock("@/lib/email/agent-mail", async original => ({ ...await original<typeof import("@/lib/email/agent-mail")>(), searchAgentMail: mocks.search }));
vi.mock("@/lib/email/agent-calendar", () => ({ readAgentCalendar: mocks.calendar }));
vi.mock("@/lib/email/agent-resource-store", async original => ({ ...await original<typeof import("@/lib/email/agent-resource-store")>(), prepareAgentOperation: mocks.prepare }));
const account = { accountId: "ms", provider: "microsoft", expectedEmail: "owner@hotmail.test" };
const request = (body: unknown) => new Request("https://mail.example.test/api/agent/v1/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
describe("typed private agent read routes", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ keyId: "key", revision: 1 }); mocks.admit.mockResolvedValue({}); mocks.search.mockResolvedValue({ items: [], completeProviderCoverage: false }); mocks.calendar.mockResolvedValue({ calendarId: "cal", complete: true, events: [] }); });
  it("checks exact granted account before mail search", async () => {
    const response = await search(request({ account, query: "paystub" }));
    expect(response.status).toBe(200);
    expect(mocks.admit).toHaveBeenCalledWith({ keyId: "key", revision: 1 }, "mail.read", account);
    expect(mocks.search).toHaveBeenCalledOnce();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects denied account before provider call", async () => {
    const { AuthError } = await import("@/lib/email/auth");
    mocks.admit.mockRejectedValue(new AuthError("Denied", 403));
    expect((await search(request({ account }))).status).toBe(403);
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("requires exact resource and rejects resolved-calendar mismatch", async () => {
    const body = { account, calendarId: "cal", range: { from: "2026-10-09T00:00:00Z", to: "2026-10-10T00:00:00Z" } };
    expect((await calendar(request(body))).status).toBe(200);
    expect(mocks.admit).toHaveBeenCalledWith(expect.anything(), "calendar.read", { account, kind: "calendar", id: "cal" });
    mocks.calendar.mockResolvedValue({ calendarId: "other", complete: true, events: [] });
    expect((await calendar(request(body))).status).toBe(403);
  });
  it("rejects request authority and provider URL injection", async () => {
    expect((await search(request({ account, providerUrl: "https://example.test" }))).status).toBe(400);
    expect((await prepare(request({ idempotencyKey: "one", principal: { keyId: "other" }, mutation: {} }))).status).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
