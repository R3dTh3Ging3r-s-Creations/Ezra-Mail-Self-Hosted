import { spawn } from "node:child_process";
import { calendarDateRange } from "./calendar-day";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CalendarAttendee, CalendarEvent, EmailEnvelope, EmailRecipient } from "./types";
import type { ProviderReplyMetadata } from "./reply-recipients";
import type { ProviderSentEvidence, ProviderSentEvidenceOptions, ProviderSentEvidencePage } from "./provider-adapter";

export type MicrosoftAccessMode = "readonly" | "maintenance" | "calendar" | "send" | "full";

type DeviceCodeResponse = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  message?: string;
  error?: string;
  error_description?: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

type ProfileResponse = {
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
};

export type MicrosoftGraphMessage = {
  id?: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  receivedDateTime?: string;
  lastModifiedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
  replyTo?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  ccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  bccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  isDraft?: boolean;
  sentDateTime?: string;
  isRead?: boolean;
  flag?: { flagStatus?: "notFlagged" | "complete" | "flagged" | string };
  webLink?: string;
  hasAttachments?: boolean;
  categories?: string[];
};

type MicrosoftGraphAttachment = {
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
  "@odata.type"?: string;
};

export type MicrosoftGraphCalendarEvent = {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  location?: { displayName?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: Array<{
    emailAddress?: { name?: string; address?: string };
    status?: { response?: string; time?: string };
    type?: string;
  }>;
  webLink?: string;
  showAs?: string;
  sensitivity?: string;
  isCancelled?: boolean;
  lastModifiedDateTime?: string;
  createdDateTime?: string;
};

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_GRANT = "refresh_token";
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
export const MICROSOFT_CALENDAR_EVENT_SELECT_FIELDS = [
  "id",
  "subject",
  "bodyPreview",
  "body",
  "start",
  "end",
  "isAllDay",
  "location",
  "organizer",
  "attendees",
  "webLink",
  "showAs",
  "sensitivity",
  "isCancelled",
  "lastModifiedDateTime",
  "createdDateTime",
] as const;

export function isMicrosoftAuthConfigured() {
  return Boolean(process.env.MICROSOFT_CLIENT_ID);
}

export async function startMicrosoftDeviceAuthorization(access: MicrosoftAccessMode) {
  const clientId = microsoftClientId();
  const body = new URLSearchParams({
    client_id: clientId,
    scope: microsoftScopes(access).join(" "),
  });
  const response = await fetch(`${microsoftAuthority()}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json()) as DeviceCodeResponse;
  if (!response.ok || payload.error || !payload.device_code || !payload.user_code) {
    throw new Error(payload.error_description || payload.error || "Microsoft sign-in could not start.");
  }
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri || "https://microsoft.com/devicelogin",
    verificationUriComplete: payload.verification_uri_complete || null,
    expiresIn: Number(payload.expires_in || 900),
    interval: Number(payload.interval || 5),
    message: payload.message || null,
  };
}

export async function completeMicrosoftDeviceAuthorization(deviceCode: string) {
  const clientId = microsoftClientId();
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: DEVICE_GRANT,
    device_code: deviceCode,
  });
  const response = await fetch(`${microsoftAuthority()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json()) as TokenResponse;
  if (payload.error === "authorization_pending") {
    return { status: "pending" as const, message: "Microsoft sign-in is still waiting." };
  }
  if (payload.error) {
    throw new Error(payload.error_description || payload.error);
  }
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error("Microsoft did not return a usable mailbox token.");
  }
  return {
    status: "connected" as const,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresIn: Number(payload.expires_in || 3600),
    scopes: microsoftGrantedScopes(payload),
  };
}

function microsoftGrantedScopes(payload: TokenResponse) {
  const responseScopes = String(payload.scope || "").split(/\s+/).filter(Boolean);
  if (responseScopes.length) return Array.from(new Set(responseScopes));
  try {
    const tokenPayload = JSON.parse(Buffer.from(String(payload.access_token).split(".")[1], "base64url").toString("utf8")) as { scp?: string };
    return Array.from(new Set(String(tokenPayload.scp || "").split(/\s+/).filter(Boolean)));
  } catch {
    return [];
  }
}

export async function getMicrosoftAccessToken(
  email: string,
  access: MicrosoftAccessMode = "readonly",
) {
  const refreshToken = await getStoredMicrosoftRefreshToken(email);
  const token = await refreshMicrosoftAccessToken(refreshToken, access);
  if (token.refreshToken) await storeMicrosoftRefreshToken(email, token.refreshToken);
  return token.accessToken;
}

export async function refreshMicrosoftAccessToken(
  refreshToken: string,
  access: MicrosoftAccessMode = "readonly",
) {
  const clientId = microsoftClientId();
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: REFRESH_GRANT,
    refresh_token: refreshToken,
    scope: microsoftScopes(access).join(" "),
  });
  const response = await fetch(`${microsoftAuthority()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || payload.error || !payload.access_token) {
    throw new Error(
      microsoftPermissionMessage(
        access,
        payload.error_description || payload.error || "Microsoft token refresh failed.",
      ),
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || null,
    expiresIn: Number(payload.expires_in || 3600),
  };
}

export async function getMicrosoftProfile(accessToken: string) {
  const response = await fetch(
    `${GRAPH_ROOT}/me?$select=displayName,mail,userPrincipalName`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  const payload = (await response.json()) as ProfileResponse & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message || "Microsoft profile lookup failed.");
  }
  return {
    displayName: payload.displayName || "",
    email: payload.mail || payload.userPrincipalName || "",
    userPrincipalName: payload.userPrincipalName || "",
  };
}

export async function listMicrosoftInboxMessages(accessToken: string, accountId: string, options?: { syncRangeDays?: number }) {
  const fields = [
    "id",
    "conversationId",
    "internetMessageId",
    "subject",
    "receivedDateTime",
    "lastModifiedDateTime",
    "bodyPreview",
    "body",
    "from",
    "isRead",
    "flag",
    "webLink",
    "hasAttachments",
    "categories",
  ].join(",");
  const days = [2, 7, 14, 30].includes(Number(options?.syncRangeDays)) ? Number(options?.syncRangeDays) : 2;
  const after = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const response = await fetch(
    `${GRAPH_ROOT}/me/mailFolders/inbox/messages?$top=25&$orderby=receivedDateTime desc&$filter=${encodeURIComponent(`receivedDateTime ge ${after}`)}&$select=${fields}`,
    { headers: microsoftGraphHeaders(accessToken) },
  );
  const payload = (await response.json()) as {
    value?: MicrosoftGraphMessage[];
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message || "Microsoft inbox polling failed.");
  }
  return (payload.value || []).map((message) => normalizeMicrosoftMessage(accountId, message));
}

export async function listMicrosoftSentEvidence(
  accessToken: string,
  accountId: string,
  options: ProviderSentEvidenceOptions,
): Promise<ProviderSentEvidencePage> {
  const { after, before, maxResults } = validateSentEvidenceOptions(options);
  const filter = `sentDateTime ge ${after} and sentDateTime le ${before}`;
  const payload = await microsoftGraphJson<{ value?: unknown }>(
    accessToken,
    `${GRAPH_ROOT}/me/mailFolders/sentitems/messages?$top=${maxResults}&$orderby=sentDateTime desc&$filter=${encodeURIComponent(filter)}&$select=id,conversationId,sentDateTime`,
    {},
    "readonly",
  );
  const rawSlots = Array.isArray(payload.value) ? payload.value : [];
  const rows = rawSlots.filter(isRecord);
  return {
    items: rows.flatMap((message) => {
      const providerMessageId = strictIdentifier(message.id);
      const providerThreadId = strictIdentifier(message.conversationId);
      const sentAt = canonicalIsoTimestamp(message.sentDateTime);
      if (!providerMessageId || !providerThreadId || !sentAt || sentAt < after || sentAt > before) return [];
      return [{ accountId, provider: "microsoft" as const, providerMessageId, providerThreadId, sentAt } satisfies ProviderSentEvidence];
    }),
    truncated: rawSlots.length >= maxResults,
  };
}

export async function getMicrosoftMessageEnvelope(
  accessToken: string,
  accountId: string,
  messageId: string,
) {
  const fields = [
    "id",
    "conversationId",
    "internetMessageId",
    "subject",
    "receivedDateTime",
    "lastModifiedDateTime",
    "bodyPreview",
    "body",
    "from",
    "isRead",
    "flag",
    "webLink",
    "hasAttachments",
    "categories",
  ].join(",");
  const payload = await microsoftGraphJson<MicrosoftGraphMessage>(
    accessToken,
    `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}?$select=${fields}`,
    {},
    "readonly",
  );
  const normalized = normalizeMicrosoftMessage(accountId, payload);
  if (payload.hasAttachments) normalized.attachments = await listMicrosoftMessageAttachments(accessToken, messageId);
  return normalized;
}

export async function getMicrosoftReplyMetadata(email: string, messageId: string): Promise<ProviderReplyMetadata> {
  const accessToken = await getMicrosoftAccessToken(email, "readonly");
  const fields = "subject,from,replyTo,toRecipients,ccRecipients";
  const payload = await microsoftGraphJson<MicrosoftGraphMessage>(
    accessToken,
    `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}?$select=${fields}`,
    {},
    "readonly",
  );
  return {
    from: microsoftRecipient(payload.from?.emailAddress),
    replyTo: microsoftRecipientList(payload.replyTo),
    to: microsoftRecipientList(payload.toRecipients),
    cc: microsoftRecipientList(payload.ccRecipients),
    subject: payload.subject || "(no subject)",
  };
}

export async function listMicrosoftMessageAttachments(accessToken: string, messageId: string) {
  const payload = await microsoftGraphJson<{ value?: MicrosoftGraphAttachment[] }>(
    accessToken,
    `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
    {},
    "readonly",
  );
  return (payload.value || []).filter((item) => item.id && item.name).map((item) => ({ id: String(item.id), name: String(item.name), mimeType: item.contentType || "application/octet-stream", size: Number(item.size || 0) }));
}

export async function downloadMicrosoftAttachment(email: string, messageId: string, attachmentId: string) {
  const accessToken = await getMicrosoftAccessToken(email, "readonly");
  const payload = await microsoftGraphJson<MicrosoftGraphAttachment>(
    accessToken,
    `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    {},
    "readonly",
  );
  if (!payload.contentBytes) throw new Error("Microsoft did not return downloadable attachment content.");
  return Buffer.from(payload.contentBytes, "base64");
}

export async function markMicrosoftMessagesRead(email: string, messageIds: string[]) {
  return patchMicrosoftMessageReadState(email, messageIds, true);
}

export async function markMicrosoftMessagesUnread(email: string, messageIds: string[]) {
  return patchMicrosoftMessageReadState(email, messageIds, false);
}

export async function setMicrosoftMessagesFlagged(email: string, messageIds: string[], flagged: boolean) {
  if (!messageIds.length) return { modified: 0 };
  const accessToken = await getMicrosoftAccessToken(email, "maintenance");
  for (const messageId of messageIds) {
    await microsoftGraphJson(
      accessToken,
      `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ flag: { flagStatus: flagged ? "flagged" : "notFlagged" } }),
      },
      "maintenance",
    );
  }
  return { modified: messageIds.length };
}

export async function moveMicrosoftMessagesToTrash(email: string, messageIds: string[]) {
  return moveMicrosoftMessages(email, messageIds, "deleteditems");
}

export async function restoreMicrosoftMessagesFromTrash(email: string, messageIds: string[]) {
  return moveMicrosoftMessages(email, messageIds, "inbox");
}

export async function moveMicrosoftMessagesToJunk(email: string, messageIds: string[]) {
  return moveMicrosoftMessages(email, messageIds, "junkemail");
}

export async function restoreMicrosoftMessagesFromJunk(email: string, messageIds: string[]) {
  return moveMicrosoftMessages(email, messageIds, "inbox");
}

export async function listMicrosoftCalendarEvents(
  accessToken: string,
  accountId: string,
  options: { from: string; to: string },
) {
  const fields = MICROSOFT_CALENDAR_EVENT_SELECT_FIELDS.join(",");
  const url =
    `${GRAPH_ROOT}/me/calendarView?startDateTime=${encodeURIComponent(options.from)}` +
    `&endDateTime=${encodeURIComponent(options.to)}&$top=100&$orderby=start/dateTime&$select=${fields}`;
  const payload = await microsoftGraphJson<{ value?: MicrosoftGraphCalendarEvent[] }>(
    accessToken,
    url,
    { headers: { Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"' } },
    "calendar",
  );
  return (payload.value || []).map((event) => normalizeMicrosoftCalendarEvent(accountId, event));
}

export async function createMicrosoftCalendarEvent(
  email: string,
  input: {
    title: string;
    description: string;
    location: string;
    startsAt: string;
    endsAt: string;
    isAllDay: boolean;
    timezone: string;
    attendees: string[];
    reminderMinutes: number | null;
    isBusy: boolean;
    privacy: string;
  },
) {
  const accessToken = await getMicrosoftAccessToken(email, "calendar");
  const event = await microsoftGraphJson<MicrosoftGraphCalendarEvent>(
    accessToken,
    `${GRAPH_ROOT}/me/events`,
    {
      method: "POST",
      body: JSON.stringify({
        subject: input.title,
        body: { contentType: "text", content: input.description },
        start: {
          dateTime: input.isAllDay ? input.startsAt.slice(0, 10) : input.startsAt,
          timeZone: input.isAllDay ? "UTC" : input.timezone,
        },
        end: {
          dateTime: input.isAllDay ? input.endsAt.slice(0, 10) : input.endsAt,
          timeZone: input.isAllDay ? "UTC" : input.timezone,
        },
        isAllDay: input.isAllDay,
        location: input.location ? { displayName: input.location } : undefined,
        attendees: input.attendees.map((attendee) => ({
          emailAddress: { address: attendee },
          type: "required",
        })),
        showAs: input.isBusy ? "busy" : "free",
        sensitivity: input.privacy === "private" ? "private" : "normal",
        isReminderOn: input.reminderMinutes !== null,
        reminderMinutesBeforeStart: input.reminderMinutes ?? undefined,
      }),
    },
    "calendar",
  );
  return normalizeMicrosoftCalendarEvent("pending", event);
}

export async function sendMicrosoftOutgoing(
  email: string,
  input: {
    to: EmailRecipient[];
    cc: EmailRecipient[];
    bcc: EmailRecipient[];
    subject: string;
    body: string;
    attachments?: Array<{ name: string; mimeType: string; bytes: Buffer }>;
  },
) {
  const accessToken = await getMicrosoftAccessToken(email, "send");
  await microsoftGraphJson(
    accessToken,
    `${GRAPH_ROOT}/me/sendMail`,
    {
      method: "POST",
      body: JSON.stringify({
        message: {
          subject: input.subject,
          body: {
            contentType: "Text",
            content: input.body,
          },
          toRecipients: microsoftRecipients(input.to),
          ccRecipients: microsoftRecipients(input.cc),
          bccRecipients: microsoftRecipients(input.bcc),
          attachments: (input.attachments || []).map((attachment) => ({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: attachment.name,
            contentType: attachment.mimeType,
            contentBytes: attachment.bytes.toString("base64"),
          })),
        },
        saveToSentItems: true,
      }),
    },
    "send",
  );
  return { accepted: true, provider: "microsoft", providerMessageId: null };
}

export class MicrosoftSendUnknownError extends Error {
  constructor(message: string, public readonly providerDraftId: string) {
    super(message);
    this.name = "MicrosoftSendUnknownError";
  }
}

export async function sendMicrosoftReply(
  email: string,
  input: {
    externalMessageId: string;
    replyMode: "sender" | "all";
    to: EmailRecipient[];
    cc: EmailRecipient[];
    bcc: EmailRecipient[];
    body: string;
    attachments?: Array<{ name: string; mimeType: string; bytes: Buffer }>;
    providerDraftId?: string | null;
    onDraftCreated?: (providerDraftId: string) => Promise<void>;
  },
) {
  const accessToken = await getMicrosoftAccessToken(email, "full");
  let providerDraftId = input.providerDraftId || null;
  const resumedProviderDraft = Boolean(providerDraftId);
  if (!providerDraftId) {
    const action = input.replyMode === "all" ? "createReplyAll" : "createReply";
    const created = await microsoftGraphJson<MicrosoftGraphMessage>(
      accessToken,
      `${GRAPH_ROOT}/me/messages/${encodeURIComponent(input.externalMessageId)}/${action}`,
      { method: "POST" },
      "full",
    );
    if (!created.id) throw new Error("Microsoft created a reply draft without an identifier.");
    providerDraftId = created.id;
    await input.onDraftCreated?.(providerDraftId);
  }

  await microsoftGraphJson(
    accessToken,
    `${GRAPH_ROOT}/me/messages/${encodeURIComponent(providerDraftId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        body: { contentType: "Text", content: input.body },
        toRecipients: microsoftRecipients(input.to),
        ccRecipients: microsoftRecipients(input.cc),
        bccRecipients: microsoftRecipients(input.bcc),
      }),
    },
    "full",
  );
  if (resumedProviderDraft) {
    const existing = await microsoftGraphJson<{ value?: MicrosoftGraphAttachment[] }>(
      accessToken,
      `${GRAPH_ROOT}/me/messages/${encodeURIComponent(providerDraftId)}/attachments?$select=id,isInline`,
      {},
      "full",
    );
    for (const attachment of existing.value || []) {
      if (!attachment.id || attachment.isInline) continue;
      await microsoftGraphJson(
        accessToken,
        `${GRAPH_ROOT}/me/messages/${encodeURIComponent(providerDraftId)}/attachments/${encodeURIComponent(attachment.id)}`,
        { method: "DELETE" },
        "full",
      );
    }
  }
  for (const attachment of input.attachments || []) {
    if (attachment.bytes.length < 3 * 1024 * 1024) {
      await microsoftGraphJson(
        accessToken,
        `${GRAPH_ROOT}/me/messages/${encodeURIComponent(providerDraftId)}/attachments`,
        {
          method: "POST",
          body: JSON.stringify({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: attachment.name,
            contentType: attachment.mimeType,
            contentBytes: attachment.bytes.toString("base64"),
          }),
        },
        "full",
      );
    } else {
      await uploadMicrosoftDraftAttachment(accessToken, providerDraftId, attachment);
    }
  }

  const verified = await microsoftGraphJson<MicrosoftGraphMessage>(
    accessToken,
    `${GRAPH_ROOT}/me/messages/${encodeURIComponent(providerDraftId)}?$select=id,isDraft,body,toRecipients,ccRecipients,bccRecipients`,
    {},
    "full",
  );
  if (verified.isDraft === false) throw new Error("Microsoft reply draft was no longer editable before send.");
  assertMicrosoftRecipients(verified.toRecipients, input.to, "To");
  assertMicrosoftRecipients(verified.ccRecipients, input.cc, "Cc");
  assertMicrosoftRecipients(verified.bccRecipients, input.bcc, "Bcc");

  try {
    await microsoftGraphJson(
      accessToken,
      `${GRAPH_ROOT}/me/messages/${encodeURIComponent(providerDraftId)}/send`,
      { method: "POST" },
      "full",
    );
  } catch (error) {
    throw new MicrosoftSendUnknownError(
      `Microsoft did not confirm whether the final reply send completed. Check provider status before retrying. ${error instanceof Error ? error.message : String(error)}`,
      providerDraftId,
    );
  }
  return { accepted: true, provider: "microsoft", providerMessageId: providerDraftId, providerDraftId };
}

export async function reconcileMicrosoftReply(email: string, providerDraftId: string) {
  const accessToken = await getMicrosoftAccessToken(email, "full");
  try {
    const message = await microsoftGraphJson<MicrosoftGraphMessage>(
      accessToken,
      `${GRAPH_ROOT}/me/messages/${encodeURIComponent(providerDraftId)}?$select=id,isDraft,sentDateTime`,
      {},
      "full",
    );
    if (message.isDraft === false || message.sentDateTime) return { status: "sent" as const, providerMessageId: message.id || providerDraftId };
    if (message.isDraft === true) return { status: "draft" as const, providerDraftId: message.id || providerDraftId };
    return { status: "unknown" as const };
  } catch {
    return { status: "unknown" as const };
  }
}

async function uploadMicrosoftDraftAttachment(
  accessToken: string,
  providerDraftId: string,
  attachment: { name: string; mimeType: string; bytes: Buffer },
) {
  const session = await microsoftGraphJson<{ uploadUrl?: string }>(
    accessToken,
    `${GRAPH_ROOT}/me/messages/${encodeURIComponent(providerDraftId)}/attachments/createUploadSession`,
    {
      method: "POST",
      body: JSON.stringify({
        AttachmentItem: {
          attachmentType: "file",
          name: attachment.name,
          size: attachment.bytes.length,
          contentType: attachment.mimeType,
        },
      }),
    },
    "full",
  );
  if (!session.uploadUrl) throw new Error("Microsoft did not return an attachment upload session.");
  const chunkSize = 3_276_800;
  for (let start = 0; start < attachment.bytes.length; start += chunkSize) {
    const endExclusive = Math.min(start + chunkSize, attachment.bytes.length);
    const response = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: {
        "content-length": String(endExclusive - start),
        "content-range": `bytes ${start}-${endExclusive - 1}/${attachment.bytes.length}`,
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array(attachment.bytes.subarray(start, endExclusive)).buffer,
    });
    if (!response.ok) throw new Error(`Microsoft attachment upload failed with ${response.status}.`);
  }
}

function assertMicrosoftRecipients(
  actual: Array<{ emailAddress?: { name?: string; address?: string } }> | undefined,
  expected: EmailRecipient[],
  label: string,
) {
  const actualEmails = microsoftRecipientList(actual).map((item) => item.email).sort();
  const expectedEmails = expected.map((item) => item.email.toLowerCase()).sort();
  if (JSON.stringify(actualEmails) !== JSON.stringify(expectedEmails)) {
    throw new Error(`Microsoft ${label} recipients did not match the exact approved draft.`);
  }
}

export function normalizeMicrosoftCalendarEvent(
  accountId: string,
  event: MicrosoftGraphCalendarEvent,
): Omit<CalendarEvent, "id" | "accountLabel" | "accountProvider" | "syncedAt"> {
  const organizer = event.organizer?.emailAddress;
  const dateRange = event.isAllDay ? calendarDateRange(event.start?.dateTime?.slice(0, 10), event.end?.dateTime?.slice(0, 10)) : null;
  if (event.isAllDay && (!dateRange || !Number.isFinite(Date.parse(normalizeMicrosoftDateTime(event.start?.dateTime) || "")) || !Number.isFinite(Date.parse(normalizeMicrosoftDateTime(event.end?.dateTime) || "")))) throw new Error("Microsoft all-day calendar range is invalid.");
  return {
    accountId,
    externalEventId: event.id || "",
    calendarId: "primary",
    calendarName: "Primary",
    title: event.subject || "(no title)",
    description: stripHtml(event.body?.content || event.bodyPreview || "") || null,
    location: event.location?.displayName || null,
    startsAt: normalizeMicrosoftDateTime(event.start?.dateTime) || new Date(0).toISOString(),
    endsAt: normalizeMicrosoftDateTime(event.end?.dateTime) || new Date(0).toISOString(),
    isAllDay: Boolean(event.isAllDay),
    dateRange,
    timezone: event.start?.timeZone || event.end?.timeZone || null,
    status: event.isCancelled ? "cancelled" : "confirmed",
    visibility: event.sensitivity || null,
    isBusy: !["free", "tentative"].includes(String(event.showAs || "busy").toLowerCase()),
    organizerName: organizer?.name || null,
    organizerEmail: organizer?.address || null,
    attendees: normalizeMicrosoftAttendees(event.attendees),
    webLink: event.webLink || null,
    updatedAt: event.lastModifiedDateTime || event.createdDateTime || null,
  };
}

export function normalizeMicrosoftMessage(
  accountId: string,
  message: MicrosoftGraphMessage,
): EmailEnvelope {
  const sender = message.from?.emailAddress;
  const externalMessageId = message.id || message.internetMessageId || "";
  if (!externalMessageId) throw new Error("Microsoft message did not include an id.");
  const categories = Array.isArray(message.categories) ? message.categories : [];
  return {
    accountId,
    externalMessageId,
    threadId: message.conversationId || externalMessageId,
    historyId: message.lastModifiedDateTime || null,
    senderName: sender?.name || sender?.address || "Unknown sender",
    senderEmail: (sender?.address || "").toLowerCase(),
    subject: message.subject || "(no subject)",
    receivedAt: message.receivedDateTime || new Date(0).toISOString(),
    snippet: message.bodyPreview || "",
    bodyText: stripHtml(message.body?.content || message.bodyPreview || ""),
    bodyHtml: message.body?.contentType?.toLowerCase() === "html" ? message.body.content?.slice(0, 200_000) : undefined,
    providerRevision: message.lastModifiedDateTime || message.internetMessageId || null,
    gmailUrl: message.webLink || "#",
    isUnread: message.isRead === false,
    isFlagged: message.flag?.flagStatus === "flagged",
    labels: [
      "INBOX",
      ...(message.isRead === false ? ["UNREAD"] : []),
      ...(message.flag?.flagStatus === "flagged" ? ["MS_FOLLOW_UP"] : []),
      ...categories.map((category) => `MS_CATEGORY:${category}`),
    ],
    attachments: message.hasAttachments ? [{ id: "microsoft", name: "Attachment", mimeType: "application/octet-stream", size: 0 }] : [],
  };
}

export async function storeMicrosoftRefreshToken(email: string, refreshToken: string) {
  if (
    process.env.EZRA_MICROSOFT_TOKEN_BACKEND === "file" ||
    process.platform !== "win32"
  ) {
    await storeMicrosoftRefreshTokenFile(email, refreshToken);
    return { stored: true, backend: "file" as const };
  }
  if (process.env.NODE_ENV === "test") return { stored: true, backend: "test" as const };
  const target = `EzraMail:Microsoft:${email}`;
  await runCredentialCommand([
    `/generic:${target}`,
    `/user:${email}`,
    `/pass:${refreshToken}`,
  ]);
  return { stored: true, backend: "windows-credential-manager" as const };
}

export async function getStoredMicrosoftRefreshToken(email: string) {
  if (
    process.env.EZRA_MICROSOFT_TOKEN_BACKEND !== "file" &&
    process.platform === "win32"
  ) {
    throw new Error("Reading Microsoft tokens from Windows Credential Manager is not implemented.");
  }
  const raw = await fs.readFile(microsoftCredentialPath(email), "utf8");
  const payload = JSON.parse(raw) as { refreshToken?: string };
  if (!payload.refreshToken) throw new Error("Stored Microsoft token was empty.");
  return payload.refreshToken;
}

export async function removeStoredMicrosoftRefreshToken(email: string) {
  if (
    process.env.EZRA_MICROSOFT_TOKEN_BACKEND === "file" ||
    process.platform !== "win32"
  ) {
    const target = microsoftCredentialPath(email);
    const existed = await fs.stat(target).then(() => true).catch(() => false);
    await fs.rm(target, { force: true });
    return { removed: existed, backend: "file" as const };
  }
  if (process.env.NODE_ENV === "test") return { removed: true, backend: "test" as const };
  const target = `EzraMail:Microsoft:${email}`;
  await runCredentialCommand([`/delete:${target}`]);
  return { removed: true, backend: "windows-credential-manager" as const };
}

function stripHtml(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function microsoftScopes(access: MicrosoftAccessMode) {
  const scopes = ["offline_access", "User.Read", "Mail.Read"];
  if (access === "maintenance") scopes.push("Mail.ReadWrite");
  if (access === "calendar") scopes.push("Mail.ReadWrite", "Calendars.ReadWrite");
  if (access === "send") scopes.push("Mail.ReadWrite", "Mail.Send");
  if (access === "full") scopes.push("Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite");
  return scopes;
}

async function patchMicrosoftMessageReadState(
  email: string,
  messageIds: string[],
  isRead: boolean,
) {
  if (!messageIds.length) return { modified: 0 };
  const accessToken = await getMicrosoftAccessToken(email, "maintenance");
  for (const messageId of messageIds) {
    await microsoftGraphJson(
      accessToken,
      `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ isRead }),
      },
      "maintenance",
    );
  }
  return { modified: messageIds.length };
}

async function moveMicrosoftMessages(
  email: string,
  messageIds: string[],
  destinationId: "deleteditems" | "inbox" | "junkemail",
) {
  if (!messageIds.length) return { modified: 0 };
  const accessToken = await getMicrosoftAccessToken(email, "maintenance");
  for (const messageId of messageIds) {
    await microsoftGraphJson(
      accessToken,
      `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}/move`,
      {
        method: "POST",
        body: JSON.stringify({ destinationId }),
      },
      "maintenance",
    );
  }
  return { modified: messageIds.length };
}

function microsoftGraphHeaders(accessToken: string, json = false) {
  return {
    authorization: `Bearer ${accessToken}`,
    prefer: 'IdType="ImmutableId"',
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function microsoftGraphJson<T = unknown>(
  accessToken: string,
  url: string,
  init: RequestInit = {},
  access: MicrosoftAccessMode = "readonly",
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...microsoftGraphHeaders(accessToken, Boolean(init.body)),
      ...init.headers,
    },
  });
  const text = await response.text();
  const payload = (text.trim() ? JSON.parse(text) : {}) as T & { error?: { message?: string } };
  if (!response.ok) {
    const message = payload.error?.message || `Microsoft Graph request failed with ${response.status}.`;
    throw new Error(
      microsoftPermissionMessage(
        access,
        message,
      ),
    );
  }
  return payload;
}

function microsoftPermissionMessage(access: MicrosoftAccessMode, message: string) {
  if (access === "maintenance") return `${message} Reconnect Hotmail from Settings to grant Microsoft Mail.ReadWrite access.`;
  if (access === "calendar") return `${message} Reconnect Hotmail from Settings to grant Microsoft calendar access.`;
  if (access === "send") return `${message} Reconnect Hotmail from Settings to grant Microsoft Mail.Send access.`;
  if (access === "full") return `${message} Reconnect Hotmail from Settings to grant mail, reply, and calendar access.`;
  return message;
}

function microsoftRecipients(recipients: EmailRecipient[]) {
  return recipients.map((recipient) => ({
    emailAddress: {
      address: recipient.email,
      name: recipient.name || undefined,
    },
  }));
}

function microsoftRecipient(value?: { name?: string; address?: string }): EmailRecipient | null {
  const email = String(value?.address || "").trim().toLowerCase();
  if (!email) return null;
  return { email, name: value?.name ? String(value.name).trim() || null : null };
}

function microsoftRecipientList(value?: Array<{ emailAddress?: { name?: string; address?: string } }>) {
  return (value || []).flatMap((item) => {
    const recipient = microsoftRecipient(item.emailAddress);
    return recipient ? [recipient] : [];
  });
}

function normalizeMicrosoftDateTime(value?: string) {
  if (!value) return null;
  const withZone = /z$|[+-][0-9]{2}:[0-9]{2}$/i.test(value) ? value : `${value}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function validateSentEvidenceOptions(options: ProviderSentEvidenceOptions) {
  const after = canonicalIsoTimestamp(options.after);
  const before = canonicalIsoTimestamp(options.before);
  if (!after || !before || after >= before || Date.parse(before) - Date.parse(after) > 14 * 24 * 60 * 60 * 1000) {
    throw new Error("Sent evidence requires a valid, non-zero window of at most fourteen days.");
  }
  if (!Number.isInteger(options.maxResults) || options.maxResults <= 0) {
    throw new Error("Sent evidence maxResults must be a positive integer.");
  }
  return { after, before, maxResults: Math.min(options.maxResults, 100) };
}

function strictIdentifier(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function canonicalIsoTimestamp(value: unknown) {
  if (typeof value !== "string" || !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMicrosoftAttendees(value?: MicrosoftGraphCalendarEvent["attendees"]): CalendarAttendee[] {
  if (!Array.isArray(value)) return [];
  return value.map((attendee) => ({
    email: attendee.emailAddress?.address || "",
    name: attendee.emailAddress?.name || undefined,
    responseStatus: attendee.status?.response || undefined,
  })).filter((attendee) => attendee.email);
}

function microsoftAuthority() {
  const tenant = process.env.MICROSOFT_TENANT || "common";
  return `https://login.microsoftonline.com/${tenant}`;
}

function microsoftClientId() {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) {
    throw new Error("Microsoft sign-in needs MICROSOFT_CLIENT_ID configured.");
  }
  return clientId;
}

async function storeMicrosoftRefreshTokenFile(email: string, refreshToken: string) {
  const target = microsoftCredentialPath(email);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(
    {
      provider: "microsoft",
      email: email.toLowerCase(),
      refreshToken,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  );
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

function microsoftCredentialPath(email: string) {
  const root = process.env.EZRA_CREDENTIAL_DIR || path.join(process.cwd(), "data", "credentials");
  const key = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 32);
  return path.join(root, "microsoft", `${key}.json`);
}

function runCredentialCommand(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("cmdkey.exe", args, {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Windows Credential Manager exited with code ${code}`));
    });
  });
}
