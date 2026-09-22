// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, getSetting } from "@/lib/email/database";
import { GET, PATCH } from "@/app/api/notifications/policy/route";
import { getAuthSession } from "@/lib/email/auth";

vi.mock("@/lib/email/auth", () => ({ getAuthSession: vi.fn() }));

const origin = "https://ezra.example.test";

function request(body?: unknown) {
  return new Request(origin + "/api/notifications/policy", {
    method: body === undefined ? "GET" : "PATCH",
    headers: {
      origin,
      "content-type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  configureEmailDatabaseForTests(`file:./attention-api-${randomUUID()}.sqlite`);
  vi.stubEnv("APP_BASE_URL", origin);
  vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "");
  vi.stubEnv("EZRA_BROWSER_NOTIFICATIONS_ENABLED", "false");
  vi.mocked(getAuthSession).mockResolvedValue({
    authenticated: true,
    configured: true,
    developmentBypass: false,
    expiresAt: null,
    authenticationMethod: "trusted-device",
    trustedDevice: {
      id: "fixture",
      label: "Fixture"
    }
  } as never);
});

afterEach(() => {
  closeEmailDatabaseForTests();
  vi.unstubAllEnvs();
});

describe("protected attention policy route", () => {
  it("returns no-store policy and persists validated controls with feature disabled", async () => {
    const response = await PATCH(request({
      dailyInterruptBudget: 2,
      calmCheckinEnabled: true
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      dailyInterruptBudget: 2,
      calmCheckinEnabled: true
    });
    expect((await GET(request())).headers.get("cache-control")).toBe("no-store");
  });
  it.each([{ unknown: true }, { categoryPreferences: { unknown: "quiet" } }, { dailyInterruptBudget: 21 }, null, []])("rejects invalid input %j without saving", async (body) => {
    const response = await PATCH(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
    expect(await getSetting("notification_policy_reviewed_at")).toBeNull();
  });
  it("rejects missing/cross origin, oversized and malformed bodies", async () => {
    const missing = request({});
    missing.headers.delete("origin");
    expect((await PATCH(missing)).status).toBe(403);
    const cross = request({});
    cross.headers.set("origin", "https://other.example.test");
    expect((await PATCH(cross)).status).toBe(403);
    expect((await PATCH(request({ unknown: "x".repeat(8200) }))).status).toBe(413);
    const malformed = new Request(origin, {
      method: "PATCH",
      headers: {
        origin,
        "content-type": "application/json"
      },
      body: "{private"
    });
    const response = await PATCH(malformed);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private");
  });
  it.each(["anonymous", "password", "bypass", "unconfigured"])("rejects %s callers", async (mode) => {
    vi.mocked(getAuthSession).mockResolvedValue({
      authenticated: mode !== "anonymous",
      configured: mode !== "unconfigured",
      developmentBypass: mode === "bypass",
      trustedDevice: mode === "password" ? null : { id: "fixture" }
    } as never);
    expect((await PATCH(request({ dailyInterruptBudget: 4 }))).status).toBe(mode === "anonymous" ? 401 : 403);
    expect(await getSetting("notification_policy_reviewed_at")).toBeNull();
  });
});
