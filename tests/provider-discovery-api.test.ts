import { describe, expect, it, vi } from "vitest";

const { mockedRequireAuth } = vi.hoisted(() => ({
  mockedRequireAuth: vi.fn(),
}));

vi.mock("@/lib/email/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/auth")>();
  return { ...actual, requireAuth: mockedRequireAuth };
});

import { AuthError } from "@/lib/email/auth";
import { POST } from "@/app/api/accounts/discover/route";

function request(body: unknown) {
  return new Request("http://localhost/api/accounts/discover", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/accounts/discover", () => {
  it("returns a redacted Gmail setup candidate to an authenticated caller", async () => {
    mockedRequireAuth.mockResolvedValue(undefined);

    const response = await POST(request({ provider: "gmail" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      discovery: {
        provider: "gmail",
        label: "Gmail",
        authorization: "browser",
        capabilities: { mailRead: true, send: true },
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/token|credential|accountId|email|host|port|refresh/i);
  });

  it("returns the Microsoft device-code candidate", async () => {
    mockedRequireAuth.mockResolvedValue(undefined);

    const response = await POST(request({ provider: "microsoft" }));

    await expect(response.json()).resolves.toEqual({
      discovery: expect.objectContaining({ provider: "microsoft", authorization: "device_code" }),
    });
  });

  it("does not serialize discovery metadata when authentication fails", async () => {
    mockedRequireAuth.mockRejectedValue(new AuthError("Sign in required.", 401));

    const response = await POST(request({ provider: "gmail" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Sign in required." });
  });

  it("rejects an unsupported provider", async () => {
    mockedRequireAuth.mockResolvedValue(undefined);

    const response = await POST(request({ provider: "standards" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ ok: false }));
  });
});
