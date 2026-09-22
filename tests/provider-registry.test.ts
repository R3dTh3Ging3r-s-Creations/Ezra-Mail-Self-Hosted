import { describe, expect, it } from "vitest";
import { discoverProvider, listProviderInventory } from "@/lib/email/provider-registry";
import { buildMailWorkspaces, workspaceSqlFilter } from "@/lib/email/workspaces";

describe("provider inventory", () => {
  it("lists Gmail and Microsoft as connectable while retaining standards presets as unavailable future options", () => {
    const providers = listProviderInventory();

    expect(providers.map((item) => item.id)).toEqual(["gmail", "microsoft", "standards"]);
    expect(providers.find((item) => item.id === "standards")).toMatchObject({
      available: false,
      presets: ["yahoo", "icloud", "fastmail", "zoho", "aol", "custom"],
    });
    expect(providers.filter((item) => item.id !== "standards").every((item) => item.available)).toBe(true);
  });

  it("advertises the proven Gmail and Microsoft Flag mappings without inventing Microsoft Pin", () => {
    const providers = listProviderInventory();

    expect(providers.find((item) => item.id === "gmail")?.capabilities).toMatchObject({ pin: true, flag: true });
    expect(providers.find((item) => item.id === "microsoft")?.capabilities).toMatchObject({ pin: false, flag: true });
    expect(providers.find((item) => item.id === "standards")?.capabilities).toMatchObject({ pin: false, flag: false });
  });

  it("reports reversible actions and provider-honest unsubscribe capability", () => {
    const gmail = listProviderInventory().find((item) => item.id === "gmail")!;
    const microsoft = listProviderInventory().find((item) => item.id === "microsoft")!;

    expect(gmail.capabilities).toMatchObject({ undo: true, unsubscribe: true });
    expect(microsoft.capabilities).toMatchObject({ undo: true, unsubscribe: false });
  });

  it("describes Gmail setup without account-scoped or secret values", () => {
    expect(discoverProvider("gmail")).toEqual({
      provider: "gmail",
      label: "Gmail",
      authorization: "browser",
      capabilities: { mailRead: true, send: true },
    });
  });

  it("describes Microsoft setup through its device-code journey", () => {
    expect(discoverProvider("microsoft")).toEqual({
      provider: "microsoft",
      label: "Microsoft",
      authorization: "device_code",
      capabilities: { mailRead: true, send: true },
    });
  });

  it("builds one workspace per active account and scopes account workspace queries exactly", () => {
    const workspaces = buildMailWorkspaces([
      { id: "acct-personal", provider: "gmail", email: "personal@gmail.test", label: "Personal", status: "connected", lastSyncAt: null, counts: { inbox: 0, unread: 0, interrupt: 0, digest: 0, maintenance: 0 } },
      { id: "acct-work", provider: "gmail", email: "work@gmail.test", label: "Work", status: "connected", lastSyncAt: null, counts: { inbox: 0, unread: 0, interrupt: 0, digest: 0, maintenance: 0 } },
    ]);

    expect(workspaces.map((workspace) => workspace.id)).toEqual([
      "workspace:account:gmail:acct-personal",
      "workspace:account:gmail:acct-work",
      "workspace:all",
    ]);
    expect(workspaceSqlFilter("workspace:account:gmail:acct-work")).toEqual({
      sql: "m.account_id = ?",
      args: ["acct-work"],
    });
  });
});
