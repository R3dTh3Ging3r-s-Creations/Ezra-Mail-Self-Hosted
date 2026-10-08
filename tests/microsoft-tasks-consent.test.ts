import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, execute, getServiceState, setServiceState, setSetting } from "@/lib/email/database";
import { startMicrosoftAccountConnection, completeMicrosoftAccountConnection } from "@/lib/email/service";
import { refreshMicrosoftAccessToken } from "@/lib/email/microsoft";
const account = { accountId:"ms",provider:"microsoft",expectedEmail:"owner@hotmail.test" };
describe("explicit personal To Do consent", () => {
  let root = "";
  let identity = account.expectedEmail;
  let scopes = "User.Read Mail.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Tasks.ReadWrite";
  let requests: { url:string;body:URLSearchParams }[];
  beforeEach(async () => {
    configureEmailDatabaseForTests(`file:./task-consent-${randomUUID()}.sqlite`);
    root = await fs.mkdtemp(path.join(os.tmpdir(),"ezra-task-consent-"));
    vi.stubEnv("EZRA_MICROSOFT_TOKEN_BACKEND","file"); vi.stubEnv("EZRA_CREDENTIAL_DIR",root); vi.stubEnv("MICROSOFT_CLIENT_ID","synthetic-client");
    identity = account.expectedEmail; scopes = "User.Read Mail.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Tasks.ReadWrite"; requests = [];
    await setSetting("agent_personal_accounts",JSON.stringify([account,{accountId:"gg",provider:"gmail",expectedEmail:"owner@gmail.test"}]));
    await execute("INSERT INTO email_accounts(id,provider,email,label,status,created_at,updated_at) VALUES ('ms','microsoft',?,'Fixture','connected',?,?)",[identity,new Date().toISOString(),new Date().toISOString()]);
    await setServiceState(`microsoft_scopes:${identity}`,JSON.stringify(["User.Read","Mail.Read","Mail.ReadWrite","Mail.Send","Calendars.ReadWrite"]));
    await setServiceState(`microsoft_access:${identity}`,"full");
    vi.stubGlobal("fetch", async (url: string,init?: RequestInit) => {
      requests.push({url:String(url),body:new URLSearchParams(String(init?.body || ""))});
      if (String(url).endsWith("/devicecode")) return Response.json({device_code:"fixture-device",user_code:"FIXTURE",expires_in:900,interval:5});
      if (String(url).endsWith("/token")) return Response.json({access_token:"fake-access",refresh_token:"fake-refresh",scope:scopes});
      if (String(url).includes("/me?")) return Response.json({mail:identity,userPrincipalName:identity});
      throw new Error("Unexpected fixture request.");
    });
  });
  afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await fs.rm(root,{recursive:true,force:true}); });
  it("adds only task consent while retaining prior grants and mail connection mode", async () => {
    const challenge = await startMicrosoftAccountConnection({email:account.expectedEmail,access:"tasks"});
    expect(requests[0].body.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["Tasks.ReadWrite","Mail.Send","Calendars.ReadWrite"]));
    await completeMicrosoftAccountConnection(challenge.connectionId);
    expect(await getServiceState(`microsoft_access:${identity}`)).toBe("full");
    expect(JSON.parse((await getServiceState(`microsoft_scopes:${identity}`))!)).toContain("Tasks.ReadWrite");
  });
  it("refuses work-account task consent before any authorization request", async () => {
    await expect(startMicrosoftAccountConnection({email:"worker@company.test",access:"tasks"})).rejects.toThrow(/personal|account/i);
    expect(requests).toHaveLength(0);
  });
  it("rejects wrong identity and missing prior scopes before saving credentials", async () => {
    const first = await startMicrosoftAccountConnection({email:account.expectedEmail,access:"tasks"});
    identity = "worker@company.test";
    await expect(completeMicrosoftAccountConnection(first.connectionId)).rejects.toThrow(/different Microsoft account/i);
    expect(await fs.readdir(root)).toEqual([]);
    identity = account.expectedEmail; scopes = "User.Read Tasks.ReadWrite";
    const second = await startMicrosoftAccountConnection({email:identity,access:"tasks"});
    await expect(completeMicrosoftAccountConnection(second.connectionId)).rejects.toThrow(/scope|permission/i);
    expect(await fs.readdir(root)).toEqual([]);
    expect(await getServiceState(`microsoft_access:${identity}`)).toBe("full");
  });
  it("ordinary profile/calendar refresh never silently requests task access", async () => {
    await refreshMicrosoftAccessToken("synthetic-refresh","profile");
    await refreshMicrosoftAccessToken("synthetic-refresh","calendar-write");
    expect(requests.every(request => !request.body.get("scope")?.includes("Tasks."))).toBe(true);
  });
});
