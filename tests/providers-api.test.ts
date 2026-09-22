import { describe, expect, it, vi } from "vitest";

const { mockedRequireAuth } = vi.hoisted(() => ({
  mockedRequireAuth: vi.fn(),
}));

vi.mock("@/lib/email/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/auth")>();
  return { ...actual, requireAuth: mockedRequireAuth };
});

import { AuthError } from "@/lib/email/auth";
import { GET } from "@/app/api/providers/route";

describe("GET /api/providers", () => {
  it("returns the provider inventory for an authenticated request", async () => {
    mockedRequireAuth.mockResolvedValue(undefined);

    const response = await GET(new Request("http://localhost/api/providers"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gmail", capabilities: expect.objectContaining({ pin: true, flag: true }) }),
      expect.objectContaining({ id: "microsoft", capabilities: expect.objectContaining({ pin: false, flag: true }) }),
    ]));
    expect(JSON.stringify(body)).not.toMatch(/token|credential|accountId|email/i);
  });

  it("does not serialize the inventory when authentication fails", async () => {
    mockedRequireAuth.mockRejectedValue(new AuthError("Sign in required.", 401));

    const response = await GET(new Request("http://localhost/api/providers"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Sign in required." });
  });
});
