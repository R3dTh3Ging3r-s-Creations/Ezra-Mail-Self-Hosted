import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMicrosoftTaskLists, readMicrosoftTasks, readMicrosoftTask, createMicrosoftTask, taskFieldsToGraph, taskBodyToPlainText } from "@/lib/email/microsoft-todo";
const mocks = vi.hoisted(() => ({ capabilities: vi.fn(), token: vi.fn(), profile: vi.fn(), personal: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/email/agent-accounts", () => ({ getAgentCapabilities: mocks.capabilities, assertPersonalAccount: mocks.personal }));
vi.mock("@/lib/email/microsoft", () => ({ getMicrosoftAccessToken: mocks.token, getMicrosoftProfile: mocks.profile }));
const account = { accountId: "ms", provider: "microsoft" as const, expectedEmail: "owner@hotmail.test" };
const target = { account, kind: "task_list" as const, id: "list" };
const list = { id: "list", displayName: "Personal", isOwner: true, isShared: false, wellknownListName: "defaultList" };
const rawTask = { id: "task", title: "Fixture", body: { contentType: "html", content: "&lt;b&gt;&amp;<br>next" }, importance: "normal", status: "notStarted", isReminderOn: false, dueDateTime: null, recurrence: null, "@odata.etag": 'W/"revision"' };
describe("bounded personal Microsoft To Do", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capabilities.mockResolvedValue({ tasksRead: "available", tasksWrite: "available", scopes: ["Tasks.ReadWrite"] });
    mocks.personal.mockResolvedValue({ id: account.accountId, email: account.expectedEmail, provider: "microsoft" });
    mocks.token.mockResolvedValue("fixture-only"); mocks.profile.mockResolvedValue({ email: account.expectedEmail });
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.fetch.mockImplementation(async url => String(url).endsWith("/tasks/task") ? Response.json(rawTask) : String(url).includes("/tasks") ? Response.json({ value: [rawTask] }) : String(url).endsWith("/list") ? Response.json(list) : Response.json({ value: [list] }));
  });
  afterEach(() => vi.unstubAllGlobals());
  it("missing task scope makes zero token or task requests", async () => {
    mocks.capabilities.mockResolvedValue({ tasksRead: "missing", tasksWrite: "missing", scopes: ["Mail.Read"] });
    await expect(readMicrosoftTaskLists(account)).rejects.toThrow(/permission/i);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.token).not.toHaveBeenCalled();
  });
  it("verifies the exact provider identity before task access", async () => {
    mocks.profile.mockResolvedValue({ email: "work@company.test" });
    await expect(readMicrosoftTasks(target)).rejects.toThrow(/identity/i);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("returns complete exact-list tasks and deterministic literal plain text", async () => {
    const result = await readMicrosoftTasks(target);
    expect(result).toMatchObject({ complete: true, tasks: [{ id: "task", list: target, body: "<b>&\nnext", bodyFormat: "plain_text", revision: 'W/"revision"' }] });
    expect(mocks.token).toHaveBeenCalledWith(account.expectedEmail, "tasks-write", expect.any(AbortSignal));
  });
  it.each(["https://attacker.test/v1.0/me/todo/lists", "https://graph.microsoft.com/v1.0/users/other/todo/lists", "https://graph.microsoft.com/v1.0/me/todo/lists/list/tasks"])("rejects foreign continuation %s", async next => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ value: [list], "@odata.nextLink": next }));
    await expect(readMicrosoftTaskLists(account)).rejects.toMatchObject({code:"task_pagination_invalid"});
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it("never reports complete after a failed later page or malformed 200", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ value: [list], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/todo/lists?$skiptoken=next" })).mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(readMicrosoftTaskLists(account)).rejects.toThrow();
    mocks.fetch.mockResolvedValueOnce(Response.json({ unexpected: [] }));
    await expect(readMicrosoftTaskLists(account)).rejects.toThrow();
  });
  it("fails at the item cap rather than claiming truncated success", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ value: Array.from({ length: 1001 }, (_, index) => ({ ...list, id: `list-${index}` })) }));
    await expect(readMicrosoftTaskLists(account)).rejects.toMatchObject({code:"task_read_limit"});
  });
  it("accepts exactly the bounded item limit when the provider reports the end", async()=>{
    mocks.fetch.mockResolvedValueOnce(Response.json({value:Array.from({length:1000},(_,index)=>({...list,id:`list-${index}`}))}));
    expect((await readMicrosoftTaskLists(account)).lists).toHaveLength(1000);
  });
  it("classifies malformed list metadata as provider evidence, not caller input",async()=>{
    mocks.fetch.mockResolvedValueOnce(Response.json({value:[{...list,isShared:"invalid"}]}));
    await expect(readMicrosoftTaskLists(account)).rejects.toMatchObject({code:"task_provider_response_invalid"});
  });
  it("rejects shared lists and a moved or substituted task ID", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ ...list, isShared: true }));
    await expect(readMicrosoftTasks(target)).rejects.toMatchObject({code:"task_list_not_private"});
    mocks.fetch.mockResolvedValueOnce(Response.json(list)).mockResolvedValueOnce(Response.json({ ...rawTask, id: "other" }));
    await expect(readMicrosoftTask(target,"task")).rejects.toThrow(/identity/i);
  });
  it("does not treat an unavailable list as an absent task", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(readMicrosoftTask(target,"task")).rejects.toThrow();
    mocks.fetch.mockResolvedValueOnce(Response.json(list)).mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(readMicrosoftTask(target,"task")).resolves.toEqual({ status: "absent" });
  });
  it.each(["", "  ", "  Existing title  ", "x".repeat(350)])("reads existing title without enforcing create rules: %j",async title=>{
    mocks.fetch.mockResolvedValueOnce(Response.json(list)).mockResolvedValueOnce(Response.json({value:[{...rawTask,title}]}));
    const result=await readMicrosoftTasks(target);
    expect(result.tasks[0].title).toBe(title);
  });
  it("returns an empty private list without manufacturing tasks",async()=>{
    mocks.fetch.mockResolvedValueOnce(Response.json(list)).mockResolvedValueOnce(Response.json({value:[]}));
    expect(await readMicrosoftTasks(target)).toMatchObject({complete:true,tasks:[]});
  });
  it("preserves an unsupported provider date with a warning instead of dropping the entire list",async()=>{
    const due={dateTime:"2026-10-08T09:00:00.0000000",timeZone:"Unmapped Provider Zone"};
    mocks.fetch.mockResolvedValueOnce(Response.json(list)).mockResolvedValueOnce(Response.json({value:[{...rawTask,dueDateTime:due}]}));
    const result=await readMicrosoftTasks(target);
    expect(result.tasks[0]).toMatchObject({due:null,readWarnings:["due_normalization_unavailable"],providerDates:{due}});
  });
  it("preserves ambiguous reminder evidence without silently claiming reminders disabled",async()=>{
    const reminder={dateTime:"2026-11-01T01:30:00",timeZone:"Central Standard Time"};
    mocks.fetch.mockResolvedValueOnce(Response.json(list)).mockResolvedValueOnce(Response.json({value:[{...rawTask,isReminderOn:true,reminderDateTime:reminder}]}));
    const result=await readMicrosoftTasks(target);
    expect(result.tasks[0]).toMatchObject({reminder:null,readWarnings:["reminder_normalization_unavailable"],providerDates:{reminder,isReminderOn:true}});
  });
  it("distinguishes provider denial from invalid client arguments without echoing provider errors",async()=>{
    mocks.fetch.mockResolvedValueOnce(new Response("private provider details",{status:403}));
    await expect(readMicrosoftTasks(target)).rejects.toMatchObject({code:"task_provider_denied"});
  });
  it("follows a valid exact-resource continuation and preserves task order",async()=>{
    mocks.fetch.mockResolvedValueOnce(Response.json(list))
      .mockResolvedValueOnce(Response.json({value:[rawTask],"@odata.nextLink":"https://graph.microsoft.com/v1.0/me/todo/lists/list/tasks?$skiptoken=next"}))
      .mockResolvedValueOnce(Response.json({value:[{...rawTask,id:"second",title:"  "}]}));
    expect((await readMicrosoftTasks(target)).tasks.map(task=>task.id)).toEqual(["task","second"]);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });
  it("reports malformed existing provider records separately from caller arguments",async()=>{
    mocks.fetch.mockResolvedValueOnce(Response.json(list)).mockResolvedValueOnce(Response.json({value:[{...rawTask,importance:"unknown"}]}));
    await expect(readMicrosoftTasks(target)).rejects.toMatchObject({code:"task_provider_response_invalid"});
  });
  it("does not silently hide unsupported task body content",async()=>{
    mocks.fetch.mockResolvedValueOnce(Response.json(list)).mockResolvedValueOnce(Response.json({value:[{...rawTask,body:{contentType:"unsupported",content:"private fixture"}}]}));
    await expect(readMicrosoftTasks(target)).rejects.toMatchObject({code:"task_body_unsupported"});
  });
  it("escapes HTML while preserving literal markup and newlines", () => {
    const result = taskFieldsToGraph({ body: "<b>&\nnext" });
    expect(result.body).toEqual({ contentType: "html", content: "&lt;b&gt;&amp;<br>next" });
    expect(taskBodyToPlainText(result.body)).toBe("<b>&\nnext");
  });
  it.each(["2026-03-08","2026-11-01"])("keeps date-only due dates local across DST %s", date => {
    expect(taskFieldsToGraph({ due: { kind: "date", date, timezone: "America/Chicago" } }).dueDateTime).toEqual({ dateTime: `${date}T00:00:00`, timeZone: "America/Chicago" });
    expect(taskFieldsToGraph({ title: "Only title" })).not.toHaveProperty("dueDateTime");
    expect(taskFieldsToGraph({ due: null, reminder: null })).toMatchObject({ dueDateTime: null, isReminderOn: false, reminderDateTime: null });
  });
  it("creates only in the exact private list and requires a returned ID", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json(list)).mockResolvedValueOnce(Response.json({ id: "created" }, { status: 201 }));
    expect(await createMicrosoftTask(target, { title: "Fixture", body: "", importance: "normal", due: null, reminder: null })).toEqual({ id: "created" });
    const [url,options] = mocks.fetch.mock.calls[1];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/todo/lists/list/tasks");
    expect(options.method).toBe("POST"); expect(options.redirect).toBe("error");
  });
});
