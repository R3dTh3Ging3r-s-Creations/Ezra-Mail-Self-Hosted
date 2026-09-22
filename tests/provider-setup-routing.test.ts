import { beforeEach, describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({
  discover: vi.fn(() => ({ provider: "gmail", label: "Adapter Gmail", authorization: "browser", capabilities: { mailRead: true, send: false } })),
  preflight: vi.fn(async () => ({ provider: "gmail", capability: "mail_read", ready: true, authorization: "browser", message: "Adapter-ready." })),
  applyMaintenance: vi.fn(),
  undoMaintenance: vi.fn(),
}));
const providerAdapterFor = vi.hoisted(() => vi.fn(() => adapter));

vi.mock("@/lib/email/provider-adapter", () => ({ providerAdapterFor }));

import { discoverProvider } from "@/lib/email/provider-registry";
import { testProviderSetup } from "@/lib/email/provider-setup";

describe("provider setup routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the selected adapter for static discovery", () => {
    expect(discoverProvider("gmail")).toMatchObject({ label: "Adapter Gmail", capabilities: { send: false } });
    expect(providerAdapterFor).toHaveBeenCalledWith("gmail");
    expect(adapter.preflight).not.toHaveBeenCalled();
  });

  it("uses the selected adapter for local setup preflight", async () => {
    await expect(testProviderSetup({ provider: "gmail", capability: "mail_read" }))
      .resolves.toMatchObject({ message: "Adapter-ready." });
    expect(providerAdapterFor).toHaveBeenCalledWith("gmail");
    expect(adapter.preflight).toHaveBeenCalledWith("mail_read");
  });
});
