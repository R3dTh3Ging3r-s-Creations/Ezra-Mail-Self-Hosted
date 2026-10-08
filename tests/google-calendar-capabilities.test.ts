import { beforeEach, expect, it, vi } from "vitest";
import { handleAgentRoute } from "@/lib/email/agent-api-handlers";
import { resourceMutationSchema } from "@/lib/email/agent-resource-types";
const mocks=vi.hoisted(()=>({auth:vi.fn(),admit:vi.fn(),grant:vi.fn(),query:vi.fn(),caps:vi.fn(),support:vi.fn()}));
vi.mock("@/lib/email/agent-api",async original=>({...await original<typeof import("@/lib/email/agent-api")>(),authenticateAgentRequest:mocks.auth}));
vi.mock("@/lib/email/database",async original=>({...await original<typeof import("@/lib/email/database")>(),execute:mocks.query}));
vi.mock("@/lib/email/agent-grants",async original=>({...await original<typeof import("@/lib/email/agent-grants")>(),requireActiveGrantRow:mocks.grant,admitAgentRead:mocks.admit}));
vi.mock("@/lib/email/agent-accounts",async original=>({...await original<typeof import("@/lib/email/agent-accounts")>(),getAgentCapabilities:mocks.caps}));
vi.mock("@/lib/email/agent-provider-support",async original=>({...await original<typeof import("@/lib/email/agent-provider-support")>(),getConditionalWriteSupport:mocks.support}));
const account={accountId:"gg",provider:"gmail" as const,expectedEmail:"owner@gmail.test"};const target={account,kind:"calendar" as const,id:account.expectedEmail};
const grant=()=>({accounts:[account],resources:[target],scopes:["accounts.read","calendar.delete","calendar.update","tasks.read","tasks.create","tasks.update","tasks.complete"],expiresAt:"2026-12-01T00:00:00Z"});
beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockResolvedValue({keyId:"key",revision:1});mocks.admit.mockResolvedValue(undefined);mocks.query.mockResolvedValue({rows:[{}]});mocks.grant.mockReturnValue(grant());mocks.caps.mockResolvedValue({identityVerifiedAt:new Date().toISOString(),calendarWrite:"available",tasksRead:"available",tasksWrite:"available"});mocks.support.mockResolvedValue({available:true});});
async function capabilities(){const response=await handleAgentRoute(new Request("https://mail.test/api/agent/v1/capabilities"),"capabilities");expect(response.status).toBe(200);return (await response.json()).accounts[0];}
it.each(["calendar.delete","calendar.update"])("qualified Google %s enables only that action and leaves Tasks closed",async qualified=>{
  mocks.support.mockImplementation(async(provider,action)=>({available:provider==="gmail"&&action===qualified}));
  expect(await capabilities()).toMatchObject({calendarDelete:qualified==="calendar.delete",calendarUpdate:qualified==="calendar.update",tasksRead:false,tasksCreate:false,tasksUpdate:false,tasksComplete:false});
  expect(mocks.support).toHaveBeenCalledTimes(2);
  expect(mocks.support).toHaveBeenCalledWith("gmail","calendar.delete");
  expect(mocks.support).toHaveBeenCalledWith("gmail","calendar.update");
});
it.each(["scope","resource","permission","qualification"])("keeps Google conditional writes closed without %s",async missing=>{if(missing==="scope")mocks.grant.mockReturnValue({...grant(),scopes:["accounts.read"]});if(missing==="resource")mocks.grant.mockReturnValue({...grant(),resources:[]});if(missing==="permission")mocks.caps.mockResolvedValue({calendarWrite:"missing"});if(missing==="qualification")mocks.support.mockResolvedValue({available:false});expect(await capabilities()).toMatchObject({calendarDelete:false,calendarUpdate:false});});
it("schema admits exact Google delete and update syntax while leaving Tasks Microsoft-only",()=>{const deletion={kind:"calendar.delete",target,eventId:"event",expectedRevision:'"old"'};expect(resourceMutationSchema.safeParse(deletion).success).toBe(true);expect(resourceMutationSchema.safeParse({...deletion,kind:"calendar.update",patch:{title:"after"}}).success).toBe(true);expect(resourceMutationSchema.safeParse({kind:"tasks.complete",target:{...target,kind:"task_list"},taskId:"task",expectedRevision:'"old"'}).success).toBe(false);expect(resourceMutationSchema.safeParse({...deletion,eventId:"*"}).success).toBe(false);});
