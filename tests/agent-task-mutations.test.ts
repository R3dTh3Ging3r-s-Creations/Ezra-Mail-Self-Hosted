import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { updateMicrosoftTask,completeMicrosoftTask } from "@/lib/email/microsoft-todo";
const mocks=vi.hoisted(()=>({support:vi.fn(),caps:vi.fn(),personal:vi.fn(),token:vi.fn(),profile:vi.fn(),fetch:vi.fn()}));
vi.mock("@/lib/email/agent-provider-support",async original=>({...await original<typeof import("@/lib/email/agent-provider-support")>(),getConditionalWriteSupport:mocks.support}));
vi.mock("@/lib/email/agent-accounts",()=>({getAgentCapabilities:mocks.caps,assertPersonalAccount:mocks.personal}));
vi.mock("@/lib/email/microsoft",()=>({getMicrosoftAccessToken:mocks.token,getMicrosoftProfile:mocks.profile}));
const account={accountId:"ms",provider:"microsoft" as const,expectedEmail:"owner@hotmail.test"};
const target={account,kind:"task_list" as const,id:"list"};
const before={id:"task",title:"Before",body:{contentType:"html",content:"Keep"},importance:"normal",status:"notStarted",isReminderOn:false,dueDateTime:null,reminderDateTime:null,recurrence:null,"@odata.etag":'W/"old"'};
describe("qualified conditional task mutations",()=>{
  let raw:Record<string,unknown>;
  beforeEach(()=>{vi.clearAllMocks();raw=structuredClone(before);mocks.support.mockResolvedValue({available:true});mocks.caps.mockResolvedValue({tasksRead:"available",tasksWrite:"available",scopes:["Tasks.ReadWrite"]});mocks.personal.mockResolvedValue({});mocks.token.mockResolvedValue("fixture");mocks.profile.mockResolvedValue({email:account.expectedEmail});
    mocks.fetch.mockImplementation(async(url,init)=>{if(String(url).endsWith("/list"))return Response.json({id:"list",displayName:"Fixture",isOwner:true,isShared:false});if(init?.method==="PATCH"){raw={...raw,...JSON.parse(init.body),"@odata.etag":'W/"new"'};}return Response.json(raw);});vi.stubGlobal("fetch",mocks.fetch);
  });afterEach(()=>vi.unstubAllGlobals());
  it("accepts equivalent seven-digit provider times and HTML wrappers for changed fields",async()=>{
    mocks.fetch.mockImplementation(async(url,init)=>{if(String(url).endsWith("/list"))return Response.json({id:"list",displayName:"Fixture",isOwner:true,isShared:false});if(init?.method==="PATCH"){raw={...raw,...JSON.parse(init.body),body:{contentType:"html",content:"<html><body><div>&lt;b&gt;&amp;<br>next</div></body></html>"},dueDateTime:{dateTime:"2026-11-06T13:00:00.1230000",timeZone:"UTC"},reminderDateTime:{dateTime:"2026-11-06T12:00:00.0000000",timeZone:"UTC"},"@odata.etag":'W/"new"'};}return Response.json(raw);});
    await expect(updateMicrosoftTask(target,"task",'W/"old"',{body:"<b>&\nnext",due:{kind:"instant",instant:"2026-11-06T13:00:00.123Z",timezone:"UTC"},reminder:{instant:"2026-11-06T12:00:00Z",timezone:"UTC"}})).resolves.toBeUndefined();
  });
  it("title-only updates preserve body and completion state",async()=>{await updateMicrosoftTask(target,"task",'W/"old"',{title:"After"});const write=mocks.fetch.mock.calls.find(([,init])=>init.method==="PATCH")!;expect(JSON.parse(write[1].body)).toEqual({title:"After"});expect(raw).toMatchObject({body:before.body,status:"notStarted"});expect(write[1].headers["if-match"]).toBe('W/"old"');});
  it("completion sends status only",async()=>{await completeMicrosoftTask(target,"task",'W/"old"');const write=mocks.fetch.mock.calls.find(([,init])=>init.method==="PATCH")!;expect(JSON.parse(write[1].body)).toEqual({status:"completed"});});
  it("update cannot complete or reopen a task",async()=>{await expect(updateMicrosoftTask(target,"task",'W/"old"',{status:"completed"} as never)).rejects.toThrow();expect(mocks.fetch.mock.calls.some(([,init])=>init.method==="PATCH")).toBe(false);});
  it.each([{recurrence:{pattern:{type:"daily"}}},{"@odata.etag":""},{id:"moved"}])("rejects recurring or changed task %#",async patch=>{raw={...raw,...patch};await expect(updateMicrosoftTask(target,"task",'W/"old"',{title:"After"})).rejects.toThrow();expect(mocks.fetch.mock.calls.some(([,init])=>init.method==="PATCH")).toBe(false);});
  it("unqualified completion makes no requests",async()=>{mocks.support.mockResolvedValue({available:false});await expect(completeMicrosoftTask(target,"task",'W/"old"')).rejects.toThrow(/qualified/i);expect(mocks.fetch).not.toHaveBeenCalled();});
  it("stale revision and HTTP412 never become verified success",async()=>{await expect(updateMicrosoftTask(target,"task",'W/"stale"',{title:"After"})).rejects.toThrow(/revision/i);mocks.fetch.mockImplementation(async(url,init)=>String(url).endsWith("/list")?Response.json({id:"list",displayName:"Fixture",isOwner:true,isShared:false}):init?.method==="PATCH"?new Response(null,{status:412}):Response.json(raw));await expect(updateMicrosoftTask(target,"task",'W/"old"',{title:"After"})).rejects.toMatchObject({code:"provider_precondition_failed"});});

  it.each([
    ["update","response"],["update","readback"],
    ["complete","response"],["complete","readback"],
  ] as const)("does not verify %s when recurrence evidence disappears from the %s",async(action,phase)=>{
    let dispatched=false;
    mocks.fetch.mockImplementation(async(url,init)=>{
      if(String(url).endsWith("/list"))return Response.json({id:"list",displayName:"Fixture",isOwner:true,isShared:false});
      if(init?.method==="PATCH"){
        dispatched=true;
        raw={...raw,...JSON.parse(init.body),"@odata.etag":'W/"new"'};
        if(phase==="response"){const response={...raw};delete response.recurrence;return Response.json(response);}
      }else if(dispatched&&phase==="readback"){
        const response={...raw};delete response.recurrence;return Response.json(response);
      }
      return Response.json(raw);
    });
    const mutation=action==="update"
      ?updateMicrosoftTask(target,"task",'W/"old"',{title:"After"})
      :completeMicrosoftTask(target,"task",'W/"old"');
    await expect(mutation).rejects.toThrow(/verify|readback/i);
    expect(mocks.fetch.mock.calls.filter(([,init])=>init.method==="PATCH")).toHaveLength(1);
  });
  it.each(['update','complete'] as const)('supports validated omitted recurrence for qualified %s without inventing null',async action=>{
    raw={...raw,createdDateTime:'2026-10-08T10:00:00Z',lastModifiedDateTime:'2026-10-08T10:00:00Z',hasAttachments:false,categories:[]};delete raw.recurrence;
    if(action==='update')await updateMicrosoftTask(target,'task','W/"old"',{title:'After'});else await completeMicrosoftTask(target,'task','W/"old"');
    expect(Object.hasOwn(raw,'recurrence')).toBe(false);expect(mocks.support).toHaveBeenCalledWith('microsoft',action==='update'?'tasks.update':'tasks.complete',account);
    expect(mocks.fetch.mock.calls.filter(([,init])=>init.method==='PATCH')).toHaveLength(1);
    expect(mocks.fetch.mock.calls.every(([url])=>!String(url).includes('?'))).toBe(true);
  });
  it.each(['createdDateTime','lastModifiedDateTime','categories','hasAttachments'])('rejects incomplete omission evidence missing %s before dispatch',async key=>{
    raw={...raw,createdDateTime:'2026-10-08T10:00:00Z',lastModifiedDateTime:'2026-10-08T10:00:00Z',hasAttachments:false,categories:[]};delete raw.recurrence;delete raw[key];
    await expect(updateMicrosoftTask(target,'task','W/"old"',{title:'After'})).rejects.toThrow();expect(mocks.fetch.mock.calls.some(([,init])=>init.method==='PATCH')).toBe(false);
  });
  it.each([{'@odata.nextLink':'https://graph.microsoft.com/next'},{'@odata.deltaLink':'https://graph.microsoft.com/delta'},{'@odata.context':'https://graph.microsoft.com/v1.0/$metadata#users/me/todo/lists/list/tasks(id,title)/$entity'}])('rejects advertised partial/projected omission evidence %j',async annotation=>{
    raw={...raw,createdDateTime:'2026-10-08T10:00:00Z',lastModifiedDateTime:'2026-10-08T10:00:00Z',hasAttachments:false,categories:[],...annotation};delete raw.recurrence;
    await expect(updateMicrosoftTask(target,'task','W/"old"',{title:'After'})).rejects.toThrow();expect(mocks.fetch.mock.calls.some(([,init])=>init.method==='PATCH')).toBe(false);
  });

  it.each(['#tasks/$entity',"#users('owner')/todo/lists('list')/tasks/$entity"])('accepts full entity metadata %s for qualified omission',async context=>{
    raw={...raw,createdDateTime:'2026-10-08T10:00:00Z',lastModifiedDateTime:'2026-10-08T10:00:00Z',hasAttachments:false,categories:[],'@odata.context':'https://graph.microsoft.com/v1.0/$metadata'+context};delete raw.recurrence;
    await expect(updateMicrosoftTask(target,'task','W/"old"',{title:'After'})).resolves.toBeUndefined();expect(Object.hasOwn(raw,'recurrence')).toBe(false);
  });
});
