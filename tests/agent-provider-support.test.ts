import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConditionalWriteSupport } from "@/lib/email/agent-provider-support";

const settings = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/lib/email/database", () => ({ getSetting: async () => settings.value }));
const actions = ["calendar.update", "calendar.delete", "tasks.update", "tasks.complete"] as const;
const evidence = () => ({ version: 1, provider: "microsoft", apiVersion: "v1.0", adapterRevision: 1,
  action: "calendar.update", verifiedAt: "2026-10-01T12:00:00.000Z", evidenceId: "authorized-probe-1",
  source: "live_authorized_probe", staleRevisionRejected: true });

describe("conditional provider write qualification", () => {
  beforeEach(() => { settings.value = null; });
  it.each(actions)("keeps unproven %s unavailable", async action => {
    expect(await getConditionalWriteSupport("microsoft", action)).toEqual({ available: false, reason: "conditional_write_unqualified" });
  });
  it.each(["not json", "null", "[]", "{}"])("rejects malformed evidence %s", async value => {
    settings.value = value;
    expect((await getConditionalWriteSupport("microsoft", "calendar.update")).available).toBe(false);
  });
  it.each([
    { action: "calendar.delete" }, { provider: "gmail" }, { apiVersion: "beta" }, { adapterRevision: 2 },
    { source: "synthetic" }, { staleRevisionRejected: false }, { evidenceId: "" },
    { verifiedAt: "not-a-date" }, { verifiedAt: "2999-01-01T00:00:00.000Z" }, { approval: true },
  ])("rejects mismatched or unsupported evidence %j", async patch => {
    settings.value = JSON.stringify({ ...evidence(), ...patch });
    expect((await getConditionalWriteSupport("microsoft", "calendar.update")).available).toBe(false);
  });
  it("admits only the exact action with recorded live qualification", async () => {
    settings.value = JSON.stringify(evidence());
    expect(await getConditionalWriteSupport("microsoft", "calendar.update")).toEqual({ available: true, reason: "qualified" });
    expect((await getConditionalWriteSupport("microsoft", "tasks.complete")).available).toBe(false);
  });
});

it("qualifies Google delete only with exact v3 helper evidence", async () => {
  settings.value = JSON.stringify({ ...evidence(), provider: "gmail", apiVersion: "v3", action: "calendar.delete", helperRevision: "ezra-event-v1" });
  expect((await getConditionalWriteSupport("gmail", "calendar.delete")).available).toBe(true);
  expect((await getConditionalWriteSupport("gmail", "calendar.update")).available).toBe(false);
  expect((await getConditionalWriteSupport("microsoft", "calendar.delete")).available).toBe(false);
});
it("requires action-specific Google update helper evidence", async () => {
 settings.value=JSON.stringify({...evidence(),provider:"gmail",apiVersion:"v3",helperRevision:"ezra-event-update-v1"});
 expect((await getConditionalWriteSupport("gmail","calendar.update")).available).toBe(true);
 expect((await getConditionalWriteSupport("gmail","calendar.delete")).available).toBe(false);
 settings.value=JSON.stringify({...evidence(),provider:"gmail",apiVersion:"v3",helperRevision:"ezra-event-v1"});
 expect((await getConditionalWriteSupport("gmail","calendar.update")).available).toBe(false);
});
it.each([{ helperRevision: "wrong" }, { source: "synthetic" }, { staleRevisionRejected: false }, { adapterRevision: 2 }])("rejects unqualified Google evidence %j", async patch => {
  settings.value = JSON.stringify({ ...evidence(), provider: "gmail", apiVersion: "v3", action: "calendar.delete", helperRevision: "ezra-event-v1", ...patch });
  expect((await getConditionalWriteSupport("gmail", "calendar.delete")).available).toBe(false);
});

const taskAccount={accountId:'personal-ms',provider:'microsoft' as const,expectedEmail:'owner@hotmail.test'};
const taskEvidence=()=>({...evidence(),adapterRevision:2,action:'tasks.update',account:taskAccount,recurrenceContract:'graph-v1-full-task-omission-v1'});
it.each(['tasks.update','tasks.complete'] as const)('requires account-bound revision2 recurrence contract for %s',async action=>{
 settings.value=JSON.stringify({...taskEvidence(),action});expect((await getConditionalWriteSupport('microsoft',action,taskAccount)).available).toBe(true);
 expect((await getConditionalWriteSupport('microsoft',action)).available).toBe(false);
 expect((await getConditionalWriteSupport('microsoft',action,{...taskAccount,accountId:'other'})).available).toBe(false);
 expect((await getConditionalWriteSupport('microsoft',action,{...taskAccount,expectedEmail:'other@hotmail.test'})).available).toBe(false);
});
it.each([{adapterRevision:1},{recurrenceContract:'other'},{account:undefined},{action:'calendar.update'}])('rejects obsolete or mismatched task contract %j',async patch=>{settings.value=JSON.stringify({...taskEvidence(),...patch});expect((await getConditionalWriteSupport('microsoft','tasks.update',taskAccount)).available).toBe(false);});
