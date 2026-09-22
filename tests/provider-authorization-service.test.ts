import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterCalls = vi.hoisted(() => {
  const adapter = {
    startAuthorization: vi.fn(async (input: { email: string; access: string }) => input.email.endsWith("gmail.test")
      ? { provider: "gmail" as const, mode: "browser" as const, processId: 123 }
      : {
          provider: "microsoft" as const,
          userCode: "ABCD",
          verificationUri: "https://microsoft.example.test/device",
          verificationUriComplete: null,
          expiresIn: 900,
          interval: 5,
          message: "Use the code.",
        }),
  };
  return { adapter, providerAdapterFor: vi.fn(() => adapter) };
});

const directProviderCalls = vi.hoisted(() => ({
  isGogInstalled: vi.fn(async () => true),
  startGmailAuthorization: vi.fn(async () => ({ mode: "browser" as const, processId: 123 })),
  isMicrosoftAuthConfigured: vi.fn(() => true),
  startMicrosoftDeviceAuthorization: vi.fn(async () => ({
    deviceCode: "device-code",
    userCode: "ABCD",
    verificationUri: "https://microsoft.example.test/device",
    verificationUriComplete: null,
    expiresIn: 900,
    interval: 5,
    message: "Use the code.",
  })),
}));

vi.mock("@/lib/email/provider-adapter", () => adapterCalls);
vi.mock("@/lib/email/gmail", () => ({
  isGogInstalled: directProviderCalls.isGogInstalled,
  startGmailAuthorization: directProviderCalls.startGmailAuthorization,
}));
vi.mock("@/lib/email/microsoft", () => ({
  isMicrosoftAuthConfigured: directProviderCalls.isMicrosoftAuthConfigured,
  startMicrosoftDeviceAuthorization: directProviderCalls.startMicrosoftDeviceAuthorization,
}));

import { configureEmailDatabaseForTests, getServiceState } from "@/lib/email/database";
import {
  startGmailAccountConnection,
  startMicrosoftAccountConnection,
} from "@/lib/email/service";

describe("provider authorization service integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureEmailDatabaseForTests(`file:./provider-authorization-service-${randomUUID()}.sqlite`);
  });

  it("routes Gmail connection start through its provider adapter", async () => {
    await expect(startGmailAccountConnection({ email: "owner@gmail.test", access: "maintenance" }))
      .resolves.toMatchObject({ status: "started", email: "owner@gmail.test", mode: "browser" });

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("gmail");
    expect(adapterCalls.adapter.startAuthorization).toHaveBeenCalledWith({
      email: "owner@gmail.test",
      access: "maintenance",
    });
  });

  it("routes Microsoft connection start through its provider adapter and keeps only session metadata", async () => {
    const result = await startMicrosoftAccountConnection({ email: "owner@outlook.test", access: "full" });

    expect(adapterCalls.providerAdapterFor).toHaveBeenCalledWith("microsoft");
    expect(adapterCalls.adapter.startAuthorization).toHaveBeenCalledWith({
      email: "owner@outlook.test",
      access: "full",
    });
    await expect(getServiceState(`microsoft_auth:${result.connectionId}`))
      .resolves.toContain("owner@outlook.test");
  });
});
