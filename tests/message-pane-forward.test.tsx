import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EzraMailApp } from "@/components/ezra/EzraMailApp";
import { MessagePane } from "@/components/ezra/MessagePane";
import type { MailActionResult, MessageDetail, OutgoingDraft } from "@/lib/email/types";

describe("real shell and mail exact navigation", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); history.replaceState(null, "", "/"); });
  it("retains incoming same-ID target across provider workspace mounts without fallback mail reads", async () => {
    localStorage.setItem("ezra-mail-workspace", "workspace:all");
    const workspaces = ["gmail", "microsoft"].map((provider) => ({ id: `workspace:account:${provider}:${provider === "gmail" ? "acct-gmail" : "acct-hotmail"}`, provider, accountIds: [provider === "gmail" ? "acct-gmail" : "acct-hotmail"], label: provider, purpose: "Synthetic", isAllAccounts: false, calendarRole: "none" }));
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session") return jsonResponse({ authenticated: true, configured: true, developmentBypass: false, expiresAt: null });
      if (url === "/api/mail/meta") return jsonResponse({ workspaces, accounts: workspaces.map((entry) => ({ id: entry.accountIds[0], provider: entry.provider, label: entry.label, email: "synthetic@example.test" })), categories: [] });
      if (url === "/api/accounts") return jsonResponse({ items: workspaces.map((entry) => ({ accountId: entry.accountIds[0], accountProvider: entry.provider, status: "connected" })) });
      if (url.startsWith("/api/views")) return jsonResponse({ items: [] });
      if (url.startsWith("/api/settings/")) return jsonResponse({ remoteImagesAllowed: false });
      if (url.startsWith("/api/mail?")) { reads.push(new URL(url, "https://synthetic.test").searchParams.get("workspaceId")!); return jsonResponse({ items: [], nextCursor: null, total: 0 }); }
      if (url === "/api/mail/mail-forward") {
        const provider = location.search.includes("microsoft") ? "microsoft" : "gmail";
        return jsonResponse({ detail: messageDetail(provider), thread: [], capabilities: { unsubscribeSupported: false, protectedMessage: false } });
      }
      return jsonResponse(null);
    }));
    history.replaceState(null, "", "/?view=mail&workspace=workspace%3Aaccount%3Agmail%3Aacct-gmail&message=mail-forward");
    render(<EzraMailApp />);
    await screen.findByRole("heading", { name: "Target Application Follow Up" });
    await act(async () => { history.pushState({ ezraIndex: 1 }, "", "/?view=mail&workspace=workspace%3Aaccount%3Amicrosoft%3Aacct-hotmail&message=mail-forward"); dispatchEvent(new PopStateEvent("popstate", { state: { ezraIndex: 1 } })); });
    await screen.findByRole("heading", { name: "Target Application Follow Up" });
    expect(location.search).toContain("message=mail-forward");
    expect(location.search).toContain("microsoft");
    expect(reads).toContain("workspace:account:gmail:acct-gmail");
    expect(reads).toContain("workspace:account:microsoft:acct-hotmail");
    expect(reads).not.toContain("workspace:all");
  });
});

describe("MessagePane exact account routing", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it.each(["account", "provider", "message"])("rejects a mismatched %s response before showing mail", async (dimension) => {
    const detail = messageDetail("microsoft");
    if (dimension === "account") detail.message.accountId = "other-account";
    if (dimension === "provider") detail.message.accountProvider = "gmail";
    if (dimension === "message") detail.message.id = "other-message";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail, thread: [], capabilities: { unsubscribeSupported: false, protectedMessage: false } })));
    render(<MessagePane messageId="mail-forward" workspaceId="workspace:account:microsoft:acct-hotmail" onClose={vi.fn()} onRequestAction={vi.fn()} />);
    await screen.findByText("Conversation unavailable");
    expect(screen.queryByRole("heading", { name: "Target Application Follow Up" })).not.toBeInTheDocument();
  });
  it("discards a delayed old-workspace response for the same message-like ID", async () => {
    let resolve!: (response: Response) => void; let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/settings/")) return jsonResponse({ remoteImagesAllowed: false });
      if (++reads === 1) return new Promise<Response>((done) => { resolve = done; });
      return jsonResponse({ detail: messageDetail("gmail"), thread: [], capabilities: { unsubscribeSupported: false, protectedMessage: false } });
    }));
    const ui = render(<MessagePane messageId="mail-forward" workspaceId="workspace:account:microsoft:acct-hotmail" onClose={vi.fn()} onRequestAction={vi.fn()} />);
    await waitFor(() => expect(resolve).toBeDefined());
    ui.rerender(<MessagePane messageId="mail-forward" workspaceId="workspace:account:gmail:acct-gmail" onClose={vi.fn()} onRequestAction={vi.fn()} />);
    await screen.findByRole("heading", { name: "Target Application Follow Up" });
    await act(async () => resolve(await jsonResponse({ detail: messageDetail("microsoft"), thread: [], capabilities: { unsubscribeSupported: false, protectedMessage: false } })));
    expect(screen.queryByText(/Hotmail/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Target Application Follow Up" })).toBeInTheDocument();
  });
});

describe("MessagePane obsolete action reloads", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(["message", "workspace", "unmount"])("does not replace the current request after %s changes during an action", async (change) => {
    let completeAction!: (result: MailActionResult) => void;
    let completeCurrentRead!: (response: Response) => void;
    const readerRequests: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
    const firstDetail = messageDetail("microsoft");
    const currentDetail = messageDetail(change === "workspace" ? "gmail" : "microsoft");
    currentDetail.message.id = change === "message" ? "mail-current" : "mail-forward";
    currentDetail.message.subject = "Current selection remains readable";
    const payload = (detail: MessageDetail) => ({
      detail, thread: [], capabilities: {
        unsubscribeSupported: false, protectedMessage: false,
        organization: { pin: { state: "unavailable", reason: "Not supported" }, flag: { state: "supported", mapping: "microsoft_follow_up" } },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/settings/")) return jsonResponse({ remoteImagesAllowed: false });
      readerRequests.push({ url, signal: init?.signal });
      if (readerRequests.length === 1) return jsonResponse(payload(firstDetail));
      if (readerRequests.length === 2 && change !== "unmount") return new Promise<Response>((resolve) => { completeCurrentRead = resolve; });
      return jsonResponse(payload(firstDetail));
    }));
    const requestAction = vi.fn(() => new Promise<MailActionResult>((resolve) => { completeAction = resolve; }));
    const pane = render(<MessagePane messageId="mail-forward" workspaceId="workspace:account:microsoft:acct-hotmail" onClose={vi.fn()} onRequestAction={requestAction} />);
    fireEvent.click(await screen.findByRole("button", { name: "Flag" }));
    await waitFor(() => expect(completeAction).toBeDefined());
    if (change === "unmount") pane.unmount();
    else {
      pane.rerender(<MessagePane messageId={currentDetail.message.id} workspaceId={change === "workspace" ? "workspace:account:gmail:acct-gmail" : "workspace:account:microsoft:acct-hotmail"} onClose={vi.fn()} onRequestAction={requestAction} />);
      await waitFor(() => expect(completeCurrentRead).toBeDefined());
    }
    await act(async () => completeAction({ actionId: "old-flag", action: "flag", successCount: 1, failureCount: 0, reversible: true, failures: [], changedIds: ["mail-forward"] }));
    expect(readerRequests).toHaveLength(change === "unmount" ? 1 : 2);
    if (change !== "unmount") {
      expect(readerRequests[1].signal?.aborted).toBe(false);
      await act(async () => completeCurrentRead(await jsonResponse(payload(currentDetail))));
      expect(await screen.findByRole("heading", { name: "Current selection remains readable" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Flag" })).toBeEnabled();
    }
  });
});

describe("MessagePane forward flow", () => {
  const posts: Array<Record<string, unknown>> = [];
  let detailProvider: "gmail" | "microsoft" = "microsoft";
  let includePreviewAttachment = false;
  let detailPinned = false;
  let detailFlagged = false;
  let organizationNeedsReconnect = false;

  beforeEach(() => {
    posts.length = 0;
    detailProvider = "microsoft";
    includePreviewAttachment = false;
    detailPinned = false;
    detailFlagged = false;
    organizationNeedsReconnect = false;
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/mail/mail-forward") {
        return jsonResponse({
          detail: messageDetail(detailProvider, includePreviewAttachment, detailPinned, detailFlagged),
          thread: [],
          capabilities: {
            unsubscribeSupported: false,
            protectedMessage: false,
            organization: detailProvider === "gmail" && organizationNeedsReconnect
              ? {
                pin: { state: "reconnect_required", reason: "Reconnect Gmail from Settings with maintenance access." },
                flag: { state: "reconnect_required", reason: "Reconnect Gmail from Settings with maintenance access." },
              }
              : detailProvider === "gmail"
              ? {
                pin: { state: "supported", mapping: "gmail_star" },
                flag: { state: "supported", mapping: "gmail_important" },
              }
              : {
                pin: { state: "unavailable", reason: "Ezra cannot safely map Pin for this Microsoft account yet." },
                flag: { state: "supported", mapping: "microsoft_follow_up" },
              },
          },
        });
      }
      if (url === "/api/mail/mail-forward/attachments/preview-file/preview") {
        return new Response("%PDF-1.7\nSafe preview", {
          headers: { "content-type": "application/pdf" },
        });
      }
      if (url === "/api/drafts") {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        posts.push(body);
        if (body.action === "prepare_reply") {
          return jsonResponse({
            messageId: "mail-forward",
            content: "Prepared reply.",
            contactMemorySummary: "First message from this contact.",
            appliedContext: [],
            replyMode: body.replyMode,
            accountId: "acct-hotmail",
            accountLabel: "Hotmail",
            accountEmail: "owner@hotmail.test",
            accountProvider: "microsoft",
            to: [{ email: "jennifer.ortiz@target.com", name: "Jennifer Ortiz" }],
            cc: body.replyMode === "all" ? [{ email: "recruiter@example.test", name: null }] : [],
            bcc: [],
          });
        }
        if (body.action === "polish_reply") {
          return jsonResponse({
            original: body.body,
            proposed: "Hi Jennifer,\n\nI can pay $200 by August 14.",
            mode: body.mode,
            appliedContext: [`Mode: ${String(body.mode)}`],
            preservationChecks: [{ category: "amount", value: "$250", preserved: false }],
            factualChangesDetected: true,
            warnings: ["The proposed version may have changed or removed amount \u201c$250\u201d."],
          });
        }
        return jsonResponse<OutgoingDraft>({
          id: body.action === "create_reply_outgoing" ? "outdraft-reply" : "outdraft-forward",
          sourceType: body.action === "create_reply_outgoing" ? "reply" : "forward",
          sourceMessageId: String(body.messageId),
          replyMode: body.action === "create_reply_outgoing" ? String(body.replyMode) as "sender" | "all" : null,
          accountId: "acct-hotmail",
          accountLabel: "Hotmail",
          accountEmail: "owner@hotmail.test",
          accountProvider: "microsoft",
          fromEmail: "owner@hotmail.test",
          to: [{ email: "mentor@example.test", name: null }],
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
      return jsonResponse({ error: "not found" }, 404);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves an exact local forward draft and links to Outbox", async () => {
    const openOutbox = vi.fn();
    render(
      <MessagePane
        messageId="mail-forward"
        onClose={vi.fn()}
        onOpenOutbox={openOutbox}
        onRequestAction={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Target Application Follow Up" });
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));

    expect(await screen.findAllByRole("heading", { name: "Target Application Follow Up" })).toHaveLength(2);
    expect(screen.getByRole("textbox", { name: /^Subject$/ })).toHaveValue("Fwd: Target Application Follow Up");
    const forwardBody = screen.getByRole("textbox", { name: /^Forward body$/ }) as HTMLTextAreaElement;
    expect(forwardBody.value).toContain("---------- Forwarded message ----------");
    expect(forwardBody.value).toContain("Please schedule your interview.");

    fireEvent.change(screen.getByRole("textbox", { name: /^To$/ }), { target: { value: "mentor@example.test" } });
    fireEvent.change(screen.getByRole("textbox", { name: /^Cc$/ }), { target: { value: "copy@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: /Save to Outbox/ }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      action: "forward_create",
      messageId: "mail-forward",
      to: [{ email: "mentor@example.test" }],
      cc: [{ email: "copy@example.test" }],
      bcc: [],
      subject: "Fwd: Target Application Follow Up",
    });
    expect(String(posts[0].body)).toContain("Please schedule your interview.");
    expect(await screen.findByText("Saved to Outbox")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Outbox" }));
    expect(openOutbox).toHaveBeenCalledWith("outdraft-forward");
  });

  it("prepares Reply all for Hotmail and saves it directly to Outbox", async () => {
    const openOutbox = vi.fn();
    render(
      <MessagePane
        messageId="mail-forward"
        onClose={vi.fn()}
        onOpenOutbox={openOutbox}
        onRequestAction={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Target Application Follow Up" });
    expect(screen.queryByRole("heading", { name: "Reply Studio" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reply all" }));
    expect(await screen.findByRole("heading", { name: "Reply Studio" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Draft for me" })).toHaveFocus());
    expect(screen.getByText("Reply all from Hotmail")).toBeInTheDocument();
    expect(screen.getByText("owner@hotmail.test")).toBeInTheDocument();
    expect(screen.getByText("recruiter@example.test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Draft for me" }));
    expect(screen.getByRole("textbox", { name: "Reply draft" })).toHaveValue("Prepared reply.");
    fireEvent.change(screen.getByRole("textbox", { name: "Reply draft" }), { target: { value: "Reviewed exact reply." } });
    expect(screen.queryByRole("button", { name: /^Send$/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save to Outbox" }));

    await screen.findByText("Saved to Outbox");
    expect(posts.at(-1)).toMatchObject({
      action: "create_reply_outgoing",
      messageId: "mail-forward",
      replyMode: "all",
      body: "Reviewed exact reply.",
    });
    expect(openOutbox).toHaveBeenCalledWith("outdraft-reply");
  });

  it("keeps a local reply when the inline studio is collapsed and reopened", async () => {
    render(
      <MessagePane
        messageId="mail-forward"
        onClose={vi.fn()}
        onOpenOutbox={vi.fn()}
        onRequestAction={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Target Application Follow Up" });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await screen.findByRole("heading", { name: "Reply Studio" });
    fireEvent.click(screen.getByRole("button", { name: "I'll write" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reply draft" }), { target: { value: "Keep this local draft." } });
    fireEvent.click(screen.getByRole("button", { name: "Close Reply Studio" }));

    expect(screen.queryByRole("heading", { name: "Reply Studio" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await screen.findByRole("heading", { name: "Reply Studio" });
    expect(screen.getByRole("textbox", { name: "Reply draft" })).toHaveValue("Keep this local draft.");
    expect(screen.getByText("Recovered local draft")).toBeInTheDocument();
  });

  it("requires factual-warning review before using a polished version", async () => {
    render(
      <MessagePane
        messageId="mail-forward"
        onClose={vi.fn()}
        onOpenOutbox={vi.fn()}
        onRequestAction={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Target Application Follow Up" });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await screen.findByRole("heading", { name: "Reply Studio" });
    fireEvent.click(screen.getByRole("button", { name: "I'll write" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reply draft" }), {
      target: { value: "Hi Jennifer,\n\nI will pay $250 by August 12." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Compare polish" }));

    expect(await screen.findByText(/changed or removed amount/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use polished version" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed the factual differences/i }));
    expect(screen.getByRole("button", { name: "Use polished version" })).toBeEnabled();
  });

  it("shows account-scoped Pin and Flag controls while explaining an unavailable mapping", async () => {
    detailProvider = "gmail";
    const requestAction = vi.fn(async () => ({
      actionId: "pin-action",
      action: "pin" as const,
      successCount: 1,
      failureCount: 0,
      reversible: true,
      failures: [],
    }));
    const rendered = render(
      <MessagePane messageId="mail-forward" onClose={vi.fn()} onRequestAction={requestAction} />,
    );

    await screen.findByRole("heading", { name: "Target Application Follow Up" });
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(requestAction).toHaveBeenCalledWith("pin", ["mail-forward"], undefined));
    fireEvent.click(screen.getByRole("button", { name: "Flag" }));
    await waitFor(() => expect(requestAction).toHaveBeenCalledWith("flag", ["mail-forward"], undefined));

    detailProvider = "microsoft";
    rendered.unmount();
    render(<MessagePane messageId="mail-forward" onClose={vi.fn()} onRequestAction={requestAction} />);
    expect(await screen.findByText(/Pin is unavailable for this Microsoft account/i)).toBeVisible();
  });

  it("refreshes the open reader after each provider organization transition", async () => {
    detailProvider = "gmail";
    const requestAction = vi.fn(async (action: string): Promise<MailActionResult> => {
      if (action === "pin") detailPinned = true;
      if (action === "unpin") detailPinned = false;
      if (action === "flag") detailFlagged = true;
      if (action === "unflag") detailFlagged = false;
      return {
        actionId: `action-${action}`,
        action: action as MailActionResult["action"],
        successCount: 1,
        failureCount: 0,
        reversible: true,
        failures: [],
        changedIds: ["mail-forward"],
      };
    });
    render(<MessagePane messageId="mail-forward" onClose={vi.fn()} onRequestAction={requestAction} />);

    fireEvent.click(await screen.findByRole("button", { name: "Pin" }));
    expect(await screen.findByRole("button", { name: "Unpin" })).toBeVisible();
    expect(screen.getByText("Pinned")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Unpin" }));
    expect(await screen.findByRole("button", { name: "Pin" })).toBeVisible();
    await waitFor(() => expect(screen.queryByText("Pinned")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Flag" }));
    expect(await screen.findByRole("button", { name: "Unflag" })).toBeVisible();
    expect(screen.getByText("Flagged")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Unflag" }));
    expect(await screen.findByRole("button", { name: "Flag" })).toBeVisible();
    await waitFor(() => expect(screen.queryByText("Flagged")).not.toBeInTheDocument());
  });

  it("refreshes the open reader when a row action advances its refresh token", async () => {
    detailProvider = "gmail";
    const rendered = render(
      <MessagePane messageId="mail-forward" refreshToken={0} onClose={vi.fn()} onRequestAction={vi.fn()} />,
    );
    await screen.findByRole("button", { name: "Pin" });

    detailPinned = true;
    rendered.rerender(
      <MessagePane messageId="mail-forward" refreshToken={1} onClose={vi.fn()} onRequestAction={vi.fn()} />,
    );

    expect(await screen.findByRole("button", { name: "Unpin" })).toBeVisible();
    expect(screen.getByText("Pinned")).toBeVisible();
  });

  it("does not duplicate an organization refresh when the parent advances the refresh token", async () => {
    detailProvider = "gmail";
    let rendered: ReturnType<typeof render>;
    const requestAction = vi.fn(async (action: string): Promise<MailActionResult> => {
      detailPinned = action === "pin";
      rendered.rerender(
        <MessagePane messageId="mail-forward" refreshToken={1} onClose={vi.fn()} onRequestAction={requestAction} />,
      );
      return {
        actionId: `action-${action}`,
        action: action as MailActionResult["action"],
        successCount: 1,
        failureCount: 0,
        reversible: true,
        failures: [],
        changedIds: ["mail-forward"],
      };
    });
    rendered = render(
      <MessagePane messageId="mail-forward" refreshToken={0} onClose={vi.fn()} onRequestAction={requestAction} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pin" }));
    expect(await screen.findByRole("button", { name: "Unpin" })).toBeVisible();
    const detailRequests = vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/mail/mail-forward");
    expect(detailRequests).toHaveLength(2);
    expect(screen.queryByText(/abort/i)).not.toBeInTheDocument();
  });

  it("distinguishes reconnect-required organization actions from unavailable mappings", async () => {
    detailProvider = "gmail";
    organizationNeedsReconnect = true;
    render(<MessagePane messageId="mail-forward" onClose={vi.fn()} onRequestAction={vi.fn()} />);

    expect(await screen.findByText(/Reconnect Gmail to use Pin/i)).toBeVisible();
    expect(screen.getByText(/Reconnect Gmail to use Flag/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Pin" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Flag" })).not.toBeInTheDocument();
  });

  it("keeps downloads available and creates a sandboxed PDF preview only after an explicit click", async () => {
    includePreviewAttachment = true;
    const createObjectURL = vi.fn(() => "blob:ezra-preview");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    render(<MessagePane messageId="mail-forward" onClose={vi.fn()} onRequestAction={vi.fn()} />);

    await screen.findByRole("heading", { name: "Attachments" });
    expect(screen.getByRole("button", { name: /report\.pdf.*Download/i })).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview report.pdf" })).toBeVisible();
    expect(screen.queryByTitle("Attachment preview")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview report.pdf" }));

    const preview = await screen.findByTitle("Attachment preview");
    expect(preview).toHaveAttribute("sandbox", "");
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("lets a keyboard user explicitly request an attachment preview", async () => {
    includePreviewAttachment = true;
    const createObjectURL = vi.fn(() => "blob:ezra-preview");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    render(<MessagePane messageId="mail-forward" onClose={vi.fn()} onRequestAction={vi.fn()} />);

    const preview = await screen.findByRole("button", { name: "Preview report.pdf" });
    preview.focus();
    fireEvent.keyDown(preview, { key: "Enter" });

    expect(await screen.findByTitle("Attachment preview")).toBeVisible();
  });

  it("shows safe attachment context before an explicit preview request", async () => {
    includePreviewAttachment = true;
    detailProvider = "gmail";
    render(<MessagePane messageId="mail-forward" onClose={vi.fn()} onRequestAction={vi.fn()} />);

    await screen.findByRole("heading", { name: "Attachments" });

    expect(screen.getByText("report.pdf")).toBeVisible();
    expect(screen.getByText("Provider-reported type")).toBeVisible();
    expect(screen.getByText("application/pdf")).toBeVisible();
    expect(screen.getByText("Verified type")).toBeVisible();
    expect(screen.getByText("Ezra checks the file only after you choose Preview.")).toBeVisible();
    expect(screen.getByText("Source")).toBeVisible();
    expect(screen.getByText("Gmail account Gmail · Target Application Follow Up")).toBeVisible();
    expect(screen.getByText("Download remains available; preview never opens the file automatically.")).toBeVisible();
  });
});

function messageDetail(
  provider: "gmail" | "microsoft" = "microsoft",
  includeAttachment = false,
  isPinned = false,
  isFlagged = false,
): MessageDetail {
  return {
    message: {
      id: "mail-forward",
      accountId: provider === "gmail" ? "acct-gmail" : "acct-hotmail",
      accountLabel: provider === "gmail" ? "Gmail" : "Hotmail",
      accountProvider: provider,
      externalMessageId: "external-forward",
      threadId: "thread-forward",
      senderName: "Jennifer Ortiz",
      senderEmail: "jennifer.ortiz@target.com",
      subject: "Target Application Follow Up",
      receivedAt: "2026-07-03T12:00:00.000Z",
      snippet: "Please schedule your interview.",
      gmailUrl: "#",
      hasAttachments: false,
      isUnread: false,
      isPinned,
      isFlagged,
      mailboxLabels: ["INBOX"],
      status: "triaged",
      attention: "interrupt",
      urgency: 94,
      confidence: 0.92,
      category: "job application",
      summary: "Recruiter follow-up.",
      reason: "Requires scheduling.",
      recommendation: "Schedule the interview.",
      needsReply: false,
      deadline: null,
      injectionFlags: [],
      model: "mock",
      notifiedAt: null,
    },
    bodyText: "Hi Eric,\n\nPlease schedule your interview.",
    bodyIsExcerpt: false,
    attachments: includeAttachment
      ? [{ id: "preview-file", name: "report.pdf", mimeType: "application/pdf", size: 24 }]
      : [],
    contactMemory: {
      summary: "First message from this contact.",
      messageCount: 1,
      firstSeenAt: "2026-07-03T12:00:00.000Z",
      lastSeenAt: "2026-07-03T12:00:00.000Z",
      categories: [],
    },
  };
}

function jsonResponse<T>(payload: T, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
}
