import { beforeEach, describe, expect, it, vi } from "vitest";

const providerCalls = vi.hoisted(() => ({
  markGmailMessagesRead: vi.fn(async () => ({ modified: 1 })),
  markGmailMessagesUnread: vi.fn(async () => ({ modified: 1 })),
  setGmailMessagesStarred: vi.fn(async () => ({ modified: 1 })),
  setGmailMessagesImportant: vi.fn(async () => ({ modified: 1 })),
  moveGmailMessagesToSpam: vi.fn(async () => ({ modified: 1 })),
  moveGmailMessagesToTrash: vi.fn(async () => ({ modified: 1 })),
  restoreGmailMessagesFromSpam: vi.fn(async () => ({ modified: 1 })),
  restoreGmailMessagesFromTrash: vi.fn(async () => ({ modified: 1 })),
  isGogInstalled: vi.fn(async () => true),
  getGmailAuthorizationCapabilities: vi.fn(async () => ({ modify: true })),
  startGmailAuthorization: vi.fn(async () => ({ mode: "browser" as const, processId: 123 })),
  searchGmailMessages: vi.fn(async () => []),
  searchGmailSentEvidence: vi.fn(async () => ({ items: [] as unknown[], truncated: false })),
  getGmailMessageEnvelope: vi.fn(async (): Promise<import("@/lib/email/types").EmailEnvelope | null> => null),
  getGmailReplyMetadata: vi.fn(async () => ({
    from: { email: "sender@gmail.test", name: "Sender" }, replyTo: [], to: [], cc: [], subject: "Subject",
  })),
  sendGmailOutgoing: vi.fn(async () => ({ id: "gmail-sent" })),
  removeGmailAuthorization: vi.fn(async () => ({ removed: true, backend: "gog-keyring" })),
  markMicrosoftMessagesRead: vi.fn(async () => ({ modified: 1 })),
  markMicrosoftMessagesUnread: vi.fn(async () => ({ modified: 1 })),
  setMicrosoftMessagesFlagged: vi.fn(async () => ({ modified: 1 })),
  moveMicrosoftMessagesToJunk: vi.fn(async () => ({ modified: 1 })),
  moveMicrosoftMessagesToTrash: vi.fn(async () => ({ modified: 1 })),
  restoreMicrosoftMessagesFromJunk: vi.fn(async () => ({ modified: 1 })),
  restoreMicrosoftMessagesFromTrash: vi.fn(async () => ({ modified: 1 })),
  isMicrosoftAuthConfigured: vi.fn(() => true),
  startMicrosoftDeviceAuthorization: vi.fn(async () => ({
    deviceCode: "device-code",
    userCode: "ABCD",
    verificationUri: "https://microsoft.example.test/device",
    verificationUriComplete: null,
    expiresIn: 900,
    interval: 5,
    message: "Use the code.",
  })),
  getMicrosoftAccessToken: vi.fn(async () => "graph-token"),
  listMicrosoftInboxMessages: vi.fn(async () => []),
  listMicrosoftSentEvidence: vi.fn(async () => ({ items: [] as unknown[], truncated: false })),
  getMicrosoftMessageEnvelope: vi.fn(async () => ({
    accountId: "acct-outlook",
    externalMessageId: "graph-message",
    threadId: "thread",
    senderName: "Sender",
    senderEmail: "sender@example.test",
    subject: "Subject",
    receivedAt: "2026-08-12T00:00:00.000Z",
    snippet: "Snippet",
    gmailUrl: "#",
    isUnread: true,
    labels: [],
    attachments: [],
  })),
  getMicrosoftReplyMetadata: vi.fn(async () => ({
    from: { email: "sender@outlook.test", name: "Sender" }, replyTo: [], to: [], cc: [], subject: "Subject",
  })),
  sendMicrosoftOutgoing: vi.fn(async () => ({ accepted: true, provider: "microsoft" })),
  sendMicrosoftReply: vi.fn(async () => ({ accepted: true, provider: "microsoft", providerDraftId: "graph-draft" })),
  reconcileMicrosoftReply: vi.fn(async () => ({ status: "sent" as const, providerMessageId: "graph-draft" })),
  removeStoredMicrosoftRefreshToken: vi.fn(async () => ({ removed: true, backend: "file" })),
}));

vi.mock("@/lib/email/gmail", () => ({
  markGmailMessagesRead: providerCalls.markGmailMessagesRead,
  markGmailMessagesUnread: providerCalls.markGmailMessagesUnread,
  setGmailMessagesStarred: providerCalls.setGmailMessagesStarred,
  setGmailMessagesImportant: providerCalls.setGmailMessagesImportant,
  moveGmailMessagesToSpam: providerCalls.moveGmailMessagesToSpam,
  moveGmailMessagesToTrash: providerCalls.moveGmailMessagesToTrash,
  restoreGmailMessagesFromSpam: providerCalls.restoreGmailMessagesFromSpam,
  restoreGmailMessagesFromTrash: providerCalls.restoreGmailMessagesFromTrash,
  isGogInstalled: providerCalls.isGogInstalled,
  getGmailAuthorizationCapabilities: providerCalls.getGmailAuthorizationCapabilities,
  startGmailAuthorization: providerCalls.startGmailAuthorization,
  searchGmailMessages: providerCalls.searchGmailMessages,
  searchGmailSentEvidence: providerCalls.searchGmailSentEvidence,
  getGmailMessageEnvelope: providerCalls.getGmailMessageEnvelope,
  getGmailReplyMetadata: providerCalls.getGmailReplyMetadata,
  sendGmailOutgoing: providerCalls.sendGmailOutgoing,
  removeGmailAuthorization: providerCalls.removeGmailAuthorization,
}));

vi.mock("@/lib/email/microsoft", () => ({
  markMicrosoftMessagesRead: providerCalls.markMicrosoftMessagesRead,
  markMicrosoftMessagesUnread: providerCalls.markMicrosoftMessagesUnread,
  setMicrosoftMessagesFlagged: providerCalls.setMicrosoftMessagesFlagged,
  moveMicrosoftMessagesToJunk: providerCalls.moveMicrosoftMessagesToJunk,
  moveMicrosoftMessagesToTrash: providerCalls.moveMicrosoftMessagesToTrash,
  restoreMicrosoftMessagesFromJunk: providerCalls.restoreMicrosoftMessagesFromJunk,
  restoreMicrosoftMessagesFromTrash: providerCalls.restoreMicrosoftMessagesFromTrash,
  isMicrosoftAuthConfigured: providerCalls.isMicrosoftAuthConfigured,
  startMicrosoftDeviceAuthorization: providerCalls.startMicrosoftDeviceAuthorization,
  getMicrosoftAccessToken: providerCalls.getMicrosoftAccessToken,
  listMicrosoftInboxMessages: providerCalls.listMicrosoftInboxMessages,
  listMicrosoftSentEvidence: providerCalls.listMicrosoftSentEvidence,
  getMicrosoftMessageEnvelope: providerCalls.getMicrosoftMessageEnvelope,
  getMicrosoftReplyMetadata: providerCalls.getMicrosoftReplyMetadata,
  sendMicrosoftOutgoing: providerCalls.sendMicrosoftOutgoing,
  sendMicrosoftReply: providerCalls.sendMicrosoftReply,
  reconcileMicrosoftReply: providerCalls.reconcileMicrosoftReply,
  removeStoredMicrosoftRefreshToken: providerCalls.removeStoredMicrosoftRefreshToken,
}));

import { providerAdapterFor } from "@/lib/email/provider-adapter";

describe("provider maintenance adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerCalls.getGmailAuthorizationCapabilities.mockReset().mockResolvedValue({ modify: true });
  });

  it("reads bounded Sent evidence through the provider's existing read-only path", async () => {
    const options = {
      after: "2026-08-29T14:00:00.000Z",
      before: "2026-08-30T14:00:00.000Z",
      maxResults: 100,
    };
    const gmailEvidence = {
      accountId: "gmail-1",
      provider: "gmail" as const,
      providerMessageId: "sent-1",
      providerThreadId: "thread-1",
      sentAt: "2026-08-30T13:00:00.000Z",
    };
    const microsoftEvidence = { ...gmailEvidence, accountId: "ms-1", provider: "microsoft" as const };
    providerCalls.searchGmailSentEvidence.mockResolvedValue({ items: [gmailEvidence], truncated: false });
    providerCalls.listMicrosoftSentEvidence.mockResolvedValue({ items: [microsoftEvidence], truncated: false });

    await expect(providerAdapterFor("gmail").readSentEvidence("owner@gmail.test", "gmail-1", options))
      .resolves.toEqual({ items: [gmailEvidence], truncated: false });
    await expect(providerAdapterFor("microsoft").readSentEvidence("owner@outlook.test", "ms-1", options))
      .resolves.toEqual({ items: [microsoftEvidence], truncated: false });

    expect(providerCalls.searchGmailSentEvidence).toHaveBeenCalledWith("owner@gmail.test", "gmail-1", options);
    expect(providerCalls.getMicrosoftAccessToken).toHaveBeenCalledWith("owner@outlook.test", "readonly");
    expect(providerCalls.listMicrosoftSentEvidence).toHaveBeenCalledWith("graph-token", "ms-1", options);
  });

  it("maps Gmail maintenance and undo to Gmail operations", async () => {
    const adapter = providerAdapterFor("gmail");

    await adapter.markRead("owner@gmail.test", ["gmail-message"]);
    await adapter.applyMaintenance("owner@gmail.test", "mark_read", ["gmail-message"]);
    await adapter.undoMaintenance("owner@gmail.test", "spam", ["gmail-message"]);

    expect(providerCalls.markGmailMessagesRead).toHaveBeenCalledWith("owner@gmail.test", ["gmail-message"]);
    expect(providerCalls.getGmailAuthorizationCapabilities).toHaveBeenCalledWith("owner@gmail.test");
    expect(providerCalls.restoreGmailMessagesFromSpam).toHaveBeenCalledWith("owner@gmail.test", ["gmail-message"]);
  });

  it("maps Microsoft maintenance and undo to Microsoft operations", async () => {
    const adapter = providerAdapterFor("microsoft");

    await adapter.markRead("owner@outlook.test", ["graph-id"]);
    await adapter.applyMaintenance("owner@outlook.test", "spam", ["graph-id"]);
    await adapter.undoMaintenance("owner@outlook.test", "mark_read", ["graph-id"]);

    expect(providerCalls.moveMicrosoftMessagesToJunk).toHaveBeenCalledWith("owner@outlook.test", ["graph-id"]);
    expect(providerCalls.markMicrosoftMessagesRead).toHaveBeenCalledWith("owner@outlook.test", ["graph-id"]);
    expect(providerCalls.markMicrosoftMessagesUnread).toHaveBeenCalledWith("owner@outlook.test", ["graph-id"]);
  });

  it("maps Gmail Pin and Flag to faithful Star and Important states", async () => {
    const gmail = providerAdapterFor("gmail");
    const microsoft = providerAdapterFor("microsoft");

    expect(gmail.organizationCapabilities()).toEqual({
      pin: { state: "supported", mapping: "gmail_star" },
      flag: { state: "supported", mapping: "gmail_important" },
    });
    expect(microsoft.organizationCapabilities()).toEqual({
      pin: { state: "unavailable", reason: "Ezra cannot safely map Pin for this Microsoft account yet." },
      flag: { state: "supported", mapping: "microsoft_follow_up" },
    });

    await gmail.applyOrganizationState("owner@gmail.test", "pin", true, ["gmail-message"]);
    await gmail.applyOrganizationState("owner@gmail.test", "flag", true, ["gmail-message"]);
    await microsoft.applyOrganizationState("owner@outlook.test", "flag", false, ["graph-message"]);

    expect(providerCalls.setGmailMessagesStarred).toHaveBeenCalledWith(
      "owner@gmail.test",
      ["gmail-message"],
      true,
    );
    expect(providerCalls.setGmailMessagesImportant).toHaveBeenCalledWith(
      "owner@gmail.test",
      ["gmail-message"],
      true,
    );
    expect(providerCalls.setMicrosoftMessagesFlagged).toHaveBeenCalledWith(
      "owner@outlook.test",
      ["graph-message"],
      false,
    );
    expect(providerCalls.getGmailAuthorizationCapabilities).toHaveBeenNthCalledWith(1, "owner@gmail.test");
    expect(providerCalls.getGmailAuthorizationCapabilities).toHaveBeenNthCalledWith(2, "owner@gmail.test");
  });

  it("does not let one Gmail account's modify permission authorize another account", async () => {
    providerCalls.getGmailAuthorizationCapabilities.mockImplementation(async (email?: string) => ({
      modify: email === "writer@gmail.test",
    }));
    const gmail = providerAdapterFor("gmail");

    await expect(gmail.applyOrganizationState("reader@gmail.test", "pin", true, ["reader-message"]))
      .rejects.toThrow(/Reconnect Gmail with modify access/i);
    await expect(gmail.applyOrganizationState("writer@gmail.test", "pin", true, ["writer-message"]))
      .resolves.toEqual({ modified: 1 });

    expect(providerCalls.setGmailMessagesStarred).toHaveBeenCalledOnce();
    expect(providerCalls.setGmailMessagesStarred).toHaveBeenCalledWith(
      "writer@gmail.test",
      ["writer-message"],
      true,
    );
  });

  it("owns Gmail setup discovery and local readiness without invoking mailbox actions", async () => {
    const adapter = providerAdapterFor("gmail");

    expect(adapter.discover()).toMatchObject({ provider: "gmail", authorization: "browser" });
    await expect(adapter.preflight("mail_read")).resolves.toMatchObject({
      provider: "gmail",
      capability: "mail_read",
      authorization: "browser",
    });
    expect(providerCalls.markGmailMessagesRead).not.toHaveBeenCalled();
  });

  it("owns Microsoft setup discovery and local readiness without invoking mailbox actions", async () => {
    const adapter = providerAdapterFor("microsoft");

    expect(adapter.discover()).toMatchObject({ provider: "microsoft", authorization: "device_code" });
    await expect(adapter.preflight("send")).resolves.toMatchObject({
      provider: "microsoft",
      capability: "send",
      authorization: "device_code",
    });
    expect(providerCalls.markMicrosoftMessagesRead).not.toHaveBeenCalled();
  });

  it("publishes stable Ezra folder mappings and redacted health for each supported provider", async () => {
    const gmail = providerAdapterFor("gmail") as any;
    const microsoft = providerAdapterFor("microsoft") as any;

    expect(gmail.folderMappings()).toEqual({
      inbox: "INBOX", sent: "SENT", spam: "SPAM", trash: "TRASH",
    });
    expect(microsoft.folderMappings()).toEqual({
      inbox: "INBOX", sent: "SENT", spam: "JUNK", trash: "DELETED",
    });
    await expect(gmail.getHealth()).resolves.toEqual({
      provider: "gmail", ready: true, authorization: "browser",
    });
    await expect(microsoft.getHealth()).resolves.toEqual({
      provider: "microsoft", ready: true, authorization: "device_code",
    });
  });

  it("starts Gmail authorization only after its local bridge is ready", async () => {
    const adapter = providerAdapterFor("gmail");

    await expect(adapter.startAuthorization({ email: "owner@gmail.test", access: "maintenance" }))
      .resolves.toMatchObject({ provider: "gmail", mode: "browser", processId: 123 });

    expect(providerCalls.isGogInstalled).toHaveBeenCalledOnce();
    expect(providerCalls.startGmailAuthorization).toHaveBeenCalledWith({
      email: "owner@gmail.test",
      access: "maintenance",
    });
  });

  it("starts Microsoft authorization only after local configuration is ready", async () => {
    const adapter = providerAdapterFor("microsoft");

    await expect(adapter.startAuthorization({ email: "owner@outlook.test", access: "full" }))
      .resolves.toMatchObject({ provider: "microsoft", userCode: "ABCD", expiresIn: 900 });

    expect(providerCalls.isMicrosoftAuthConfigured).toHaveBeenCalledOnce();
    expect(providerCalls.startMicrosoftDeviceAuthorization).toHaveBeenCalledWith("full");
  });

  it("keeps Gmail authorization unavailable when the local bridge is missing", async () => {
    providerCalls.isGogInstalled.mockResolvedValue(false);

    await expect(providerAdapterFor("gmail").startAuthorization({
      email: "owner@gmail.test",
      access: "readonly",
    })).rejects.toThrow("local Gmail bridge");

    expect(providerCalls.startGmailAuthorization).not.toHaveBeenCalled();
  });

  it("keeps Microsoft authorization unavailable when local configuration is missing", async () => {
    providerCalls.isMicrosoftAuthConfigured.mockReturnValue(false);

    await expect(providerAdapterFor("microsoft").startAuthorization({
      email: "owner@outlook.test",
      access: "readonly",
    })).rejects.toThrow("MICROSOFT_CLIENT_ID");

    expect(providerCalls.startMicrosoftDeviceAuthorization).not.toHaveBeenCalled();
  });

  it("reads a Gmail inbox with account identity preserved for safe attachment retrieval", async () => {
    await providerAdapterFor("gmail").readInbox("owner@gmail.test", "acct-gmail", { syncRangeDays: 14 } as any);

    expect(providerCalls.searchGmailMessages).toHaveBeenCalledWith("owner@gmail.test", { syncRangeDays: 14 });
  });

  it("reads a Microsoft inbox with its account-scoped token", async () => {
    await providerAdapterFor("microsoft").readInbox("owner@outlook.test", "acct-outlook", { syncRangeDays: 14 } as any);

    expect(providerCalls.getMicrosoftAccessToken).toHaveBeenCalledWith("owner@outlook.test", "readonly");
    expect(providerCalls.listMicrosoftInboxMessages).toHaveBeenCalledWith("graph-token", "acct-outlook", { syncRangeDays: 14 });
  });

  it("reads a Gmail message through its owning account and normalizes its account identity", async () => {
    providerCalls.getGmailMessageEnvelope.mockResolvedValue({
      accountId: "other-account",
      externalMessageId: "gmail-message",
      threadId: "thread",
      senderName: "Sender",
      senderEmail: "sender@example.test",
      subject: "Subject",
      receivedAt: "2026-08-12T00:00:00.000Z",
      snippet: "Snippet",
      gmailUrl: "#",
      isUnread: true,
      labels: [],
      attachments: [],
    });

    await expect(providerAdapterFor("gmail").readMessage("owner@gmail.test", "acct-gmail", "gmail-message"))
      .resolves.toMatchObject({ accountId: "acct-gmail", externalMessageId: "gmail-message" });

    expect(providerCalls.getGmailMessageEnvelope).toHaveBeenCalledWith("owner@gmail.test", "gmail-message");
  });

  it("reads a Microsoft message through its owning account-scoped token", async () => {
    await expect(providerAdapterFor("microsoft").readMessage("owner@outlook.test", "acct-outlook", "graph-message"))
      .resolves.toMatchObject({ accountId: "acct-outlook", externalMessageId: "graph-message" });

    expect(providerCalls.getMicrosoftAccessToken).toHaveBeenCalledWith("owner@outlook.test", "readonly");
    expect(providerCalls.getMicrosoftMessageEnvelope).toHaveBeenCalledWith(
      "graph-token",
      "acct-outlook",
      "graph-message",
    );
  });

  it("gets Gmail reply metadata through the owning account", async () => {
    await expect(providerAdapterFor("gmail").getReplyMetadata("owner@gmail.test", "gmail-message"))
      .resolves.toMatchObject({ from: { email: "sender@gmail.test" } });

    expect(providerCalls.getGmailReplyMetadata).toHaveBeenCalledWith("owner@gmail.test", "gmail-message");
  });

  it("gets Microsoft reply metadata through the owning account", async () => {
    await expect(providerAdapterFor("microsoft").getReplyMetadata("owner@outlook.test", "graph-message"))
      .resolves.toMatchObject({ from: { email: "sender@outlook.test" } });

    expect(providerCalls.getMicrosoftReplyMetadata).toHaveBeenCalledWith("owner@outlook.test", "graph-message");
  });

  it("removes Gmail credentials through the Gmail adapter", async () => {
    await expect(providerAdapterFor("gmail").disconnect("owner@gmail.test"))
      .resolves.toMatchObject({ removed: true, backend: "gog-keyring" });

    expect(providerCalls.removeGmailAuthorization).toHaveBeenCalledWith("owner@gmail.test");
  });

  it("removes Microsoft credentials through the Microsoft adapter", async () => {
    await expect(providerAdapterFor("microsoft").disconnect("owner@outlook.test"))
      .resolves.toMatchObject({ removed: true, backend: "file" });

    expect(providerCalls.removeStoredMicrosoftRefreshToken).toHaveBeenCalledWith("owner@outlook.test");
  });

  it("maps reversible workspace trash through Gmail and Microsoft adapters", async () => {
    await providerAdapterFor("gmail").applyWorkspaceAction("owner@gmail.test", "trash", ["gmail-message"]);
    await providerAdapterFor("gmail").undoWorkspaceAction("owner@gmail.test", "trash", ["gmail-message"], []);
    await providerAdapterFor("microsoft").applyWorkspaceAction("owner@outlook.test", "trash", ["graph-message"]);
    await providerAdapterFor("microsoft").undoWorkspaceAction("owner@outlook.test", "trash", ["graph-message"], []);

    expect(providerCalls.moveGmailMessagesToTrash).toHaveBeenCalledWith("owner@gmail.test", ["gmail-message"]);
    expect(providerCalls.restoreGmailMessagesFromTrash).toHaveBeenCalledWith("owner@gmail.test", ["gmail-message"]);
    expect(providerCalls.moveMicrosoftMessagesToTrash).toHaveBeenCalledWith("owner@outlook.test", ["graph-message"]);
    expect(providerCalls.restoreMicrosoftMessagesFromTrash).toHaveBeenCalledWith("owner@outlook.test", ["graph-message"]);
  });

  it("owns Gmail and Microsoft outbound provider operations", async () => {
    const gmail = providerAdapterFor("gmail") as any;
    const microsoft = providerAdapterFor("microsoft") as any;
    const attachment = { name: "note.txt", mimeType: "text/plain", path: "C:\\safe\\note.txt", bytes: Buffer.from("safe") };

    await gmail.sendOutgoing("owner@gmail.test", {
      from: "owner@gmail.test", to: [{ email: "recipient@example.test", name: null }], cc: [], bcc: [],
      subject: "Subject", body: "Body", attachments: [attachment],
    });
    await microsoft.sendThreadedReply("owner@outlook.test", {
      externalMessageId: "graph-source", replyMode: "all", to: [{ email: "recipient@example.test", name: null }],
      cc: [], bcc: [], body: "Reply", attachments: [attachment], providerDraftId: null,
    });
    await microsoft.reconcileThreadedReply("owner@outlook.test", "graph-draft");

    expect(providerCalls.sendGmailOutgoing).toHaveBeenCalledWith(expect.objectContaining({ account: "owner@gmail.test" }));
    expect(providerCalls.sendMicrosoftReply).toHaveBeenCalledWith("owner@outlook.test", expect.objectContaining({ externalMessageId: "graph-source" }));
    expect(providerCalls.reconcileMicrosoftReply).toHaveBeenCalledWith("owner@outlook.test", "graph-draft");
  });

});
