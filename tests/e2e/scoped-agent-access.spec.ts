import {expect,test,type Page} from "@playwright/test";
const account={accountId:"personal-ms",provider:"microsoft",expectedEmail:"owner@hotmail.test"};
async function fixture(page:Page,connected:boolean){
 const writes:unknown[]=[];
 await page.route("**/api/**",async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==="/api/auth/session")return route.fulfill({json:{authenticated:true,configured:true,developmentBypass:true,expiresAt:null}});
  if(path==="/api/mail/meta")return route.fulfill({json:{workspaces:[{id:"workspace:microsoft",label:"Personal",purpose:"Personal",accountIds:[account.accountId],isAllAccounts:false,calendarRole:"primary_future",provider:"microsoft"}]}});
  if(path==="/api/auth/agent-grants/resources")return route.fulfill({json:route.request().method()==="GET"?{accounts:[{account,availableScopes:connected?["tasks.read","tasks.create"]:[],unavailable:connected?[]:["To Do needs explicit personal Microsoft task consent."]}]}:{resources:[{title:"Personal list",target:{account,kind:"task_list",id:"list"}}]}});
  if(path==="/api/todo")return route.fulfill({json:{complete:true,tasks:[],fetchedAt:new Date().toISOString()}});
  if(path==="/api/todo/actions") {const body=route.request().postDataJSON();writes.push(body);return route.fulfill({json:{id:"prepared-fixture",kind:"tasks.create",payloadHash:"a".repeat(64),status:body.action==="prepare"?"prepared":"succeeded",expiresAt:new Date(Date.now()+600000).toISOString(),...(body.action==="execute"?{receipt:{providerId:"fixture-task",outcome:"created",verifiedAt:new Date().toISOString()}}:{})}});}
  return route.fulfill({status:404,json:{error:"fixture_unavailable"}});
 });return writes;
}
test("To Do consent is deliberate and limited to the personal account",async({page})=>{const actions=await fixture(page,false);await page.goto("/?view=todo");await page.getByLabel("Personal account").selectOption(account.accountId);await expect(page.getByRole("button",{name:"Connect personal To Do"})).toBeVisible();expect(actions).toEqual([]);await expect(page.getByText(/local Today checklist/)).toBeVisible();});
test("To Do requires exact review before execution",async({page})=>{const actions=await fixture(page,true);await page.goto("/?view=todo");await page.getByLabel("Personal account").selectOption(account.accountId);await page.getByRole("button",{name:"Load task lists"}).click();await page.getByLabel("Task list").selectOption("list");await page.getByLabel("Task title").fill("Synthetic task");await page.getByRole("button",{name:"Review task",exact:true}).click();await expect(page.getByLabel("Exact task review")).toContainText(account.expectedEmail);expect(actions).toHaveLength(1);await page.getByRole("button",{name:"Confirm task action"}).click();await expect(page.getByRole("status")).toContainText("verified created");expect(actions).toHaveLength(2);});
