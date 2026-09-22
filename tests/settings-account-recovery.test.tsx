import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "@/components/ezra/SettingsView";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/components/ezra/api", () => mocks);

describe("Settings account recovery", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    mocks.api.mockReset();
    mocks.post.mockReset();
    mocks.api.mockImplementation(async (url: string) => responseFor(url));
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/accounts/discover") {
        return {
          discovery: {
            provider: body.provider,
            label: body.provider === "gmail" ? "Gmail" : "Microsoft",
            authorization: body.provider === "gmail" ? "browser" : "device_code",
            capabilities: { mailRead: true, send: true },
          },
        };
      }
      if (url === "/api/accounts/test") {
        return {
          test: {
            provider: body.provider,
            capability: body.capability,
            ready: true,
            authorization: body.provider === "gmail" ? "browser" : "device_code",
            message: `${body.provider === "gmail" ? "Gmail" : "Microsoft"} is ready for authorization.`,
          },
        };
      }
      if (url === "/api/email" && body.action === "connect_gmail") {
        return {
          ok: true,
          result: {
            status: "started",
            email: "owner@gmail.test",
            access: "maintenance",
            mode: "remote",
            authUrl: "https://accounts.google.test/authorize",
            message: "Approve Google access, then paste the final redirect URL.",
          },
        };
      }
      if (url === "/api/email" && body.action === "connect_microsoft") {
        return {
          ok: true,
          result: {
            connectionId: "microsoft-connection",
            userCode: "ABCD-EFGH",
            verificationUri: "https://microsoft.example.test/device",
            verificationUriComplete: null,
            expiresAt: "2026-08-12T22:30:00.000Z",
            message: "Open Microsoft sign-in and enter the code.",
            interval: 5,
          },
        };
      }
      if (url === "/api/accounts" && body.action === "disconnect") {
        return {
          result: { credentialRemoved: true, retainedLocalData: true },
          freshness: freshness("disabled"),
        };
      }
      if (url === "/api/system/recovery" && body.action === "pause_polling") {
        return recovery(true);
      }
      throw new Error(`Unexpected POST ${url} ${String(body.action)}`);
    });
  });

  it("offers a guided Gmail reconnect without exposing the raw OAuth error", async () => {
    render(<SettingsView workspaceId="workspace:gmail" />);
    fireEvent.click(await screen.findByRole("button", { name: "Accounts" }));

    expect(await screen.findByText("Reconnect recommended")).toBeInTheDocument();
    expect(screen.getAllByText("Gmail authorization expired or was revoked. Reconnect Gmail from Settings > Accounts.")).toHaveLength(2);
    expect(screen.queryByText(/invalid_grant/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect Gmail" }));
    expect(await screen.findByText("Google authorization")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Google sign-in" })).toHaveAttribute(
      "href",
      "https://accounts.google.test/authorize",
    );
  });

  it("checks redacted provider setup before starting a new Gmail authorization", async () => {
    render(<SettingsView workspaceId="workspace:gmail" />);
    fireEvent.click(await screen.findByRole("button", { name: "Accounts" }));

    expect(await screen.findByRole("heading", { name: "Guided account setup" })).toBeInTheDocument();
    expect(screen.getByText("1. Provider")).toBeInTheDocument();
    expect(screen.getByText("6. Verified result")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Gmail email address"), { target: { value: "new@gmail.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));

    await waitFor(() => expect(mocks.post).toHaveBeenNthCalledWith(
      1,
      "/api/accounts/discover",
      { provider: "gmail" },
    ));
    await waitFor(() => expect(mocks.post).toHaveBeenNthCalledWith(
      2,
      "/api/accounts/test",
      { provider: "gmail", capability: "mail_read" },
    ));
    expect(mocks.post).not.toHaveBeenCalledWith(
      "/api/accounts/test",
      expect.objectContaining({ email: "new@gmail.test" }),
    );
    await waitFor(() => expect(mocks.post).toHaveBeenNthCalledWith(
      3,
      "/api/email",
      { action: "connect_gmail", email: "new@gmail.test", access: "maintenance" },
    ));
    expect(await screen.findByText("Gmail is ready for authorization.")).toBeInTheDocument();
  });

  it("lets guided setup return from Google authorization without losing staged account choices", async () => {
    render(<SettingsView workspaceId="workspace:gmail" />);
    fireEvent.click(await screen.findByRole("button", { name: "Accounts" }));
    fireEvent.change(screen.getByLabelText("Gmail email address"), { target: { value: "new@gmail.test" } });
    fireEvent.change(screen.getByLabelText("Purpose for this account"), { target: { value: "Career mail" } });
    fireEvent.change(screen.getByLabelText("Initial sync range"), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    expect(await screen.findByText("Google authorization")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to setup" }));

    expect(screen.queryByText("Google authorization")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Gmail email address")).toHaveValue("new@gmail.test");
    expect(screen.getByLabelText("Purpose for this account")).toHaveValue("Career mail");
    expect(screen.getByLabelText("Initial sync range")).toHaveValue("14");
  });

  it("resumes non-secret staged account choices after Settings reloads", async () => {
    const first = render(<SettingsView workspaceId="workspace:gmail" />);
    fireEvent.click(await screen.findByRole("button", { name: "Accounts" }));
    fireEvent.change(screen.getByLabelText("Gmail email address"), { target: { value: "resume@gmail.test" } });
    fireEvent.change(screen.getByLabelText("Purpose for this account"), { target: { value: "Projects" } });
    fireEvent.change(screen.getByLabelText("Initial sync range"), { target: { value: "30" } });
    first.unmount();

    render(<SettingsView workspaceId="workspace:gmail" />);
    fireEvent.click(await screen.findByRole("button", { name: "Accounts" }));

    expect(screen.getByLabelText("Gmail email address")).toHaveValue("resume@gmail.test");
    expect(screen.getByLabelText("Purpose for this account")).toHaveValue("Projects");
    expect(screen.getByLabelText("Initial sync range")).toHaveValue("30");
    expect(window.sessionStorage.getItem("ezra-mail-guided-account-setup")).not.toContain("authUrl");
  });

  it("lets guided setup return from Microsoft authorization without losing staged account choices", async () => {
    render(<SettingsView workspaceId="workspace:gmail" />);
    fireEvent.click(await screen.findByRole("button", { name: "Accounts" }));
    fireEvent.click(screen.getByRole("button", { name: "Microsoft" }));
    fireEvent.change(screen.getByLabelText("Microsoft email address"), { target: { value: "new@outlook.test" } });
    fireEvent.change(screen.getByLabelText("Purpose for this account"), { target: { value: "Consulting" } });
    fireEvent.change(screen.getByLabelText("Initial sync range"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    expect(await screen.findByText("Microsoft code")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to setup" }));

    expect(screen.queryByText("Microsoft code")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Microsoft email address")).toHaveValue("new@outlook.test");
    expect(screen.getByLabelText("Purpose for this account")).toHaveValue("Consulting");
    expect(screen.getByLabelText("Initial sync range")).toHaveValue("7");
  });

  it("stops guided setup before authorization when the provider prerequisite is unavailable", async () => {
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/accounts/discover") {
        return { discovery: { provider: body.provider, label: "Gmail", authorization: "browser", capabilities: { mailRead: true, send: true } } };
      }
      if (url === "/api/accounts/test") {
        return { test: { provider: "gmail", capability: "mail_read", ready: false, authorization: "browser", message: "Gmail needs the local mail bridge installed before authorization." } };
      }
      throw new Error(`Unexpected POST ${url} ${String(body.action)}`);
    });
    render(<SettingsView workspaceId="workspace:gmail" />);
    fireEvent.click(await screen.findByRole("button", { name: "Accounts" }));
    fireEvent.change(screen.getByLabelText("Gmail email address"), { target: { value: "new@gmail.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));

    expect(await screen.findByText("Gmail needs the local mail bridge installed before authorization.")).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalledWith(
      "/api/email",
      expect.objectContaining({ action: "connect_gmail" }),
    );
  });

  it("requires a second explicit action and explains what disconnect preserves", async () => {
    render(<SettingsView workspaceId="workspace:gmail" />);
    fireEvent.click(await screen.findByRole("button", { name: "Accounts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));

    expect(screen.getByText(/Downloaded mail, drafts, rules, purpose labels, and activity history stay/i)).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalledWith(
      "/api/accounts",
      expect.objectContaining({ action: "disconnect" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/accounts",
      {
        action: "disconnect",
        accountId: "acct-gmail",
        confirmEmail: "owner@gmail.test",
      },
    ));
  });

  it("does not overwrite an unsaved purpose label during background refresh", async () => {
    render(<SettingsView workspaceId="workspace:gmail" />);
    fireEvent.click(await screen.findByRole("button", { name: "Accounts" }));
    const input = await screen.findByDisplayValue("Private daily mail");
    fireEvent.change(input, { target: { value: "My unsaved purpose" } });
    const callsBefore = mocks.api.mock.calls.length;

    window.dispatchEvent(new Event("ezra:refresh"));
    await waitFor(() => expect(mocks.api.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(screen.getByDisplayValue("My unsaved purpose")).toBeInTheDocument();
  });

  it("shows recovery evidence and guards the emergency polling pause", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsView workspaceId="workspace:gmail" />);
    fireEvent.click(await screen.findByRole("button", { name: "System" }));

    expect(await screen.findByRole("region", { name: "Safe recovery and backup" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Emergency pause polling" }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/system/recovery",
      {
        action: "pause_polling",
        confirmation: "PAUSE POLLING",
        reason: "Emergency pause requested from Settings",
      },
    ));
    expect(await screen.findByText(/Provider polling is paused/i)).toBeInTheDocument();
  });
});

function responseFor(url: string) {
  if (url === "/api/settings") {
    return {
      accounts: [{
        id: "acct-gmail",
        provider: "gmail",
        email: "owner@gmail.test",
        label: "Gmail",
        purpose: "Private daily mail",
        status: "error",
        lastSyncAt: "2026-07-13T18:00:00.000Z",
        counts: { inbox: 1, unread: 1, interrupt: 0, digest: 1, maintenance: 0 },
      }],
      inbox: [], mailbox: [], drafts: [], preferences: [], modelRuns: [], maintenance: [],
      workspaces: [], digests: { upcoming: [], history: [] }, activeModel: "qwen3:8b-maxctx",
      benchmarks: { status: "idle", runs: [] },
      updates: {
        checkedAt: "2026-07-13T19:00:00.000Z",
        app: { currentVersion: "0.6.12", commit: "test", remoteConfigured: true, latestVersion: null, updateAvailable: false },
        ollama: { installedVersion: "0.31.2", latestVersion: null, updateAvailable: false },
        models: [],
      },
      health: { worker: "running", lastPollAt: null, lastPollError: null, ollama: true, telegramConfigured: false, telegramRunning: false, gogInstalled: true, gmailModifyAuthorized: true },
      counts: { interrupt: 0, digest: 0, suppress: 0, maintenance: 0, awaitingApproval: 0 },
      backlog: { status: "idle", query: "", accounts: 0, pagesScanned: 0, discovered: 0, queued: 0, ruleHandled: 0, modelHandled: 0, lastRunAt: null, error: null },
      schedule: { timezone: "America/Chicago", pollMinutes: 5, digestTimes: [], quietStart: "22:00", quietEnd: "07:00" },
    };
  }
  if (url.startsWith("/api/rules")) return [];
  if (url.startsWith("/api/calendar")) return { accounts: [], events: [], drafts: [], range: { from: "", to: "", timezone: "America/Chicago" } };
  if (url.startsWith("/api/permissions")) {
    return {
      generatedAt: "2026-07-13T19:00:00.000Z", workspaceId: "workspace:gmail",
      summary: { accounts: 1, connectedAccounts: 0, needsSetup: 1, errors: 1, readOnly: 0, disabled: 0 },
      accounts: [],
    };
  }
  if (url === "/api/notifications/policy") {
    return {
      generatedAt: "2026-07-13T19:00:00.000Z", timezone: "America/Chicago", digestTimes: [], quietStart: "22:00", quietEnd: "07:00",
      channels: [], categoryPolicies: [], guardrails: [], stats: { windowDays: 7, interruptsSent: 0, interruptsSkipped: 0, interruptsFailed: 0, digestsSent: 0, digestsSkipped: 0, digestsFailed: 0, lastNotificationAt: null, lastDigestAt: null },
    };
  }
  if (url.startsWith("/api/onboarding")) return { generatedAt: "", workspaceId: "workspace:gmail", summary: { total: 0, complete: 0, needsAttention: 0, planned: 0, percentComplete: 0 }, items: [] };
  if (url === "/api/accounts") return freshness("error");
  if (url === "/api/auth/devices") return { devices: [], passkeys: [], currentDeviceId: null, bypassActive: true, configured: true };
  if (url === "/api/system/recovery") {
    return recovery(false);
  }
  throw new Error(`Unexpected API ${url}`);
}

function recovery(paused: boolean) {
  return {
    generatedAt: "2026-07-13T19:00:00.000Z",
    database: { kind: "file", sizeBytes: 1024, schemaVersion: 1 },
    backup: { latest: null, verified: false, verifiedAt: null, sha256: null, detail: "No backup found." },
    runtime: { webRevision: null, workerRevision: null, revisionsMatch: null, workerHeartbeatAt: null, workerHealthy: false },
    polling: {
      paused,
      pausedAt: paused ? "2026-07-16T12:00:00.000Z" : null,
      reason: paused ? "Emergency pause requested from Settings" : null,
    },
  };
}

function freshness(status: "error" | "disabled") {
  return {
    generatedAt: "2026-07-13T19:00:00.000Z",
    pollIntervalMinutes: 5,
    manualSyncCooldownSeconds: 60,
    items: [{
      accountId: "acct-gmail", accountLabel: "Gmail", accountEmail: "owner@gmail.test", accountProvider: "gmail",
      purposeLabel: "Private daily mail", status, lastSuccessfulPollAt: "2026-07-13T18:00:00.000Z", lastProviderActionAt: null,
      lastError: status === "error" ? "Gmail authorization expired or was revoked. Reconnect Gmail from Settings > Accounts." : null,
      nextExpectedCheckAt: null, manualSyncAvailableAt: null, canSyncNow: false, reconnectRecommended: true,
      recoveryMessage: status === "error"
        ? "Gmail authorization expired or was revoked. Reconnect Gmail from Settings > Accounts."
        : "This account is disconnected. Local mail, rules, drafts, and history are still preserved.",
    }],
  };
}
