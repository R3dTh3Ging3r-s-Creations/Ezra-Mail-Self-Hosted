import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef } from "react";
import { EzraMailApp } from "@/components/ezra/EzraMailApp";
const mailRenders: Array<{ workspaceId: string; initialMessageId: string | null }> = [];
vi.mock("@/components/ezra/MailView", () => ({
  MailView: (props: { workspaceId: string; initialMessageId: string | null; onSelectWorkspace: (id: string) => void; onSelectedMessage: (id: string | null) => void }) => {
    const previous = useRef(props.workspaceId);
    useEffect(() => {
      if (previous.current !== props.workspaceId) props.onSelectedMessage(null);
      previous.current = props.workspaceId;
    }, [props.workspaceId]);
    mailRenders.push(props);
    return <div><p>Opened {props.workspaceId} / {props.initialMessageId}</p><button onClick={() => props.onSelectWorkspace("workspace:account:gmail:gmail-1")}>Switch test workspace</button><button onClick={() => props.onSelectedMessage("ordinary-message")}>Select ordinary message</button></div>;
  }
}));
vi.mock("@/components/ezra/TodayView", () => ({ TodayView: () => <p>Today content</p> }));
const workspaces = [{ id: "workspace:gmail", provider: "gmail", accountIds: ["gmail-1"], isAllAccounts: false, label: "Gmail", purpose: "", calendarRole: "work" }, { id: "workspace:account:gmail:gmail-1", provider: "gmail", accountIds: ["gmail-1"], isAllAccounts: false, label: "Gmail one", purpose: "", calendarRole: "work" }, { id: "workspace:account:microsoft:ms-1", provider: "microsoft", accountIds: ["ms-1"], isAllAccounts: false, label: "Microsoft one", purpose: "", calendarRole: "work" }];
function setup(disconnected = false) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/auth/session" ? { authenticated: true, configured: true, developmentBypass: false, expiresAt: null } : url === "/api/mail/meta" ? { workspaces } : url === "/api/accounts" ? { items: [{ accountId: "gmail-1", accountProvider: "gmail", status: "connected" }, { accountId: "ms-1", accountProvider: "microsoft", status: disconnected ? "disabled" : "connected" }] } : null), { status: 200 })));
}
const href = (provider: string, account: string) => `/?view=mail&workspace=workspace%3Aaccount%3A${provider}%3A${account}&message=same-id`;
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("ezra-mail-workspace", "workspace:gmail");
  mailRenders.length = 0;
  setup();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("exact notification URL routing", () => {
  it("retains account identity with ordinary filters on reload", async () => {
    history.replaceState(null, "", href("microsoft", "ms-1") + "&drill=1&folder=inbox&unread=true");
    render(<EzraMailApp />);
    await screen.findByText("Opened workspace:account:microsoft:ms-1 / same-id");
    expect(location.search).toContain("folder=inbox");
    expect(mailRenders.every((entry) => entry.workspaceId === "workspace:account:microsoft:ms-1")).toBe(true);
  });
  it.each(["&message=other", "&workspace=workspace%3Aaccount%3Agmail%3Agmail-1", "&unexpected=value", "&q=%ZZ"])("rejects malformed or ambiguous exact core %s", async (suffix) => {
    history.replaceState(null, "", href("microsoft", "ms-1") + suffix);
    render(<EzraMailApp />);
    await screen.findByText(/This notification target is unavailable/i);
    expect(mailRenders).toHaveLength(0);
  });
  it("honors URL account before any mail render and on reload", async () => {
    history.replaceState(null, "", href("microsoft", "ms-1"));
    const ui = render(<EzraMailApp />);
    await screen.findByText("Opened workspace:account:microsoft:ms-1 / same-id");
    expect(mailRenders.every((item) => item.workspaceId === "workspace:account:microsoft:ms-1")).toBe(true);
    ui.unmount();
    localStorage.setItem("ezra-mail-workspace", "workspace:gmail");
    mailRenders.length = 0;
    render(<EzraMailApp />);
    await screen.findByText("Opened workspace:account:microsoft:ms-1 / same-id");
    expect(mailRenders.every((item) => item.workspaceId === "workspace:account:microsoft:ms-1")).toBe(true);
  });
  it("restores exact account and same-looking message on popstate", async () => {
    history.replaceState(null, "", href("gmail", "gmail-1"));
    render(<EzraMailApp />);
    await screen.findByText("Opened workspace:account:gmail:gmail-1 / same-id");
    await act(async () => {
      history.pushState({ ezraIndex: 1 }, "", href("microsoft", "ms-1"));
      dispatchEvent(new PopStateEvent("popstate", { state: { ezraIndex: 1 } }));
    });
    await screen.findByText("Opened workspace:account:microsoft:ms-1 / same-id");
  });
  it.each(["missing", "disconnected", "malformed"])("blocks %s target without fallback mail fetch", async (mode) => {
    if (mode === "disconnected") setup(true);
    history.replaceState(null, "", mode === "malformed" ? "/?view=mail&workspace=workspace%3Agmail&message=same-id" : href("microsoft", mode === "missing" ? "gone" : "ms-1"));
    render(<EzraMailApp />);
    expect(await screen.findByText(/This notification target is unavailable/i)).toBeInTheDocument();
    expect(mailRenders).toHaveLength(0);
  });
  it("manual workspace switch clears stale exact target from URL and respects draft guard", async () => {
    history.replaceState(null, "", href("microsoft", "ms-1"));
    render(<EzraMailApp />);
    await screen.findByText("Opened workspace:account:microsoft:ms-1 / same-id");
    const guard = (event: Event) => event.preventDefault();
    window.addEventListener("ezra:before-navigate", guard);
    fireEvent.click(screen.getByRole("button", { name: "Switch test workspace" }));
    expect(location.search).toContain("ms-1");
    window.removeEventListener("ezra:before-navigate", guard);
    fireEvent.click(screen.getByRole("button", { name: "Switch test workspace" }));
    await waitFor(() => expect(location.search).not.toContain("message="));
    expect(location.search).not.toContain("ms-1");
  });
});

it("preserves ordinary filtered selection through reload and back despite conflicting stored workspace", async () => {
  localStorage.setItem("ezra-mail-workspace", "workspace:account:microsoft:ms-1");
  history.replaceState(null, "", "/?view=mail&drill=1&folder=inbox&unread=true");
  const first = render(<EzraMailApp />);
  await screen.findByText("Opened workspace:account:microsoft:ms-1 /");
  fireEvent.click(screen.getByRole("button", { name: "Select ordinary message" }));
  await waitFor(() => expect(location.search).toContain("message=ordinary-message"));
  expect(location.search).toContain("folder=inbox");
  expect(location.search).toContain("unread=true");
  const selected = location.href;
  first.unmount();
  localStorage.setItem("ezra-mail-workspace", "workspace:gmail");
  mailRenders.length = 0;
  render(<EzraMailApp />);
  await screen.findByText("Opened workspace:account:microsoft:ms-1 / ordinary-message");
  expect(mailRenders.every(item => item.workspaceId === "workspace:account:microsoft:ms-1")).toBe(true);
  fireEvent.click(screen.getAllByRole("button", { name: "Today" })[0]);
  await screen.findByText("Today content");
  await act(async () => {
    history.back();
  });
  await screen.findByText("Opened workspace:account:microsoft:ms-1 / ordinary-message");
  expect(location.href).toBe(selected);
});
