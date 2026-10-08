import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureEmailDatabaseForTests, execute, setSetting } from "@/lib/email/database";
import { prepareAgentOperation } from "@/lib/email/agent-resource-store";
import { executeAgentOperation, reconcileAgentOperation } from "@/lib/email/agent-resource-operations";

const mocks=vi.hoisted(()=>({support:vi.fn(),caps:vi.fn(),personal:vi.fn(),token:vi.fn(),profile:vi.fn(),fetch:vi.fn()}));
vi.mock("@/lib/email/agent-provider-support",async original=>({...await original<typeof import("@/lib/email/agent-provider-support")>(),getConditionalWriteSupport:mocks.support}));
vi.mock("@/lib/email/agent-accounts",()=>({getAgentCapabilities:mocks.caps,assertPersonalAccount:mocks.personal}));
vi.mock("@/lib/email/microsoft",()=>({getMicrosoftAccessToken:mocks.token,getMicrosoftProfile:mocks.profile}));
const account={accountId:"ms",provider:"microsoft" as const,expectedEmail:"owner@hotmail.test"};
const target={account,kind:"task_list" as const,id:"list"};
const principal={keyId:"fixture",revision:1};

describe("task mutation receipts preserve uncertain provider evidence",()=>{
  let raw:Record<string,unknown>;
  beforeEach(async()=>{
    vi.clearAllMocks();
    configureEmailDatabaseForTests(`file:./task-verification-${randomUUID()}.sqlite`);
    await setSetting("agent_personal_accounts",JSON.stringify([account,{accountId:"gg",provider:"gmail",expectedEmail:"owner@gmail.test"}]));
    const now=new Date().toISOString();
    await execute("INSERT INTO email_accounts(id,provider,email,label,status,created_at,updated_at) VALUES ('ms','microsoft',?,'Fixture','connected',?,?)",[account.expectedEmail,now,now]);
    await execute("INSERT INTO agent_grants(key_id,secret_digest,grant_json,revision,created_at,expires_at) VALUES ('fixture','synthetic',?,1,?,?)",[JSON.stringify({label:"Fixture",lifetimeDays:7,accounts:[account],resources:[target],scopes:["tasks.read","tasks.update","tasks.complete"]}),now,new Date(Date.now()+86_400_000).toISOString()]);
    mocks.support.mockResolvedValue({available:true});
    mocks.caps.mockResolvedValue({tasksRead:"available",tasksWrite:"available",scopes:["Tasks.ReadWrite"]});
    mocks.personal.mockResolvedValue({});
    mocks.token.mockResolvedValue("synthetic-token");
    mocks.profile.mockResolvedValue({email:account.expectedEmail});
    raw={id:"task",title:"Before",body:{contentType:"html",content:"Keep"},importance:"normal",status:"notStarted",isReminderOn:false,dueDateTime:null,reminderDateTime:null,recurrence:null,"@odata.etag":'W/"old"'};
    vi.stubGlobal("fetch",mocks.fetch);
  });
  afterEach(()=>vi.unstubAllGlobals());

  it.each([
    ["tasks.update","response"],["tasks.update","readback"],
    ["tasks.complete","response"],["tasks.complete","readback"],
  ] as const)("%s remains unknown and locked when %s loses recurrence evidence",async(kind,phase)=>{
    let writes=0;
    mocks.fetch.mockImplementation(async(url,init)=>{
      if(String(url).endsWith("/list"))return Response.json({id:"list",displayName:"Fixture",isOwner:true,isShared:false});
      if(init?.method==="PATCH"){
        writes++;
        raw={...raw,...JSON.parse(init.body),"@odata.etag":'W/"new"'};
        if(phase==="response"){const response={...raw};delete response.recurrence;return Response.json(response);}
      }else if(writes>0&&phase==="readback"){
        const response={...raw};delete response.recurrence;return Response.json(response);
      }
      return Response.json(raw);
    });
    const common={target,taskId:"task",expectedRevision:'W/"old"'};
    const mutation=kind==="tasks.update"?{...common,kind,patch:{title:"After"}}:{...common,kind};
    const op=await prepareAgentOperation(principal,"missing-recurrence",mutation);
    const result=await executeAgentOperation(principal,op.id,op.payloadHash);
    expect(result).toMatchObject({status:"unknown",errorCode:"unverified_provider_outcome"});
    expect(result.receipt).toBeUndefined();
    expect((await execute("SELECT operation_id FROM agent_resource_locks")).rows).toEqual([{operation_id:op.id}]);
    expect((await execute("SELECT outcome FROM agent_resource_operation_attempts WHERE operation_id=?",[op.id])).rows).toEqual([{outcome:"unknown"}]);
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:"unknown"});
    expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({status:"unknown"});
    expect(writes).toBe(1);
    expect((await execute("SELECT operation_id FROM agent_resource_locks")).rows).toEqual([{operation_id:op.id}]);
  });

  it.each(['tasks.update','tasks.complete'] as const)('%s verifies qualified inferred recurrence and never repeats a successful operation',async kind=>{
    raw={...raw,createdDateTime:'2026-10-08T10:00:00Z',lastModifiedDateTime:'2026-10-08T10:00:00Z',hasAttachments:false,categories:[]};delete raw.recurrence;
    let writes=0;
    mocks.fetch.mockImplementation(async(url,init)=>{if(String(url).endsWith('/list'))return Response.json({id:'list',displayName:'Fixture',isOwner:true,isShared:false});if(init?.method==='PATCH'){writes++;raw={...raw,...JSON.parse(init.body),'@odata.etag':'W/"new"'};}return Response.json(raw);});
    const common={target,taskId:'task',expectedRevision:'W/"old"'};
    const mutation=kind==='tasks.update'?{...common,kind,patch:{title:'After'}}:{...common,kind};
    const op=await prepareAgentOperation(principal,'inferred-success',mutation);
    const result=await executeAgentOperation(principal,op.id,op.payloadHash);
    expect(result).toMatchObject({status:'succeeded',receipt:{providerId:'task',outcome:kind==='tasks.update'?'updated':'completed'}});
    expect((await execute('SELECT operation_id FROM agent_resource_locks')).rows).toEqual([]);
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:'succeeded'});
    expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({status:'succeeded'});
    expect(writes).toBe(1);expect(Object.hasOwn(raw,'recurrence')).toBe(false);
  });

  it.each([
    ['tasks.update','response','incomplete'],['tasks.update','readback','incomplete'],
    ['tasks.complete','response','incomplete'],['tasks.complete','readback','incomplete'],
    ['tasks.update','response','recurring'],['tasks.update','readback','recurring'],
    ['tasks.complete','response','recurring'],['tasks.complete','readback','recurring'],
  ] as const)('%s holds inferred-to-%s-%s drift without replay',async(kind,phase,drift)=>{
    raw={...raw,createdDateTime:'2026-10-08T10:00:00Z',lastModifiedDateTime:'2026-10-08T10:00:00Z',hasAttachments:false,categories:[]};delete raw.recurrence;
    let writes=0;
    mocks.fetch.mockImplementation(async(url,init)=>{
      if(String(url).endsWith('/list'))return Response.json({id:'list',displayName:'Fixture',isOwner:true,isShared:false});
      const isPatch=init?.method==='PATCH';if(isPatch){writes++;raw={...raw,...JSON.parse(init.body),'@odata.etag':'W/"new"'};}
      const reply={...raw};if(writes&&((phase==='response'&&isPatch)||(phase==='readback'&&!isPatch))){if(drift==='incomplete')delete reply.categories;else reply.recurrence={pattern:{type:'daily'}};}
      return Response.json(reply);
    });
    const common={target,taskId:'task',expectedRevision:'W/"old"'};const mutation=kind==='tasks.update'?{...common,kind,patch:{title:'After'}}:{...common,kind};
    const op=await prepareAgentOperation(principal,'inferred-drift',mutation);
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:'unknown',errorCode:'unverified_provider_outcome'});
    expect((await execute('SELECT operation_id FROM agent_resource_locks')).rows).toEqual([{operation_id:op.id}]);
    expect(await executeAgentOperation(principal,op.id,op.payloadHash)).toMatchObject({status:'unknown'});
    expect(await reconcileAgentOperation(principal,op.id)).toMatchObject({status:'unknown'});
    expect(writes).toBe(1);expect((await execute('SELECT outcome FROM agent_resource_operation_attempts WHERE operation_id=?',[op.id])).rows).toEqual([{outcome:'unknown'}]);
  });
});
