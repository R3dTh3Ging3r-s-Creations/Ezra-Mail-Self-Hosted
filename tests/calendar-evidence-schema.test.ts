import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { migrateCalendarProviderEvidence } from "@/lib/email/database";

it("adds cached calendar evidence without changing legacy events or lowering later versions",async()=>{
  const client=createClient({url:"file::memory:"});
  try{
    await client.batch(["CREATE TABLE calendar_events(id TEXT PRIMARY KEY,title TEXT)","INSERT INTO calendar_events VALUES ('old','Preserved')","PRAGMA user_version=12"],"write");
    await migrateCalendarProviderEvidence(client);await migrateCalendarProviderEvidence(client);
    expect((await client.execute("SELECT * FROM calendar_events")).rows).toEqual([{id:"old",title:"Preserved",reminder_evidence:null,provider_revision:null,correlation_id:null,recurrence_id:null}]);
    expect((await client.execute("PRAGMA user_version")).rows[0].user_version).toBe(13);
    await client.execute("PRAGMA user_version=14");await migrateCalendarProviderEvidence(client);
    expect((await client.execute("PRAGMA user_version")).rows[0].user_version).toBe(14);
  }finally{client.close();}
});
