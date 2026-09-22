import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockedRequireAuth, testProviderSetup } = vi.hoisted(() => ({
  mockedRequireAuth: vi.fn(),
  testProviderSetup: vi.fn(),
}));

vi.mock("@/lib/email/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/auth")>();
  return { ...actual, requireAuth: mockedRequireAuth };
});
vi.mock("@/lib/email/provider-setup", () => ({ testProviderSetup }));

import { AuthError } from "@/lib/email/auth";
import { POST } from "@/app/api/accounts/test/route";

function request(body: unknown) {
  return new Request("http://localhost/api/accounts/test", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/accounts/test", () => {
  beforeEach(() => {
    mockedRequireAuth.mockReset();
    testProviderSetup.mockReset();
  });

  it("returns a redacted local Gmail prerequisite result without an account identity", async () => {
    mockedRequireAuth.mockResolvedValue(undefined);
    testProviderSetup.mockResolvedValue({ provider: "gmail", capability: "mail_read", ready: true, authorization: "browser", message: "Gmail is ready for authorization." });

    const response = await POST(request({ provider: "gmail", capability: "mail_read" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ test: expect.objectContaining({ provider: "gmail", capability: "mail_read", ready: true }) });
    expect(testProviderSetup).toHaveBeenCalledWith({ provider: "gmail", capability: "mail_read" });
    expect(JSON.stringify(body)).not.toMatch(/token|credential|accountId|email|host|port|refresh/i);
  });

  it("returns an unavailable Microsoft prerequisite without starting sign-in", async () => {
    mockedRequireAuth.mockResolvedValue(undefined);
    testProviderSetup.mockResolvedValue({ provider: "microsoft", capability: "send", ready: false, authorization: "device_code", message: "Microsoft sign-in needs local setup." });

    const response = await POST(request({ provider: "microsoft", capability: "send" }));

    await expect(response.json()).resolves.toEqual({
      test: expect.objectContaining({ provider: "microsoft", capability: "send", ready: false }),
    });
  });

  it("does not run the prerequisite when authentication fails", async () => {
    mockedRequireAuth.mockRejectedValue(new AuthError("Sign in required.", 401));

    const response = await POST(request({ provider: "gmail", capability: "send" }));

    expect(response.status).toBe(401);
    expect(testProviderSetup).not.toHaveBeenCalled();
  });

  it("rejects unsupported capability input", async () => {
    mockedRequireAuth.mockResolvedValue(undefined);
    const response = await POST(request({ provider: "gmail", capability: "calendar" }));
    expect(response.status).toBe(400);
    expect(testProviderSetup).not.toHaveBeenCalled();
  });
});
