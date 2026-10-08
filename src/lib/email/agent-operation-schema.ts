import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { z } from "zod";
import { accountRefSchema, calendarIdSchema } from "./agent-types";
import type { CalendarEvent } from "./types";
import { calendarDateInZone, calendarDayBounds } from "./calendar-day";

export const calendarCreateInputSchema = z.object({
  account: accountRefSchema,
  calendarId: calendarIdSchema,
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10_000), location: z.string().max(500),
  startsAt: z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  endsAt: z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  timezone: z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } }),
  isAllDay: z.boolean(),
  reminder: z.discriminatedUnion("mode", [z.object({ mode: z.literal("default") }).strict(), z.object({ mode: z.literal("none") }).strict(), z.object({ mode: z.literal("minutes"), minutes: z.number().int().min(0).max(40_320) }).strict()]),
  isBusy: z.boolean(), privacy: z.enum(["default", "private", "public"]),
  attendees: z.array(z.string().email()).max(500), sendUpdates: z.boolean(),
}).strict();
export const calendarCreateSchema = calendarCreateInputSchema.refine(value => value.account.provider !== "microsoft" || value.privacy !== "public", "Microsoft calendars do not support explicit public privacy; choose default or private.")
  .refine(value => Date.parse(value.startsAt) < Date.parse(value.endsAt), "Calendar end must be after start.")
  .refine(value => !value.isAllDay || [value.startsAt, value.endsAt].every(instant => {
    try { return calendarDayBounds(calendarDateInZone(instant, value.timezone), value.timezone).startIso === instant; } catch { return false; }
  }), "All-day event boundaries must be local midnight in the selected timezone.");
export type CalendarCreate = z.infer<typeof calendarCreateSchema>;
export type OperationStatus = "prepared" | "approved" | "executing" | "succeeded" | "failed" | "cancelled" | "expired" | "unknown";
export type OperationReceipt = {
  operationId: string; payloadHash: string; account: CalendarCreate["account"]; calendarId: string;
  providerEventId: string; outcome: "created" | "existing_match"; verifiedAt: string; event: CalendarEvent;
};
export function canonicalJson(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, val]) => [key, ordered(val)])) : item;
  return JSON.stringify(ordered(value));
}
export function hashCalendarCreate(value: unknown) {
  return createHash("sha256").update(canonicalJson({ version: 1, kind: "calendar.create", payload: calendarCreateSchema.parse(value) })).digest("hex");
}

/** Additive v12. No provider calls or changes to existing account/calendar data. */
export async function migrateAgentOperationSchema(client: Client) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS agent_operations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind='calendar.create'), version INTEGER NOT NULL,
      account_id TEXT NOT NULL, provider TEXT NOT NULL, expected_email TEXT NOT NULL, calendar_id TEXT NOT NULL,
      payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, evidence_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared','approved','executing','succeeded','failed','cancelled','expired','unknown')),
      approval_json TEXT, claim_id TEXT, lease_expires_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
      provider_event_id TEXT, receipt_json TEXT, error_code TEXT)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS agent_calendar_dispatch_lock ON agent_operations(account_id, calendar_id) WHERE status IN ('executing','unknown')`,
    `CREATE TABLE IF NOT EXISTS agent_operation_attempts (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES agent_operations(id),
      started_at TEXT NOT NULL, dispatched_at TEXT, finished_at TEXT, outcome TEXT, error_code TEXT)`,
    `CREATE TRIGGER IF NOT EXISTS agent_operation_immutable BEFORE UPDATE OF id,kind,version,account_id,provider,expected_email,calendar_id,payload_json,payload_hash,evidence_json,snapshot_json,created_at,expires_at ON agent_operations
      BEGIN SELECT RAISE(ABORT, 'Operation content is immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_approval_immutable BEFORE UPDATE OF approval_json ON agent_operations WHEN OLD.approval_json IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'Operation approval is immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_receipt_immutable BEFORE UPDATE OF receipt_json ON agent_operations WHEN OLD.receipt_json IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'Operation receipt is immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_attempt_immutable BEFORE UPDATE ON agent_operation_attempts WHEN OLD.finished_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'Operation attempt receipt is immutable'); END`,
  ];
  const version = Number((await client.execute("PRAGMA user_version")).rows[0].user_version);
  if (version < 12) statements.push("PRAGMA user_version=12");
  await client.batch(statements, "write");
}
