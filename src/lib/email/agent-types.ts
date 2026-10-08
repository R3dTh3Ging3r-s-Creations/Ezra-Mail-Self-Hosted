import { z } from "zod";
import type { CalendarEvent } from "./types";

export const calendarIdSchema = z.string().min(1).max(1024).regex(/^[^-\x00-\x1f][^\x00-\x1f]*$/);
export const calendarRangeSchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
}).strict().refine(range => Date.parse(range.from) < Date.parse(range.to), "Calendar range must end after it starts.");
export type CalendarRange = z.infer<typeof calendarRangeSchema>;
export type CalendarSnapshot = {
  account: AccountRef;
  calendarId: string;
  range: CalendarRange;
  fetchedAt: string;
  complete: true;
  events: CalendarEvent[];
};

export const accountRefSchema = z.object({
  accountId: z.string().min(1).max(200),
  provider: z.enum(["microsoft", "gmail"]),
  expectedEmail: z.string().trim().email().max(320),
}).strict();
export type AccountRef = z.infer<typeof accountRefSchema>;
export type CapabilityState = "available" | "missing" | "unknown" | "denied";
export type CapabilityEvidence = {
  account: AccountRef;
  scopes: string[];
  identityVerifiedAt: string | null;
  mailRead: CapabilityState;
  mailWrite: CapabilityState;
  mailSend: CapabilityState;
  calendarRead: CapabilityState;
  calendarWrite: CapabilityState;
  tasksRead?: CapabilityState;
  tasksWrite?: CapabilityState;
};
