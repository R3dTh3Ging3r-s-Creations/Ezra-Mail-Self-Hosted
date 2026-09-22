import fs from "node:fs/promises";
import { calendarDateRange } from "./calendar-day";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CalendarAttendee, CalendarEvent, EmailAttachment, EmailEnvelope, EmailRecipient } from "./types";
import { parseMailboxList, type ProviderReplyMetadata } from "./reply-recipients";
import type { ProviderSentEvidence, ProviderSentEvidenceOptions, ProviderSentEvidencePage } from "./provider-adapter";

type JsonRecord = Record<string, unknown>;
type GmailAccessMode = "readonly" | "maintenance" | "calendar";

export type GmailAuthorizationStart =
  | {
      mode: "browser";
      processId: number | null;
    }
  | {
      mode: "remote";
      authUrl: string;
      message: string;
    };

export type GmailSearchPage = {
  messages: EmailEnvelope[];
  nextPageToken: string | null;
};

export async function isGogInstalled() {
  try {
    await runGog(["--version"], 10_000);
    return true;
  } catch {
    return false;
  }
}

export async function listAuthorizedGmailAccounts() {
  const configured = (process.env.GMAIL_ACCOUNTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length) return configured;

  try {
    const payload = await runGog(
      ["auth", "list", "--json", "--no-input"],
      30_000,
      "auth.list",
    );
    const parsed = JSON.parse(payload) as unknown;
    return collectEmails(parsed);
  } catch {
    return [];
  }
}

export async function removeGmailAuthorization(email: string) {
  try {
    await runGog(
      ["auth", "remove", email, "--force", "--no-input"],
      60_000,
      "auth.remove",
    );
    return { removed: true as const, backend: "gog-keyring" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|no (stored )?(refresh )?token|no credentials|unknown account/i.test(message)) {
      return { removed: false as const, backend: "gog-keyring" as const };
    }
    throw error;
  }
}

export async function getGmailAuthorizationCapabilities(email?: string) {
  try {
    const payload = await runGog(
      ["auth", "list", "--json", "--no-input"],
      30_000,
      "auth.list",
    );
    return gmailAuthorizationCapabilitiesFromAuthList(JSON.parse(payload) as unknown, email);
  } catch {
    return { modify: false };
  }
}

export function gmailAuthorizationCapabilitiesFromAuthList(value: unknown, email?: string) {
  const scopes = email ? collectScopesForAccount(value, email) : collectScopes(value);
  return {
    modify:
      scopes.has("https://www.googleapis.com/auth/gmail.modify") ||
      scopes.has("https://mail.google.com/"),
  };
}

export async function searchGmailMessages(account: string, options?: { syncRangeDays?: number }): Promise<EmailEnvelope[]> {
  const days = [2, 7, 14, 30].includes(Number(options?.syncRangeDays)) ? Number(options?.syncRangeDays) : 2;
  const query = process.env.GMAIL_SEARCH_QUERY || `in:inbox newer_than:${days}d`;
  const maxResults = boundedInteger(process.env.GMAIL_POLL_MAX, 50, 1, 100);
  return (await searchGmailMessagePage(account, { query, maxResults })).messages;
}

export async function searchGmailSentEvidence(
  account: string,
  accountId: string,
  options: ProviderSentEvidenceOptions,
): Promise<ProviderSentEvidencePage> {
  const { after, before, maxResults } = validateSentEvidenceOptions(options);
  const queryBounds = gmailSentEvidenceQueryBounds(after, before);
  const query = `in:sent after:${queryBounds.lower} before:${queryBounds.upper}`;
  const payload = await runGog(
    [
      "gmail", "messages", "search", query, "--account", account, "--max", String(maxResults),
      "--wrap-untrusted", "--json", "--no-input",
    ],
    120_000,
    "gmail.messages.search",
  );
  const parsed = JSON.parse(payload) as unknown;
  const rawSlots = extractGmailRawSlots(parsed);
  const records = extractRecords(parsed);
  return {
    items: records.flatMap((record) => {
      const providerMessageId = stringValue(record.id, record.messageId, record.message_id);
      const providerThreadId = stringValue(record.threadId, record.thread_id);
      const sentAt = canonicalGmailSentAt(record);
      if (!providerMessageId || !providerThreadId || !sentAt || sentAt < after || sentAt > before) return [];
      return [{ accountId, provider: "gmail" as const, providerMessageId, providerThreadId, sentAt } satisfies ProviderSentEvidence];
    }),
    truncated: rawSlots.length >= maxResults,
  };
}

export async function searchGmailMessagePage(
  account: string,
  options: {
    query: string;
    maxResults: number;
    pageToken?: string | null;
  },
): Promise<GmailSearchPage> {
  const args = [
    "gmail",
    "messages",
    "search",
    options.query,
    "--account",
    account,
    "--max",
    String(boundedInteger(String(options.maxResults), 25, 1, 100)),
  ];
  if (options.pageToken) args.push("--page", options.pageToken);
  args.push(
    "--wrap-untrusted",
    "--json",
    "--no-input",
  );
  const payload = await runGog(
    args,
    120_000,
    "gmail.messages.search",
  );
  const parsed = JSON.parse(payload) as unknown;
  const records = extractRecords(parsed);
  return {
    messages: records.map((record) => normalizeMessage(account, record)).filter(isEnvelope),
    nextPageToken:
      isRecord(parsed) && typeof parsed.nextPageToken === "string"
        ? parsed.nextPageToken
        : null,
  };
}

export async function getGmailMessage(account: string, messageId: string) {
  const payload = await runGog(
    [
      "gmail",
      "get",
      messageId,
      "--account",
      account,
      "--sanitize-content",
      "--wrap-untrusted",
      "--json",
      "--no-input",
    ],
    60_000,
    "gmail.get",
  );
  return JSON.parse(payload) as unknown;
}

export async function getGmailReplyMetadata(account: string, messageId: string): Promise<ProviderReplyMetadata> {
  const raw = await runGog(
    [
      "gmail",
      "get",
      messageId,
      "--account",
      account,
      "--format",
      "metadata",
      "--headers",
      "From,Reply-To,To,Cc,Subject",
      "--json",
      "--no-input",
    ],
    60_000,
    "gmail.get",
  );
  const payload = JSON.parse(raw) as unknown;
  const headers = findHeaders(payload);
  const from = parseMailboxList(headerValue(headers, "from"))[0] || null;
  const replyTo = parseMailboxList(headerValue(headers, "reply-to"));
  return {
    from,
    replyTo,
    to: parseMailboxList(headerValue(headers, "to")),
    cc: parseMailboxList(headerValue(headers, "cc")),
    subject: unwrapGogMetadata(headerValue(headers, "subject") || "(no subject)"),
  };
}

export async function getGmailMessageEnvelope(account: string, messageId: string) {
  const payload = await getGmailMessage(account, messageId);
  const messages = extractRecords(payload)
    .map((record) => normalizeMessage(account, record))
    .filter(isEnvelope);
  return messages.find((message) => message.externalMessageId === messageId) || messages[0] || null;
}

export async function getGmailUnsubscribeMetadata(account: string, messageId: string) {
  const payload = await runGog(
    [
      "gmail",
      "get",
      messageId,
      "--account",
      account,
      "--format",
      "metadata",
      "--headers",
      "List-Unsubscribe,List-Unsubscribe-Post",
      "--json",
      "--no-input",
    ],
    60_000,
    "gmail.get",
  );
  return parseUnsubscribeMetadata(JSON.parse(payload) as unknown);
}

export async function markGmailMessagesRead(account: string, messageIds: string[]) {
  if (!messageIds.length) return { modified: 0 };
  for (const messageIdBatch of chunk(messageIds, 100)) {
    await runGog(
      [
        "gmail",
        "batch",
        "modify",
        ...messageIdBatch,
        "--account",
        account,
        "--remove",
        "UNREAD",
        "--json",
        "--force",
        "--no-input",
      ],
      120_000,
      "gmail.batch.modify",
    );
  }
  return { modified: messageIds.length };
}

export async function markGmailMessagesUnread(account: string, messageIds: string[]) {
  if (!messageIds.length) return { modified: 0 };
  for (const messageIdBatch of chunk(messageIds, 100)) {
    await runGog(
      [
        "gmail",
        "batch",
        "modify",
        ...messageIdBatch,
        "--account",
        account,
        "--add",
        "UNREAD",
        "--json",
        "--force",
        "--no-input",
      ],
      120_000,
      "gmail.batch.modify",
    );
  }
  return { modified: messageIds.length };
}

export async function setGmailMessagesStarred(account: string, messageIds: string[], starred: boolean) {
  return setGmailMessagesSystemLabel(account, messageIds, "STARRED", starred);
}

export async function setGmailMessagesImportant(account: string, messageIds: string[], important: boolean) {
  return setGmailMessagesSystemLabel(account, messageIds, "IMPORTANT", important);
}

async function setGmailMessagesSystemLabel(account: string, messageIds: string[], label: "STARRED" | "IMPORTANT", enabled: boolean) {
  if (!messageIds.length) return { modified: 0 };
  for (const messageIdBatch of chunk(messageIds, 100)) {
    await runGog(
      [
        "gmail",
        "batch",
        "modify",
        ...messageIdBatch,
        "--account",
        account,
        enabled ? "--add" : "--remove",
        label,
        "--json",
        "--force",
        "--no-input",
      ],
      120_000,
      "gmail.batch.modify",
    );
  }
  return { modified: messageIds.length };
}

export async function moveGmailMessagesToSpam(account: string, messageIds: string[]) {
  if (!messageIds.length) return { modified: 0 };
  for (const messageIdBatch of chunk(messageIds, 100)) {
    await runGog(
      [
        "gmail",
        "batch",
        "modify",
        ...messageIdBatch,
        "--account",
        account,
        "--add",
        "SPAM",
        "--remove",
        "INBOX,UNREAD",
        "--json",
        "--force",
        "--no-input",
      ],
      120_000,
      "gmail.batch.modify",
    );
  }
  return { modified: messageIds.length };
}

export async function moveGmailMessagesToTrash(account: string, messageIds: string[]) {
  if (!messageIds.length) return { modified: 0 };
  for (const messageIdBatch of chunk(messageIds, 100)) {
    await runGog(
      [
        "gmail",
        "batch",
        "modify",
        ...messageIdBatch,
        "--account",
        account,
        "--add",
        "TRASH",
        "--remove",
        "INBOX,UNREAD",
        "--json",
        "--force",
        "--no-input",
      ],
      120_000,
      "gmail.batch.modify",
    );
  }
  return { modified: messageIds.length };
}

export async function restoreGmailMessagesFromSpam(account: string, messageIds: string[]) {
  if (!messageIds.length) return { modified: 0 };
  for (const messageIdBatch of chunk(messageIds, 100)) {
    await runGog(
      [
        "gmail",
        "batch",
        "modify",
        ...messageIdBatch,
        "--account",
        account,
        "--add",
        "INBOX,UNREAD",
        "--remove",
        "SPAM",
        "--json",
        "--force",
        "--no-input",
      ],
      120_000,
      "gmail.batch.modify",
    );
  }
  return { modified: messageIds.length };
}

export async function restoreGmailMessagesFromTrash(account: string, messageIds: string[]) {
  if (!messageIds.length) return { modified: 0 };
  for (const messageIdBatch of chunk(messageIds, 100)) {
    await runGog(
      [
        "gmail",
        "batch",
        "modify",
        ...messageIdBatch,
        "--account",
        account,
        "--add",
        "INBOX,UNREAD",
        "--remove",
        "TRASH",
        "--json",
        "--force",
        "--no-input",
      ],
      120_000,
      "gmail.batch.modify",
    );
  }
  return { modified: messageIds.length };
}

export async function downloadGmailAttachment(input: {
  account: string;
  messageId: string;
  attachmentId: string;
  name: string;
}) {
  const safeName = path.basename(input.name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-mail-"));
  const target = path.join(directory, safeName || "attachment.bin");
  await runGog(
    [
      "gmail",
      "attachment",
      input.messageId,
      input.attachmentId,
      "--account",
      input.account,
      "--out",
      target,
      "--no-input",
    ],
    120_000,
    "gmail.attachment",
  );
  return { directory, path: target };
}

export async function sendGmailReply(input: {
  account: string;
  externalMessageId: string;
  to: string;
  subject: string;
  content: string;
}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-send-"));
  const bodyFile = path.join(directory, "reply.txt");
  await fs.writeFile(bodyFile, input.content, { encoding: "utf8", mode: 0o600 });
  try {
    const payload = await runGog(
      [
        "gmail",
        "send",
        "--account",
        input.account,
        "--to",
        input.to,
        "--subject",
        /^re:/i.test(input.subject) ? input.subject : `Re: ${input.subject}`,
        "--body-file",
        bodyFile,
        "--reply-to-message-id",
        input.externalMessageId,
        "--json",
        "--no-input",
      ],
      120_000,
      "gmail.send",
    );
    return JSON.parse(payload) as unknown;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function sendGmailOutgoing(input: {
  account: string;
  from: string;
  to: EmailRecipient[];
  cc: EmailRecipient[];
  bcc: EmailRecipient[];
  subject: string;
  body: string;
  attachments?: Array<{ name: string; mimeType: string; path: string }>;
  replyToMessageId?: string | null;
}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-outgoing-"));
  const bodyFile = path.join(directory, "message.txt");
  await fs.writeFile(bodyFile, input.body, { encoding: "utf8", mode: 0o600 });
  try {
    const args = [
      "gmail",
      "send",
      "--account",
      input.account,
      "--to",
      formatGmailRecipients(input.to),
      "--subject",
      input.subject,
      "--body-file",
      bodyFile,
      "--json",
      "--force",
      "--no-input",
    ];
    if (input.from && input.from.toLowerCase() !== input.account.toLowerCase()) {
      args.push("--from", input.from);
    }
    if (input.cc.length) args.push("--cc", formatGmailRecipients(input.cc));
    if (input.bcc.length) args.push("--bcc", formatGmailRecipients(input.bcc));
    if (input.replyToMessageId) args.push("--reply-to-message-id", input.replyToMessageId);
    for (const attachment of input.attachments || []) args.push("--attach", attachment.path);
    const payload = await runGog(args, 120_000, "gmail.send");
    return payload ? JSON.parse(payload) as unknown : {};
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export type GoogleCalendarEventRecord = JsonRecord;

export async function listGoogleCalendarEvents(
  account: string,
  accountId: string,
  options: { from: string; to: string },
) {
  const payload = await runGog(
    [
      "calendar",
      "events",
      "primary",
      "--account",
      account,
      "--from",
      options.from,
      "--to",
      options.to,
      "--max",
      "100",
      "--all-pages",
      "--json",
      "--no-input",
    ],
    120_000,
    "calendar.events",
  );
  return extractRecords(JSON.parse(payload) as unknown)
    .map((record) => normalizeGoogleCalendarEvent(accountId, record))
    .filter((event): event is Omit<CalendarEvent, "id" | "accountLabel" | "accountProvider" | "syncedAt"> => Boolean(event));
}

export async function createGoogleCalendarEvent(input: {
  account: string;
  calendarId: string;
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
  sendUpdates: boolean;
}) {
  const args = [
    "calendar",
    "create",
    input.calendarId || "primary",
    "--account",
    input.account,
    "--summary",
    input.title,
    "--from",
    input.isAllDay ? input.startsAt.slice(0, 10) : input.startsAt,
    "--to",
    input.isAllDay ? input.endsAt.slice(0, 10) : input.endsAt,
    "--description",
    input.description,
    "--location",
    input.location,
    "--visibility",
    input.privacy,
    "--transparency",
    input.isBusy ? "busy" : "free",
    "--send-updates",
    input.sendUpdates ? "all" : "none",
    "--json",
    "--no-input",
  ];
  if (!input.isAllDay) {
    args.push("--start-timezone", input.timezone, "--end-timezone", input.timezone);
  } else {
    args.push("--all-day");
  }
  if (input.attendees.length) args.push("--attendees", input.attendees.join(","));
  if (input.reminderMinutes !== null) args.push("--reminder", `popup:${input.reminderMinutes}m`);
  const payload = await runGog(args, 120_000, "calendar.create");
  const record = extractRecords(JSON.parse(payload) as unknown)[0] || {};
  return normalizeGoogleCalendarEvent("pending", record);
}

export async function startGmailAuthorization(input: {
  email: string;
  access: GmailAccessMode;
}): Promise<GmailAuthorizationStart> {
  const args = buildGmailAuthorizationArgs(input.email, input.access);
  if (shouldUseRemoteGoogleAuth()) {
    const payload = await runGog([...args, "--remote", "--step", "1", "--json", "--no-input"], 60_000);
    const authUrl = extractGoogleAuthUrl(payload);
    if (!authUrl) {
      throw new Error("Google did not return a sign-in URL. Check gog auth output and try again.");
    }
    return {
      mode: "remote",
      authUrl,
      message:
        "Open Google sign-in, approve access, then paste the final browser URL back into Ezra.",
    };
  }

  const executable = process.env.GOG_PATH || "gog.exe";
  return new Promise<{ mode: "browser"; processId: number | null }>((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ mode: "browser", processId: child.pid || null });
    });
  });
}

export async function completeGmailAuthorization(input: {
  email: string;
  access: GmailAccessMode;
  authUrl: string;
}) {
  const authUrl = input.authUrl.trim();
  if (!authUrl) throw new Error("Paste the final Google redirect URL before completing sign-in.");
  await runGog(
    [
      ...buildGmailAuthorizationArgs(input.email, input.access),
      "--remote",
      "--step",
      "2",
      "--auth-url",
      authUrl,
      "--json",
      "--no-input",
    ],
    120_000,
  );
  return { status: "connected" as const, email: input.email, access: input.access };
}

function shouldUseRemoteGoogleAuth() {
  const mode = (process.env.EZRA_GOOGLE_AUTH_MODE || "").toLowerCase();
  if (mode === "browser") return false;
  if (mode === "remote") return true;
  return process.platform !== "win32";
}

function buildGmailAuthorizationArgs(email: string, access: GmailAccessMode) {
  const extraScopes: string[] = [];
  if (access === "maintenance") extraScopes.push("https://www.googleapis.com/auth/gmail.modify");
  if (access === "calendar") {
    extraScopes.push(
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar.events",
    );
  }
  const args = [
    "auth",
    "add",
    email,
    "--services",
    access === "calendar" ? "gmail,calendar" : "gmail",
    "--readonly",
    "--gmail-no-send",
    "--force-consent",
  ];
  if (extraScopes.length) {
    args.push("--extra-scopes", extraScopes.join(","));
  }
  return args;
}

function extractGoogleAuthUrl(payload: string) {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (isRecord(parsed)) {
      const direct = stringValue(parsed.auth_url, parsed.authUrl, parsed.url);
      if (direct) return direct;
    }
  } catch {
    // gog can also return plain text in older builds; fall through to URL scan.
  }
  const match = payload.match(/https?:\/\/\S+/);
  return match ? match[0].replace(/[)"'<>]+$/g, "") : null;
}

export function normalizeGoogleCalendarEvent(
  accountId: string,
  record: GoogleCalendarEventRecord,
): Omit<CalendarEvent, "id" | "accountLabel" | "accountProvider" | "syncedAt"> | null {
  const id = stringValue(record.id, record.eventId, record.event_id);
  if (!id) return null;
  const start = normalizeGoogleEventTime(record.start);
  const end = normalizeGoogleEventTime(record.end);
  if (!start.value || !end.value) return null;
  const isAllDay = start.allDay || end.allDay;
  const dateRange = isAllDay ? calendarDateRange(isRecord(record.start) ? record.start.date : null, isRecord(record.end) ? record.end.date : null) : null;
  if (isAllDay && (!start.allDay || !end.allDay || !dateRange)) return null;
  const organizer = isRecord(record.organizer) ? record.organizer : {};
  const creator = isRecord(record.creator) ? record.creator : {};
  return {
    accountId,
    externalEventId: id,
    calendarId: stringValue(record.calendarId, record.calendar_id, record.calendar, "primary") || "primary",
    calendarName: stringValue(record.calendarSummary, record.calendar_name, record.calendar, "Primary") || "Primary",
    title: unwrapGogMetadata(stringValue(record.summary, record.title) || "(no title)"),
    description: unwrapGogMetadata(stringValue(record.description) || "") || null,
    location: unwrapGogMetadata(stringValue(record.location) || "") || null,
    startsAt: start.value,
    endsAt: end.value,
    isAllDay,
    dateRange,
    timezone: start.timezone || end.timezone || stringValue(record.timeZone, record.timezone) || null,
    status: stringValue(record.status, "confirmed") || "confirmed",
    visibility: stringValue(record.visibility) || null,
    isBusy: stringValue(record.transparency) !== "transparent",
    organizerName: stringValue(organizer.displayName, creator.displayName) || null,
    organizerEmail: stringValue(organizer.email, creator.email) || null,
    attendees: normalizeGoogleAttendees(record.attendees),
    webLink: stringValue(record.htmlLink, record.webLink, record.link) || null,
    updatedAt: normalizeDate(stringValue(record.updated, record.updatedAt)) || null,
  };
}

function normalizeGoogleEventTime(value: unknown) {
  if (!isRecord(value)) return { value: "", allDay: false, timezone: null as string | null };
  const dateTime = stringValue(value.dateTime, value.datetime);
  const date = stringValue(value.date);
  if (dateTime) {
    return {
      value: normalizeDate(dateTime) || dateTime,
      allDay: false,
      timezone: stringValue(value.timeZone, value.timezone) || null,
    };
  }
  if (date) {
    return {
      value: `${date}T00:00:00.000Z`,
      allDay: true,
      timezone: stringValue(value.timeZone, value.timezone) || null,
    };
  }
  return { value: "", allDay: false, timezone: null as string | null };
}

function normalizeGoogleAttendees(value: unknown): CalendarAttendee[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((attendee) => ({
    email: stringValue(attendee.email) || "",
    name: stringValue(attendee.displayName, attendee.name) || undefined,
    responseStatus: stringValue(attendee.responseStatus, attendee.status) || undefined,
  })).filter((attendee) => attendee.email);
}

async function runGog(args: string[], timeoutMs: number, exactCommand?: string) {
  const executable = process.env.GOG_PATH || "gog.exe";
  return new Promise<string>((resolve, reject) => {
    const guardedArgs = exactCommand
      ? ["--enable-commands-exact", exactCommand, ...args]
      : args;
    const child = spawn(executable, guardedArgs, {
      windowsHide: true,
      shell: false,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`gog timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `gog exited with code ${code}`));
    });
  });
}

function extractRecords(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of ["messages", "results", "items", "data"]) {
    if (Array.isArray(value[key])) return value[key].filter(isRecord);
  }
  return [value];
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

function canonicalGmailSentAt(record: JsonRecord) {
  const internalDate = stringValue(record.internalDate, record.internal_date);
  if (internalDate && /^\d+$/.test(internalDate)) {
    const epochMilliseconds = Number(internalDate);
    const date = new Date(epochMilliseconds);
    if (!Number.isFinite(epochMilliseconds) || Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }
  return canonicalIsoTimestamp(stringValue(record.sentDateTime, record.sent_date_time, record.sentAt, record.sent_at));
}

function canonicalIsoTimestamp(value: string | null | undefined) {
  if (!value || !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function gmailSentEvidenceQueryBounds(after: string, before: string) {
  const lower = Math.ceil(Date.parse(after) / 1000) - 1;
  const upper = Math.floor(Date.parse(before) / 1000) + 1;
  if (upper - lower > 14 * 24 * 60 * 60) {
    throw new Error("Sent evidence inclusive provider interval exceeds fourteen days.");
  }
  return { lower, upper };
}

function extractGmailRawSlots(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["messages", "results", "items", "data"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [value];
}

function normalizeMessage(account: string, record: JsonRecord): EmailEnvelope | null {
  const headers = normalizeHeaders(
    record.headers ||
      nested(record, "payload", "headers") ||
      nested(record, "message", "headers"),
  );
  const id = stringValue(
    record.id,
    record.messageId,
    record.message_id,
    nested(record, "message", "id"),
  );
  const threadId =
    stringValue(
      record.threadId,
      record.thread_id,
      nested(record, "message", "threadId"),
      nested(record, "message", "thread_id"),
    ) || id;
  if (!id || !threadId) return null;
  const from = unwrapGogMetadata(
    stringValue(record.from, headers.from, nested(record, "sender", "email")) || "Unknown",
  );
  const sender = parseSender(from);
  const subject = unwrapGogMetadata(
    stringValue(record.subject, headers.subject) || "(no subject)",
  );
  const receivedAt =
    normalizeDate(
      stringValue(record.date, record.receivedAt, record.received_at, headers.date, record.internalDate),
    ) || new Date().toISOString();
  const bodyText = stringValue(
    record.body,
    record.bodyText,
    record.body_text,
    record.text,
    nested(record, "body", "text"),
  );
  const bodyHtml = stringValue(
    record.html,
    record.bodyHtml,
    record.body_html,
    nested(record, "body", "html"),
    nested(record, "message", "bodyHtml"),
  );
  const snippet = unwrapGogMetadata(
    stringValue(record.snippet, record.preview, nested(record, "message", "snippet"), bodyText) ||
      "",
  ).slice(0, 1200);
  const labels = normalizeLabels(record);
  return {
    accountId: account,
    externalMessageId: id,
    threadId,
    historyId: stringValue(record.historyId, record.history_id),
    senderName: sender.name,
    senderEmail: sender.email,
    subject,
    receivedAt,
    snippet,
    bodyText: bodyText?.slice(0, 80_000),
    bodyHtml: bodyHtml?.slice(0, 200_000),
    providerRevision: stringValue(record.historyId, record.history_id) || null,
    gmailUrl: `https://mail.google.com/mail/u/${encodeURIComponent(account)}/#inbox/${threadId}`,
    isUnread: labels.includes("UNREAD"),
    labels,
    attachments: normalizeAttachments(record),
  };
}

function normalizeLabels(record: JsonRecord) {
  const raw =
    record.labels ||
    record.labelIds ||
    record.label_ids ||
    nested(record, "message", "labelIds") ||
    nested(record, "message", "label_ids");
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") return raw.split(",").map((label) => label.trim());
  return [];
}

function normalizeAttachments(record: JsonRecord): EmailAttachment[] {
  const raw = record.attachments || nested(record, "payload", "attachments");
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((attachment, index) => ({
    id:
      stringValue(attachment.id, attachment.attachmentId, attachment.attachment_id) ||
      `attachment-${index}`,
    name: stringValue(attachment.name, attachment.filename) || `attachment-${index}`,
    mimeType: stringValue(attachment.mimeType, attachment.mime_type, attachment.type) || "",
    size: Number(attachment.size || 0),
  }));
}

function normalizeHeaders(value: unknown) {
  if (!Array.isArray(value)) return isRecord(value) ? value : {};
  return Object.fromEntries(
    value
      .filter(isRecord)
      .map((header) => [String(header.name || "").toLowerCase(), String(header.value || "")]),
  );
}

function formatGmailRecipients(recipients: EmailRecipient[]) {
  return recipients.map(formatGmailRecipient).join(",");
}

function formatGmailRecipient(recipient: EmailRecipient) {
  const email = String(recipient.email || "").trim();
  const name = String(recipient.name || "").trim();
  if (!name) return email;
  return `${name.replace(/"/g, "")} <${email}>`;
}

function parseSender(value: string) {
  const match = value.match(/^(.*?)\s*<([^>]+)>$/);
  if (!match) return { name: value.includes("@") ? value.split("@")[0] : value, email: value };
  return {
    name: match[1].replace(/^["']|["']$/g, "").trim() || match[2],
    email: match[2].trim(),
  };
}

function normalizeDate(value?: string) {
  if (!value) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nested(value: JsonRecord, ...keys: string[]) {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function stringValue(...values: unknown[]) {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim());
  return typeof value === "string" ? value.trim() : undefined;
}

function collectEmails(value: unknown): string[] {
  const emails = new Set<string>();
  const walk = (current: unknown) => {
    if (typeof current === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(current)) {
      emails.add(current);
    } else if (Array.isArray(current)) {
      current.forEach(walk);
    } else if (isRecord(current)) {
      Object.values(current).forEach(walk);
    }
  };
  walk(value);
  return [...emails];
}

function collectScopes(value: unknown) {
  const scopes = new Set<string>();
  const walk = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(walk);
    } else if (isRecord(current)) {
      for (const [key, next] of Object.entries(current)) {
        if (key === "scopes" && Array.isArray(next)) next.forEach((scope) => scopes.add(String(scope)));
        else walk(next);
      }
    }
  };
  walk(value);
  return scopes;
}

function collectScopesForAccount(value: unknown, email: string) {
  const target = email.trim().toLowerCase();
  const scopes = new Set<string>();
  const walk = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }
    if (!isRecord(current)) return;
    const keyedAccount = Object.entries(current).find(
      ([key]) => key.trim().toLowerCase() === target,
    );
    if (keyedAccount) {
      for (const scope of collectScopes(keyedAccount[1])) scopes.add(scope);
      return;
    }
    const ownsAccount = Object.entries(current).some(
      ([key, candidate]) => {
        const identityKey = key.replace(/[_-]/g, "").toLowerCase();
        return ["email", "account", "accountemail", "user", "username", "address"].includes(identityKey)
          && typeof candidate === "string"
          && candidate.trim().toLowerCase() === target;
      },
    );
    if (ownsAccount) {
      for (const scope of collectScopes(current)) scopes.add(scope);
      return;
    }
    Object.values(current).forEach(walk);
  };
  walk(value);
  return scopes;
}

export function parseUnsubscribeMetadata(value: unknown) {
  const headers = findHeaders(value);
  const listUnsubscribe = headerValue(headers, "list-unsubscribe");
  const listUnsubscribePost = headerValue(headers, "list-unsubscribe-post");
  const urls = listUnsubscribe
    ? [...listUnsubscribe.matchAll(/<([^>]+)>/g)].map((match) => match[1].trim())
    : [];
  const oneClickUrl =
    /List-Unsubscribe=One-Click/i.test(listUnsubscribePost || "")
      ? urls.find((url) => url.startsWith("https://")) || null
      : null;
  return {
    oneClickUrl,
    mailto: urls.find((url) => url.startsWith("mailto:")) || null,
    supported: Boolean(oneClickUrl),
  };
}

function findHeaders(value: unknown): unknown {
  if (!isRecord(value)) return null;
  if (value.headers) return value.headers;
  if (isRecord(value.message) && value.message.headers) return value.message.headers;
  if (isRecord(value.message) && isRecord(value.message.payload)) {
    return value.message.payload.headers;
  }
  return null;
}

function headerValue(headers: unknown, name: string) {
  if (Array.isArray(headers)) {
    const match = headers.find(
      (header) =>
        isRecord(header) &&
        String(header.name || "").toLowerCase() === name.toLowerCase(),
    );
    return match && isRecord(match) ? String(match.value || "") : null;
  }
  if (!isRecord(headers)) return null;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? String(headers[key] || "") : null;
}

function chunk<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEnvelope(value: EmailEnvelope | null): value is EmailEnvelope {
  return Boolean(value);
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function unwrapGogMetadata(value: string) {
  const match = value.match(
    /^<<<EXTERNAL_UNTRUSTED_CONTENT(?:\s+[^>]*)?>>>\s*(?:Source:[^\r\n]*\r?\n)?\s*(?:---\s*)?([\s\S]*?)\s*<<<END_EXTERNAL_UNTRUSTED_CONTENT(?:\s+[^>]*)?>>>$/,
  );
  return match ? match[1].trim() : value;
}
