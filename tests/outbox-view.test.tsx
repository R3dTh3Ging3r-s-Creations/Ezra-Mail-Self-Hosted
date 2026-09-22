import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutboxView } from "@/components/ezra/OutboxView";
import type { OutboxActionResult, OutboxItem, OutboxPage } from "@/lib/email/types";

describe("OutboxView", () => {
  let currentPage: OutboxPage;
  const actions: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    actions.length = 0;
    currentPage = makePage();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/outbox?")) {
        return jsonResponse(currentPage);
      }
      if (url === "/api/outbox/actions") {
        const body = JSON.parse(String(init?.body || "{}")) as { action: string; draftId: string };
        actions.push(body);
        if (body.action === "request_approval") {
          currentPage = updateItem(currentPage, body.draftId, (item) => {
            const snapshot = approvalSnapshot(item);
            return {
              ...item,
              status: "awaiting_approval",
              approvalSnapshot: JSON.stringify(snapshot),
              blockedReason: "Send is blocked until you approve the exact reviewed snapshot.",
            };
          });
          return jsonResponse<OutboxActionResult>({
            ok: true,
            message: "Exact review snapshot is ready.",
            item: currentPage.items.find((item) => item.draftId === body.draftId),
          });
        }
        if (body.action === "approve") {
          currentPage = updateItem(currentPage, body.draftId, (item) => ({
            ...item,
            status: "approved",
            canSend: true,
            blockedReason: null,
          }));
          return jsonResponse<OutboxActionResult>({
            ok: true,
            message: "Outgoing draft approved and ready for Gmail send.",
            item: currentPage.items.find((item) => item.draftId === body.draftId),
          });
        }
        if (body.action === "send") {
          currentPage = updateItem(currentPage, body.draftId, (item) => ({
            ...item,
            status: "sent",
            canSend: false,
            canCancel: false,
            providerMessageId: "gmail-provider-message-1",
            blockedReason: null,
          }));
          return jsonResponse<OutboxActionResult>({
            ok: true,
            message: "Outgoing Gmail draft sent.",
            providerMessageId: "gmail-provider-message-1",
            item: currentPage.items.find((item) => item.draftId === body.draftId),
          });
        }
        if (body.action === "cancel") {
          currentPage = {
            ...currentPage,
            counts: { ...currentPage.counts, blocked: 1, cancellable: 1, cancelled: 1 },
            items: currentPage.items.map((item) =>
              item.draftId === body.draftId
                ? { ...item, status: "cancelled", canCancel: false, blockedReason: null }
                : item,
            ),
          };
          return jsonResponse<OutboxActionResult>({
            ok: true,
            message: "Outgoing draft cancelled.",
            item: currentPage.items.find((item) => item.draftId === body.draftId),
          });
        }
        return jsonResponse<OutboxActionResult>({
          ok: false,
          message: "Provider send execution is still locked.",
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows exact outgoing draft details and locked provider-send controls", async () => {
    render(<OutboxView workspaceId="workspace:all" />);

    expect(await screen.findByText("Send Safety Queue")).toBeInTheDocument();
    expect(await screen.findAllByText("Gmail exact draft")).toHaveLength(2);
    expect(screen.getByDisplayValue("This is the exact body that should require approval.")).toBeInTheDocument();
    expect(screen.getByText("Provider send is locked")).toBeInTheDocument();
    expect(screen.getByText("Send is blocked until this draft goes through the Outbox exact-review approval flow.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });

  it("honors an initial Action Center draft target", async () => {
    render(<OutboxView workspaceId="workspace:all" initialDraftId="draft-failed" />);

    expect(await screen.findByDisplayValue("Failed body")).toBeInTheDocument();
    expect(screen.getByText("Last send error")).toBeInTheDocument();
    expect(screen.getByText("provider timeout")).toBeInTheDocument();
  });

  it("cancels the selected draft and refreshes the queue quietly", async () => {
    render(<OutboxView workspaceId="workspace:all" />);

    await screen.findByDisplayValue("This is the exact body that should require approval.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel draft" }));

    await waitFor(() => {
      expect(actions).toEqual([{ action: "cancel", draftId: "draft-gmail" }]);
    });
    expect(await screen.findByText("Outgoing draft cancelled.")).toBeInTheDocument();
  });

  it("opens exact review, requires confirmation, approves, and sends Gmail", async () => {
    render(<OutboxView workspaceId="workspace:all" />);

    await screen.findByDisplayValue("This is the exact body that should require approval.");
    fireEvent.click(screen.getByRole("button", { name: "Review exact draft" }));

    expect(await screen.findByRole("heading", { name: "Approve this exact draft?" })).toBeInTheDocument();
    expect(screen.getByText("Ezra will only mark this local draft approved. No Gmail or Hotmail provider write happens in this step.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve exact draft" })).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/I reviewed the exact sender/i));
    fireEvent.click(screen.getByRole("button", { name: "Approve exact draft" }));

    await waitFor(() => {
      expect(actions.map((action) => action.action)).toEqual(["request_approval", "approve"]);
    });
    expect(await screen.findByText("Outgoing draft approved and ready for Gmail send.")).toBeInTheDocument();
    expect(screen.getByText("Exact draft approved")).toBeInTheDocument();
    expect(screen.getByText("Ezra has an approval snapshot for this exact content. The Gmail send button is now unlocked for this draft only.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(actions.map((action) => action.action)).toEqual(["request_approval", "approve", "send"]);
    });
    expect(await screen.findByText("Outgoing Gmail draft sent.")).toBeInTheDocument();
  });
});

function updateItem(page: OutboxPage, draftId: string, updater: (item: OutboxItem) => OutboxItem): OutboxPage {
  const items = page.items.map((item) => item.draftId === draftId ? updater(item) : item);
  return {
    ...page,
    counts: {
      ...page.counts,
      draft: items.filter((item) => item.status === "draft").length,
      awaitingApproval: items.filter((item) => item.status === "awaiting_approval").length,
      approved: items.filter((item) => item.status === "approved").length,
      sent: items.filter((item) => item.status === "sent").length,
      blocked: items.filter((item) => item.blockedReason && item.status !== "sent" && item.status !== "cancelled").length,
    },
    items,
  };
}

function approvalSnapshot(item: OutboxItem) {
  return {
    draftId: item.draftId,
    sourceType: item.sourceType,
    sourceMessageId: item.sourceMessageId,
    accountId: item.accountId,
    accountLabel: item.accountLabel,
    accountEmail: item.accountEmail,
    accountProvider: item.accountProvider,
    fromEmail: item.fromEmail,
    to: item.to,
    cc: item.cc,
    bcc: item.bcc,
    subject: item.subject,
    body: item.body,
    contentHash: item.contentHash,
    version: item.version,
    requestedAt: "2026-07-03T12:00:00.000Z",
  };
}

function makePage(): OutboxPage {
  const items = [
    makeItem({
      id: "outbox:draft-gmail",
      draftId: "draft-gmail",
      subject: "Gmail exact draft",
      body: "This is the exact body that should require approval.",
      bodyPreview: "This is the exact body that should require approval.",
      status: "draft",
      blockedReason: "Send is blocked until this draft goes through the Outbox exact-review approval flow.",
      lastError: null,
    }),
    makeItem({
      id: "outbox:draft-failed",
      draftId: "draft-failed",
      subject: "Failed outgoing",
      body: "Failed body",
      bodyPreview: "Failed body",
      status: "failed",
      blockedReason: "Retry is blocked until provider send execution records retry-safe failures.",
      lastError: "provider timeout",
    }),
  ];
  return {
    generatedAt: "2026-07-03T12:00:00.000Z",
    counts: {
      total: items.length,
      draft: 1,
      awaitingApproval: 0,
      approved: 0,
      sending: 0,
      sent: 0,
      failed: 1,
      cancelled: 0,
      blocked: 2,
      cancellable: 2,
    },
    items,
  };
}

function makeItem(overrides: Partial<OutboxItem>): OutboxItem {
  return {
    id: "outbox:draft",
    draftId: "draft",
    sourceType: "new",
    sourceMessageId: null,
    accountId: "acct-gmail",
    accountLabel: "Gmail",
    accountEmail: "owner@gmail.test",
    accountProvider: "gmail",
    fromEmail: "owner@gmail.test",
    to: [{ email: "contact@example.test" }],
    cc: [],
    bcc: [],
    recipientCount: 1,
    subject: "Subject",
    body: "Body",
    attachments: [],
    bodyPreview: "Body",
    status: "draft",
    version: 1,
    contentHash: "abcdef1234567890",
    approvalSnapshot: null,
    providerMessageId: null,
    lastError: null,
    canSend: false,
    canCancel: true,
    canRetry: false,
    blockedReason: "blocked",
    updatedAt: "2026-07-03T12:00:00.000Z",
    createdAt: "2026-07-03T11:55:00.000Z",
    ...overrides,
  };
}

function jsonResponse<T>(payload: T, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
}
