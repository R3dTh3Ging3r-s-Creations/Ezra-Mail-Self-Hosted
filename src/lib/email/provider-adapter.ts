import fs from "node:fs/promises";
import {
  markGmailMessagesRead,
  markGmailMessagesUnread,
  setGmailMessagesStarred,
  setGmailMessagesImportant,
  moveGmailMessagesToSpam,
  moveGmailMessagesToTrash,
  restoreGmailMessagesFromSpam,
  restoreGmailMessagesFromTrash,
  isGogInstalled,
  getGmailAuthorizationCapabilities,
  startGmailAuthorization,
  searchGmailMessages,
  searchGmailSentEvidence,
  getGmailMessageEnvelope,
  getGmailReplyMetadata,
  sendGmailOutgoing,
  removeGmailAuthorization,
  downloadGmailAttachment,
  type GmailAuthorizationStart,
} from "./gmail";
import {
  markMicrosoftMessagesRead,
  markMicrosoftMessagesUnread,
  setMicrosoftMessagesFlagged,
  moveMicrosoftMessagesToJunk,
  moveMicrosoftMessagesToTrash,
  restoreMicrosoftMessagesFromJunk,
  restoreMicrosoftMessagesFromTrash,
  isMicrosoftAuthConfigured,
  startMicrosoftDeviceAuthorization,
  getMicrosoftAccessToken,
  listMicrosoftInboxMessages,
  listMicrosoftSentEvidence,
  getMicrosoftMessageEnvelope,
  getMicrosoftReplyMetadata,
  sendMicrosoftOutgoing,
  sendMicrosoftReply,
  reconcileMicrosoftReply,
  removeStoredMicrosoftRefreshToken,
  downloadMicrosoftAttachment,
} from "./microsoft";
import type {
  AccountProvider,
  EmailEnvelope,
  EmailRecipient,
  OrganizationKind,
  ProviderOrganizationCapabilities,
  ProviderSetupDiscovery,
  ReplyMode,
} from "./types";
import type { ProviderReplyMetadata } from "./reply-recipients";

export type { OrganizationKind, ProviderOrganizationCapabilities, ProviderOrganizationCapability } from "./types";

export type ProviderMaintenanceAction = "mark_read" | "spam";
export type ProviderWorkspaceAction = "read" | "spam" | "trash";
export type ProviderSetupCapability = "mail_read" | "send";
export type ProviderAuthorizationAccess = "readonly" | "maintenance" | "calendar" | "send" | "full";
export type ProviderAuthorizationStart =
  | ({ provider: "gmail" } & GmailAuthorizationStart)
  | {
      provider: "microsoft";
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string | null;
      expiresIn: number;
      interval: number;
      message: string | null;
    };
export type ProviderSetupTest = {
  provider: AccountProvider;
  capability: ProviderSetupCapability;
  ready: boolean;
  authorization: "browser" | "device_code";
  message: string;
};
export type ProviderFolderMappings = {
  inbox: string;
  sent: string;
  spam: string;
  trash: string;
};
export type ProviderHealth = {
  provider: AccountProvider;
  ready: boolean;
  authorization: "browser" | "device_code";
};
export type ProviderInboxRead = {
  messages: EmailEnvelope[];
  attachmentAccountEmail: string | null;
};
export type ProviderInboxReadOptions = { syncRangeDays?: number };
export type ProviderSentEvidence = {
  accountId: string;
  provider: AccountProvider;
  providerMessageId: string;
  providerThreadId: string;
  sentAt: string;
};
export type ProviderSentEvidenceOptions = {
  after: string;
  before: string;
  maxResults: number;
};
export type ProviderSentEvidencePage = {
  items: ProviderSentEvidence[];
  truncated: boolean;
};
export type ProviderOutgoingAttachment = {
  name: string;
  mimeType: string;
  path: string;
  bytes: Buffer;
};
export type ProviderOutgoingMessage = {
  from: string;
  to: EmailRecipient[];
  cc: EmailRecipient[];
  bcc: EmailRecipient[];
  subject: string;
  body: string;
  attachments: ProviderOutgoingAttachment[];
  replyToMessageId?: string | null;
};
export type ProviderThreadedReply = {
  externalMessageId: string;
  replyMode: ReplyMode;
  to: EmailRecipient[];
  cc: EmailRecipient[];
  bcc: EmailRecipient[];
  body: string;
  attachments: ProviderOutgoingAttachment[];
  providerDraftId: string | null;
  onDraftCreated?: (providerDraftId: string) => Promise<void>;
};
export type ProviderReplyReconciliation =
  | { status: "sent"; providerMessageId: string }
  | { status: "draft"; providerDraftId: string }
  | { status: "unknown" }
  | { status: "unsupported" };

export type ProviderMaintenanceAdapter = {
  discover: () => ProviderSetupDiscovery;
  preflight: (capability: ProviderSetupCapability) => Promise<ProviderSetupTest>;
  folderMappings: () => ProviderFolderMappings;
  getHealth: () => Promise<ProviderHealth>;
  startAuthorization: (input: { email: string; access: ProviderAuthorizationAccess }) => Promise<ProviderAuthorizationStart>;
  readInbox: (email: string, accountId: string, options?: ProviderInboxReadOptions) => Promise<ProviderInboxRead>;
  readSentEvidence: (email: string, accountId: string, options: ProviderSentEvidenceOptions) => Promise<ProviderSentEvidencePage>;
  readMessage: (email: string, accountId: string, messageId: string) => Promise<EmailEnvelope | null>;
  getReplyMetadata: (email: string, messageId: string) => Promise<ProviderReplyMetadata>;
  disconnect: (email: string) => Promise<{ removed: boolean; backend: string }>;
  applyWorkspaceAction: (email: string, action: ProviderWorkspaceAction, messageIds: string[]) => Promise<Record<string, unknown>>;
  undoWorkspaceAction: (email: string, action: ProviderWorkspaceAction, messageIds: string[], unreadMessageIds: string[]) => Promise<Record<string, unknown>>;
  downloadAttachment: (email: string, messageId: string, attachmentId: string, name: string) => Promise<Buffer>;
  sendOutgoing: (email: string, input: ProviderOutgoingMessage) => Promise<unknown>;
  sendThreadedReply: (email: string, input: ProviderThreadedReply) => Promise<unknown>;
  reconcileThreadedReply: (email: string, providerDraftId: string) => Promise<ProviderReplyReconciliation>;
  markRead: (email: string, messageIds: string[]) => Promise<Record<string, unknown>>;
  applyMaintenance: (
    email: string,
    action: ProviderMaintenanceAction,
    messageIds: string[],
  ) => Promise<Record<string, unknown>>;
  undoMaintenance: (
    email: string,
    action: ProviderMaintenanceAction,
    messageIds: string[],
  ) => Promise<Record<string, unknown>>;
  organizationCapabilities: () => ProviderOrganizationCapabilities;
  applyOrganizationState: (
    email: string,
    kind: OrganizationKind,
    desired: boolean,
    messageIds: string[],
  ) => Promise<Record<string, unknown>>;
};

const gmailAdapter: ProviderMaintenanceAdapter = {
  discover: () => ({ provider: "gmail", label: "Gmail", authorization: "browser", capabilities: { mailRead: true, send: true } }),
  async preflight(capability) {
    const ready = await isGogInstalled();
    return { provider: "gmail", capability, ready, authorization: "browser", message: ready ? "Gmail is ready for authorization." : "Gmail needs the local mail bridge installed before authorization." };
  },
  folderMappings: () => ({ inbox: "INBOX", sent: "SENT", spam: "SPAM", trash: "TRASH" }),
  async getHealth() {
    const { ready, authorization } = await this.preflight("mail_read");
    return { provider: "gmail", ready, authorization };
  },
  async startAuthorization(input) {
    if (!(await isGogInstalled())) {
      throw new Error("The local Gmail bridge is not installed or GOG_PATH is not configured.");
    }
    const { email, access } = input;
    if (access === "send" || access === "full") {
      throw new Error("Gmail authorization does not support that access level.");
    }
    return { provider: "gmail", ...await startGmailAuthorization({ email, access }) };
  },
  async readInbox(email, accountId, options) {
    const messages = await searchGmailMessages(email, options);
    for (const message of messages) message.accountId = accountId;
    return { messages, attachmentAccountEmail: email };
  },
  readSentEvidence(email, accountId, options) {
    return searchGmailSentEvidence(email, accountId, options);
  },
  async readMessage(email, accountId, messageId) {
    const message = await getGmailMessageEnvelope(email, messageId);
    return message ? { ...message, accountId } : null;
  },
  getReplyMetadata(email, messageId) {
    return getGmailReplyMetadata(email, messageId);
  },
  disconnect(email) {
    return removeGmailAuthorization(email);
  },
  async applyWorkspaceAction(email, action, messageIds) {
    const capabilities = await getGmailAuthorizationCapabilities(email);
    if (!capabilities.modify) throw new Error("Gmail maintenance permission is required for this action.");
    if (action === "spam") return moveGmailMessagesToSpam(email, messageIds);
    if (action === "trash") return moveGmailMessagesToTrash(email, messageIds);
    return markGmailMessagesRead(email, messageIds);
  },
  undoWorkspaceAction(email, action, messageIds, unreadMessageIds) {
    if (action === "spam") return restoreGmailMessagesFromSpam(email, messageIds);
    if (action === "trash") return restoreGmailMessagesFromTrash(email, messageIds);
    return unreadMessageIds.length ? markGmailMessagesUnread(email, unreadMessageIds) : Promise.resolve({ modified: 0 });
  },
  async downloadAttachment(email, messageId, attachmentId, name) {
    const downloaded = await downloadGmailAttachment({ account: email, messageId, attachmentId, name });
    try {
      return await fs.readFile(downloaded.path);
    } finally {
      await fs.rm(downloaded.directory, { recursive: true, force: true });
    }
  },
  sendOutgoing(email, input) {
    return sendGmailOutgoing({ account: email, ...input });
  },
  sendThreadedReply(email, input) {
    return sendGmailOutgoing({
      account: email,
      from: email,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: "Re: message",
      body: input.body,
      attachments: input.attachments,
      replyToMessageId: input.externalMessageId,
    });
  },
  reconcileThreadedReply() {
    return Promise.resolve({ status: "unsupported" as const });
  },
  async markRead(email, messageIds) {
    const capabilities = await getGmailAuthorizationCapabilities(email);
    if (!capabilities.modify) {
      throw new Error("Gmail maintenance permission is not authorized yet. Reconnect Gmail with modify access.");
    }
    return markGmailMessagesRead(email, messageIds);
  },
  applyMaintenance(email, action, messageIds) {
    return action === "spam"
      ? moveGmailMessagesToSpam(email, messageIds)
      : markGmailMessagesRead(email, messageIds);
  },
  undoMaintenance(email, action, messageIds) {
    return action === "spam"
      ? restoreGmailMessagesFromSpam(email, messageIds)
      : markGmailMessagesUnread(email, messageIds);
  },
  organizationCapabilities() {
    return {
      pin: { state: "supported", mapping: "gmail_star" },
      flag: { state: "supported", mapping: "gmail_important" },
    };
  },
  async applyOrganizationState(email, kind, desired, messageIds) {
    const capabilities = await getGmailAuthorizationCapabilities(email);
    if (!capabilities.modify) {
      throw new Error("Gmail maintenance permission is not authorized yet. Reconnect Gmail with modify access.");
    }
    return kind === "pin"
      ? setGmailMessagesStarred(email, messageIds, desired)
      : setGmailMessagesImportant(email, messageIds, desired);
  },
};

const microsoftAdapter: ProviderMaintenanceAdapter = {
  discover: () => ({ provider: "microsoft", label: "Microsoft", authorization: "device_code", capabilities: { mailRead: true, send: true } }),
  async preflight(capability) {
    const ready = isMicrosoftAuthConfigured();
    return { provider: "microsoft", capability, ready, authorization: "device_code", message: ready ? "Microsoft is ready for authorization." : "Microsoft sign-in needs local setup before authorization." };
  },
  folderMappings: () => ({ inbox: "INBOX", sent: "SENT", spam: "JUNK", trash: "DELETED" }),
  async getHealth() {
    const { ready, authorization } = await this.preflight("mail_read");
    return { provider: "microsoft", ready, authorization };
  },
  async startAuthorization(input) {
    if (!isMicrosoftAuthConfigured()) {
      throw new Error("Microsoft sign-in needs MICROSOFT_CLIENT_ID configured.");
    }
    const challenge = await startMicrosoftDeviceAuthorization(input.access);
    return { provider: "microsoft", ...challenge };
  },
  async readInbox(email, accountId, options) {
    const accessToken = await getMicrosoftAccessToken(email, "readonly");
    return {
      messages: await listMicrosoftInboxMessages(accessToken, accountId, options),
      attachmentAccountEmail: null,
    };
  },
  async readSentEvidence(email, accountId, options) {
    const accessToken = await getMicrosoftAccessToken(email, "readonly");
    return listMicrosoftSentEvidence(accessToken, accountId, options);
  },
  async readMessage(email, accountId, messageId) {
    const accessToken = await getMicrosoftAccessToken(email, "readonly");
    return getMicrosoftMessageEnvelope(accessToken, accountId, messageId);
  },
  getReplyMetadata(email, messageId) {
    return getMicrosoftReplyMetadata(email, messageId);
  },
  disconnect(email) {
    return removeStoredMicrosoftRefreshToken(email);
  },
  applyWorkspaceAction(email, action, messageIds) {
    if (action === "spam") return moveMicrosoftMessagesToJunk(email, messageIds);
    if (action === "trash") return moveMicrosoftMessagesToTrash(email, messageIds);
    return markMicrosoftMessagesRead(email, messageIds);
  },
  undoWorkspaceAction(email, action, messageIds, unreadMessageIds) {
    if (action === "spam") return restoreMicrosoftMessagesFromJunk(email, messageIds);
    if (action === "trash") return restoreMicrosoftMessagesFromTrash(email, messageIds);
    return unreadMessageIds.length ? markMicrosoftMessagesUnread(email, unreadMessageIds) : Promise.resolve({ modified: 0 });
  },
  downloadAttachment(email, messageId, attachmentId) {
    return downloadMicrosoftAttachment(email, messageId, attachmentId);
  },
  sendOutgoing(email, input) {
    return sendMicrosoftOutgoing(email, {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      body: input.body,
      attachments: input.attachments.map(({ name, mimeType, bytes }) => ({ name, mimeType, bytes })),
    });
  },
  sendThreadedReply(email, input) {
    return sendMicrosoftReply(email, {
      externalMessageId: input.externalMessageId,
      replyMode: input.replyMode,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      body: input.body,
      attachments: input.attachments.map(({ name, mimeType, bytes }) => ({ name, mimeType, bytes })),
      providerDraftId: input.providerDraftId,
      onDraftCreated: input.onDraftCreated,
    });
  },
  reconcileThreadedReply(email, providerDraftId) {
    return reconcileMicrosoftReply(email, providerDraftId);
  },
  markRead(email, messageIds) {
    return markMicrosoftMessagesRead(email, messageIds);
  },
  applyMaintenance(email, action, messageIds) {
    return action === "spam"
      ? moveMicrosoftMessagesToJunk(email, messageIds)
      : markMicrosoftMessagesRead(email, messageIds);
  },
  undoMaintenance(email, action, messageIds) {
    return action === "spam"
      ? restoreMicrosoftMessagesFromJunk(email, messageIds)
      : markMicrosoftMessagesUnread(email, messageIds);
  },
  organizationCapabilities() {
    return {
      pin: { state: "unavailable", reason: "Ezra cannot safely map Pin for this Microsoft account yet." },
      flag: { state: "supported", mapping: "microsoft_follow_up" },
    };
  },
  async applyOrganizationState(email, kind, desired, messageIds) {
    if (kind === "pin") throw new Error("Ezra cannot safely map Pin for this Microsoft account yet.");
    return setMicrosoftMessagesFlagged(email, messageIds, desired);
  },
};

export function providerAdapterFor(provider: AccountProvider): ProviderMaintenanceAdapter {
  return provider === "microsoft" ? microsoftAdapter : gmailAdapter;
}
