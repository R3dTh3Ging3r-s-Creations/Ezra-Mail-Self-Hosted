import { beforeEach, describe, expect, it, vi } from "vitest";

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
  getGoogleCalendarIdentity,
  getGmailMessageEnvelope,
  parseUnsubscribeMetadata,
  unwrapGogMetadata,
  searchGmailSentEvidence,
  searchGmailMessagePage,
} from "../src/lib/email/gmail";

describe("Gmail metadata", () => {
  beforeEach(() => gog.spawn.mockClear());
  it("reads the nested sanitized message body, numeric receipt time and attachment metadata", async () => {
    gog.spawn.mockImplementation(() => fakeGog(JSON.stringify({message:{
      id:"nested",threadId:"thread",internalDate:1791376496123,labelIds:["INBOX"],
      headers:{from:"Sender <sender@example.test>",subject:"Nested",date:"Wed, 7 Oct 2026 08:14:56 -0500"},
      body:'<<<EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>\nSource: google_api\n---\nFull sanitized body\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>',
      snippet:"Short preview",attachments:[{attachmentId:"attachment",filename:"fixture.txt",mimeType:"text/plain",size:12}],
    }})));
    const message=await getGmailMessageEnvelope("owner@gmail.test","nested");
    expect(message).toMatchObject({externalMessageId:"nested",subject:"Nested",senderEmail:"sender@example.test",bodyText:"Full sanitized body",receivedAt:"2026-10-07T12:34:56.123Z",attachments:[{id:"attachment",name:"fixture.txt",mimeType:"text/plain",size:12}]});
  });
  it("uses the same exact internal receipt timestamp for Gmail search and read", async () => {
    gog.spawn.mockImplementationOnce(() => fakeGog(JSON.stringify({messages:[{id:"same",date:"2026-10-07 08:14",internalDateIso:"2026-10-07T07:34:56.123-05:00",from:"sender@example.test",subject:"Fixture"}]})));
    const page=await searchGmailMessagePage("owner@gmail.test",{query:"in:inbox",maxResults:1});
    gog.spawn.mockImplementationOnce(() => fakeGog(JSON.stringify({message:{id:"same",internalDate:1791376496123,headers:{date:"Wed, 7 Oct 2026 08:14:56 -0500"},body:"Full body"}})));
    const read=await getGmailMessageEnvelope("owner@gmail.test","same");
    expect(page.messages[0].receivedAt).toBe("2026-10-07T12:34:56.123Z");
    expect(read.receivedAt).toBe(page.messages[0].receivedAt);
    expect(page.messages[0].snippet).toBe("");
    expect(gog.spawn.mock.calls[0][1]).not.toContain("--include-body");
  });
  it("does not invent a current receipt time when provider metadata is missing",async()=>{
    gog.spawn.mockImplementation(()=>fakeGog(JSON.stringify({id:"undated",body:"Text"})));
    expect((await getGmailMessageEnvelope("owner@gmail.test","undated")).receivedAt).toBe("1970-01-01T00:00:00.000Z");
  });
  it("retains literal embedded body markers while removing only the outer transport wrapper",async()=>{
    const literal='Quoted example:\n<<<EXTERNAL_UNTRUSTED_CONTENT>>>\nquoted text\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>\nEnd example';
    gog.spawn.mockImplementation(()=>fakeGog(JSON.stringify({message:{id:"quoted",body:`<<<EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>\nSource: google_api\n---\n${literal}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>`}})));
    expect((await getGmailMessageEnvelope("owner@gmail.test","quoted")).bodyText).toBe(literal);
    gog.spawn.mockImplementation(()=>fakeGog(JSON.stringify({id:"quoted",body:literal})));
    expect((await getGmailMessageEnvelope("owner@gmail.test","quoted")).bodyText).toBe(literal);
  });
  it("retains nested sanitized body truncation evidence",async()=>{
    gog.spawn.mockImplementation(()=>fakeGog(JSON.stringify({message:{id:"long-nested",body:"x".repeat(80_001)}})));
    const message=await getGmailMessageEnvelope("owner@gmail.test","long-nested");
    expect(message.bodyText).toHaveLength(80_000);expect(message.bodyTextTruncated).toBe(true);
  });
  it.each([
    '<<<EXTERNAL_UNTRUSTED_CONTENT>>>\nLiteral quoted content\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>',
    '<<<EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>\nSource: google_api\n---\nLiteral mismatched markers\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="fedcba9876543210">>>',
  ])("leaves a literal body resembling a wrapper intact: %s",async body=>{
    gog.spawn.mockImplementation(()=>fakeGog(JSON.stringify({message:{id:"literal",body}})));
    expect((await getGmailMessageEnvelope("owner@gmail.test","literal")).bodyText).toBe(body);
  });
  it("retains truncation evidence when the Gmail HTML source exceeds its adapter cap",async()=>{
    gog.spawn.mockImplementation(()=>fakeGog(JSON.stringify({id:"html",html:`<p>${"x".repeat(200_001)}</p>`})));
    const message=await getGmailMessageEnvelope("owner@gmail.test","html");
    expect(message.bodyHtml).toHaveLength(200_000);
    expect(message.bodyHtmlTruncated).toBe(true);
  });
  it("retains truncation evidence for a bounded provider body",async()=>{
    gog.spawn.mockImplementation(()=>fakeGog(JSON.stringify({id:"long-message",body:"x".repeat(80_001)})));
    const message=await getGmailMessageEnvelope("owner@gmail.test","long-message");
    expect(message.bodyText).toHaveLength(80_000);expect(message.bodyTextTruncated).toBe(true);
  });
  it("verifies account identity using the authenticated primary calendar, never a label", async () => {
    gog.spawn.mockImplementation(() => fakeGog(JSON.stringify({ calendars: [
      { id: "owner@gmail.test", primary: true, summary: "Untrusted label" },
    ] })));
    expect(await getGoogleCalendarIdentity("owner@gmail.test")).toBe("owner@gmail.test");
    gog.spawn.mockImplementation(() => fakeGog(JSON.stringify({ calendars: [
      { id: "other@gmail.test", primary: false, summary: "owner@gmail.test" },
    ] })));
    await expect(getGoogleCalendarIdentity("owner@gmail.test")).rejects.toThrow(/identity/i);
  });
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

    expect(gmailAuthorizationCapabilitiesFromAuthList(authList, "writer@gmail.example")).toMatchObject({ modify: true });
    expect(gmailAuthorizationCapabilitiesFromAuthList(authList, "reader@gmail.example")).toMatchObject({ modify: false });
    expect(gmailAuthorizationCapabilitiesFromAuthList(authList, "missing@gmail.example")).toMatchObject({ modify: false });
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

    expect(gmailAuthorizationCapabilitiesFromAuthList(authList, "writer@gmail.example")).toMatchObject({ modify: true });
    expect(gmailAuthorizationCapabilitiesFromAuthList(authList, "reader@gmail.example")).toMatchObject({ modify: false });
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

    expect(gmailAuthorizationCapabilitiesFromAuthList(authList, "reader@gmail.example")).toMatchObject({ modify: false });
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
