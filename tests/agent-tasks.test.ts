import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, execute, setSetting } from "@/lib/email/database";
import { prepareAgentOperation } from "@/lib/email/agent-resource-store";
import { executeAgentOperation,reconcileAgentOperation } from "@/lib/email/agent-resource-operations";
import { readAgentTaskLists } from "@/lib/email/agent-tasks";
import type { ResourceMutation, TaskRecord } from "@/lib/email/agent-resource-types";
const mocks = vi.hoisted(()=>({verify:vi.fn(),create:vi.fn(),read:vi.fn()}));
vi.mock("@/lib/email/microsoft-todo",()=>({verifyMicrosoftTaskList:mocks.verify,createMicrosoftTask:mocks.create,readMicrosoftTask:mocks.read,readMicrosoftTasks:vi.fn()}));
const account = {accountId:"ms",provider:"microsoft" as const,expectedEmail:"owner@hotmail.test"};
const target = {account,kind:"task_list" as const,id:"selected"};
const principal = {keyId:"fixture",revision:1};
const fields = {title:"Fixture",body:"<b>&\nnext",importance:"normal" as const,due:null,reminder:null};
const mutation: ResourceMutation = {kind:"tasks.create",target,fields};
const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({...fields,list:target,id:"created",revision:"etag",status:"notStarted",bodyFormat:"plain_text",recurring:false,fetchedAt:new Date().toISOString(),...overrides});
describe("verified task creation",()=>{
  beforeEach(async()=>{
    configureEmailDatabaseForTests(`file:./agent-tasks-${randomUUID()}.sqlite`);
    await setSetting("agent_personal_accounts",JSON.stringify([account,{accountId:"gg",provider:"gmail",expectedEmail:"owner@gmail.test"}]));
    await execute("INSERT INTO email_accounts(id,provider,email,label,status,created_at,updated_at) VALUES ('ms','microsoft',?,'Fixture','connected',?,?)",[account.expectedEmail,new Date().toISOString(),new Date().toISOString()]);
    await execute("INSERT INTO agent_grants(key_id,secret_digest,grant_json,revision,created_at,expires_at) VALUES ('fixture','synthetic',?,1,?,?)",[JSON.stringify({label:"Fixture",lifetimeDays:7,accounts:[account],resources:[target],scopes:["tasks.read","tasks.create"]}),new Date().toISOString(),new Date(Date.now()+86_400_000).toISOString()]);
    vi.clearAllMocks();
    mocks.verify.mockImplementation(async value=>({target:value,complete:true,title:"Selected",fetchedAt:new Date().toISOString(),identityVerifiedAt:new Date().toISOString()}));
    mocks.create.mockImplementation(async(...args:any[])=>{await args.at(-1)();return {id:"created"};});
    mocks.read.mockResolvedValue({status:"found",task:{...fields,list:target,id:"created",revision:"etag",status:"notStarted",bodyFormat:"plain_text",recurring:false,fetchedAt:new Date().toISOString()}});
  });
  it("persists provider ID before exact readback and does not dispatch twice",async()=>{
    const op=await prepareAgentOperation(principal,"request",mutation);
    mocks.read.mockImplementationOnce(async()=>{
      expect((await execute("SELECT provider_id FROM agent_resource_operations WHERE id=?",[op.id])).rows[0].provider_id).toBe("created");
      return {status:"found",task:{...fields,list:target,id:"created",revision:"etag",status:"notStarted",bodyFormat:"plain_text",recurring:false,fetchedAt:new Date().toISOString()}};
    });
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"succeeded",receipt:{providerId:"created",outcome:"created"}});
    await executeAgentOperation(principal,op.id,op.payloadHash);
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it("lost create response without ID remains unknown; reconciliation never searches by title",async()=>{
    const op=await prepareAgentOperation(principal,"request",mutation);
    mocks.create.mockImplementationOnce(async(...args:any[])=>{await args.at(-1)();throw new Error("connection lost");});
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"unknown"});
    expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({status:"unknown"});
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.create).toHaveBeenCalledOnce();
  });
  it("mismatched readback stays unknown and can reconcile only the stored ID",async()=>{
    const op=await prepareAgentOperation(principal,"request",mutation);
    mocks.read.mockResolvedValueOnce({status:"absent"});
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"unknown"});
    expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({status:"succeeded"});
    expect(mocks.read).toHaveBeenLastCalledWith(target,"created",expect.any(AbortSignal));
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it.each(["", " ", "\t\r\n "])("verifies an explicitly empty body when the provider returns %j",async body=>{
    const op=await prepareAgentOperation(principal,"request",{kind:"tasks.create",target,fields:{...fields,body:""}});
    mocks.read.mockResolvedValue({status:"found",task:task({body})});
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"succeeded",receipt:{providerId:"created",outcome:"created"}});
    expect((await execute("SELECT * FROM agent_resource_locks")).rows).toHaveLength(0);
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it("reconciles the saved ID with a whitespace-only body and releases the unknown operation lock without another create",async()=>{
    const op=await prepareAgentOperation(principal,"request",{kind:"tasks.create",target,fields:{...fields,body:""}});
    mocks.read.mockRejectedValueOnce(new Error("Readback unavailable"));
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({id:op.id,status:"unknown"});
    expect((await execute("SELECT provider_id FROM agent_resource_operations WHERE id=?",[op.id])).rows).toEqual([{provider_id:"created"}]);
    expect((await execute("SELECT operation_id FROM agent_resource_locks")).rows).toEqual([{operation_id:op.id}]);
    mocks.read.mockResolvedValue({status:"found",task:task({body:" \r\n\t"})});
    expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({id:op.id,status:"succeeded",receipt:{providerId:"created",outcome:"created"}});
    expect(mocks.read).toHaveBeenLastCalledWith(target,"created",expect.any(AbortSignal));
    expect((await execute("SELECT * FROM agent_resource_locks")).rows).toHaveLength(0);
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({id:op.id,status:"succeeded"});
    expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({id:op.id,status:"succeeded"});
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it.each<[string, Partial<TaskRecord>]>([
    ["task ID",{id:"other"}],
    ["list",{list:{...target,id:"other"}}],
    ["account",{list:{...target,account:{...account,accountId:"other"}}}],
    ["email identity",{list:{...target,account:{...account,expectedEmail:"other@hotmail.test"}}}],
    ["provider",{list:{...target,account:{...account,provider:"gmail"}}}],
    ["title",{title:"Other"}],
    ["importance",{importance:"high"}],
    ["status",{status:"completed"}],
    ["recurrence",{recurring:true}],
    ["unresolved provider date",{readWarnings:["due_normalization_unavailable"]}],
    ["due",{due:{kind:"instant",instant:"2026-10-08T12:00:00Z",timezone:"UTC"}}],
    ["reminder",{reminder:{instant:"2026-10-08T12:00:00Z",timezone:"UTC"}}],
    ["meaningful body",{body:"unexpected"}],
  ])("keeps an empty-body operation unknown and locked when %s differs",async(_label,overrides)=>{
    const op=await prepareAgentOperation(principal,"request",{kind:"tasks.create",target,fields:{...fields,body:""}});
    mocks.read.mockResolvedValue({status:"found",task:task({body:" \n",...overrides})});
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"unknown"});
    expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({status:"unknown"});
    expect((await execute("SELECT operation_id FROM agent_resource_locks")).rows).toEqual([{operation_id:op.id}]);
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it.each([
    [" ",""],
    [" ","\t"],
    ["meaningful"," meaningful "],
    ["meaningful ","meaningful"],
    ["line\nnext","line next"],
    ["meaningful\n","meaningful"],
    ["meaningful\n","meaningful\n\n"],
  ])("keeps requested nonempty body %j distinct from provider body %j",async(requested,returned)=>{
    const op=await prepareAgentOperation(principal,"request",{kind:"tasks.create",target,fields:{...fields,body:requested}});
    mocks.read.mockResolvedValue({status:"found",task:task({body:returned})});
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"unknown"});
    expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({status:"unknown"});
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it("preserves exact newline-normalized comparison for nonempty requested bodies",async()=>{
    const op=await prepareAgentOperation(principal,"request",{kind:"tasks.create",target,fields:{...fields,body:"line\r\nnext\rlast"}});
    mocks.read.mockResolvedValue({status:"found",task:task({body:"line\nnext\nlast"})});
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"succeeded"});
  });
  it("reconciles a persisted nonempty task with one provider terminal line ending without another create",async()=>{
    const body="Temporary test of direct plugin task creation.";
    const op=await prepareAgentOperation(principal,"terminal-line",{kind:"tasks.create",target,fields:{...fields,body}});
    mocks.read.mockRejectedValueOnce(new Error("Readback interrupted"));
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"unknown"});
    expect((await execute("SELECT provider_id FROM agent_resource_operations WHERE id=?",[op.id])).rows).toEqual([{provider_id:"created"}]);
    expect((await execute("SELECT operation_id FROM agent_resource_locks")).rows).toEqual([{operation_id:op.id}]);
    mocks.read.mockResolvedValue({status:"found",task:task({body:body+"\n"})});
    expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({id:op.id,status:"succeeded",receipt:{providerId:"created",outcome:"created"}});
    expect(mocks.read).toHaveBeenLastCalledWith(target,"created",expect.any(AbortSignal));
    expect((await execute("SELECT * FROM agent_resource_locks")).rows).toHaveLength(0);
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"succeeded"});
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it.each(["meaningful\n\n","meaningful \n"," meaningful\n","meaningful\nchanged"])("does not hide changed content behind terminal-line normalization: %j",async body=>{
    const op=await prepareAgentOperation(principal,"changed-body",{kind:"tasks.create",target,fields:{...fields,body:"meaningful"}});
    mocks.read.mockResolvedValue({status:"found",task:task({body})});
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"unknown"});
    expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({status:"unknown"});
    expect((await execute("SELECT operation_id FROM agent_resource_locks")).rows).toEqual([{operation_id:op.id}]);
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it("list metadata reads only exact grant-selected resources",async()=>{
    expect(await readAgentTaskLists(principal,account)).toEqual({complete:true,lists:[{id:"selected",title:"Selected",shared:false}]});
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(mocks.verify).toHaveBeenCalledWith(target,false,undefined);
  });
});
