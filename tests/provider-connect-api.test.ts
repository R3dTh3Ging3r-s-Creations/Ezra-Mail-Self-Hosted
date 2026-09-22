import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockedRequireAuth, completeGmailAccountConnection, completeMicrosoftAccountConnection } = vi.hoisted(() => ({
  mockedRequireAuth: vi.fn(),
  completeGmailAccountConnection: vi.fn(),
  completeMicrosoftAccountConnection: vi.fn(),
}));

vi.mock("@/lib/email/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/auth")>();
  return { ...actual, requireAuth: mockedRequireAuth };
});
vi.mock("@/lib/email/service", () => ({ completeGmailAccountConnection, completeMicrosoftAccountConnection }));

import { POST } from "@/app/api/accounts/connect/route";

function request(body: unknown) {
  return new Request("http://localhost/api/accounts/connect", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/accounts/connect", () => {
  beforeEach(() => {
    mockedRequireAuth.mockReset();
    completeGmailAccountConnection.mockReset();
    completeMicrosoftAccountConnection.mockReset();
  });

  it("completes a Gmail verification through the existing redirect verifier without accepting credentials", async () => {
    mockedRequireAuth.mockResolvedValue(undefined);
    completeGmailAccountConnection.mockResolvedValue({ status: "connected", email: "owner@gmail.test", access: "maintenance" });

    const response = await POST(request({
      provider: "gmail", email: "owner@gmail.test", access: "maintenance", authUrl: "http://127.0.0.1:4865/oauth2/callback?code=verified",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ connection: { status: "connected", email: "owner@gmail.test", access: "maintenance" } });
    expect(completeGmailAccountConnection).toHaveBeenCalledWith({
      email: "owner@gmail.test", access: "maintenance", authUrl: "http://127.0.0.1:4865/oauth2/callback?code=verified",
    });
    expect(completeMicrosoftAccountConnection).not.toHaveBeenCalled();
  });

  it("completes a Microsoft verification through its server-held device-code connection", async () => {
    mockedRequireAuth.mockResolvedValue(undefined);
    completeMicrosoftAccountConnection.mockResolvedValue({ status: "connected", email: "owner@outlook.test" });

    const response = await POST(request({ provider: "microsoft", connectionId: "server-held-connection" }));

    await expect(response.json()).resolves.toEqual({ connection: { status: "connected", email: "owner@outlook.test" } });
    expect(completeMicrosoftAccountConnection).toHaveBeenCalledWith("server-held-connection");
    expect(completeGmailAccountConnection).not.toHaveBeenCalled();
  });
});
