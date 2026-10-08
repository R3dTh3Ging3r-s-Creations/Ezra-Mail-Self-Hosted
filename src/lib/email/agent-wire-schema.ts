import {z} from "zod";
import {accountRefSchema,calendarRangeSchema,calendarIdSchema} from "./agent-types";
import {resourceMutationSchema,resourceRefSchema,taskReadFieldsSchema,taskReadWarningSchema,taskProviderDatesSchema} from "./agent-resource-types";
import type {AgentRoute} from "./agent-api-handlers";
const id=z.string().min(1).max(1024),stamp=z.string().datetime({offset:true});
const operationId=z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
export const mailSearchRequestSchema=z.object({account:accountRefSchema,query:z.string().max(500).default(""),limit:z.number().int().min(1).max(50).default(25),cursor:z.string().max(2048).optional()}).strict();
export const mailReadRequestSchema=z.object({account:accountRefSchema,messageId:z.string().min(1).max(200)}).strict();
export const agentRequestSchemas={
 "capabilities":z.object({}).strict(),
 "mail/search":mailSearchRequestSchema,
 "mail/read":mailReadRequestSchema,
 "calendar/read":z.object({account:accountRefSchema,calendarId:calendarIdSchema,range:calendarRangeSchema}).strict(),
 "tasks/lists":z.object({account:accountRefSchema}).strict(),
 "tasks/read":z.object({target:resourceRefSchema}).strict(),
 "operations/prepare":z.object({idempotencyKey:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),mutation:resourceMutationSchema.describe("Choose exactly one action by kind. calendar.create uses payload; updates/deletes use target and a fresh expectedRevision; tasks.create uses fields. No request can supply authority or credentials.")}).strict(),
 "operations/status":z.object({operationId}).strict(),
 "operations/execute":z.object({operationId,payloadHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 "operations/reconcile":z.object({operationId}).strict(),
} satisfies Record<AgentRoute,z.ZodType>;
const operation=z.object({id,kind:z.enum(["calendar.create","calendar.update","calendar.delete","tasks.create","tasks.update","tasks.complete"]),payloadHash:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(["prepared","approved","executing","succeeded","failed","cancelled","expired","unknown"]),expiresAt:stamp,errorCode:z.string().regex(/^[a-z_]{1,80}$/).optional(),receipt:z.object({providerId:id,outcome:z.enum(["created","existing_match","updated","deleted","completed"]),verifiedAt:stamp}).optional()}).superRefine((value,context)=>{if((value.status==="succeeded")!==!!value.receipt)context.addIssue({code:"custom",message:"Receipt status mismatch."});});
const short=z.string().max(4000),nullable=short.nullable();
const reminder=z.discriminatedUnion("mode",[z.object({mode:z.literal("default")}),z.object({mode:z.literal("none")}),z.object({mode:z.literal("unknown")}),z.object({mode:z.literal("minutes"),minutes:z.number().int().min(0)}),z.object({mode:z.literal("custom"),overrides:z.array(z.object({method:z.string().max(100),minutes:z.number().int()})).max(100)})]);
const event=z.object({id,accountId:id,accountLabel:short,accountProvider:z.enum(["microsoft","gmail"]),externalEventId:id,calendarId:id,calendarName:short,title:short,description:z.string().max(1_000_000).nullable(),location:nullable,startsAt:stamp,endsAt:stamp,isAllDay:z.boolean(),dateRange:z.object({startDate:z.string(),endDate:z.string()}).nullable(),timezone:nullable,status:short,visibility:nullable,isBusy:z.boolean(),organizerName:nullable,organizerEmail:nullable,attendees:z.array(z.object({email:short,name:short.optional(),responseStatus:short.optional()})).max(1000),webLink:nullable,updatedAt:stamp.nullable(),syncedAt:stamp,reminder:reminder.optional(),revision:z.string().max(2048).nullable().optional(),correlationId:nullable.optional(),recurrenceId:nullable.optional()});
const mailItem=z.object({messageId:id,subject:short,senderName:short,senderEmail:short,receivedAt:stamp,snippet:short,snippetAvailable:z.boolean().optional(),indexedAt:stamp});
const task=taskReadFieldsSchema.strip().extend({list:resourceRefSchema,id,revision:z.string().max(2048),status:short,fetchedAt:stamp,bodyFormat:z.literal("plain_text"),recurring:z.boolean(),readWarnings:z.array(taskReadWarningSchema).max(2).optional(),providerDates:taskProviderDatesSchema.optional()});
const capability=z.object({account:accountRefSchema,identityVerifiedAt:stamp,mailRead:z.boolean(),calendarRead:z.boolean(),calendarCreate:z.boolean(),calendarUpdate:z.boolean(),calendarDelete:z.boolean(),calendarDeleteSafety:z.enum(["unavailable","conditional_revision","fresh_read_non_atomic"]).optional(),tasksRead:z.boolean(),tasksCreate:z.boolean(),tasksUpdate:z.boolean(),tasksComplete:z.boolean()});
export const agentResponseSchemas:Record<AgentRoute,z.ZodType>={
 "capabilities":z.object({accounts:z.array(capability).max(2),resources:z.array(resourceRefSchema).max(100),expiresAt:stamp}),
 "mail/search":z.object({account:accountRefSchema,source:z.literal("local_index"),freshness:z.literal("not_verified").optional(),timestampMeaning:z.object({receivedAt:z.literal("indexed_message_timestamp"),indexedAt:z.literal("local_row_updated_at"),lastProviderSyncAt:z.literal("account_sync_completed_at")}).optional(),completeProviderCoverage:z.literal(false),untrustedContent:z.literal(true),lastProviderSyncAt:stamp.nullable(),items:z.array(mailItem).max(50),nextCursor:z.string().max(2048).nullable()}),
 "mail/read":z.object({account:accountRefSchema,source:z.literal("provider"),timestampMeaning:z.object({receivedAt:z.literal("provider_metadata_time_or_unknown"),fetchedAt:z.literal("provider_read_completed_at")}).optional(),indexComparison:z.object({indexedReceivedAt:stamp,receivedAtMatches:z.boolean(),indexFreshness:z.literal("not_verified")}).optional(),fetchedAt:stamp,untrustedContent:z.literal(true),message:z.object({messageId:id,subject:short,senderName:short,senderEmail:short,receivedAt:stamp,receivedAtKnown:z.boolean().optional(),bodyText:z.string().max(100000),bodySource:z.enum(["plain_text","html_to_text","snippet","unavailable"]).optional(),bodyIsExcerpt:z.boolean(),truncated:z.boolean(),attachments:z.array(z.object({name:short,mimeType:short,size:z.number().nonnegative()})).max(50)})}),
 "calendar/read":z.object({account:accountRefSchema,calendarId:id,range:calendarRangeSchema,fetchedAt:stamp,complete:z.literal(true),events:z.array(event).max(10000)}),
 "tasks/lists":z.object({complete:z.literal(true),lists:z.array(z.object({id,title:short,shared:z.literal(false)})).max(1000)}),
 "tasks/read":z.object({complete:z.literal(true),tasks:z.array(task).max(1000),fetchedAt:stamp}),
 "operations/prepare":operation,"operations/status":operation,"operations/execute":operation,"operations/reconcile":operation,
};
