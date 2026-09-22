import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftsView } from "@/components/ezra/DraftsView";
import type { MailWorkspace, OutgoingDraft } from "@/lib/email/types";

describe("DraftsView new email composer", () => {
  const posts: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    posts.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/drafts") {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body || "{}")) as Record<string, unknown>;
          posts.push(body);
          return jsonResponse<OutgoingDraft>({
            id: "outdraft-1",
            sourceType: "new",
            sourceMessageId: null,
            accountId: String(body.accountId),
            accountLabel: "Hotmail",
            accountEmail: "owner@hotmail.test",
            accountProvider: "microsoft",
            fromEmail: "owner@hotmail.test",
            to: [{ email: "taylor@example.test", name: "Taylor" }],
            cc: [],
            bcc: [],
            subject: String(body.subject),
            body: String(body.body),
            attachments: [],
            contentHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
            version: 1,
            status: "draft",
            approvalSnapshot: null,
            providerMessageId: null,
            lastError: null,
            sendDisabledReason: "Hotmail mail sends only after Outbox exact-review approval and Microsoft Mail.Send access.",
            createdAt: "2026-07-03T12:00:00.000Z",
            updatedAt: "2026-07-03T12:00:00.000Z",
          });
        }
        return jsonResponse([]);
      }
      if (url === "/api/mail/meta") {
        return jsonResponse({
          accounts: [
            { id: "acct-gmail", provider: "gmail", label: "Gmail", email: "owner@gmail.test", purpose: "General / Signup / Noise Catcher" },
            { id: "acct-hotmail", provider: "microsoft", label: "Hotmail", email: "owner@hotmail.test", purpose: "Professional / Personal / Submissions" },
          ],
          workspaces: [gmailWorkspace, hotmailWorkspace, allWorkspace],
          categories: [],
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a workspace-scoped local new-email draft and links to Outbox", async () => {
    const openOutbox = vi.fn();
    render(
      <DraftsView
        workspaceId="workspace:microsoft"
        workspace={hotmailWorkspace}
        onOpenMessage={vi.fn()}
        onOpenOutbox={openOutbox}
      />,
    );

    await screen.findByText("No drafts here");
    fireEvent.click(screen.getByRole("button", { name: "New email draft" }));

    expect(await screen.findByRole("heading", { name: "Draft a new email" })).toBeInTheDocument();
    expect(screen.getByLabelText("Sending account")).toHaveValue("acct-hotmail");
    expect(screen.queryByText(/owner@gmail.test/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "Taylor <Taylor@Example.test>" } });
    fireEvent.change(screen.getByLabelText("Cc"), { target: { value: "copy@example.test" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Interview availability" } });
    fireEvent.change(screen.getByLabelText("Message body"), {
      target: { value: "Hi Taylor,\n\nFriday morning works for me." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save to Outbox/ }));

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]).toMatchObject({
      action: "new_email_create",
      accountId: "acct-hotmail",
      to: [{ name: "Taylor", email: "Taylor@Example.test" }],
      cc: [{ email: "copy@example.test" }],
      bcc: [],
      subject: "Interview availability",
      body: "Hi Taylor,\n\nFriday morning works for me.",
    });
    expect(await screen.findByText("New email draft saved to Outbox for exact review.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Outbox" }));
    expect(openOutbox).toHaveBeenCalledWith("outdraft-1");
  });

  it("keeps unsaved reply text and reports a server conflict during refresh", async () => {
    let serverVersion = 1;
    const serverDraft = () => ({
      id: "reply-1",
      messageId: "mail-1",
      subject: "Reply subject",
      senderName: "Taylor",
      senderEmail: "taylor@example.test",
      content: serverVersion === 1 ? "Server draft one" : "Server draft two",
      version: serverVersion,
      status: "draft" as const,
      approvalStatus: null,
      approvalExpiresAt: null,
      updatedAt: `2026-07-03T12:0${serverVersion}:00.000Z`,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/drafts") return jsonResponse([serverDraft()]);
      if (url === "/api/mail/meta") return jsonResponse({ accounts: [], workspaces: [], categories: [] });
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<DraftsView workspaceId="workspace:gmail" workspace={gmailWorkspace} onOpenMessage={vi.fn()} />);
    const editor = await screen.findByLabelText("Exact reply text");
    await waitFor(() => expect(editor).toHaveValue("Server draft one"));
    fireEvent.change(editor, { target: { value: "My unsaved reply" } });
    serverVersion = 2;
    await act(async () => {
      window.dispatchEvent(new Event("ezra:refresh"));
    });

    expect(await screen.findByText("The server copy changed while you were editing.")).toBeInTheDocument();
    expect(screen.getByLabelText("Exact reply text")).toHaveValue("My unsaved reply");
  });
});

const gmailWorkspace: MailWorkspace = {
  id: "workspace:gmail",
  label: "Gmail",
  purpose: "General / Signup / Noise Catcher",
  accountIds: ["acct-gmail"],
  isAllAccounts: false,
  calendarRole: "none",
  provider: "gmail",
};

const hotmailWorkspace: MailWorkspace = {
  id: "workspace:microsoft",
  label: "Hotmail",
  purpose: "Professional / Personal / Submissions",
  accountIds: ["acct-hotmail"],
  isAllAccounts: false,
  calendarRole: "primary_future",
  provider: "microsoft",
};

const allWorkspace: MailWorkspace = {
  id: "workspace:all",
  label: "All accounts",
  purpose: "Explicit blend",
  accountIds: ["acct-gmail", "acct-hotmail"],
  isAllAccounts: true,
  calendarRole: "none",
  provider: "all",
};

function jsonResponse<T>(payload: T, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
}
