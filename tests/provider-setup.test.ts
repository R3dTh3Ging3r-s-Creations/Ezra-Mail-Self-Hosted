import { beforeEach, describe, expect, it, vi } from "vitest";

const { isGogInstalled, isMicrosoftAuthConfigured } = vi.hoisted(() => ({
  isGogInstalled: vi.fn(),
  isMicrosoftAuthConfigured: vi.fn(),
}));

vi.mock("@/lib/email/gmail", () => ({ isGogInstalled }));
vi.mock("@/lib/email/microsoft", () => ({ isMicrosoftAuthConfigured }));

import { testProviderSetup } from "@/lib/email/provider-setup";

describe("provider setup preflight", () => {
  beforeEach(() => vi.clearAllMocks());

  it("checks the Gmail local bridge without starting authorization", async () => {
    isGogInstalled.mockResolvedValue(true);

    await expect(testProviderSetup({ provider: "gmail", capability: "mail_read" }))
      .resolves.toEqual(expect.objectContaining({ ready: true, authorization: "browser" }));
    expect(isMicrosoftAuthConfigured).not.toHaveBeenCalled();
  });

  it("checks Microsoft local configuration without starting device authorization", async () => {
    isMicrosoftAuthConfigured.mockReturnValue(false);

    await expect(testProviderSetup({ provider: "microsoft", capability: "send" }))
      .resolves.toEqual(expect.objectContaining({ ready: false, authorization: "device_code" }));
    expect(isGogInstalled).not.toHaveBeenCalled();
  });
});
