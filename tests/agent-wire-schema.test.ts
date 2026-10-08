import {describe,expect,it} from "vitest";
import {agentResponseSchemas} from "@/lib/email/agent-wire-schema";
const account={accountId:"fixture",provider:"microsoft",expectedEmail:"owner@example.test"};
const stamp="2026-10-07T12:00:00Z";
describe("agent read metadata wire contract",()=>{
 it("preserves provider task titles and uncertain original dates",()=>{
  const task={list:{account,kind:"task_list",id:"list"},id:"task",revision:"revision",status:"notStarted",fetchedAt:stamp,bodyFormat:"plain_text",recurring:false,title:"   ",body:"",importance:"normal",due:null,reminder:null,readWarnings:["due_normalization_unavailable"],providerDates:{due:{dateTime:"2026-10-07T00:00:00",timeZone:"Unmapped Provider Zone"},reminder:null,isReminderOn:false}};
  const result=agentResponseSchemas["tasks/read"].parse({complete:true,tasks:[task],fetchedAt:stamp});
  expect(result.tasks[0]).toEqual(task);
 });
 it("retains local-index freshness and snippet availability",()=>{
  const response={account,source:"local_index",completeProviderCoverage:false,untrustedContent:true,lastProviderSyncAt:stamp,items:[{messageId:"message",subject:"Fixture",senderName:"Fixture",senderEmail:"sender@example.test",receivedAt:stamp,snippet:"",indexedAt:stamp,snippetAvailable:false}],nextCursor:null,freshness:"not_verified",timestampMeaning:{receivedAt:"indexed_message_timestamp",indexedAt:"local_row_updated_at",lastProviderSyncAt:"account_sync_completed_at"}};
  expect(agentResponseSchemas["mail/search"].parse(response)).toEqual(response);
 });
 it("retains provider body source and indexed/provider timestamp comparison",()=>{
  const response={account,source:"provider",fetchedAt:stamp,untrustedContent:true,timestampMeaning:{receivedAt:"provider_metadata_time_or_unknown",fetchedAt:"provider_read_completed_at"},indexComparison:{indexedReceivedAt:stamp,receivedAtMatches:true,indexFreshness:"not_verified"},message:{messageId:"message",subject:"Fixture",senderName:"Fixture",senderEmail:"sender@example.test",receivedAt:stamp,bodyText:"",bodyIsExcerpt:true,truncated:false,attachments:[],bodySource:"unavailable",receivedAtKnown:true}};
  expect(agentResponseSchemas["mail/read"].parse(response)).toEqual(response);
 });
});
