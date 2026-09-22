import { describe, expect, it, vi } from "vitest";

const gog = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: gog.spawn,
    default: { ...actual, spawn: gog.spawn },
  };
});
import {
  gmailAuthorizationCapabilitiesFromAuthList,
  parseUnsubscribeMetadata,
  unwrapGogMetadata,
  searchGmailSentEvidence,
} from "../src/lib/email/gmail";

describe("Gmail metadata", () => {
  it("reads only capped in-window Sent evidence and strips provider content", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: index === 1 ? undefined : index === 0 ? "sent-1" : `sent-${index}`,
      threadId: index === 2 ? undefined : index === 0 ? "thread-1" : `thread-${index}`,
      internalDate: index === 0 ? "1788099000000" : index === 4 ? "1788102001000" : "invalid",
      subject: "Never retain this subject",
      snippet: "Never retain this snippet",
    }));
    gog.spawn.mockImplementation(() => fakeGog(JSON.stringify({ messages: rows, nextPageToken: "must-not-follow" })));

    const page = await searchGmailSentEvidence("owner@gmail.test", "gmail-1", {
      after: "2026-08-29T14:00:00.000Z",
      before: "2026-08-30T15:00:00.000Z",
      maxResults: 500,
    });

    expect(gog.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        "--enable-commands-exact", "gmail.messages.search", "gmail", "messages", "search",
        expect.stringContaining("in:sent"), "--account", "owner@gmail.test", "--max", "100",
        "--wrap-untrusted", "--json", "--no-input",
      ]),
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
    expect(gog.spawn.mock.calls[0][1]).not.toContain("--page");
    expect(gog.spawn).toHaveBeenCalledOnce();
    expect(gog.spawn.mock.calls[0][1]).toContain("in:sent after:1788011999 before:1788102001");
    expect(gog.spawn.mock.calls[0][1].join(" ")).not.toMatch(/\d{4}\/\d{2}\/\d{2}/);
    expect(page).toEqual({
      items: [{
        accountId: "gmail-1", provider: "gmail", providerMessageId: "sent-1", providerThreadId: "thread-1",
        sentAt: "2026-08-30T14:10:00.000Z",
      }],
      truncated: true,
    });
    expect(JSON.stringify(page.items[0])).not.toMatch(/subject|snippet|recipient|body|header|attachment/i);
  });

  it("encodes strict integer Gmail bounds inclusively without missing exact endpoints", async () => {
    gog.spawn.mockClear();
    gog.spawn.mockImplementation(() => fakeGog(JSON.stringify({ messages: [
      { id: "at-after", threadId: "thread-1", internalDate: "1788099000000", subject: "never retain" },
      { id: "at-before", threadId: "thread-1", internalDate: "1788099060000" },
      { id: "offset", threadId: "thread-2", sentDateTime: "2026-08-30T09:10:30-05:00", snippet: "never retain" },
      { id: "outside", threadId: "thread-2", sentDateTime: "2026-08-30T09:11:01-05:00" },
    ] })));

    const page = await searchGmailSentEvidence("owner@gmail.test", "gmail-1", {
      after: "2026-08-30T14:10:00.000Z",
      before: "2026-08-30T14:11:00.000Z",
      maxResults: 10,
    });

    expect(gog.spawn.mock.calls[0][1]).toContain("in:sent after:1788098999 before:1788099061");
    expect(page.items).toEqual([
      { accountId: "gmail-1", provider: "gmail", providerMessageId: "at-after", providerThreadId: "thread-1", sentAt: "2026-08-30T14:10:00.000Z" },
      { accountId: "gmail-1", provider: "gmail", providerMessageId: "at-before", providerThreadId: "thread-1", sentAt: "2026-08-30T14:11:00.000Z" },
      { accountId: "gmail-1", provider: "gmail", providerMessageId: "offset", providerThreadId: "thread-2", sentAt: "2026-08-30T14:10:30.000Z" },
    ]);
    expect(JSON.stringify(page.items)).not.toMatch(/subject|snippet|recipient|body|header|attachment/i);
  });

  it("rejects a fractional fourteen-day window when inclusive Gmail encoding exceeds the cap", async () => {
    gog.spawn.mockClear();
    await expect(searchGmailSentEvidence("owner@gmail.test", "gmail-1", {
      after: "2026-08-16T14:00:00.001Z",
      before: "2026-08-30T14:00:00.000Z",
      maxResults: 1,
    })).rejects.toThrow(/Sent evidence/i);
    expect(gog.spawn).not.toHaveBeenCalled();
  });

  it("keeps raw malformed Gmail slots conservative and skips invalid epoch values", async () => {
    gog.spawn.mockClear();
    gog.spawn.mockImplementation(() => fakeGog(JSON.stringify({ messages: [
      null,
      "not-a-message",
      { id: "huge", threadId: "thread-huge", internalDate: "999999999999999999999999" },
    ] })));

    await expect(searchGmailSentEvidence("owner@gmail.test", "gmail-1", {
      after: "2026-08-30T14:00:00.000Z",
      before: "2026-08-30T15:00:00.000Z",
      maxResults: 3,
    })).resolves.toEqual({ items: [], truncated: true });
    expect(gog.spawn).toHaveBeenCalledOnce();
    expect(gog.spawn.mock.calls[0][1]).not.toContain("--page");
  });

  it("rejects invalid or unbounded Sent evidence windows before invoking Gmail", async () => {
    gog.spawn.mockClear();
    for (const options of [
      { after: "bad", before: "2026-08-30T14:00:00.000Z", maxResults: 1 },
      { after: "2026-08-30T14:00:00.000Z", before: "2026-08-30T14:00:00.000Z", maxResults: 1 },
      { after: "2026-08-30T14:00:00.000Z", before: "2026-08-29T14:00:00.000Z", maxResults: 1 },
      { after: "2026-08-01T14:00:00.000Z", before: "2026-08-30T14:00:00.000Z", maxResults: 1 },
      { after: "2026-08-29T14:00:00.000Z", before: "2026-08-30T14:00:00.000Z", maxResults: 0 },
      { after: "2026-08-29T14:00:00.000Z", before: "2026-08-30T14:00:00.000Z", maxResults: 1.5 },
    ]) {
      await expect(searchGmailSentEvidence("owner@gmail.test", "gmail-1", options)).rejects.toThrow(/Sent evidence/i);
    }
    expect(gog.spawn).not.toHaveBeenCalled();
  });
  it("resolves modify permission for the exact authorized Gmail account", () => {
    const authList = {
      accounts: [
        {
          email: "writer@gmail.example",
          scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        },
        {
          email: "reader@gmail.example",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        },
      ],
    };

    expect(gmailAuthorizationCapabilitiesFromAuthList(authList, "writer@gmail.example")).toEqual({ modify: true });
    expect(gmailAuthorizationCapabilitiesFromAuthList(authList, "reader@gmail.example")).toEqual({ modify: false });
    expect(gmailAuthorizationCapabilitiesFromAuthList(authList, "missing@gmail.example")).toEqual({ modify: false });
  });

  it("isolates modify permission when the authorization list is keyed by account email", () => {
    const authList = {
      accounts: {
        "writer@gmail.example": {
          scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        },
        "reader@gmail.example": {
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        },
      },
    };

    expect(gmailAuthorizationCapabilitiesFromAuthList(authList, "writer@gmail.example")).toEqual({ modify: true });
    expect(gmailAuthorizationCapabilitiesFromAuthList(authList, "reader@gmail.example")).toEqual({ modify: false });
  });

  it("does not aggregate sibling scopes from a top-level selected-account field", () => {
    const authList = {
      selectedAccount: "reader@gmail.example",
      accounts: [
        {
          email: "writer@gmail.example",
          scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        },
        {
          email: "reader@gmail.example",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        },
      ],
    };

    expect(gmailAuthorizationCapabilitiesFromAuthList(authList, "reader@gmail.example")).toEqual({ modify: false });
  });

  it("removes gog's transport wrapper from a complete metadata value", () => {
    const wrapped = `<<<EXTERNAL_UNTRUSTED_CONTENT id="abc123">>>
Source: google_api
---
Quarterly review tomorrow
<<<END_EXTERNAL_UNTRUSTED_CONTENT id="abc123">>>`;

    expect(unwrapGogMetadata(wrapped)).toBe("Quarterly review tomorrow");
  });

  it("leaves ordinary and incomplete values untouched", () => {
    expect(unwrapGogMetadata("Ordinary subject")).toBe("Ordinary subject");
    expect(unwrapGogMetadata("<<<EXTERNAL_UNTRUSTED_CONTENT>>>partial")).toBe(
      "<<<EXTERNAL_UNTRUSTED_CONTENT>>>partial",
    );
  });

  it("accepts only standards-based HTTPS one-click unsubscribe metadata", () => {
    expect(
      parseUnsubscribeMetadata({
        message: {
          payload: {
            headers: [
              {
                name: "List-Unsubscribe",
                value: "<mailto:leave@example.com>, <https://example.com/unsubscribe/123>",
              },
              {
                name: "List-Unsubscribe-Post",
                value: "List-Unsubscribe=One-Click",
              },
            ],
          },
        },
      }),
    ).toEqual({
      oneClickUrl: "https://example.com/unsubscribe/123",
      mailto: "mailto:leave@example.com",
      supported: true,
    });
  });

  it("does not treat a link without one-click consent metadata as supported", () => {
    expect(
      parseUnsubscribeMetadata({
        headers: {
          "List-Unsubscribe": "<https://example.com/preferences>",
        },
      }),
    ).toEqual({
      oneClickUrl: null,
      mailto: null,
      supported: false,
    });
  });
});

function fakeGog(payload: string) {
  return {
    stdout: { on: (event: string, listener: (chunk: Buffer) => void) => { if (event === "data") queueMicrotask(() => listener(Buffer.from(payload))); } },
    stderr: { on: () => undefined },
    on: (event: string, listener: (value?: unknown) => void) => {
      if (event === "close") queueMicrotask(() => listener(0));
      return undefined;
    },
    kill: () => undefined,
  };
}
