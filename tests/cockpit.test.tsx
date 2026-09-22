import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailCockpit } from "@/components/EmailCockpit";
import { EzraMailApp } from "@/components/ezra/EzraMailApp";
import { TodayView } from "@/components/ezra/TodayView";
import type {
  ActionCenterTarget,
  BriefMemoryAction,
  DashboardState,
  InboxItem,
  LivingBriefItem,
  MailActionResult,
  MailWorkspace,
  MessageDetail,
  TodayBrief,
} from "@/lib/email/types";

const state: DashboardState = {
  inbox: [],
  mailbox: [],
  drafts: [],
  preferences: [],
  modelRuns: [],
  accounts: [],
  activeModel: "qwen3:8b-maxctx",
  benchmarks: {
    status: "idle",
    runId: null,
    startedAt: null,
    completedAt: null,
    progress: null,
    error: null,
    caseCount: 0,
    summaries: [],
  },
  updates: {
    checkedAt: "2026-06-14T12:00:00.000Z",
    app: {
      currentVersion: "1.1.0",
      commit: "abc1234",
      remoteConfigured: false,
      latestVersion: null,
      updateAvailable: false,
    },
    ollama: {
      installedVersion: "0.30.5",
      latestVersion: "0.30.8",
      updateAvailable: true,
    },
    models: [
      {
        id: "qwen3:8b-maxctx",
        label: "Qwen3 8B",
        baseModel: "qwen3:8b",
        installed: true,
        configuredContext: 40960,
        nativeContext: 40960,
        updateState: "idle",
        updateMessage: null,
      },
      {
        id: "qwen3.5:9b-maxctx",
        label: "Qwen3.5 9B",
        baseModel: "qwen3.5:9b",
        installed: true,
        configuredContext: 40960,
        nativeContext: 262144,
        updateState: "idle",
        updateMessage: null,
      },
      {
        id: "qwen3:14b-maxctx",
        label: "Qwen3 14B",
        baseModel: "qwen3:14b",
        installed: true,
        configuredContext: 40960,
        nativeContext: 40960,
        updateState: "idle",
        updateMessage: null,
      },
    ],
  },
  health: {
    worker: "stopped",
    lastPollAt: null,
    lastPollError: null,
    ollama: true,
    telegramConfigured: false,
    telegramRunning: false,
    gogInstalled: true,
    gmailModifyAuthorized: false,
  },
  counts: { interrupt: 0, digest: 0, suppress: 0, maintenance: 0, awaitingApproval: 0 },
  maintenance: [],
  digests: {
    upcoming: [],
    history: [],
  },
  backlog: {
    status: "idle",
    query: "in:inbox is:unread",
    accounts: 0,
    pagesScanned: 0,
    discovered: 0,
    queued: 0,
    ruleHandled: 0,
    modelHandled: 0,
    lastRunAt: null,
    error: null,
  },
  schedule: {
    timezone: "America/Chicago",
    pollMinutes: 5,
    digestTimes: ["08:00", "16:30"],
    quietStart: "22:00",
    quietEnd: "07:00",
  },
};

function inboxItem(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: "mail-1",
    accountId: "acct-1",
    accountLabel: "test@example.com",
    externalMessageId: "external-1",
    threadId: "thread-1",
    senderName: "Sender",
    senderEmail: "sender@example.com",
    subject: "Subject",
    receivedAt: "2026-06-14T12:00:00.000Z",
    snippet: "Snippet",
    gmailUrl: "#",
    hasAttachments: false,
    isUnread: true,
    mailboxLabels: ["INBOX", "UNREAD"],
    status: "triaged",
    attention: "suppress",
    urgency: 0,
    confidence: 0.9,
    category: "general",
    summary: "Summary",
    reason: "Reason",
    recommendation: "Recommendation",
    needsReply: false,
    deadline: null,
    injectionFlags: [],
    model: "qwen3:8b-maxctx",
    notifiedAt: null,
    ...overrides,
  };
}

function messageDetail(item: InboxItem): MessageDetail {
  return {
    message: item,
    bodyText: "Full sanitized email body for review.",
    bodyIsExcerpt: false,
    attachments: [],
    contactMemory: {
      summary: "Ezra has reviewed 4 messages from this contact.",
      messageCount: 4,
      firstSeenAt: "2026-05-01T12:00:00.000Z",
      lastSeenAt: item.receivedAt,
      categories: [
        { label: "Relationship", summary: "Four messages over six weeks." },
        { label: "Patterns", summary: "Project updates (3), scheduling (1)." },
        { label: "Preferences", summary: "Always alert after two signals." },
        { label: "Recent history", summary: "Jun 14, 2026: Current subject." },
      ],
    },
  };
}

describe("email cockpit", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as {
            action: string;
            messageId?: string;
          };
          if (payload.action === "get_message_detail") {
            const item = state.inbox.find((candidate) => candidate.id === payload.messageId);
            return {
              ok: Boolean(item),
              json: async () =>
                item
                  ? { ok: true, result: messageDetail(item) }
                  : { ok: false, error: "Email message was not found." },
            };
          }
        }
        return {
          ok: true,
          json: async () => state,
        };
      }),
    );
  });

  it("renders the focused email navigation and health surface", async () => {
    render(React.createElement(EmailCockpit));
    expect((await screen.findAllByText("Priority inbox")).length).toBeGreaterThan(0);
    expect(screen.getByText("All mail")).toBeInTheDocument();
    expect(screen.getByText("Accounts")).toBeInTheDocument();
    expect(screen.getByText("Reply queue")).toBeInTheDocument();
    expect(screen.getByText("Unread backlog review")).toBeInTheDocument();
    expect(screen.getByText("qwen3:8b")).toBeInTheDocument();
    expect(screen.queryByText("Mascot")).not.toBeInTheDocument();
  });

  it("shows sender maintenance actions but keeps them disabled without modify access", async () => {
    const maintenanceState: DashboardState = {
      ...state,
      counts: {
        ...state.counts,
        maintenance: 7,
      },
      maintenance: [
        {
          accountId: "acct-1",
          accountEmail: "test@example.com",
          latestMessageId: "mail-1",
          senderName: "Weekly Offers",
          senderEmail: "offers@example.com",
          messageCount: 3,
          latestSubject: "This week's offers",
          latestReceivedAt: "2026-06-13T12:00:00.000Z",
          categories: ["bulk-mail"],
          approvedActions: [],
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => maintenanceState,
      })),
    );

    render(React.createElement(EmailCockpit));
    await screen.findAllByText("Priority inbox");
    fireEvent.click(screen.getByRole("button", { name: /Maintenance 7/i }));

    expect(screen.getByRole("button", { name: /Maintenance 7/i })).toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 7 sender groups.")).toBeInTheDocument();
    expect(screen.getByText("Gmail maintenance permission needed")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Mark read" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(screen.getAllByRole("button", { name: "Unsubscribe" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(screen.getAllByRole("button", { name: "Spam" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
  });

  it("defaults to priority mail and keeps important messages ahead of quieter decisions", async () => {
    const prioritizedState: DashboardState = {
      ...state,
      counts: {
        ...state.counts,
        interrupt: 1,
        digest: 1,
        suppress: 1,
      },
      inbox: [
        inboxItem({
          id: "suppress",
          senderName: "Store",
          subject: "Promotional message",
          receivedAt: "2026-06-14T18:00:00.000Z",
        }),
        inboxItem({
          id: "digest",
          senderName: "Newsletter",
          subject: "Digest message",
          attention: "digest",
          urgency: 40,
          receivedAt: "2026-06-14T17:00:00.000Z",
        }),
        inboxItem({
          id: "interrupt",
          senderName: "Important sender",
          subject: "Critical action",
          attention: "interrupt",
          urgency: 90,
          receivedAt: "2026-06-13T12:00:00.000Z",
        }),
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as {
            action: string;
            messageId?: string;
          };
          if (payload.action === "get_message_detail") {
            const item = prioritizedState.inbox.find(
              (candidate) => candidate.id === payload.messageId,
            )!;
            return {
              ok: true,
              json: async () => ({ ok: true, result: messageDetail(item) }),
            };
          }
        }
        return {
          ok: true,
          json: async () => prioritizedState,
        };
      }),
    );

    render(React.createElement(EmailCockpit));

    expect(await screen.findByRole("heading", { name: "Needs attention" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Important sender.*Critical action/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Store.*Promotional message/i })).not.toBeInTheDocument();
    expect(await screen.findByText("Full sanitized email body for review.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ezra's breakdown" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Contact memory" })).toBeInTheDocument();
    expect(screen.getByText("Four messages over six weeks.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All" }));

    const priorityRow = screen.getByRole("button", { name: /Important sender.*Critical action/i });
    const suppressedRow = screen.getByRole("button", { name: /Store.*Promotional message/i });
    expect(
      priorityRow.compareDocumentPosition(suppressedRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("can mark priority mail read or clear it without teaching a sender preference", async () => {
    const item = inboxItem({
      id: "priority-clear",
      senderName: "Important sender",
      subject: "Review this once",
      attention: "interrupt",
      urgency: 88,
    });
    const priorityState: DashboardState = {
      ...state,
      inbox: [item],
      mailbox: [item],
      counts: { ...state.counts, interrupt: 1 },
    };
    const actions: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          actions.push(payload);
          if (payload.action === "get_message_detail") {
            return { ok: true, json: async () => ({ ok: true, result: messageDetail(item) }) };
          }
          return { ok: true, json: async () => ({ ok: true, result: { messageId: item.id } }) };
        }
        return { ok: true, json: async () => priorityState };
      }),
    );

    render(React.createElement(EmailCockpit));
    await screen.findByRole("heading", { name: "Needs attention" });

    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await screen.findByText("Marked read and cleared from Priority.");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await screen.findByText("Cleared from Priority without changing future handling.");

    expect(actions).toContainEqual(
      expect.objectContaining({ action: "mark_read", messageId: item.id }),
    );
    expect(actions).toContainEqual(
      expect.objectContaining({ action: "clear_message", messageId: item.id }),
    );
  });

  it("shows recent mailbox mail with folder labels and supports user-first replies", async () => {
    const item = inboxItem({
      id: "mailbox-item",
      senderName: "Client Person",
      senderEmail: "client@example.com",
      subject: "Can you review this?",
      attention: "digest",
      urgency: 50,
      isUnread: true,
      mailboxLabels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
      needsReply: true,
    });
    const mailboxState: DashboardState = {
      ...state,
      mailbox: [item],
      counts: { ...state.counts, digest: 1 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          if (payload.action === "get_message_detail") {
            return { ok: true, json: async () => ({ ok: true, result: messageDetail(item) }) };
          }
          if (payload.action === "prepare_draft") {
            return {
              ok: true,
              json: async () => ({
                ok: true,
                result: {
                  messageId: item.id,
                  content: "Thanks, I will review this today.",
                  contactMemorySummary: "Ezra has reviewed four messages from Client Person.",
                  appliedContext: [],
                },
              }),
            };
          }
        }
        return { ok: true, json: async () => mailboxState };
      }),
    );

    render(React.createElement(EmailCockpit));
    await screen.findAllByText("Priority inbox");
    fireEvent.click(screen.getByRole("button", { name: "All mail" }));

    expect(await screen.findByRole("heading", { name: "Recent mail" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Client Person.*Can you review this/i })).toBeInTheDocument();
    expect(screen.getAllByText("Inbox").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Updates").length).toBeGreaterThan(0);
    expect(await screen.findByText("Full sanitized email body for review.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Write reply" }));
    const manualDraft = await screen.findByLabelText("Your reply draft");
    fireEvent.change(manualDraft, { target: { value: "I can look this over today." } });
    expect(manualDraft).toHaveValue("I can look this over today.");
    expect(screen.getAllByText("Suggested move").length).toBeGreaterThan(0);
  });

  it("shows digest queue and history inside the cockpit", async () => {
    const item = inboxItem({
      id: "digest-ready",
      senderName: "Operations Update",
      senderEmail: "ops@example.com",
      subject: "Useful but not urgent",
      attention: "digest",
      urgency: 52,
      summary: "A useful operational update that can wait for the brief.",
      recommendation: "Include this in the next digest.",
    });
    const digestState: DashboardState = {
      ...state,
      inbox: [item],
      mailbox: [item],
      counts: { ...state.counts, digest: 1 },
      digests: {
        upcoming: [
          {
            label: "Afternoon email brief",
            scheduledFor: "2026-06-16T21:30:00.000Z",
            itemCount: 1,
            items: [item],
          },
        ],
        history: [
          {
            id: "digest-1",
            label: "Morning email brief",
            channel: "telegram",
            status: "sent",
            itemCount: 1,
            scheduledFor: "2026-06-16T13:00:00.000Z",
            createdAt: "2026-06-16T13:01:00.000Z",
            sentAt: "2026-06-16T13:01:03.000Z",
            error: null,
            items: [item],
          },
        ],
      },
    };
    const actions: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as { action: string; messageId?: string };
          actions.push(String(payload.action));
          if (payload.action === "get_message_detail") {
            return { ok: true, json: async () => ({ ok: true, result: messageDetail(item) }) };
          }
          return {
            ok: true,
            json: async () => ({ ok: true, result: { digestId: "digest-manual", count: 1 } }),
          };
        }
        return { ok: true, json: async () => digestState };
      }),
    );

    render(React.createElement(EmailCockpit));
    await screen.findAllByText("Priority inbox");
    fireEvent.click(screen.getByRole("button", { name: /Digests 1/i }));

    expect(await screen.findByRole("heading", { name: "Next digest" })).toBeInTheDocument();
    expect(screen.getByText(/Afternoon email brief/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Digest history" })).toBeInTheDocument();
    expect(screen.getByText("Morning email brief")).toBeInTheDocument();
    expect(screen.getAllByText("Telegram").length).toBeGreaterThan(0);

    fireEvent.click(
      screen.getAllByRole("button", { name: /Open digest email: Useful but not urgent/i })[0],
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Full sanitized email body for review.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await screen.findByText("Digest run recorded. Telegram delivery status is in the digest history.");
    expect(actions).toContain("send_digest_now");
  });

  it("shows separate mail account lanes and starts provider sign-in", async () => {
    const accountState: DashboardState = {
      ...state,
      accounts: [
        {
          id: "acct-personal",
          provider: "gmail",
          email: "personal@example.com",
          label: "Personal",
          status: "connected",
          lastSyncAt: "2026-06-16T14:00:00.000Z",
          counts: { inbox: 120, unread: 8, interrupt: 2, digest: 5, maintenance: 18 },
        },
        {
          id: "acct-work",
          provider: "gmail",
          email: "work@example.com",
          label: "Work",
          status: "connected",
          lastSyncAt: null,
          counts: { inbox: 44, unread: 3, interrupt: 1, digest: 2, maintenance: 7 },
        },
        {
          id: "acct-hotmail",
          provider: "microsoft",
          email: "outlook-user@example.com",
          label: "Hotmail",
          status: "connected",
          lastSyncAt: null,
          counts: { inbox: 0, unread: 0, interrupt: 0, digest: 0, maintenance: 0 },
        },
      ],
    };
    const actions: string[] = [];
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          actions.push(String(payload.action));
          payloads.push(payload);
          return {
            ok: true,
            json: async () => ({
              ok: true,
              result:
                payload.action === "connect_gmail"
                  ? { status: "started", email: payload.email, access: payload.access }
                  : payload.action === "connect_microsoft"
                    ? {
                        connectionId: "msauth-1",
                        userCode: "ABCD-EFGH",
                        verificationUri: "https://microsoft.com/devicelogin",
                        verificationUriComplete: null,
                        expiresAt: "2026-06-16T14:15:00.000Z",
                        message: null,
                        interval: 5,
                      }
                    : payload.action === "complete_microsoft_auth"
                      ? { status: "connected", email: "outlook-user@example.com" }
                      : { accounts: 2 },
            }),
          };
        }
        return { ok: true, json: async () => accountState };
      }),
    );

    render(React.createElement(EmailCockpit));
    await screen.findAllByText("Priority inbox");
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));

    expect(await screen.findByText("personal@example.com")).toBeInTheDocument();
    expect(screen.getByText("work@example.com")).toBeInTheDocument();
    expect(screen.getByText("outlook-user@example.com")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connect mail accounts" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hotmail / Outlook" })).toBeInTheDocument();
    expect(screen.getByText("3 mail accounts")).toBeInTheDocument();
    expect(screen.getAllByText("cleanup").length).toBe(3);

    fireEvent.change(screen.getByLabelText("Gmail address"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Gmail permission level" })).getByRole("button", {
        name: /Maintenance/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    await screen.findByText("Google sign-in opened. Finish the browser prompt, then refresh accounts.");

    fireEvent.change(screen.getByLabelText("Microsoft email address"), {
      target: { value: "outlook-user@example.com" },
    });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Microsoft permission level" })).getByRole(
        "button",
        { name: /Maintenance/i },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Microsoft" }));
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    await screen.findByText("Microsoft mailbox connected: outlook-user@example.com.");

    fireEvent.click(screen.getByRole("button", { name: "Refresh accounts" }));
    await screen.findByText("Authorized Gmail accounts refreshed.");
    expect(payloads).toContainEqual(
      expect.objectContaining({
        action: "connect_gmail",
        email: "user@example.com",
        access: "maintenance",
      }),
    );
    expect(payloads).toContainEqual(
      expect.objectContaining({
        action: "connect_microsoft",
        email: "outlook-user@example.com",
        access: "maintenance",
      }),
    );
    expect(payloads).toContainEqual(
      expect.objectContaining({
        action: "complete_microsoft_auth",
        connectionId: "msauth-1",
      }),
    );
    expect(actions).toContain("sync_accounts");
  });

  it("applies a selected maintenance action to multiple sender groups", async () => {
    const maintenanceState: DashboardState = {
      ...state,
      health: { ...state.health, gmailModifyAuthorized: true },
      counts: { ...state.counts, maintenance: 2 },
      maintenance: [
        {
          accountId: "acct-1",
          accountEmail: "test@example.com",
          latestMessageId: "mail-1",
          senderName: "Offers One",
          senderEmail: "offers1@example.com",
          messageCount: 3,
          latestSubject: "Sale one",
          latestReceivedAt: "2026-06-13T12:00:00.000Z",
          categories: ["bulk-mail"],
          approvedActions: [],
        },
        {
          accountId: "acct-1",
          accountEmail: "test@example.com",
          latestMessageId: "mail-2",
          senderName: "Offers Two",
          senderEmail: "offers2@example.com",
          messageCount: 2,
          latestSubject: "Sale two",
          latestReceivedAt: "2026-06-13T13:00:00.000Z",
          categories: ["bulk-mail"],
          approvedActions: [],
        },
      ],
    };
    const actions: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          actions.push(payload);
          return {
            ok: true,
            json: async () => ({
              ok: true,
              result: { successCount: 2, failureCount: 0, messageCount: 5 },
            }),
          };
        }
        return { ok: true, json: async () => maintenanceState };
      }),
    );

    render(React.createElement(EmailCockpit));
    await screen.findAllByText("Priority inbox");
    fireEvent.click(screen.getByRole("button", { name: /Maintenance 2/i }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Spam" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await screen.findByText("Moved 5 messages across 2 senders.");
    expect(actions).toContainEqual(
      expect.objectContaining({
        action: "apply_maintenance_batch",
        maintenanceAction: "spam",
        remember: true,
        targets: [
          { accountId: "acct-1", senderEmail: "offers1@example.com" },
          { accountId: "acct-1", senderEmail: "offers2@example.com" },
        ],
      }),
    );
  });

  it("opens the same email, AI breakdown, and contact memory from maintenance and replies", async () => {
    const item = inboxItem({
      id: "mail-detail",
      senderName: "Project Contact",
      senderEmail: "contact@example.com",
      subject: "Project status",
      attention: "suppress",
    });
    const detailState: DashboardState = {
      ...state,
      inbox: [item],
      counts: { ...state.counts, maintenance: 1, awaitingApproval: 1, suppress: 1 },
      maintenance: [
        {
          accountId: "acct-1",
          accountEmail: "test@example.com",
          latestMessageId: item.id,
          senderName: item.senderName,
          senderEmail: item.senderEmail,
          messageCount: 2,
          latestSubject: item.subject,
          latestReceivedAt: item.receivedAt,
          categories: ["project-update"],
          approvedActions: [],
        },
      ],
      drafts: [
        {
          id: "draft-1",
          messageId: item.id,
          subject: item.subject,
          senderName: item.senderName,
          senderEmail: item.senderEmail,
          content: "Thanks for the update.",
          version: 1,
          status: "awaiting_approval",
          approvalStatus: "pending",
          approvalExpiresAt: null,
          updatedAt: item.receivedAt,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as { action: string };
          if (payload.action === "get_message_detail") {
            return {
              ok: true,
              json: async () => ({ ok: true, result: messageDetail(item) }),
            };
          }
        }
        return { ok: true, json: async () => detailState };
      }),
    );

    render(React.createElement(EmailCockpit));
    await screen.findAllByText("Priority inbox");
    fireEvent.click(screen.getByRole("button", { name: /Maintenance 1/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Open latest email from Project Contact/i }),
    );

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Full sanitized email body for review.")).toBeInTheDocument();
    expect(screen.getByText("Four messages over six weeks.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: /Reply queue 1/i }));
    fireEvent.click(screen.getByRole("button", { name: /Open original email: Project status/i }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ezra's breakdown" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Contact memory" })).toBeInTheDocument();
  });

  it("opens with an AI draft, revises from context, and saves the user's exact words", async () => {
    const item = inboxItem({
      id: "draft-source",
      senderName: "Morgan Lee",
      senderEmail: "morgan@example.com",
      subject: "Friday review",
      attention: "interrupt",
      urgency: 84,
      needsReply: true,
    });
    const draftState: DashboardState = {
      ...state,
      inbox: [item],
      counts: { ...state.counts, interrupt: 1 },
    };
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          requests.push(payload);
          if (payload.action === "get_message_detail") {
            return {
              ok: true,
              json: async () => ({ ok: true, result: messageDetail(item) }),
            };
          }
          if (payload.action === "prepare_draft") {
            const revised = Boolean(payload.context);
            return {
              ok: true,
              json: async () => ({
                ok: true,
                result: {
                  messageId: item.id,
                  content: revised
                    ? "Hi Morgan,\n\nFriday afternoon works well for me.\n\nBest,\nEric"
                    : "Hi Morgan,\n\nFriday works for me.\n\nBest,\nEric",
                  contactMemorySummary:
                    "Ezra has reviewed four messages from Morgan Lee.",
                  appliedContext: revised ? [String(payload.context)] : [],
                },
              }),
            };
          }
          if (payload.action === "save_draft") {
            return { ok: true, json: async () => ({ ok: true, result: { id: "draft-2" } }) };
          }
        }
        return { ok: true, json: async () => draftState };
      }),
    );

    render(React.createElement(EmailCockpit));
    await screen.findByRole("heading", { name: "Needs attention" });
    fireEvent.click(await screen.findByRole("button", { name: "Draft reply" }));

    const draftEditor = await screen.findByLabelText("Ezra's draft");
    await waitFor(() =>
      expect(draftEditor).toHaveValue("Hi Morgan,\n\nFriday works for me.\n\nBest,\nEric"),
    );
    expect(
      screen.getByText("Ezra has reviewed four messages from Morgan Lee."),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Tell Ezra what to add or change"), {
      target: { value: "Confirm Friday afternoon and keep it warm." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revise with Ezra" }));
    await waitFor(() =>
      expect(draftEditor).toHaveValue(
        "Hi Morgan,\n\nFriday afternoon works well for me.\n\nBest,\nEric",
      ),
    );

    fireEvent.change(draftEditor, {
      target: { value: "Hi Morgan,\n\nFriday at 2 PM works for me.\n\nBest,\nEric" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save to reply queue" }));

    await screen.findByRole("heading", { name: "Drafts and approvals" });
    expect(screen.getByText("Draft saved to the reply queue.")).toBeInTheDocument();
    expect(requests).toContainEqual(
      expect.objectContaining({
        action: "save_draft",
        messageId: item.id,
        content: "Hi Morgan,\n\nFriday at 2 PM works for me.\n\nBest,\nEric",
        context: "Confirm Friday afternoon and keep it warm.",
      }),
    );
  });

  it("routes quick actions, learning, model, backlog, and settings controls", async () => {
    const item = inboxItem({
      id: "action-mail",
      senderName: "Action Sender",
      subject: "Action message",
      attention: "interrupt",
      urgency: 91,
    });
    const actionState: DashboardState = {
      ...state,
      inbox: [item],
      counts: { ...state.counts, interrupt: 1 },
      backlog: { ...state.backlog, status: "running" },
      preferences: [
        {
          id: "pref-1",
          kind: "sender",
          pattern: item.senderEmail,
          action: "interrupt",
          weight: 1,
          evidenceCount: 1,
          enabled: true,
          updatedAt: item.receivedAt,
        },
      ],
    };
    const actions: string[] = [];
    let getCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as { action: string };
          actions.push(payload.action);
          if (payload.action === "get_message_detail") {
            return {
              ok: true,
              json: async () => ({ ok: true, result: messageDetail(item) }),
            };
          }
          return { ok: true, json: async () => ({ ok: true, result: {} }) };
        }
        getCount += 1;
        return { ok: true, json: async () => actionState };
      }),
    );

    render(React.createElement(EmailCockpit));
    await screen.findByRole("heading", { name: "Needs attention" });

    fireEvent.click(screen.getByRole("button", { name: "Not important" }));
    await screen.findByText("Moved out of Priority and learned as lower priority.");
    fireEvent.click(screen.getByRole("button", { name: "Always alert for this sender" }));
    await screen.findByText("This sender will now be treated as priority.");
    fireEvent.click(screen.getByRole("button", { name: "Snooze one hour" }));
    await screen.findByText("Snoozed for one hour.");
    fireEvent.click(screen.getByRole("button", { name: "Pause review" }));
    await screen.findByText("Backlog review paused.");

    fireEvent.click(screen.getByRole("button", { name: "Learning" }));
    fireEvent.click(screen.getByRole("button", { name: "Forget rule" }));
    await screen.findByText("Learned preference forgotten.");

    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    expect(screen.getByRole("heading", { name: "Qwen3.5 9B" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run comparison" }));
    await screen.findByText("Model comparison started. Results will appear as each model finishes.");
    fireEvent.click(screen.getAllByRole("button", { name: "Use this model" })[1]);
    await screen.findByText("qwen3:14b is now active.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Poll now" }));
    await screen.findByText("Gmail check complete.");
    fireEvent.click(screen.getByRole("button", { name: "Load safe demo" }));
    await screen.findByText("Safe demo messages loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await screen.findByText("Software and model status refreshed.");

    const refreshesBefore = getCount;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Mailbox refreshed.");
    expect(getCount).toBeGreaterThan(refreshesBefore);
    expect(actions).toEqual(
      expect.arrayContaining([
        "feedback",
        "snooze",
        "pause_backlog",
        "forget_preference",
        "switch_model",
        "start_model_benchmark",
        "poll",
        "seed_demo",
        "check_updates",
      ]),
    );
  });

  it("routes edit, approval, cancellation, and confirmed send controls", async () => {
    const item = inboxItem({ id: "reply-source", attention: "digest" });
    const replyState: DashboardState = {
      ...state,
      inbox: [item],
      drafts: [
        {
          id: "draft-edit",
          messageId: item.id,
          subject: "Editable reply",
          senderName: item.senderName,
          senderEmail: item.senderEmail,
          content: "Original reply",
          version: 1,
          status: "draft",
          approvalStatus: null,
          approvalExpiresAt: null,
          updatedAt: item.receivedAt,
        },
        {
          id: "draft-send",
          messageId: item.id,
          subject: "Approved reply",
          senderName: item.senderName,
          senderEmail: item.senderEmail,
          content: "Approved exact reply",
          version: 2,
          status: "awaiting_approval",
          approvalStatus: "pending",
          approvalExpiresAt: "2026-06-14T13:00:00.000Z",
          updatedAt: item.receivedAt,
        },
      ],
      counts: { ...state.counts, awaitingApproval: 1 },
    };
    const actions: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as { action: string };
          actions.push(payload.action);
          if (payload.action === "get_message_detail") {
            return {
              ok: true,
              json: async () => ({ ok: true, result: messageDetail(item) }),
            };
          }
          return { ok: true, json: async () => ({ ok: true, result: {} }) };
        }
        return { ok: true, json: async () => replyState };
      }),
    );

    render(React.createElement(EmailCockpit));
    await screen.findAllByText("Priority inbox");
    fireEvent.click(screen.getByRole("button", { name: /Reply queue 1/i }));

    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    fireEvent.click(editButtons[0]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited exact reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Save new version" }));
    await screen.findByText("New draft version saved. Send approval must be requested again.");

    fireEvent.click(screen.getByRole("button", { name: "Request send" }));
    await screen.findByText("Draft locked for exact send confirmation.");
    const cancelButtons = screen.getAllByTitle("Cancel draft");
    fireEvent.click(cancelButtons[0]);
    await screen.findByText("Draft cancelled.");

    fireEvent.click(screen.getByRole("button", { name: "Review and send" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    await screen.findByText("Email sent.");

    expect(actions).toEqual(
      expect.arrayContaining([
        "update_draft",
        "request_send",
        "cancel_draft",
        "approve_send",
      ]),
    );
  });

  it("dismisses maintenance confirmation when an attempted action cannot be applied", async () => {
    const maintenanceState: DashboardState = {
      ...state,
      health: {
        ...state.health,
        gmailModifyAuthorized: true,
      },
      counts: {
        ...state.counts,
        maintenance: 1,
      },
      maintenance: [
        {
          accountId: "acct-1",
          accountEmail: "test@example.com",
          latestMessageId: "mail-1",
          senderName: "Weekly Offers",
          senderEmail: "offers@example.com",
          messageCount: 3,
          latestSubject: "This week's offers",
          latestReceivedAt: "2026-06-13T12:00:00.000Z",
          categories: ["bulk-mail"],
          approvedActions: [],
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return {
            ok: false,
            json: async () => ({
              ok: false,
              error: "This sender does not provide a standards-based one-click unsubscribe endpoint.",
            }),
          };
        }
        return {
          ok: true,
          json: async () => maintenanceState,
        };
      }),
    );

    render(React.createElement(EmailCockpit));
    await screen.findAllByText("Priority inbox");
    fireEvent.click(screen.getByRole("button", { name: /Maintenance/i }));
    const unsubscribeButton = screen
      .getAllByRole("button", { name: "Unsubscribe" })
      .find((button) => !button.hasAttribute("disabled"));
    expect(unsubscribeButton).toBeDefined();
    fireEvent.click(unsubscribeButton!);

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(
      await screen.findByText(
        "This sender does not provide a standards-based one-click unsubscribe endpoint.",
      ),
    ).toBeInTheDocument();
  });
});

describe("Living Daily Brief Today UI", () => {
  function renderToday(input: {
    data?: TodayBrief;
    refreshing?: boolean;
    onOpenTarget?: (target: ActionCenterTarget) => void;
    onBriefAction?: (itemId: string, action: BriefMemoryAction) => Promise<void>;
  } = {}) {
    return render(
      <TodayView
        data={input.data || livingTodayBrief()}
        loading={false}
        refreshing={Boolean(input.refreshing)}
        error=""
        onOpen={vi.fn()}
        onOpenMail={vi.fn()}
        onAction={vi.fn().mockResolvedValue({
          actionId: "legacy-action",
          action: "keep",
          successCount: 1,
          failureCount: 0,
          reversible: false,
          failures: [],
        })}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onOpenTarget={input.onOpenTarget || vi.fn()}
        onBriefAction={input.onBriefAction || vi.fn().mockResolvedValue(undefined)}
      />,
    );
  }

  it("keeps actions primary and source warnings visible while history is collapsed", () => {
    renderToday({ refreshing: true });

    expect(screen.getByLabelText("Living daily brief page")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("group", { name: "Today's mail activity" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Today's agenda" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Needs your attention" })).toBeInTheDocument();
    expect(screen.getByText("Earlier, still open (1)")).toBeVisible();
    fireEvent.click(screen.getByText("Earlier, still open (1)"));
    expect(screen.getByText("Carried over")).toBeVisible();
    expect(screen.getByText(/Some sources need attention/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Calendar is showing its last cached state.");
    expect(screen.getByRole("status")).toBeVisible();
    expect(screen.getByRole("button", { name: "Bring back Sent budget reply" })).not.toBeVisible();
    fireEvent.click(screen.getByText("Completed and history"));
    expect(screen.getByRole("button", { name: "Bring back Sent budget reply" })).toBeVisible();

    expect(screen.getByText("Legacy mail topic")).toBeInTheDocument();
    expect(screen.getByText("Cleanup Sender")).toBeInTheDocument();
    expect(screen.getByText("Legacy glance message")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open history/ })).toBeInTheDocument();
  });

  it("shows overlapping FYI mail once under Worth knowing while retaining local controls", () => {
    const data = livingTodayBrief();
    data.topics[0] = { ...data.topics[0], kind: "fyi", id: "mail-reply-1", title: "Reply to Casey" };
    renderToday({ data });
    const attention = screen.getByRole("region", { name: "Needs your attention" });
    const fyi = screen.getByRole("region", { name: "Worth knowing" });
    expect(within(attention).queryByText("Reply to Casey")).not.toBeInTheDocument();
    expect(screen.getAllByText("Reply to Casey")).toHaveLength(1);
    expect(within(fyi).getByRole("button", { name: "Open Reply to Casey" })).toBeInTheDocument();
    expect(within(fyi).getByRole("button", { name: "Dismiss Reply to Casey" })).toBeEnabled();
    fireEvent.click(screen.getByText("Earlier, still open (1)"));
    expect(within(attention).getByRole("button", { name: "Open Submit expense report" })).toBeInTheDocument();
  });

  it("does not reintroduce completed mail through the legacy topic list", () => {
    const data = livingTodayBrief();
    data.topics[0] = { ...data.topics[0], id: "mail-completed-1", title: "Sent budget reply" };
    renderToday({ data });
    expect(within(screen.getByRole("region", { name: "Needs your attention" })).queryByText("Sent budget reply")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Completed and history"));
    expect(screen.getAllByText("Sent budget reply")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Bring back Sent budget reply" })).toBeEnabled();
  });

  it("keeps healthy source detail collapsed without claiming an approval-only day is empty", () => {
    const data = livingTodayBrief();
    data.topics = [];
    data.needsAttention = [];
    data.counts = { action: 0, reply: 0, deadline: 0, fyi: 0 };
    data.sourceStatus = data.sourceStatus.map(item => ({ ...item, status: "current", detail: null }));
    renderToday({ data });
    expect(screen.getByText("Sources up to date").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText("Your inbox is in a calm place")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing needs your attention")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Earlier, still open (1)"));
    expect(screen.getByRole("button", { name: "Open Submit expense report" })).toBeVisible();
  });

  it("keeps FYI carryovers informational when current mail topics are unavailable", () => {
    const data = livingTodayBrief();
    data.topics = [];
    data.carryovers[0] = { ...data.carryovers[0], sourceType: "mail_thread", topicKind: "fyi", target: { view: "mail", messageId: "older-fyi" } };
    renderToday({ data });
    expect(within(screen.getByRole("region", { name: "Worth knowing" })).getByText("Submit expense report")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Needs your attention" })).queryByText("Submit expense report")).not.toBeInTheDocument();
  });

  it("keeps a reconciled terminal topic out of open work after its completion day", () => {
    const data = livingTodayBrief();
    const completed = data.completedSinceLastBrief[0];
    data.topics[0] = { ...data.topics[0], id: "mail-completed-1", title: "Sent budget reply" };
    data.briefCandidates = [completed];
    data.completedSinceLastBrief = [];
    renderToday({ data });
    expect(screen.queryByText("Sent budget reply")).not.toBeInTheDocument();
  });

  it("retains sender, account, thread and deadline context on a consolidated mail row", () => {
    const data = livingTodayBrief();
    data.topics[0] = { ...data.topics[0], kind: "deadline", id: "mail-reply-1", title: "Reply to Casey", deadline: "2026-09-02T12:00:00Z", threadCount: 3 };
    renderToday({ data });
    const row = screen.getByRole("button", { name: "Open Reply to Casey" });
    expect(row).toHaveTextContent("Legacy Sender");
    expect(row).toHaveTextContent("Gmail One");
    expect(row).toHaveTextContent("Due Sep 2");
    expect(row).toHaveTextContent("3 in thread");
    expect(screen.getAllByText("Reply to Casey")).toHaveLength(1);
  });

  it("displays dismissal and restored-open times without losing historical completion", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-31T14:00:00.000Z"));
    const data = livingTodayBrief();
    data.completedSinceLastBrief[0] = { ...data.completedSinceLastBrief[0], state: "dismissed", completedAt: "2026-08-31T13:00:00.000Z", restoredAt: "2026-08-31T13:40:00.000Z", dismissedAt: "2026-08-31T13:55:00.000Z" };
    data.needsAttention[0] = { ...data.needsAttention[0], completedAt: "2026-08-31T13:00:00.000Z", restoredAt: "2026-08-31T13:58:00.000Z", lastSeenAt: "2026-08-31T13:30:00.000Z" };
    renderToday({ data });
    fireEvent.click(screen.getByText("Completed and history"));
    expect(screen.getByText(/dismissed 5m ago/)).toBeInTheDocument();
    expect(screen.getByRole("button", {name:"Open Reply to Casey"})).toHaveTextContent("Waiting since today");
    vi.useRealTimers();
  });

  it("forwards exact stored targets and exposes only state-appropriate local controls", async () => {
    const onOpenTarget = vi.fn();
    const action = deferred<void>();
    const onBriefAction = vi.fn(() => action.promise);
    renderToday({ onOpenTarget, onBriefAction });

    fireEvent.click(screen.getByRole("button", { name: "Open Planning review" }));
    expect(onOpenTarget).toHaveBeenLastCalledWith({
      view: "calendar",
      eventId: "calendar-event-1",
      date: "2026-08-31",
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Reply to Casey" }));
    expect(onOpenTarget).toHaveBeenLastCalledWith({ view: "mail", messageId: "mail-reply-1" });
    fireEvent.click(screen.getByText("Earlier, still open (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Open Submit expense report" }));
    expect(onOpenTarget).toHaveBeenLastCalledWith({ view: "outbox", draftId: "draft-older-1" });

    expect(screen.getByRole("button", { name: "Mark handled Reply to Casey" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Dismiss Reply to Casey" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Mark handled Sent budget reply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss Sent budget reply" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Completed and history"));
    expect(screen.getByRole("button", { name: "Bring back Sent budget reply" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Mark handled Reply to Casey" }));
    expect(onBriefAction).toHaveBeenCalledWith("brief-attention", "complete");
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark handled Reply to Casey" })).toBeDisabled());
    expect(screen.getByLabelText("Living daily brief page")).toHaveAttribute("aria-busy", "true");

    action.resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark handled Reply to Casey" })).toBeEnabled());
  });
});

describe("Living Daily Brief shell actions", () => {
  const workspaceA = "workspace:account:gmail:gmail-1";
  const workspaceB = "workspace:account:microsoft:outlook-1";

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("ezra-mail-workspace", workspaceA);
    window.history.replaceState({}, "", "/?view=today");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("preserves exact Today calendar target through URL reload and popstate, clearing ordinary and workspace navigation", async () => {
    const calendarRequests: URLSearchParams[] = [];
    const mutations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") mutations.push(url);
      if (url === "/api/auth/session") return jsonResponse(authenticatedSession());
      if (url === "/api/mail/meta") return jsonResponse({ workspaces: shellWorkspaces() });
      if (url === "/api/accounts") return jsonResponse(emptyFreshness());
      if (url.startsWith("/api/today?")) return jsonResponse(livingTodayBrief());
      if (url.startsWith("/api/calendar?")) {
        const params = new URL(url, "https://ezra.test").searchParams;
        calendarRequests.push(params);
        return jsonResponse({
          events: [{ id: "calendar-event-1", externalEventId: "provider-calendar-1", accountId: "gmail-1", accountLabel: "Gmail", accountProvider: "gmail", calendarId: "primary", calendarName: "Primary", title: "Planning review", description: "Exact local calendar source.", location: null, startsAt: "2026-08-31T15:00:00.000Z", endsAt: "2026-08-31T16:00:00.000Z", isAllDay: false, dateRange: null, timezone: "America/Chicago", status: "confirmed", visibility: null, isBusy: true, organizerName: null, organizerEmail: null, attendees: [], webLink: null, updatedAt: "2026-08-31T12:00:00.000Z", syncedAt: "2026-08-31T14:00:00.000Z" }],
          accounts: [], drafts: [], range: { from: params.get("from"), to: params.get("to"), timezone: "America/Chicago" },
        });
      }
      return jsonResponse({ events: [], cursor: null });
    }));
    localStorage.setItem("ezra-calendar-mode", "month");
    localStorage.setItem("ezra-calendar-date", "2025-01-12");
    const first = render(<EzraMailApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Planning review" }));
    const targetUrl = window.location.href;
    expect(new URL(targetUrl).searchParams.get("event")).toBe("calendar-event-1");
    expect(new URL(targetUrl).searchParams.get("date")).toBe("2026-08-31");
    expect(await screen.findByRole("dialog", { name: "Planning review" })).toHaveTextContent("Exact local calendar source.");
    first.unmount();
    localStorage.setItem("ezra-calendar-mode", "month");
    localStorage.setItem("ezra-calendar-date", "2025-01-12");
    render(<EzraMailApp />);
    expect(await screen.findByRole("dialog", { name: "Planning review" })).toBeInTheDocument();
    await act(async () => { window.history.replaceState({}, "", "/?view=today"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(await screen.findByRole("button", { name: "Open Planning review" })).toBeInTheDocument();
    await act(async () => { window.history.replaceState({}, "", targetUrl); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(await screen.findByRole("dialog", { name: "Planning review" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Today" })[0]);
    expect(new URL(window.location.href).searchParams.has("event")).toBe(false);
    expect(new URL(window.location.href).searchParams.has("date")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Open Planning review" }));
    await screen.findByRole("dialog", { name: "Planning review" });
    fireEvent.click(screen.getByRole("button", { name: /Outlook/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(new URL(window.location.href).searchParams.has("event")).toBe(false);
    expect(new URL(window.location.href).searchParams.has("date")).toBe(false);
    expect(calendarRequests.some((params) => params.get("workspaceId") === workspaceB)).toBe(true);
    expect(mutations).toEqual([]);
  });

  it("posts the exact local action and performs one quiet Today regeneration", async () => {
    const initial = shellBrief(workspaceA, "Reply to Casey");
    const regenerated = shellBrief(workspaceA, "Regenerated follow-up");
    const reload = deferred<Response>();
    const todayRequests: string[] = [];
    const itemPosts: Array<Record<string, unknown>> = [];
    const mailActionPosts: Array<Record<string, unknown>> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/session") return jsonResponse(authenticatedSession());
      if (url === "/api/mail/meta") return jsonResponse({ workspaces: shellWorkspaces() });
      if (url === "/api/accounts") return jsonResponse(emptyFreshness());
      if (url.startsWith("/api/today?")) {
        const requestedWorkspace = new URL(url, "https://ezra.test").searchParams.get("workspaceId") || "";
        todayRequests.push(requestedWorkspace);
        if (todayRequests.length === 1) return jsonResponse(initial);
        return reload.promise;
      }
      if (url === "/api/today/items" && init?.method === "POST") {
        itemPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ item: initial.needsAttention[0] });
      }
      if (url === "/api/mail/actions" && init?.method === "POST") {
        mailActionPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
    }));

    render(<EzraMailApp />);
    expect(await screen.findByText("Reply to Casey")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mark handled Reply to Casey" }));

    await waitFor(() => expect(itemPosts).toEqual([{
      workspaceId: workspaceA,
      itemId: "brief-attention",
      action: "complete",
    }]));
    await waitFor(() => expect(todayRequests).toEqual([workspaceA, workspaceA]));
    expect(mailActionPosts).toEqual([]);
    expect(screen.getByText("Reply to Casey")).toBeInTheDocument();
    expect(screen.getByLabelText("Living daily brief page")).toHaveAttribute("aria-busy", "true");

    reload.resolve(jsonResponse(regenerated));
    expect(await screen.findByText("Regenerated follow-up")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Living daily brief page")).toHaveAttribute("aria-busy", "false"));
    expect(todayRequests).toEqual([workspaceA, workspaceA]);
  });

  it("does not regenerate Today after a failed local action", async () => {
    const initial = shellBrief(workspaceA, "Reply to Casey");
    const currentB = shellBrief(workspaceB, "Workspace B remains clear", "brief-b-clear");
    const todayRequests: string[] = [];
    const itemPosts: Array<Record<string, unknown>> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/session") return jsonResponse(authenticatedSession());
      if (url === "/api/mail/meta") return jsonResponse({ workspaces: shellWorkspaces() });
      if (url === "/api/accounts") return jsonResponse(emptyFreshness());
      if (url.startsWith("/api/today?")) {
        const requestedWorkspace = new URL(url, "https://ezra.test").searchParams.get("workspaceId") || "";
        todayRequests.push(requestedWorkspace);
        return jsonResponse(requestedWorkspace === workspaceB ? currentB : initial);
      }
      if (url === "/api/today/items" && init?.method === "POST") {
        itemPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ error: "Brief item could not be updated." }, 400);
      }
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
    }));

    render(<EzraMailApp />);
    expect(await screen.findByText("Reply to Casey")).toBeInTheDocument();
    const complete = screen.getByRole("button", { name: "Mark handled Reply to Casey" });
    fireEvent.click(complete);

    expect(await screen.findByText("Brief item could not be updated.")).toBeInTheDocument();
    expect(itemPosts).toHaveLength(1);
    expect(todayRequests).toEqual([workspaceA]);
    expect(screen.getByText("Reply to Casey")).toBeInTheDocument();
    expect(complete).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /Outlook Two/ }));
    expect(await screen.findByText("Workspace B remains clear")).toBeInTheDocument();
    expect(screen.queryByText("Brief item could not be updated.")).not.toBeInTheDocument();
    expect(todayRequests).toEqual([workspaceA, workspaceB]);
  });

  it("cannot reload or overwrite a newly selected workspace when an old action finishes", async () => {
    const initialA = shellBrief(workspaceA, "Reply to Casey");
    const currentB = shellBrief(workspaceB, "Workspace B decision", "brief-b");
    const staleA = shellBrief(workspaceA, "Stale workspace A reload");
    const action = deferred<Response>();
    const todayRequests: string[] = [];
    const itemPosts: Array<Record<string, unknown>> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/session") return jsonResponse(authenticatedSession());
      if (url === "/api/mail/meta") return jsonResponse({ workspaces: shellWorkspaces() });
      if (url === "/api/accounts") return jsonResponse(emptyFreshness());
      if (url.startsWith("/api/today?")) {
        const requestedWorkspace = new URL(url, "https://ezra.test").searchParams.get("workspaceId") || "";
        todayRequests.push(requestedWorkspace);
        if (requestedWorkspace === workspaceB) return jsonResponse(currentB);
        return jsonResponse(todayRequests.length === 1 ? initialA : staleA);
      }
      if (url === "/api/today/items" && init?.method === "POST") {
        itemPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return action.promise;
      }
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
    }));

    render(<EzraMailApp />);
    expect(await screen.findByText("Reply to Casey")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark handled Reply to Casey" }));
    await waitFor(() => expect(itemPosts).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /Outlook Two/ }));
    expect(await screen.findByText("Workspace B decision")).toBeInTheDocument();
    expect(todayRequests).toEqual([workspaceA, workspaceB]);

    action.resolve(jsonResponse({ item: initialA.needsAttention[0] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark handled Workspace B decision" })).toBeEnabled());
    expect(screen.getByText("Workspace B decision")).toBeInTheDocument();
    expect(screen.queryByText("Stale workspace A reload")).not.toBeInTheDocument();
    expect(todayRequests).toEqual([workspaceA, workspaceB]);
  });

  it("keeps a newer workspace action pending while an older workspace failure settles", async () => {
    const initialA = shellBrief(workspaceA, "Reply to Casey");
    const currentB = shellBrief(workspaceB, "Workspace B stays actionable", "brief-b-actionable");
    const actionA = deferred<Response>();
    const actionB = deferred<Response>();
    const todayRequests: string[] = [];
    const itemPosts: Array<Record<string, unknown>> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/session") return jsonResponse(authenticatedSession());
      if (url === "/api/mail/meta") return jsonResponse({ workspaces: shellWorkspaces() });
      if (url === "/api/accounts") return jsonResponse(emptyFreshness());
      if (url.startsWith("/api/today?")) {
        const requestedWorkspace = new URL(url, "https://ezra.test").searchParams.get("workspaceId") || "";
        todayRequests.push(requestedWorkspace);
        return jsonResponse(requestedWorkspace === workspaceB ? currentB : initialA);
      }
      if (url === "/api/today/items" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        itemPosts.push(body);
        return body.workspaceId === workspaceA ? actionA.promise : actionB.promise;
      }
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
    }));

    render(<EzraMailApp />);
    expect(await screen.findByText("Reply to Casey")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark handled Reply to Casey" }));
    await waitFor(() => expect(itemPosts).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /Outlook Two/ }));
    expect(await screen.findByText("Workspace B stays actionable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark handled Workspace B stays actionable" })).toBeEnabled();
    expect(screen.getByLabelText("Living daily brief page")).toHaveAttribute("aria-busy", "false");

    fireEvent.click(screen.getByRole("button", { name: "Mark handled Workspace B stays actionable" }));
    await waitFor(() => expect(itemPosts).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Mark handled Workspace B stays actionable" })).toBeDisabled();
    expect(screen.getByLabelText("Living daily brief page")).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      actionA.resolve(jsonResponse({ error: "Old workspace action failed." }, 400));
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Mark handled Workspace B stays actionable" })).toBeDisabled();
    expect(screen.queryByText("Old workspace action failed.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Living daily brief page")).toHaveAttribute("aria-busy", "true");

    actionB.resolve(jsonResponse({ item: currentB.needsAttention[0] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark handled Workspace B stays actionable" })).toBeEnabled());
    expect(screen.getByLabelText("Living daily brief page")).toHaveAttribute("aria-busy", "false");
    expect(todayRequests).toEqual([workspaceA, workspaceB, workspaceB]);
  });
});

describe("foreground notification shell routing", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("ezra-mail-workspace", "workspace:account:microsoft:outlook-1");
    localStorage.setItem("ezra-mail-browser-notifications-enabled", JSON.stringify({
      origin: window.location.origin,
      enabled: true,
      deviceId: "browser_shell",
      generation: 1,
    }));
    window.history.replaceState({}, "", "/?view=today");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("does not mount the foreground listener outside the authenticated shell", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/auth/session") return jsonResponse({
        authenticated: false,
        configured: true,
        developmentBypass: false,
        expiresAt: null,
      });
      throw new Error(`Unexpected request: GET ${url}`);
    }));

    render(<EzraMailApp />);

    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(requests).toEqual(["/api/auth/session"]);
  });

  it("opens the authoritative second Gmail account and exact local message without a mail mutation", async () => {
    const notifications: Array<{ onclick: ((event: Event) => void) | null; close: ReturnType<typeof vi.fn> }> = [];
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
      onclick: ((event: Event) => void) | null = null;
      close = vi.fn();
      constructor() { notifications.push(this); }
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: FakeNotification as unknown as typeof Notification,
    });
    vi.spyOn(window, "focus").mockImplementation(() => window);

    const posts: Array<{ url: string; body: unknown }> = [];
    const target = "/?view=mail&workspace=workspace%3Aaccount%3Agmail%3Agmail-7&message=message-local-7";
    const event = { deliveryId: "delivery_7", eventId: "event_7", kind: "interrupt", target, tag: "shell_7", title: "Ezra Mail", body: "Open Ezra Mail to review new attention.", createdAt: "2026-09-03T15:07:00.000Z" };
    const mailWorkspaces: string[] = [];
    const detailRequests: string[] = [];
    const exactMessage = inboxItem({
      id: "message-local-7",
      accountId: "gmail-7",
      accountLabel: "Gmail Two",
      accountProvider: "gmail",
      senderName: "Casey",
      senderEmail: "casey@example.test",
      subject: "Quarterly review moved to 3 PM",
    });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url === "/api/auth/session") return jsonResponse({ ...authenticatedSession(), developmentBypass: false, trustedDevice: { id: "trusted_shell" } });
      if (url === "/api/accounts") return jsonResponse({ ...emptyFreshness(), items: [{ accountId: "gmail-7", accountProvider: "gmail", status: "connected" }] });
      if (url.startsWith("/api/today?")) return jsonResponse(shellBrief(new URL(url, "https://ezra.test").searchParams.get("workspaceId") || "", "Notification route"));
      if (url === "/api/mail/meta") return jsonResponse({
        accounts: [
          { id: "gmail-1", provider: "gmail", label: "Gmail One", email: "one@example.test" },
          { id: "gmail-7", provider: "gmail", label: "Gmail Two", email: "two@example.test" },
          { id: "outlook-1", provider: "microsoft", label: "Outlook Two", email: "outlook@example.test" },
        ],
        workspaces: notificationShellWorkspaces(),
        categories: [],
      });
      if (url === "/api/notifications/foreground") return jsonResponse({
        enabled: true, deviceId: "browser_shell", generation: 1, hasMore: false, events: [event],
      });
      if (url === "/api/notifications/claims" && init?.method === "POST") return jsonResponse({ ...event, attemptId: "attempt_7", generation: 1 });
      if (url === "/api/notifications/receipts" && init?.method === "POST") return jsonResponse({ recorded: true });
      if (url.startsWith("/api/views?")) return jsonResponse({
        generatedAt: "2026-09-03T15:08:00.000Z",
        workspaceId: new URL(url, "https://ezra.test").searchParams.get("workspaceId"),
        items: [],
      });
      if (url.startsWith("/api/mail?")) {
        const workspace = new URL(url, "https://ezra.test").searchParams.get("workspaceId") || "";
        mailWorkspaces.push(workspace);
        return jsonResponse({ items: [exactMessage], nextCursor: null, total: 1 });
      }
      if (url === "/api/mail/message-local-7") {
        detailRequests.push(url);
        return jsonResponse({
          detail: messageDetail(exactMessage),
          thread: [],
          capabilities: { unsubscribeSupported: false, protectedMessage: false },
        });
      }
      if (url.startsWith("/api/settings/writing?")) return jsonResponse({ remoteImagesAllowed: false });
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
    }));

    render(<EzraMailApp />);
    await waitFor(() => expect(notifications).toHaveLength(1));

    await act(async () => {
      notifications[0].onclick?.(new Event("click"));
    });

    await waitFor(() => expect(window.location.search).toBe(target.slice(1)));
    expect(localStorage.getItem("ezra-mail-workspace")).toBe("workspace:account:gmail:gmail-7");
    await waitFor(() => expect(mailWorkspaces).toContain("workspace:account:gmail:gmail-7"));
    await waitFor(() => expect(detailRequests).toEqual(["/api/mail/message-local-7"]));
    expect(await screen.findByRole("heading", { name: "Quarterly review moved to 3 PM" })).toBeInTheDocument();
    expect(posts).toEqual([
      { url: "/api/notifications/claims", body: { deliveryId: "delivery_7", expectedGeneration: 1 } },
      { url: "/api/notifications/receipts", body: { attemptId: "attempt_7", generation: 1, kind: "foreground_shown" } },
      { url: "/api/notifications/receipts", body: { attemptId: "attempt_7", generation: 1, kind: "clicked" } },
    ]);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });
});

describe("Daily Brief refresh orchestration", () => {
  const workspace = "workspace:account:gmail:gmail-1";

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("ezra-mail-workspace", workspace);
    window.history.replaceState({}, "", "/?view=today");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("regenerates once for a successful mail action and once for its successful undo", async () => {
    const todayRequests: string[] = [];
    const mailPosts: Array<Record<string, unknown>> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const bootstrap = shellBootstrapResponse(url);
      if (bootstrap) return bootstrap;
      if (url.startsWith("/api/today?")) {
        todayRequests.push(new URL(url, "https://ezra.test").searchParams.get("workspaceId") || "");
        return jsonResponse(shellBrief(workspace, todayRequests.length === 1 ? "Mail action before" : "Mail action regenerated"));
      }
      if (url === "/api/mail/actions" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        mailPosts.push(body);
        return jsonResponse(body.action === "undo"
          ? shellMailAction("undo", { actionId: "undo-action", reversible: false })
          : shellMailAction("quiet", {
            actionId: "quiet-action",
            reversible: true,
            changedIds: ["cleanup-mail-1"],
            failureCount: 1,
            failures: [{ id: "other-mail", error: "One related message could not be changed." }],
          }));
      }
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
    }));

    render(<EzraMailApp />);
    expect(await screen.findByText("Mail action before")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Quiet sender" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(todayRequests).toEqual([workspace, workspace]));
    expect(mailPosts[0]).toEqual({ action: "quiet", messageIds: ["cleanup-mail-1"] });

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(todayRequests).toEqual([workspace, workspace, workspace]));
    expect(mailPosts[1]).toEqual({ action: "undo", actionId: "quiet-action" });
  });

  it("does not regenerate after Undo reports zero successful changes", async () => {
    const todayRequests: string[] = [];
    const mailPosts: Array<Record<string, unknown>> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const bootstrap = shellBootstrapResponse(url);
      if (bootstrap) return bootstrap;
      if (url.startsWith("/api/today?")) {
        todayRequests.push(new URL(url, "https://ezra.test").searchParams.get("workspaceId") || "");
        return jsonResponse(shellBrief(workspace, todayRequests.length === 1 ? "Undo before" : "Undo action applied"));
      }
      if (url === "/api/mail/actions" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        mailPosts.push(body);
        return jsonResponse(body.action === "undo"
          ? shellMailAction("undo", {
            successCount: 0,
            failureCount: 1,
            failures: [{ id: "quiet-action", error: "Undo could not be applied." }],
          })
          : shellMailAction("quiet", {
            actionId: "quiet-action",
            reversible: true,
            changedIds: ["cleanup-mail-1"],
          }));
      }
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
    }));

    render(<EzraMailApp />);
    expect(await screen.findByText("Undo before")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Quiet sender" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(todayRequests).toEqual([workspace, workspace]));

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(mailPosts).toHaveLength(2));
    expect(todayRequests).toEqual([workspace, workspace]);
    expect(mailPosts[1]).toEqual({ action: "undo", actionId: "quiet-action" });
  });

  it("does not regenerate after a mail action reports zero successful changes", async () => {
    const todayRequests: string[] = [];
    const mailPosts: Array<Record<string, unknown>> = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const bootstrap = shellBootstrapResponse(url);
      if (bootstrap) return bootstrap;
      if (url.startsWith("/api/today?")) {
        todayRequests.push(new URL(url, "https://ezra.test").searchParams.get("workspaceId") || "");
        return jsonResponse(shellBrief(workspace, "Mail action unchanged"));
      }
      if (url === "/api/mail/actions" && init?.method === "POST") {
        mailPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse(shellMailAction("quiet", {
          successCount: 0,
          failureCount: 1,
          failures: [{ id: "cleanup-mail-1", error: "Provider rejected the change." }],
        }));
      }
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
    }));

    render(<EzraMailApp />);
    expect(await screen.findByText("Mail action unchanged")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Quiet sender" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(mailPosts).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(todayRequests).toEqual([workspace]);
  });

  it("keeps Today mounted, busy, and focused during one manual quiet refresh", async () => {
    const reload = deferred<Response>();
    const todayRequests: string[] = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const bootstrap = shellBootstrapResponse(url);
      if (bootstrap) return bootstrap;
      if (url.startsWith("/api/today?")) {
        todayRequests.push(new URL(url, "https://ezra.test").searchParams.get("workspaceId") || "");
        if (todayRequests.length === 1) return jsonResponse(shellBrief(workspace, "Manual refresh before"));
        return reload.promise;
      }
      throw new Error(`Unexpected request: GET ${url}`);
    }));

    render(<EzraMailApp />);
    expect(await screen.findByText("Manual refresh before")).toBeInTheDocument();
    const refresh = screen.getByRole("button", { name: "Refresh" });
    refresh.focus();
    fireEvent.click(refresh);

    await waitFor(() => expect(todayRequests).toEqual([workspace, workspace]));
    expect(screen.getByText("Manual refresh before")).toBeInTheDocument();
    expect(screen.getByLabelText("Living daily brief page")).toHaveAttribute("aria-busy", "true");
    expect(refresh).toHaveFocus();

    reload.resolve(jsonResponse(shellBrief(workspace, "Manual refresh after")));
    expect(await screen.findByText("Manual refresh after")).toBeInTheDocument();
    expect(refresh).toHaveFocus();
    expect(todayRequests).toEqual([workspace, workspace]);
  });

  it("performs one quiet refresh at the timer boundary without moving focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const todayRequests: string[] = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const bootstrap = shellBootstrapResponse(url);
      if (bootstrap) return bootstrap;
      if (url.startsWith("/api/today?")) {
        todayRequests.push(new URL(url, "https://ezra.test").searchParams.get("workspaceId") || "");
        return jsonResponse(shellBrief(workspace, todayRequests.length === 1 ? "Timer refresh before" : "Timer refresh after"));
      }
      throw new Error(`Unexpected request: GET ${url}`);
    }));

    render(<EzraMailApp />);
    expect(await screen.findByText("Timer refresh before")).toBeInTheDocument();
    const stationary = screen.getByRole("button", { name: /Open history/ });
    stationary.focus();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    await waitFor(() => expect(todayRequests).toEqual([workspace, workspace]));
    expect(await screen.findByText("Timer refresh after")).toBeInTheDocument();
    expect(stationary).toHaveFocus();
  });

  it("refreshes once only when a hidden page becomes visible and keeps focus stationary", async () => {
    let hidden = true;
    const hiddenSpy = vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const todayRequests: string[] = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const bootstrap = shellBootstrapResponse(url);
      if (bootstrap) return bootstrap;
      if (url.startsWith("/api/today?")) {
        todayRequests.push(new URL(url, "https://ezra.test").searchParams.get("workspaceId") || "");
        return jsonResponse(shellBrief(workspace, todayRequests.length === 1 ? "Visibility before" : "Visibility after"));
      }
      throw new Error(`Unexpected request: GET ${url}`);
    }));

    render(<EzraMailApp />);
    expect(await screen.findByText("Visibility before")).toBeInTheDocument();
    const stationary = screen.getByRole("button", { name: /Open history/ });
    stationary.focus();

    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(todayRequests).toEqual([workspace]);

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(todayRequests).toEqual([workspace, workspace]));
    expect(await screen.findByText("Visibility after")).toBeInTheDocument();
    expect(stationary).toHaveFocus();
    hiddenSpy.mockRestore();
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

function shellBootstrapResponse(url: string): Response | null {
  if (url === "/api/auth/session") return jsonResponse(authenticatedSession());
  if (url === "/api/mail/meta") return jsonResponse({ workspaces: shellWorkspaces() });
  if (url === "/api/accounts") return jsonResponse(emptyFreshness());
  return null;
}

function shellMailAction(
  action: MailActionResult["action"],
  overrides: Partial<MailActionResult> = {},
): MailActionResult {
  return {
    actionId: "mail-action",
    action,
    successCount: 1,
    failureCount: 0,
    reversible: false,
    failures: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function authenticatedSession() {
  return {
    authenticated: true,
    configured: true,
    developmentBypass: true,
    expiresAt: null,
    trustedDevice: null,
  };
}

function emptyFreshness() {
  return {
    generatedAt: "2026-08-31T14:00:00.000Z",
    pollIntervalMinutes: 5,
    manualSyncCooldownSeconds: 30,
    items: [],
  };
}

function shellWorkspaces(): MailWorkspace[] {
  return [
    {
      id: "workspace:account:gmail:gmail-1",
      label: "Gmail One",
      purpose: "Primary",
      accountIds: ["gmail-1"],
      isAllAccounts: false,
      calendarRole: "primary_future",
      provider: "gmail",
    },
    {
      id: "workspace:account:microsoft:outlook-1",
      label: "Outlook Two",
      purpose: "Secondary",
      accountIds: ["outlook-1"],
      isAllAccounts: false,
      calendarRole: "none",
      provider: "microsoft",
    },
  ];
}

function notificationShellWorkspaces(): MailWorkspace[] {
  return [
    shellWorkspaces()[0],
    {
      id: "workspace:account:gmail:gmail-7",
      label: "Gmail Two",
      purpose: "Second Gmail",
      accountIds: ["gmail-7"],
      isAllAccounts: false,
      calendarRole: "none",
      provider: "gmail",
    },
    shellWorkspaces()[1],
    {
      id: "workspace:all",
      label: "All accounts",
      purpose: "Explicit blend",
      accountIds: ["gmail-1", "gmail-7", "outlook-1"],
      isAllAccounts: true,
      calendarRole: "none",
      provider: "all",
    },
  ];
}

function shellBrief(workspaceId: string, title: string, itemId = "brief-attention"): TodayBrief {
  const base = livingTodayBrief();
  const attention = {
    ...base.needsAttention[0],
    id: itemId,
    workspaceId,
    sourceKey: `mail_thread:${itemId}`,
    title,
    target: { view: "mail", messageId: `mail-${itemId}` } as ActionCenterTarget,
  };
  return {
    ...base,
    id: `brief-${workspaceId}`,
    workspaceId,
    agenda: [],
    needsAttention: [attention],
    carryovers: [],
    completedSinceLastBrief: [],
  };
}

function livingTodayBrief(): TodayBrief {
  return {
    id: "living-brief",
    workspaceId: "workspace:account:gmail:gmail-1",
    date: "2026-08-31",
    generatedAt: "2026-08-31T14:00:00.000Z",
    quietReviewed: 4,
    mailActivity: {
      receivedToday: 3,
      handledToday: 2,
      unhandledToday: 1,
      attentionCounts: { interrupt: 1, digest: 1, suppress: 1, unknown: 0 },
      stillNeedsAttention: 1,
      categoryCounts: [{ category: "project", count: 1 }],
      lastPollAt: "2026-08-31T13:59:00.000Z",
      lastPollError: null,
    },
    topics: [{
      id: "legacy-topic",
      kind: "action",
      title: "Legacy mail topic",
      summary: "The existing mail brief remains available.",
      senderName: "Legacy Sender",
      accountLabel: "Gmail One",
      receivedAt: "2026-08-31T13:00:00.000Z",
      deadline: null,
      urgency: 80,
      threadCount: 1,
    }],
    cleanup: [{
      accountId: "gmail-1",
      accountLabel: "Gmail One",
      latestMessageId: "cleanup-mail-1",
      senderName: "Cleanup Sender",
      senderEmail: "cleanup@example.test",
      latestSubject: "Weekly promotion",
      latestReceivedAt: "2026-08-31T12:00:00.000Z",
      messageCount: 2,
      category: "bulk-mail",
      recommendation: "quiet",
      reason: "Repeated low-value promotion.",
      unsubscribeSupported: false,
    }],
    oneMoreGlance: [{
      id: "glance-mail-1",
      accountId: "gmail-1",
      accountLabel: "Gmail One",
      accountProvider: "gmail",
      senderName: "Glance Sender",
      senderEmail: "glance@example.test",
      subject: "Legacy glance message",
      summary: "This existing review surface remains visible.",
      receivedAt: "2026-08-31T11:00:00.000Z",
      category: "project",
      attention: "digest",
      reasonLabel: "Looks handled",
    }],
    history: {
      generatedAt: "2026-08-31T14:00:00.000Z",
      sections: [{
        kind: "received",
        title: "Received",
        description: "Messages observed today.",
        count: 1,
        items: [{
          id: "history-1",
          kind: "received",
          itemType: "message",
          messageId: "legacy-topic",
          actionId: null,
          accountId: "gmail-1",
          accountLabel: "Gmail One",
          accountProvider: "gmail",
          title: "Legacy history item",
          subtitle: "Legacy Sender",
          detail: "Observed today.",
          occurredAt: "2026-08-31T13:00:00.000Z",
          action: null,
          status: null,
          successCount: null,
          failureCount: null,
        }],
      }],
    },
    counts: { action: 1, reply: 1, deadline: 0, fyi: 0 },
    briefCandidates: [],
    replyCandidates: [],
    sourceStatus: [
      { source: "mail", status: "current", accountId: null, checkedAt: "2026-08-31T13:59:00.000Z", detail: null },
      { source: "calendar", status: "stale", accountId: null, checkedAt: "2026-08-31T13:55:00.000Z", detail: "Calendar is showing its last cached state." },
    ],
    agenda: [
      livingBriefItem({
        id: "brief-agenda",
        title: "Planning review",
        sourceType: "calendar_event",
        role: "agenda",
        target: { view: "calendar", eventId: "calendar-event-1", date: "2026-08-31" },
      }),
    ],
    needsAttention: [
      livingBriefItem({
        id: "brief-attention",
        title: "Reply to Casey",
        target: { view: "mail", messageId: "mail-reply-1" },
      }),
    ],
    carryovers: [
      livingBriefItem({
        id: "brief-carryover",
        title: "Submit expense report",
        sourceType: "action_center",
        target: { view: "outbox", draftId: "draft-older-1" },
        firstSeenAt: "2026-08-29T14:00:00.000Z",
      }),
    ],
    completedSinceLastBrief: [
      livingBriefItem({
        id: "brief-completed",
        title: "Sent budget reply",
        state: "completed",
        completedAt: "2026-08-31T13:45:00.000Z",
        target: { view: "mail", messageId: "mail-completed-1" },
      }),
    ],
  };
}

function livingBriefItem(input: {
  id: string;
  title: string;
  target: ActionCenterTarget;
  sourceType?: LivingBriefItem["sourceType"];
  role?: LivingBriefItem["role"];
  state?: LivingBriefItem["state"];
  firstSeenAt?: string;
  completedAt?: string | null;
}): LivingBriefItem {
  const sourceType = input.sourceType || "mail_thread";
  return {
    id: input.id,
    workspaceId: "workspace:account:gmail:gmail-1",
    sourceType,
    sourceKey: sourceType + ":" + input.id,
    sourceAccountId: "gmail-1",
    provider: "gmail",
    providerThreadId: sourceType === "mail_thread" ? "thread-" + input.id : null,
    revisionAt: "2026-08-31T13:30:00.000Z",
    occurredAt: "2026-08-31T13:30:00.000Z",
    role: input.role || "attention",
    title: input.title,
    summary: "Exact source summary for " + input.title + ".",
    target: input.target,
    state: input.state || "open",
    firstSeenAt: input.firstSeenAt || "2026-08-31T13:30:00.000Z",
    lastSeenAt: "2026-08-31T14:00:00.000Z",
    completedAt: input.completedAt || null,
    dismissedAt: null,
    restoredAt: null,
  };
}
