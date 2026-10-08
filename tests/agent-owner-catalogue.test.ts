import {beforeEach,describe,expect,it,vi} from "vitest";
import {ownerAccountChoices,ownerResourceChoices,readOwnerTasks} from "@/lib/email/agent-owner-catalogue";
const mocks=vi.hoisted(()=>({setting:vi.fn(),caps:vi.fn(),support:vi.fn(),lists:vi.fn(),tasks:vi.fn(),token:vi.fn(),resolve:vi.fn(),google:vi.fn()}));
vi.mock("@/lib/email/database",()=>({getSetting:mocks.setting}));vi.mock("@/lib/email/agent-accounts",()=>({getAgentCapabilities:mocks.caps}));vi.mock("@/lib/email/agent-provider-support",()=>({getConditionalWriteSupport:mocks.support}));vi.mock("@/lib/email/microsoft",()=>({getMicrosoftAccessToken:mocks.token,resolveMicrosoftCalendarId:mocks.resolve}));vi.mock("@/lib/email/gmail",()=>({getGoogleCalendarIdentity:mocks.google}));vi.mock("@/lib/email/microsoft-todo",()=>({readMicrosoftTaskLists:mocks.lists,readMicrosoftTasks:mocks.tasks}));
const account={accountId:"ms",provider:"microsoft" as const,expectedEmail:"owner@hotmail.test"},google={accountId:"gg",provider:"gmail" as const,expectedEmail:"owner@gmail.test"};
describe("personal owner resource catalogue",()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.setting.mockResolvedValue(JSON.stringify([account,google]));mocks.caps.mockResolvedValue({mailRead:"available",calendarRead:"available",calendarWrite:"available",tasksRead:"missing",tasksWrite:"missing"});mocks.support.mockResolvedValue({available:false});mocks.resolve.mockResolvedValue("exact-primary");mocks.google.mockResolvedValue(google.expectedEmail);});
 it("missing task grants and conditional proof never advertise writes",async()=>{const result=await ownerAccountChoices();expect(result.accounts[0].availableScopes).toEqual(["accounts.read","mail.read","calendar.read","calendar.create"]);expect(result.accounts[0].unavailable.join(" ")).toContain("consent");expect(mocks.lists).not.toHaveBeenCalled();});
 it("verifies provider identity and resolves exact primary for both providers",async()=>{expect((await ownerResourceChoices(account,"calendar")).resources[0].target.id).toBe("exact-primary");expect((await ownerResourceChoices(google,"calendar")).resources[0].target.id).toBe(google.expectedEmail);expect(mocks.caps).toHaveBeenCalledWith(account,true);});
 it("excludes shared lists and fails closed on identity rejection",async()=>{mocks.caps.mockResolvedValue({tasksRead:"available"});mocks.lists.mockResolvedValue({lists:[{id:"owned",title:"Owned",supported:true},{id:"shared",title:"Shared",supported:false}]});expect((await ownerResourceChoices(account,"task_list")).resources.map(r=>r.target.id)).toEqual(["owned"]);mocks.caps.mockRejectedValueOnce(new Error("identity mismatch"));await expect(ownerResourceChoices(account,"task_list")).rejects.toThrow();});
 it("does not accept mismatched task list contents",async()=>{mocks.tasks.mockResolvedValue({tasks:[{list:{account,id:"different"}}]});await expect(readOwnerTasks({account,kind:"task_list",id:"selected"})).rejects.toThrow();});

it("offers Google delete only after provider qualification, never Google update or Tasks",async()=>{
 mocks.support.mockImplementation(async(provider:string,action:string)=>({available:provider==="gmail"&&action==="calendar.delete"}));
 const googleChoice=(await ownerAccountChoices()).accounts.find(choice=>choice.account.provider==="gmail")!;
 expect(googleChoice.availableScopes).toContain("calendar.delete");
 expect(googleChoice.availableScopes).not.toContain("calendar.update");
 expect(googleChoice.availableScopes.some(scope=>scope.startsWith("tasks."))).toBe(false);
});

 it("offers Microsoft deletion only for the accepted account policy, without conditional proof",async()=>{
  const policy={version:1,policy:"graph-v1-owned-appointment-delete-v1",account,acceptedAt:"2026-10-08T00:00:00.000Z",approvalId:"owner-fixture",externalEditRaceAccepted:true};
  mocks.setting.mockImplementation(async key=>key==="agent_personal_accounts"?JSON.stringify([account,google]):JSON.stringify(policy));
  expect((await ownerAccountChoices()).accounts[0].availableScopes).toContain("calendar.delete");
  expect((await ownerAccountChoices()).accounts[0].availableScopes).not.toContain("calendar.update");
  mocks.setting.mockImplementation(async key=>key==="agent_personal_accounts"?JSON.stringify([account,google]):JSON.stringify({...policy,account:{...account,accountId:"other"}}));
  expect((await ownerAccountChoices()).accounts[0].availableScopes).not.toContain("calendar.delete");
 });

});
