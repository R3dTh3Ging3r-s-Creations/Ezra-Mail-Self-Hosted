import { createHash } from "node:crypto";
import { z } from "zod";
import { accountRefSchema } from "./agent-types";
import { assertPersonalAccount, getAgentCapabilities } from "./agent-accounts";
import { execute, nowIso } from "./database";
import { providerAdapterFor } from "./provider-adapter";
import { sanitizeMessageHtml } from "./message-content";

export const mailSearchSchema = z.object({ account: accountRefSchema, query: z.string().max(500).default(""), limit: z.number().int().min(1).max(50).default(25), cursor: z.string().max(2048).optional() }).strict();
export const mailReadSchema = z.object({ account: accountRefSchema, messageId: z.string().min(1).max(200) }).strict();
const cursorSchema = z.object({ scope: z.string(), receivedAt: z.string().datetime({ offset: true }), id: z.string().min(1).max(200) }).strict();
const clean = (value: unknown, max: number) => String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0,max);
const escapeLike = (value: string) => value.replace(/[\\%_]/g, char => `\\${char}`);

/** Local index only: provider completeness/freshness is deliberately not implied. */
export async function searchAgentMail(input: z.input<typeof mailSearchSchema>) {
  const args = mailSearchSchema.parse(input); const account = await assertPersonalAccount(args.account);
  const scope = createHash("sha256").update(JSON.stringify([account.id,account.provider,account.email.toLowerCase(),args.query])).digest("hex");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (args.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(args.cursor,"base64url").toString("utf8"))); if (cursor.scope !== scope) throw new Error(); }
    catch { throw new Error("Mail cursor does not match this account and query."); }
  }
  const pattern = `%${escapeLike(args.query)}%`;
  const result = await execute(`SELECT id,subject,sender_name,sender_email,received_at,snippet,updated_at FROM email_messages
    WHERE account_id=? AND (subject LIKE ? ESCAPE '\\' OR sender_email LIKE ? ESCAPE '\\' OR snippet LIKE ? ESCAPE '\\')
    ${cursor ? "AND (received_at<? OR (received_at=? AND id<?))" : ""} ORDER BY received_at DESC,id DESC LIMIT ?`,
    [account.id,pattern,pattern,pattern,...(cursor ? [cursor.receivedAt,cursor.receivedAt,cursor.id] : []),args.limit+1]);
  await assertPersonalAccount(args.account);
  const sync = (await execute("SELECT last_sync_at FROM email_accounts WHERE id=?",[account.id])).rows[0];
  const items = result.rows.slice(0,args.limit).map(row => ({ messageId:String(row.id),subject:clean(row.subject,1000),senderName:clean(row.sender_name,320),senderEmail:clean(row.sender_email,320),receivedAt:String(row.received_at),snippet:clean(row.snippet,4000),snippetAvailable:clean(row.snippet,4000).trim().length>0,indexedAt:String(row.updated_at) }));
  const last = items.at(-1);
  return { account:args.account,source:"local_index" as const,completeProviderCoverage:false,untrustedContent:true,
    freshness:"not_verified" as const,timestampMeaning:{receivedAt:"indexed_message_timestamp",indexedAt:"local_row_updated_at",lastProviderSyncAt:"account_sync_completed_at"} as const,
    lastProviderSyncAt:sync?.last_sync_at ? String(sync.last_sync_at) : null,items,
    nextCursor:result.rows.length>args.limit && last ? Buffer.from(JSON.stringify({scope,receivedAt:last.receivedAt,id:last.messageId})).toString("base64url") : null };
}

export async function readAgentMail(input: z.input<typeof mailReadSchema>) {
  const args = mailReadSchema.parse(input); const account = await assertPersonalAccount(args.account);
  const row = (await execute("SELECT external_message_id,received_at FROM email_messages WHERE id=? AND account_id=?",[args.messageId,account.id])).rows[0];
  if (!row) throw new Error("Mail message was not found in this account.");
  const capabilities = await getAgentCapabilities(args.account);
  if (capabilities.mailRead !== "available") throw new Error("Mail read permission has not been verified for this account.");
  let message;
  try { message = await providerAdapterFor(account.provider).readMessage(account.email,account.id,String(row.external_message_id)); }
  catch { throw new Error("Mail could not be read for this account."); }
  await assertPersonalAccount(args.account);
  if (!message || message.accountId !== account.id || message.externalMessageId !== row.external_message_id) throw new Error("Provider mail did not match the requested account/message.");
  const html = !message.bodyText && message.bodyHtml ? sanitizeMessageHtml(message.bodyHtml) : null;
  const bodySource = message.bodyText ? "plain_text" as const : html ? "html_to_text" as const : message.snippet ? "snippet" as const : "unavailable" as const;
  const text = message.bodyText || html?.plainText || (html ? "" : message.snippet) || "";
  const receivedTime = Date.parse(message.receivedAt);
  return { account:args.account,source:"provider" as const,fetchedAt:nowIso(),untrustedContent:true,
    timestampMeaning:{receivedAt:"provider_metadata_time_or_unknown",fetchedAt:"provider_read_completed_at"} as const,
    indexComparison:{indexedReceivedAt:String(row.received_at),receivedAtMatches:Date.parse(String(row.received_at))===Date.parse(message.receivedAt),indexFreshness:"not_verified" as const},
    message:{messageId:args.messageId,subject:clean(message.subject,1000),senderName:clean(message.senderName,320),senderEmail:clean(message.senderEmail,320),receivedAt:message.receivedAt,receivedAtKnown:Number.isFinite(receivedTime) && receivedTime!==0,
      bodyText:clean(text,100_000),bodySource,bodyIsExcerpt:bodySource==="snippet" || bodySource==="unavailable",truncated:message.bodyTextTruncated===true || (html!==null && (html.truncated || message.bodyHtmlTruncated===true)) || text.length>100_000,
      attachments:(message.attachments || []).slice(0,50).map(item => ({name:clean(item.name,500),mimeType:clean(item.mimeType,100),size:item.size}))} };
}
