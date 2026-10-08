import { z } from "zod";

const readMessages = {
  task_provider_denied: "Task provider access was denied. Verify the existing account permissions; do not broaden access automatically.",
  task_provider_unavailable: "Task provider read is unavailable. No complete task list was returned.",
  task_provider_response_invalid: "Task provider returned an unsupported response. No complete task list was returned.",
  task_list_not_private: "Task list privacy could not be established. Select an explicitly granted private list.",
  task_pagination_invalid: "Task pagination could not be verified. No complete task list was returned.",
  task_read_limit: "Task read exceeded its bounded limit. No complete task list was returned.",
  task_body_unsupported: "Task body format is unsupported. No complete task list was returned.",
  task_date_unsupported: "Task date representation is unsupported. No complete task list was returned.",
  task_identity_mismatch: "Task identity did not match the selected account and list. No complete task list was returned.",
} as const;
export type AgentReadErrorCode = keyof typeof readMessages;
export class AgentReadError extends Error {
  constructor(readonly code: AgentReadErrorCode) { super(readMessages[code]); this.name = "AgentReadError"; }
}
export function isAgentReadErrorCode(value: unknown): value is AgentReadErrorCode {
  return typeof value === "string" && Object.hasOwn(readMessages, value);
}

// Only schema-owned names can appear in diagnostics; no issue messages, values,
// provider text, unknown keys, or dynamic path components cross this boundary.
const fieldNames = new Set("account accountId provider expectedEmail query limit cursor messageId calendarId range from to target kind id idempotencyKey mutation payload title description location startsAt endsAt timezone isAllDay reminder mode minutes isBusy privacy attendees sendUpdates eventId expectedRevision patch time fields body importance due date instant taskId operationId payloadHash".split(" "));
export function safeAgentValidationMessage(error: z.ZodError): string {
  const details = error.issues.slice(0, 20).map(issue => {
    const path = issue.path.map(part => typeof part === "number" ? "item" : fieldNames.has(part) ? part : "field").join(".") || "request";
    const hint = issue.code === "unrecognized_keys" ? "Remove unsupported fields."
      : issue.code === "invalid_type" && issue.received === "undefined" ? "Required field is missing."
      : issue.code === "invalid_union_discriminator" ? "Choose a supported action kind from the tool schema."
      : issue.code === "invalid_literal" ? "Use the exact value required by the tool schema."
      : issue.code === "invalid_enum_value" ? "Choose one of the values in the tool schema."
      : "Check the field type, format, bounds and action constraints in the tool schema.";
    return `${path}: ${hint}`;
  });
  return `Invalid request. ${[...new Set(details)].join(" ")} No request was dispatched.`;
}

const transportMessages = {
 request_invalid: "The request could not be validated locally.",
 credential_unavailable: "The local scoped credential could not be loaded or validated.",
 request_interrupted: "The request was interrupted; its outcome is not established.",
 transport_unavailable: "The private HTTPS request failed; its outcome is not established.",
 response_invalid: "The private API reply could not be safely validated; its outcome is not established.",
 http_400: "The private API rejected the request (HTTP 400).",
 http_401: "The private API requires valid scoped authentication (HTTP 401).",
 http_403: "The private API denied access (HTTP 403). Do not broaden access automatically.",
 http_404: "The private API could not find the requested resource (HTTP 404).",
 http_409: "The private API reported a conflict (HTTP 409).",
 http_413: "The private API rejected the request size (HTTP 413).",
 http_429: "The private API rate limit was reached (HTTP 429).",
 http_503: "The private API reported an unavailable action or service (HTTP 503).",
 http_other: "The private API returned an unsupported HTTP failure status.",
} as const;
export type AgentTransportErrorCode = keyof typeof transportMessages;
export function isAgentTransportErrorCode(value: unknown): value is AgentTransportErrorCode {
 return typeof value === "string" && Object.hasOwn(transportMessages, value);
}
export class AgentTransportError extends Error {
 constructor(readonly code: AgentTransportErrorCode) {
  super(`Agent request failed. ${transportMessages[code]} Check the persisted operation status before any retry. No automatic retry was made.`);
  this.name = "AgentTransportError";
 }
}
/** Classify only the observed HTTP status, never provider/body text or dispatch outcome. */
export function agentHttpFailure(status: number): AgentTransportError {
 const candidate = `http_${status}`;
 return new AgentTransportError(isAgentTransportErrorCode(candidate) ? candidate : "http_other");
}
