import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { calendarCreateSchema, hashCalendarCreate, migrateAgentOperationSchema } from "@/lib/email/agent-operation-schema";
export const payload = { account: { accountId: "ms", provider: "microsoft", expectedEmail: "owner@hotmail.test" }, calendarId: "cal", title: "Reminder", description: "", location: "", startsAt: "2026-10-09T12:00:00.000Z", endsAt: "2026-10-09T12:10:00.000Z", timezone: "America/Chicago", isAllDay: false, reminder: { mode: "minutes", minutes: 0 }, isBusy: false, privacy: "default", attendees: [], sendUpdates: false };
describe("immutable calendar payload", () => {
  it("migrates a version-11 database additively and can run again safely", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
      await client.batch(["CREATE TABLE calendar_drafts(id TEXT PRIMARY KEY, reminder_mode TEXT)", "INSERT INTO calendar_drafts VALUES ('legacy',NULL)", "PRAGMA user_version=11"], "write");
      await migrateAgentOperationSchema(client); await migrateAgentOperationSchema(client);
      expect((await client.execute("SELECT * FROM calendar_drafts")).rows).toEqual([{ id: "legacy", reminder_mode: null }]);
      expect((await client.execute("PRAGMA user_version")).rows[0].user_version).toBe(12);
    } finally { client.close(); }
  });
  it("hashes canonical fields independently of property ordering", () => {
    expect(hashCalendarCreate(payload)).toBe(hashCalendarCreate(Object.fromEntries(Object.entries(payload).reverse())));
    expect(hashCalendarCreate({ ...payload, title: "Different" })).not.toBe(hashCalendarCreate(payload));
  });
  it("rejects all-day instants that are not local midnight", () => {
    expect(() => calendarCreateSchema.parse({ ...payload, isAllDay: true })).toThrow(/midnight/i);
    expect(calendarCreateSchema.parse({ ...payload, isAllDay: true, startsAt: "2026-10-09T05:00:00.000Z", endsAt: "2026-10-10T05:00:00.000Z" }).isAllDay).toBe(true);
  });
  it.each([{ ...payload, approved: true }, { ...payload, account: { ...payload.account, approved: true } }, { ...payload, endsAt: payload.startsAt }, { ...payload, reminder: { mode: "minutes", minutes: -1 } }, { ...payload, timezone: "Invalid/Zone" }])("rejects invalid or invented authority %j", value => {
    expect(() => calendarCreateSchema.parse(value)).toThrow();
  });
});
