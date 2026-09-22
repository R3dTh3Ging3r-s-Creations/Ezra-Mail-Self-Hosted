import { notificationSettingsReads } from "./fixtures/notification-settings";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "@/components/ezra/SettingsView";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/components/ezra/api", () => mocks);

type Provider = "gmail" | "microsoft";

describe("Settings daily brief refresh signals", () => {
  let provider: Provider;
  let reconnectRecommended: boolean;

  beforeEach(() => {
    window.sessionStorage.clear();
    provider = "gmail";
    reconnectRecommended = false;
    mocks.api.mockReset();
    mocks.post.mockReset();
    mocks.api.mockImplementation(async (url: string) => responseFor(url, provider, reconnectRecommended));
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => defaultPost(url, body, provider));
  });

  it("signals exactly once with the initiating workspace after a confirmed account sync", async () => {
    let finishSync!: (value: { freshness: ReturnType<typeof freshness> }) => void;
    const pendingSync = new Promise<{ freshness: ReturnType<typeof freshness> }>((resolve) => { finishSync = resolve; });
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/accounts" && body.action === "sync_now") return pendingSync;
      return defaultPost(url, body, provider);
    });
    const onAccountsChanged = vi.fn();
    const onDailyBriefChanged = vi.fn();
    const view = render(
      <SettingsView
        workspaceId="workspace:initiating"
        onAccountsChanged={onAccountsChanged}
        onDailyBriefChanged={onDailyBriefChanged}
      />,
    );
    await openAccounts();

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/accounts",
      { action: "sync_now", accountId: "acct-gmail" },
    ));
    view.rerender(
      <SettingsView
        workspaceId="workspace:after-switch"
        onAccountsChanged={onAccountsChanged}
        onDailyBriefChanged={onDailyBriefChanged}
      />,
    );
    finishSync({ freshness: freshness("gmail") });

    await waitFor(() => expect(onDailyBriefChanged).toHaveBeenCalledTimes(1));
    expect(onDailyBriefChanged).toHaveBeenCalledWith("workspace:initiating");
    expect(onAccountsChanged).toHaveBeenCalledTimes(1);
  });

  it("waits for confirmed Google completion before signaling once", async () => {
    const onAccountsChanged = vi.fn();
    const onDailyBriefChanged = vi.fn();
    const view = render(
      <SettingsView
        workspaceId="workspace:google-start"
        onAccountsChanged={onAccountsChanged}
        onDailyBriefChanged={onDailyBriefChanged}
      />,
    );
    await openAccounts();

    fireEvent.change(screen.getByLabelText("Gmail email address"), { target: { value: "owner@gmail.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    expect(await screen.findByText("Google authorization")).toBeInTheDocument();
    expect(onDailyBriefChanged).not.toHaveBeenCalled();
    view.rerender(
      <SettingsView
        workspaceId="workspace:after-switch"
        onAccountsChanged={onAccountsChanged}
        onDailyBriefChanged={onDailyBriefChanged}
      />,
    );

    fireEvent.change(screen.getByLabelText("Final Google redirect URL"), {
      target: { value: "http://127.0.0.1:4865/oauth2/callback?code=redacted&state=opaque" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete Google connection" }));

    await waitFor(() => expect(onDailyBriefChanged).toHaveBeenCalledTimes(1));
    expect(onDailyBriefChanged).toHaveBeenCalledWith("workspace:google-start");
    expect(onAccountsChanged).toHaveBeenCalledTimes(2);
  });

  it("does not signal for an encoded Google completion failure", async () => {
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/email" && body.action === "complete_gmail_auth") {
        return { ok: false, error: "Google authorization was rejected." };
      }
      return defaultPost(url, body, provider);
    });
    const onDailyBriefChanged = vi.fn();
    render(<SettingsView workspaceId="workspace:gmail" onDailyBriefChanged={onDailyBriefChanged} />);
    await openAccounts();
    fireEvent.change(screen.getByLabelText("Gmail email address"), { target: { value: "owner@gmail.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    expect(await screen.findByText("Google authorization")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Final Google redirect URL"), {
      target: { value: "http://127.0.0.1:4865/oauth2/callback?error=access_denied&state=opaque" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete Google connection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Google authorization was rejected.");
    expect(onDailyBriefChanged).not.toHaveBeenCalled();
  });

  it("does not signal while Microsoft is pending and signals once when completion is confirmed", async () => {
    provider = "microsoft";
    let completionChecks = 0;
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/email" && body.action === "complete_microsoft_auth") {
        completionChecks += 1;
        return completionChecks === 1
          ? { ok: true, result: { status: "pending", message: "Microsoft sign-in is still waiting." } }
          : { ok: true, result: { status: "connected", email: "owner@outlook.test" } };
      }
      return defaultPost(url, body, provider);
    });
    const onAccountsChanged = vi.fn();
    const onDailyBriefChanged = vi.fn();
    const view = render(
      <SettingsView
        workspaceId="workspace:microsoft-start"
        onAccountsChanged={onAccountsChanged}
        onDailyBriefChanged={onDailyBriefChanged}
      />,
    );
    await openAccounts();
    fireEvent.click(screen.getByRole("button", { name: "Microsoft" }));
    fireEvent.change(screen.getByLabelText("Microsoft email address"), { target: { value: "owner@outlook.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    expect(await screen.findByText("Microsoft code")).toBeInTheDocument();
    expect(onDailyBriefChanged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    expect(await screen.findByText("Microsoft sign-in is still waiting.")).toBeInTheDocument();
    expect(onDailyBriefChanged).not.toHaveBeenCalled();
    view.rerender(
      <SettingsView
        workspaceId="workspace:after-switch"
        onAccountsChanged={onAccountsChanged}
        onDailyBriefChanged={onDailyBriefChanged}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(onDailyBriefChanged).toHaveBeenCalledTimes(1));
    expect(onDailyBriefChanged).toHaveBeenCalledWith("workspace:microsoft-start");
    expect(onAccountsChanged).toHaveBeenCalledTimes(1);
  });

  it("does not signal for a rejected Microsoft completion request", async () => {
    provider = "microsoft";
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/email" && body.action === "complete_microsoft_auth") {
        throw new Error("Microsoft connection check failed.");
      }
      return defaultPost(url, body, provider);
    });
    const onDailyBriefChanged = vi.fn();
    render(<SettingsView workspaceId="workspace:microsoft" onDailyBriefChanged={onDailyBriefChanged} />);
    await openAccounts();
    fireEvent.click(screen.getByRole("button", { name: "Microsoft" }));
    fireEvent.change(screen.getByLabelText("Microsoft email address"), { target: { value: "owner@outlook.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    expect(await screen.findByText("Microsoft code")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Microsoft connection check failed.");
    expect(onDailyBriefChanged).not.toHaveBeenCalled();
  });

  it("identifies the intended Microsoft account and keeps setup choices fixed during authorization", async () => {
    provider = "microsoft";
    render(<SettingsView workspaceId="workspace:microsoft" />);
    await openAccounts();
    fireEvent.click(screen.getByRole("button", { name: "Microsoft" }));
    fireEvent.change(screen.getByLabelText("Microsoft email address"), { target: { value: "owner@outlook.test" } });
    fireEvent.change(screen.getByLabelText("Purpose for this account"), { target: { value: "Work" } });
    fireEvent.change(screen.getByLabelText("Initial sync range"), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    expect(await screen.findByText("Connecting owner@outlook.test")).toBeInTheDocument();
    expect(screen.getByText(/private.*window/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Microsoft email address")).toBeDisabled();
    expect(screen.getByLabelText("Purpose for this account")).toBeDisabled();
    expect(screen.getByLabelText("Initial sync range")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/accounts", {
      action: "update_setup", accountId: "acct-microsoft", purposeLabel: "Work", syncRangeDays: 14,
    }));
  });

  it("preserves the work setup draft after Microsoft rejects a different account", async () => {
    provider = "microsoft";
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/email" && body.action === "complete_microsoft_auth") {
        return { ok: false, error: "You signed in with a different Microsoft account. Start again." };
      }
      return defaultPost(url, body, provider);
    });
    const onAccountsChanged = vi.fn();
    render(<SettingsView workspaceId="workspace:microsoft" onAccountsChanged={onAccountsChanged} />);
    await openAccounts();
    fireEvent.click(screen.getByRole("button", { name: "Microsoft" }));
    fireEvent.change(screen.getByLabelText("Microsoft email address"), { target: { value: "work@example.test" } });
    fireEvent.change(screen.getByLabelText("Purpose for this account"), { target: { value: "Work" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    await screen.findByText("Microsoft code");
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("different Microsoft account");
    expect(mocks.post).not.toHaveBeenCalledWith("/api/accounts", expect.objectContaining({ action: "update_setup" }));
    expect(onAccountsChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to setup" }));
    expect(screen.getByLabelText("Microsoft email address")).toHaveValue("work@example.test");
    expect(screen.getByLabelText("Purpose for this account")).toHaveValue("Work");
  });

  it("does not apply an unrelated setup draft when reconnecting Microsoft", async () => {
    provider = "microsoft";
    reconnectRecommended = true;
    const onAccountsChanged = vi.fn();
    render(<SettingsView workspaceId="workspace:microsoft" onAccountsChanged={onAccountsChanged} />);
    await openAccounts();
    fireEvent.change(screen.getByLabelText("Purpose for this account"), { target: { value: "Unrelated draft" } });
    fireEvent.click(screen.getByRole("button", { name: /Reconnect (Microsoft|Hotmail)/ }));
    await screen.findByText("Microsoft code");
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(onAccountsChanged).toHaveBeenCalledTimes(1));
    expect(mocks.post).not.toHaveBeenCalledWith("/api/accounts", expect.objectContaining({ action: "update_setup" }));
    expect(screen.getByLabelText("Purpose for this account")).toHaveValue("Unrelated draft");
  });

  it("does not announce success for an incomplete Microsoft completion response", async () => {
    provider = "microsoft";
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/email" && body.action === "complete_microsoft_auth") return { ok: true };
      return defaultPost(url, body, provider);
    });
    const onAccountsChanged = vi.fn();
    render(<SettingsView workspaceId="workspace:microsoft" onAccountsChanged={onAccountsChanged} />);
    await openAccounts();
    fireEvent.click(screen.getByRole("button", { name: "Microsoft" }));
    fireEvent.change(screen.getByLabelText("Microsoft email address"), { target: { value: "owner@outlook.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    await screen.findByText("Microsoft code");
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Microsoft did not confirm a connected mailbox");
    expect(onAccountsChanged).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Microsoft email address")).toHaveValue("owner@outlook.test");
  });
  it("signals once after a successful Calendar retry", async () => {
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/calendar/actions" && body.action === "sync") {
        return { ok: true, message: "Calendar sync completed.", synced: 1, failures: [] };
      }
      return defaultPost(url, body, provider);
    });
    const onAccountsChanged = vi.fn();
    const onDailyBriefChanged = vi.fn();
    render(
      <SettingsView
        workspaceId="workspace:gmail"
        onAccountsChanged={onAccountsChanged}
        onDailyBriefChanged={onDailyBriefChanged}
      />,
    );
    await openAccounts();

    fireEvent.click(screen.getByRole("button", { name: "Retry check" }));
    await waitFor(() => expect(onDailyBriefChanged).toHaveBeenCalledTimes(1));
    expect(onDailyBriefChanged).toHaveBeenCalledWith("workspace:gmail");
    expect(onAccountsChanged).toHaveBeenCalledTimes(1);
  });

  it("does not signal when Calendar returns an encoded failure", async () => {
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/calendar/actions" && body.action === "sync") {
        return { ok: false, message: "Calendar unavailable.", synced: 0, failures: [] };
      }
      return defaultPost(url, body, provider);
    });
    const onAccountsChanged = vi.fn();
    const onDailyBriefChanged = vi.fn();
    render(
      <SettingsView
        workspaceId="workspace:gmail"
        onAccountsChanged={onAccountsChanged}
        onDailyBriefChanged={onDailyBriefChanged}
      />,
    );
    await openAccounts();

    fireEvent.click(screen.getByRole("button", { name: "Retry check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Calendar unavailable.");
    expect(onDailyBriefChanged).not.toHaveBeenCalled();
    expect(onAccountsChanged).not.toHaveBeenCalled();
  });

  it("signals once after a successful disconnect", async () => {
    const onAccountsChanged = vi.fn();
    const onDailyBriefChanged = vi.fn();
    render(
      <SettingsView
        workspaceId="workspace:gmail"
        onAccountsChanged={onAccountsChanged}
        onDailyBriefChanged={onDailyBriefChanged}
      />,
    );
    await openAccounts();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));

    await waitFor(() => expect(onDailyBriefChanged).toHaveBeenCalledTimes(1));
    expect(onDailyBriefChanged).toHaveBeenCalledWith("workspace:gmail");
    expect(onAccountsChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps purpose edits as metadata-only changes", async () => {
    const onAccountsChanged = vi.fn();
    const onDailyBriefChanged = vi.fn();
    render(
      <SettingsView
        workspaceId="workspace:gmail"
        onAccountsChanged={onAccountsChanged}
        onDailyBriefChanged={onDailyBriefChanged}
      />,
    );
    await openAccounts();

    fireEvent.change(screen.getByLabelText("Purpose label"), { target: { value: "Updated purpose" } });
    fireEvent.click(screen.getByRole("button", { name: "Save purpose" }));
    await waitFor(() => expect(onAccountsChanged).toHaveBeenCalledTimes(1));
    expect(onDailyBriefChanged).not.toHaveBeenCalled();
  });

  it("does not signal when reconnect only starts authorization", async () => {
    reconnectRecommended = true;
    const onDailyBriefChanged = vi.fn();
    render(<SettingsView workspaceId="workspace:gmail" onDailyBriefChanged={onDailyBriefChanged} />);
    await openAccounts();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect Gmail" }));
    expect(await screen.findByText("Google authorization")).toBeInTheDocument();
    expect(onDailyBriefChanged).not.toHaveBeenCalled();
  });

  it("does not signal when an account sync request fails", async () => {
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === "/api/accounts" && body.action === "sync_now") throw new Error("Account sync failed.");
      return defaultPost(url, body, provider);
    });
    const onDailyBriefChanged = vi.fn();
    render(<SettingsView workspaceId="workspace:gmail" onDailyBriefChanged={onDailyBriefChanged} />);
    await openAccounts();

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Account sync failed.");
    expect(onDailyBriefChanged).not.toHaveBeenCalled();
  });
});

async function openAccounts() {
  fireEvent.click(await screen.findByRole("button", { name: "Accounts" }));
  await screen.findByRole("heading", { name: "Guided account setup" });
}

async function defaultPost(url: string, body: Record<string, unknown>, provider: Provider) {
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
        access: body.access,
        mode: "remote",
        authUrl: "https://accounts.google.test/authorize",
        message: "Approve Google access, then paste the final redirect URL.",
      },
    };
  }
  if (url === "/api/email" && body.action === "complete_gmail_auth") {
    return { ok: true, result: { status: "connected", email: "owner@gmail.test", access: body.access } };
  }
  if (url === "/api/email" && body.action === "connect_microsoft") {
    return {
      ok: true,
      result: {
        connectionId: "microsoft-connection",
        userCode: "ABCD-EFGH",
        verificationUri: "https://microsoft.example.test/device",
        verificationUriComplete: null,
        expiresAt: "2026-08-31T22:30:00.000Z",
        message: "Open Microsoft sign-in and enter the code.",
        interval: 5,
      },
    };
  }
  if (url === "/api/email" && body.action === "complete_microsoft_auth") {
    return { ok: true, result: { status: "connected", email: "owner@outlook.test" } };
  }
  if (url === "/api/accounts" && body.action === "sync_now") return { freshness: freshness(provider) };
  if (url === "/api/accounts" && body.action === "update_purpose") return freshness(provider, false, String(body.purposeLabel));
  if (url === "/api/accounts" && body.action === "update_setup") return freshness(provider);
  if (url === "/api/accounts" && body.action === "disconnect") {
    return {
      result: { credentialRemoved: true, retainedLocalData: true },
      freshness: freshness(provider, false, undefined, "disabled"),
    };
  }
  if (url === "/api/calendar/actions" && body.action === "sync") {
    return { ok: true, message: "Calendar sync completed.", synced: 1, failures: [] };
  }
  throw new Error(`Unexpected POST ${url} ${String(body.action)}`);
}

function responseFor(url: string, provider: Provider, reconnectRecommended: boolean) {
  const account = accountDetails(provider);
  if (url.startsWith("/api/settings/writing?")) {
    return {
      accountId: account.id,
      signature: "",
      signatureEnabled: false,
      defaultTone: "professional",
      preferredLength: "balanced",
      remoteImagesAllowed: false,
      updatedAt: null,
    };
  }
  if (url === "/api/settings") {
    return {
      accounts: [{
        id: account.id,
        provider,
        email: account.email,
        label: account.label,
        purpose: "Private daily mail",
        status: reconnectRecommended ? "error" : "connected",
        lastSyncAt: "2026-08-31T18:00:00.000Z",
        counts: { inbox: 1, unread: 1, interrupt: 0, digest: 1, maintenance: 0 },
      }],
      inbox: [], mailbox: [], drafts: [], preferences: [], modelRuns: [], maintenance: [],
      workspaces: [], digests: { upcoming: [], history: [] }, activeModel: "qwen3:8b-maxctx",
      benchmarks: { status: "idle", runs: [] },
      updates: {
        checkedAt: "2026-08-31T19:00:00.000Z",
        app: { currentVersion: "0.8.0", commit: "test", remoteConfigured: true, latestVersion: null, updateAvailable: false },
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
  if (url.startsWith("/api/calendar")) {
    return {
      accounts: [{
        accountId: account.id,
        accountLabel: account.label,
        accountEmail: account.email,
        provider,
        status: reconnectRecommended ? "error" : "connected",
        calendarStatus: "error",
        calendarAccess: "none",
        lastSyncAt: null,
        lastError: "Calendar access needs attention.",
      }],
      events: [],
      drafts: [],
      range: { from: "2026-08-31", to: "2026-09-01", timezone: "America/Chicago" },
    };
  }
  if (url.startsWith("/api/permissions")) {
    return {
      generatedAt: "2026-08-31T19:00:00.000Z",
      workspaceId: `workspace:${provider}`,
      summary: { accounts: 1, connectedAccounts: reconnectRecommended ? 0 : 1, needsSetup: 0, errors: reconnectRecommended ? 1 : 0, readOnly: 0, disabled: 0 },
      accounts: [],
    };
  }
  if (url === "/api/notifications/policy") {
    return {
      generatedAt: "2026-08-31T19:00:00.000Z",
      timezone: "America/Chicago",
      digestTimes: [],
      quietStart: "22:00",
      quietEnd: "07:00",
      channels: [],
      categoryPolicies: [],
      guardrails: [],
      stats: { windowDays: 7, interruptsSent: 0, interruptsSkipped: 0, interruptsFailed: 0, digestsSent: 0, digestsSkipped: 0, digestsFailed: 0, lastNotificationAt: null, lastDigestAt: null },
    };
  }
  if (url.startsWith("/api/onboarding")) {
    return {
      generatedAt: "2026-08-31T19:00:00.000Z",
      workspaceId: `workspace:${provider}`,
      summary: { total: 0, complete: 0, needsAttention: 0, planned: 0, percentComplete: 0 },
      items: [],
    };
  }
  if (url === "/api/accounts") return freshness(provider, reconnectRecommended);
  if (url === "/api/auth/devices") return { devices: [], passkeys: [], currentDeviceId: null, bypassActive: true, configured: true };
  if (url === "/api/system/recovery") return recovery();
  throw new Error(`Unexpected API ${url}`);
}

function freshness(
  provider: Provider,
  reconnectRecommended = false,
  purposeLabel = "Private daily mail",
  status: "connected" | "disabled" = "connected",
) {
  const account = accountDetails(provider);
  const needsReconnect = reconnectRecommended && status !== "disabled";
  return {
    generatedAt: "2026-08-31T19:00:00.000Z",
    pollIntervalMinutes: 5,
    manualSyncCooldownSeconds: 60,
    items: [{
      accountId: account.id,
      accountLabel: account.label,
      accountEmail: account.email,
      accountProvider: provider,
      purposeLabel,
      syncRangeDays: 2,
      status: needsReconnect ? "error" : status,
      lastSuccessfulPollAt: "2026-08-31T18:00:00.000Z",
      lastProviderActionAt: null,
      lastError: needsReconnect ? `${account.label} authorization needs attention.` : null,
      nextExpectedCheckAt: null,
      manualSyncAvailableAt: null,
      canSyncNow: status === "connected" && !needsReconnect,
      reconnectRecommended: needsReconnect,
      recoveryMessage: needsReconnect ? `${account.label} authorization needs attention.` : status === "disabled" ? "This account is disconnected." : null,
      issues: [],
    }],
  };
}

function accountDetails(provider: Provider) {
  return provider === "gmail"
    ? { id: "acct-gmail", email: "owner@gmail.test", label: "Gmail" }
    : { id: "acct-microsoft", email: "owner@outlook.test", label: "Hotmail" };
}

function recovery() {
  return {
    generatedAt: "2026-08-31T19:00:00.000Z",
    database: { kind: "file", sizeBytes: 1024, schemaVersion: 1 },
    backup: { latest: null, verified: false, verifiedAt: null, sha256: null, detail: "No backup found." },
    runtime: { webRevision: null, workerRevision: null, revisionsMatch: null, workerHeartbeatAt: null, workerHealthy: false },
    polling: { paused: false, pausedAt: null, reason: null },
  };
}

describe("Settings notification recovery composition", () => {
  it.each([[403, true], [503, true], [403, false], [200, false]])("keeps owner Settings and pending cleanup reachable with policy %s and browser enabled %s", async (status, featureEnabled) => {
    window.localStorage.clear();
    mocks.api.mockImplementation(async (url: string) => {
      if (url === "/api/notifications/policy") {
        if (status !== 200) throw new Error("Notification policy unavailable (" + status + ").");
        return { ...responseFor(url, "gmail", false), channels: [{ id: "browser", label: "Browser notifications", status: "deferred", detail: "Feature disabled", lastError: null }] };
      }
      if (url === "/api/auth/devices") return { devices: [], passkeys: [], currentDeviceId: null, bypassActive: false, configured: true };
      return notificationSettingsReads[url.split("?")[0]] ?? responseFor(url, "gmail", false);
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/setup") ? {
      origin: location.origin, featureEnabled, setupEpoch: 2, currentDevice: null, completion: null,
      pending: { operationId: "pending-cleanup", pendingEpoch: 2, kind: "worker_repair", startedAt: "2026-09-14T12:00:00Z", recoveryInstructions: "Close the initiating browser and complete cleanup." },
    } : { code: "trusted_device_required" }), { status: url.endsWith("/setup") ? 200 : 403 })));
    try {
      render(<SettingsView workspaceId="workspace:gmail" />);
      fireEvent.click(await screen.findByRole("button", { name: "System" }));
      expect(await screen.findByRole("button", { name: "Trust this device" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Delivery" }));
      expect(await screen.findByRole("button", { name: "Confirm interrupted cleanup" })).toBeInTheDocument();
      if (status !== 200) expect(screen.getByText(/Notification policy unavailable/)).toBeInTheDocument();
      expect(screen.queryByText("Settings unavailable")).not.toBeInTheDocument();
    } finally { vi.unstubAllGlobals(); }
  });
});
