import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getStoredMicrosoftRefreshToken,
  listMicrosoftSentEvidence,
  markMicrosoftMessagesRead,
  normalizeMicrosoftMessage,
  refreshMicrosoftAccessToken,
  reconcileMicrosoftReply,
  sendMicrosoftOutgoing,
  sendMicrosoftReply,
  setMicrosoftMessagesFlagged,
  storeMicrosoftRefreshToken,
} from "@/lib/email/microsoft";

describe("Microsoft credential storage", () => {
  const originalBackend = process.env.EZRA_MICROSOFT_TOKEN_BACKEND;
  const originalDirectory = process.env.EZRA_CREDENTIAL_DIR;
  const originalClientId = process.env.MICROSOFT_CLIENT_ID;
  const roots: string[] = [];

  afterEach(async () => {
    if (originalBackend === undefined) delete process.env.EZRA_MICROSOFT_TOKEN_BACKEND;
    else process.env.EZRA_MICROSOFT_TOKEN_BACKEND = originalBackend;
    if (originalDirectory === undefined) delete process.env.EZRA_CREDENTIAL_DIR;
    else process.env.EZRA_CREDENTIAL_DIR = originalDirectory;
    if (originalClientId === undefined) delete process.env.MICROSOFT_CLIENT_ID;
    else process.env.MICROSOFT_CLIENT_ID = originalClientId;
    vi.unstubAllGlobals();
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it("stores Microsoft refresh tokens in an app-private file backend", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-ms-"));
    roots.push(root);
    process.env.EZRA_MICROSOFT_TOKEN_BACKEND = "file";
    process.env.EZRA_CREDENTIAL_DIR = root;

    const result = await storeMicrosoftRefreshToken("owner@hotmail.com", "refresh-token");
    const restored = await getStoredMicrosoftRefreshToken("OWNER@hotmail.com");
    const files = await fs.readdir(path.join(root, "microsoft"));
    const stat = await fs.stat(path.join(root, "microsoft", files[0]));

    expect(result).toMatchObject({ stored: true, backend: "file" });
    expect(restored).toBe("refresh-token");
    expect(files).toHaveLength(1);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("refreshes Microsoft tokens with maintenance scopes", async () => {
    process.env.MICROSOFT_CLIENT_ID = "client-id";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "access-token", refresh_token: "refresh-token-2", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const token = await refreshMicrosoftAccessToken("refresh-token-1", "maintenance");
    const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams;

    expect(token).toMatchObject({ accessToken: "access-token", refreshToken: "refresh-token-2" });
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("scope")).toContain("Mail.ReadWrite");
  });

  it("reads only bounded Sent Items evidence with Mail.Read and immutable IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ value: [
      { id: "sent-1", conversationId: "thread-1", sentDateTime: "2026-08-30T09:10:00-05:00", subject: "Do not keep" },
      { id: "missing-thread", sentDateTime: "2026-08-30T14:15:00Z" },
      { conversationId: "missing-id", sentDateTime: "2026-08-30T14:15:00Z" },
      { id: "invalid-time", conversationId: "thread-3", sentDateTime: "not-a-timestamp" },
      { id: "outside", conversationId: "thread-2", sentDateTime: "2026-08-30T15:00:01Z" },
    ], "@odata.nextLink": "https://graph.example.test/next" }));
    vi.stubGlobal("fetch", fetchMock);

    const page = await listMicrosoftSentEvidence("graph-token", "ms-1", {
      after: "2026-08-30T14:00:00.000Z",
      before: "2026-08-30T15:00:00.000Z",
      maxResults: 500,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toContain("/me/mailFolders/sentitems/messages");
    expect(url).toContain("$top=100");
    expect(url).toContain("$orderby=sentDateTime desc");
    expect(decodeURIComponent(url)).toContain("sentDateTime ge 2026-08-30T14:00:00.000Z and sentDateTime le 2026-08-30T15:00:00.000Z");
    expect(url).toContain("$select=id,conversationId,sentDateTime");
    expect(init.headers).toMatchObject({ authorization: "Bearer graph-token", prefer: 'IdType="ImmutableId"' });
    expect(page).toEqual({ items: [{
      accountId: "ms-1", provider: "microsoft", providerMessageId: "sent-1", providerThreadId: "thread-1",
      sentAt: "2026-08-30T14:10:00.000Z",
    }], truncated: false });
    expect(JSON.stringify(page.items[0])).not.toMatch(/subject|recipient|body|snippet|header|attachment/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps raw malformed Microsoft slots conservative without coercing identifiers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ value: [
      null,
      "not-a-message",
      { id: 7, conversationId: true, sentDateTime: "2026-08-30T14:10:00Z" },
    ] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listMicrosoftSentEvidence("graph-token", "ms-1", {
      after: "2026-08-30T14:00:00.000Z",
      before: "2026-08-30T15:00:00.000Z",
      maxResults: 3,
    })).resolves.toEqual({ items: [], truncated: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects invalid Sent evidence bounds before a Graph request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(listMicrosoftSentEvidence("graph-token", "ms-1", {
      after: "2026-08-01T14:00:00.000Z", before: "2026-08-30T14:00:00.000Z", maxResults: 1,
    })).rejects.toThrow(/Sent evidence/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes Microsoft tokens with calendar scopes without dropping mail maintenance", async () => {
    process.env.MICROSOFT_CLIENT_ID = "client-id";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "access-token", refresh_token: "refresh-token-2", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await refreshMicrosoftAccessToken("refresh-token-1", "calendar");
    const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams;

    expect(body.get("scope")).toContain("Calendars.ReadWrite");
    expect(body.get("scope")).toContain("Mail.ReadWrite");
  });

  it("refreshes Microsoft tokens with send scope", async () => {
    process.env.MICROSOFT_CLIENT_ID = "client-id";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "access-token", refresh_token: "refresh-token-2", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await refreshMicrosoftAccessToken("refresh-token-1", "send");
    const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams;

    expect(body.get("scope")).toContain("Mail.Send");
    expect(body.get("scope")).toContain("Mail.ReadWrite");
  });

  it("marks Microsoft messages read through Graph after refreshing the stored token", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-ms-"));
    roots.push(root);
    process.env.EZRA_MICROSOFT_TOKEN_BACKEND = "file";
    process.env.EZRA_CREDENTIAL_DIR = root;
    process.env.MICROSOFT_CLIENT_ID = "client-id";
    await storeMicrosoftRefreshToken("owner@hotmail.com", "refresh-token-1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-token", refresh_token: "refresh-token-2" }))
      .mockResolvedValueOnce(jsonResponse({ id: "message/id", isRead: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await markMicrosoftMessagesRead("owner@hotmail.com", ["message/id"]);
    const graphCall = fetchMock.mock.calls[1];
    const init = graphCall[1] as RequestInit;

    expect(result).toEqual({ modified: 1 });
    expect(String(graphCall[0])).toContain(encodeURIComponent("message/id"));
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ isRead: true }));
    expect(await getStoredMicrosoftRefreshToken("owner@hotmail.com")).toBe("refresh-token-2");
  });

  it("sets and clears Microsoft follow-up flags through Graph", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-ms-"));
    roots.push(root);
    process.env.EZRA_MICROSOFT_TOKEN_BACKEND = "file";
    process.env.EZRA_CREDENTIAL_DIR = root;
    process.env.MICROSOFT_CLIENT_ID = "client-id";
    await storeMicrosoftRefreshToken("owner@hotmail.com", "refresh-token-1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-token", refresh_token: "refresh-token-2" }))
      .mockResolvedValueOnce(jsonResponse({ id: "message/id", flag: { flagStatus: "flagged" } }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-token-2", refresh_token: "refresh-token-3" }))
      .mockResolvedValueOnce(jsonResponse({ id: "message/two", flag: { flagStatus: "notFlagged" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(setMicrosoftMessagesFlagged("owner@hotmail.com", ["message/id"], true)).resolves.toEqual({ modified: 1 });
    await expect(setMicrosoftMessagesFlagged("owner@hotmail.com", ["message/two"], false)).resolves.toEqual({ modified: 1 });

    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(JSON.stringify({ flag: { flagStatus: "flagged" } }));
    expect((fetchMock.mock.calls[3][1] as RequestInit).body).toBe(JSON.stringify({ flag: { flagStatus: "notFlagged" } }));
  });

  it("normalizes a Graph follow-up flag into Ezra's account-scoped organization state", () => {
    const message = normalizeMicrosoftMessage("account-microsoft", {
      id: "message-flagged",
      subject: "Follow up",
      receivedDateTime: "2026-08-13T12:00:00.000Z",
      from: { emailAddress: { address: "sender@example.test" } },
      flag: { flagStatus: "flagged" },
    });

    expect(message).toMatchObject({
      accountId: "account-microsoft",
      externalMessageId: "message-flagged",
      isFlagged: true,
      labels: expect.arrayContaining(["MS_FOLLOW_UP"]),
    });
  });

  it("sends approved outgoing mail through Microsoft Graph sendMail", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-ms-"));
    roots.push(root);
    process.env.EZRA_MICROSOFT_TOKEN_BACKEND = "file";
    process.env.EZRA_CREDENTIAL_DIR = root;
    process.env.MICROSOFT_CLIENT_ID = "client-id";
    await storeMicrosoftRefreshToken("owner@hotmail.com", "refresh-token-1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-token", refresh_token: "refresh-token-2" }))
      .mockResolvedValueOnce(new Response("", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMicrosoftOutgoing("owner@hotmail.com", {
      to: [{ name: "Taylor", email: "taylor@example.test" }],
      cc: [{ email: "copy@example.test" }],
      bcc: [],
      subject: "Interview availability",
      body: "Friday morning works for me.",
      attachments: [{ name: "notes.txt", mimeType: "text/plain", bytes: Buffer.from("hello") }],
    });
    const graphCall = fetchMock.mock.calls[1];
    const init = graphCall[1] as RequestInit;
    const payload = JSON.parse(String(init.body || "{}"));

    expect(result).toEqual({ accepted: true, provider: "microsoft", providerMessageId: null });
    expect(String(graphCall[0])).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(init.method).toBe("POST");
    expect(payload).toMatchObject({
      message: {
        subject: "Interview availability",
        body: { contentType: "Text", content: "Friday morning works for me." },
        toRecipients: [{ emailAddress: { address: "taylor@example.test", name: "Taylor" } }],
        ccRecipients: [{ emailAddress: { address: "copy@example.test" } }],
        bccRecipients: [],
        attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: "notes.txt", contentType: "text/plain", contentBytes: Buffer.from("hello").toString("base64") }],
      },
      saveToSentItems: true,
    });
    expect(await getStoredMicrosoftRefreshToken("owner@hotmail.com")).toBe("refresh-token-2");
  });

  it("creates, verifies, and sends a threaded Reply all draft with combined mail and Calendar access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-ms-"));
    roots.push(root);
    process.env.EZRA_MICROSOFT_TOKEN_BACKEND = "file";
    process.env.EZRA_CREDENTIAL_DIR = root;
    process.env.MICROSOFT_CLIENT_ID = "client-id";
    await storeMicrosoftRefreshToken("owner@hotmail.com", "refresh-token-1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-token", refresh_token: "refresh-token-2" }))
      .mockResolvedValueOnce(jsonResponse({ id: "immutable-reply-draft", isDraft: true }, 201))
      .mockResolvedValueOnce(jsonResponse({ id: "immutable-reply-draft" }))
      .mockResolvedValueOnce(jsonResponse({ id: "attachment-1" }, 201))
      .mockResolvedValueOnce(jsonResponse({
        id: "immutable-reply-draft",
        isDraft: true,
        toRecipients: [{ emailAddress: { address: "team@example.test" } }],
        ccRecipients: [{ emailAddress: { address: "copy@example.test" } }],
        bccRecipients: [],
      }))
      .mockResolvedValueOnce(new Response("", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const created: string[] = [];

    const result = await sendMicrosoftReply("owner@hotmail.com", {
      externalMessageId: "source/message",
      replyMode: "all",
      to: [{ email: "team@example.test" }],
      cc: [{ email: "copy@example.test" }],
      bcc: [],
      body: "Exact approved reply.",
      attachments: [{ name: "notes.txt", mimeType: "text/plain", bytes: Buffer.from("hello") }],
      onDraftCreated: async (id) => { created.push(id); },
    });

    expect(result).toMatchObject({ accepted: true, providerDraftId: "immutable-reply-draft" });
    expect(created).toEqual(["immutable-reply-draft"]);
    expect(String(fetchMock.mock.calls[1][0])).toContain("source%2Fmessage/createReplyAll");
    expect(String(fetchMock.mock.calls[2][0])).toContain("immutable-reply-draft");
    expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body))).toMatchObject({
      body: { contentType: "Text", content: "Exact approved reply." },
      toRecipients: [{ emailAddress: { address: "team@example.test" } }],
      ccRecipients: [{ emailAddress: { address: "copy@example.test" } }],
      bccRecipients: [],
    });
    expect(String(fetchMock.mock.calls[5][0])).toContain("immutable-reply-draft/send");
    const refreshBody = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
    expect(refreshBody.get("scope")).toContain("Mail.Send");
    expect(refreshBody.get("scope")).toContain("Calendars.ReadWrite");
  });

  it("reconciles an immutable Microsoft provider draft after an uncertain send", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-ms-"));
    roots.push(root);
    process.env.EZRA_MICROSOFT_TOKEN_BACKEND = "file";
    process.env.EZRA_CREDENTIAL_DIR = root;
    process.env.MICROSOFT_CLIENT_ID = "client-id";
    await storeMicrosoftRefreshToken("owner@hotmail.com", "refresh-token-1");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-token", refresh_token: "refresh-token-2" }))
      .mockResolvedValueOnce(jsonResponse({ id: "immutable-reply-draft", isDraft: false, sentDateTime: "2026-07-16T18:00:00Z" })));

    await expect(reconcileMicrosoftReply("owner@hotmail.com", "immutable-reply-draft")).resolves.toEqual({
      status: "sent",
      providerMessageId: "immutable-reply-draft",
    });
  });
});

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
