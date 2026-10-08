import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { grantSpecSchema, grantSpecForAccounts } from "@/lib/email/agent-resource-types";
import { migrateAgentGrantSchema } from "@/lib/email/agent-grant-schema";

const account = { accountId: "personal", provider: "microsoft" as const, expectedEmail: "owner@hotmail.test" };
const resource = { account, kind: "calendar" as const, id: "primary" };
const grant = { label: "Personal", lifetimeDays: 7, accounts: [account], resources: [resource], scopes: ["calendar.read"] };

describe("strict scoped grants", () => {
  it("accepts exact selected resources", () => expect(grantSpecForAccounts([account]).parse(grant)).toEqual(grant));
  it.each([
    { ...grant, lifetimeDays: 0 }, { ...grant, lifetimeDays: 365 },
    { ...grant, accounts: [account, account] }, { ...grant, resources: [resource, resource] },
    { ...grant, resources: [{ ...resource, id: "*" }] },
    { ...grant, accounts: [{ ...account, accountId: "*" }] },
    { ...grant, resources: [{ ...resource, account: { ...account, accountId: "other" } }] },
    { ...grant, scopes: ["calendar.read", "calendar.read"] }, { ...grant, approved: true },
  ])("rejects malformed or ambiguous grant %#", value => expect(grantSpecSchema.safeParse(value).success).toBe(false));
  it("rejects a work identity outside the configured personal profile", () => {
    const work = { ...account, expectedEmail: "worker@company.test" };
    expect(grantSpecForAccounts([account]).safeParse({ ...grant, accounts: [work], resources: [{ ...resource, account: work }] }).success).toBe(false);
  });
  it("makes grant identity immutable and revocation irreversible", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
      await migrateAgentGrantSchema(client);
      await client.execute({ sql: "INSERT INTO agent_grants(key_id,secret_digest,grant_json,revision,created_at,expires_at) VALUES (?,?,?,1,?,?)", args: ["key", "a".repeat(64), JSON.stringify(grant), "2026-10-01T00:00:00Z", "2026-10-08T00:00:00Z"] });
      await expect(client.execute("UPDATE agent_grants SET grant_json='{}'")).rejects.toThrow(/immutable/i);
      await expect(client.execute("UPDATE agent_grants SET secret_digest='replacement'")).rejects.toThrow(/immutable/i);
      await client.execute("UPDATE agent_grants SET revoked_at='2026-10-02T00:00:00Z'");
      await expect(client.execute("UPDATE agent_grants SET revoked_at=NULL")).rejects.toThrow(/revocation/i);
    } finally { client.close(); }
  });
});
