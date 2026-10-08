import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as review } from "@/app/api/auth/agent-grants/review/route";
import { GET, POST } from "@/app/api/auth/agent-grants/route";
import { agentJsonResponse, readAgentJson } from "@/lib/email/agent-api";
const mocks = vi.hoisted(() => ({ session: vi.fn(), issue: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/email/auth", async original => ({ ...await original<typeof import("@/lib/email/auth")>(), getAuthSession: mocks.session }));
vi.mock("@/lib/email/agent-grants", async original => ({ ...await original<typeof import("@/lib/email/agent-grants")>(), issueAgentGrant: mocks.issue, listAgentGrants: mocks.list }));
const origin = "https://mail.example.test";
const spec = { label: "Fixture", lifetimeDays: 7, accounts: [{ accountId: "ms", provider: "microsoft", expectedEmail: "owner@hotmail.test" }], resources: [], scopes: ["accounts.read"] };
const request = (headers: Record<string,string> = {}, body: unknown = { spec, stepUpReceiptId: "receipt" }) => new Request(`${origin}/api/auth/agent-grants`, { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify(body) });
describe("isolated owner grant routes", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => { vi.unstubAllEnvs(); vi.stubEnv("EZRA_WEBAUTHN_ORIGIN", ""); vi.clearAllMocks(); mocks.session.mockResolvedValue({ authenticated: true, authenticationMethod: "trusted_device", trustedDevice: { id: "device" } }); mocks.issue.mockResolvedValue({ grant: { keyId: "fixture" }, secret: "fake-once-only" }); mocks.list.mockResolvedValue([]); });
  it("uses server-derived owner identity and emits no-store responses", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.issue).toHaveBeenCalledWith(spec, { deviceId: "device", stepUpReceiptId: "receipt" });
  });
  it("bearer never authenticates owner API", async () => {
    expect((await POST(request({ authorization: "Bearer synthetic" }))).status).toBe(401);
    expect((await GET(new Request(`${origin}/api/auth/agent-grants`, { headers: { authorization: "Bearer synthetic" } }))).status).toBe(401);
    expect(mocks.issue).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
  });
  it("rejects CSRF, missing origin and injected authority", async () => {
    expect((await POST(request({ origin: "https://attacker.test" }))).status).toBe(403);
    expect((await POST(request({ origin: "" }))).status).toBe(403);
    expect((await POST(request({}, { spec, stepUpReceiptId: "receipt", deviceId: "chosen" }))).status).toBe(400);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("requires a trusted owner device", async () => {
    mocks.session.mockResolvedValue({ authenticated: true, authenticationMethod: "password", trustedDevice: null });
    expect((await POST(request())).status).toBe(401);
  });
  it("bounds streaming JSON without trusting Content-Length", async () => {
    await expect(readAgentJson(request({}, { body: "x".repeat(65_536) }))).rejects.toMatchObject({ status: 413 });
  });
  it("redacts unexpected provider/database errors", async () => {
    const response = await agentJsonResponse(async () => { throw new Error("private-token-and-provider-body"); });
    expect(await response.text()).not.toContain("private-token");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("reviews access behind the configured owner HTTPS proxy without issuing a grant", async () => {
    const proxyOrigin = origin + ":8450";
    vi.stubEnv("EZRA_WEBAUTHN_ORIGIN", proxyOrigin);
    const proxied = new Request("https://localhost:8789/api/auth/agent-grants/review", {
      method: "POST", headers: { host: "mail.example.test:8450", origin: proxyOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ action: "issue", spec }),
    });
    const response = await review(proxied);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reviewHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(mocks.issue).not.toHaveBeenCalled();
    expect((await GET(new Request("https://localhost:8789/api/auth/agent-grants", {
      headers: { host: "mail.example.test:8450", "sec-fetch-site": "same-origin" },
    }))).status).toBe(200);
    expect((await review(new Request("https://localhost:8789/api/auth/agent-grants/review", {
      method: "POST", headers: { host: "mail.example.test:8449", origin: proxyOrigin, "content-type": "application/json" },
      body: JSON.stringify({ action: "issue", spec }),
    }))).status).toBe(403);
  });
  it("rejects forged proxy headers and alternate hosts before owner authentication", async () => {
    vi.stubEnv("EZRA_WEBAUTHN_ORIGIN", origin);
    for (const headers of [
      { host: "attacker.test", origin },
      { host: "mail.example.test", origin: "https://attacker.test" },
      { host: "localhost:8789", origin },
      { host: "mail.example.test", origin, "sec-fetch-site": "same-site" },
      { host: "mail.example.test", origin, "sec-fetch-site": "cross-site" },
      { host: "mail.example.test", origin: "null" },
    ] as Record<string,string>[]) {
      const response = await review(new Request("https://localhost:8789/api/auth/agent-grants/review", {
        method: "POST", headers: { ...headers, "x-forwarded-host": "mail.example.test", "x-forwarded-proto": "https", "content-type": "application/json" },
        body: JSON.stringify({ action: "issue", spec }),
      }));
      expect(response.status).toBe(403);
    }
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("fails closed when the configured owner origin is malformed", async () => {
    for (const configured of ["https://mail.example.test/path", "https://user@mail.example.test", "http://mail.example.test", "https://mail.example.test,https://attacker.test"]) {
      vi.stubEnv("EZRA_WEBAUTHN_ORIGIN", configured);
      expect((await review(request({}, { action: "issue", spec }))).status).toBe(503);
    }
    expect(mocks.session).not.toHaveBeenCalled();
  });

});
