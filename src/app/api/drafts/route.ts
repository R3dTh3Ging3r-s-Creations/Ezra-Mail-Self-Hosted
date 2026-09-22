import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import {
  cancelOutgoingDraft,
  createForwardDraft,
  createNewEmailDraft,
  createReplyOutgoingDraft,
  createReplyOutgoingDraftFromMessage,
  getOutgoingDrafts,
  updateOutgoingDraft,
} from "@/lib/email/composition";
import { getDraftWorkspace } from "@/lib/email/professional";
import {
  approveAndSendDraft,
  addMessageContext,
  cancelDraft,
  polishReplyDraft,
  prepareReplyDraft,
  requestSendApproval,
  saveReplyDraft,
  updateReplyDraft,
} from "@/lib/email/service";
import { writingTones } from "@/lib/email/writing-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const recipientSchema = z.object({
  name: z.string().max(256).nullable().optional(),
  email: z.string().min(3).max(320),
});

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("prepare"),
    messageId: z.string(),
    context: z.string().max(20_000).optional(),
    previousDraft: z.string().max(20_000).optional(),
  }),
  z.object({
    action: z.literal("prepare_reply"),
    messageId: z.string(),
    replyMode: z.enum(["sender", "all"]),
    context: z.string().max(20_000).optional(),
    previousDraft: z.string().max(20_000).optional(),
  }),
  z.object({
    action: z.literal("polish_reply"),
    messageId: z.string(),
    body: z.string().min(1).max(20_000),
    mode: z.enum(writingTones),
    direction: z.string().max(2_000).optional(),
  }),
  z.object({
    action: z.literal("create_reply_outgoing"),
    messageId: z.string(),
    replyMode: z.enum(["sender", "all"]),
    body: z.string().min(1).max(20_000),
    context: z.string().max(20_000).optional(),
  }),
  z.object({
    action: z.literal("save"),
    messageId: z.string(),
    content: z.string().min(1).max(20_000),
    context: z.string().max(20_000).optional(),
  }),
  z.object({ action: z.literal("update"), draftId: z.string(), content: z.string().min(1).max(20_000) }),
  z.object({ action: z.literal("request_send"), draftId: z.string() }),
  z.object({ action: z.literal("approve_send"), draftId: z.string() }),
  z.object({ action: z.literal("cancel"), draftId: z.string() }),
  z.object({
    action: z.literal("new_email_create"),
    accountId: z.string(),
    to: z.array(recipientSchema),
    cc: z.array(recipientSchema).optional().default([]),
    bcc: z.array(recipientSchema).optional().default([]),
    subject: z.string().min(1).max(20_000),
    body: z.string().min(1).max(20_000),
  }),
  z.object({
    action: z.literal("forward_create"),
    messageId: z.string(),
    to: z.array(recipientSchema),
    cc: z.array(recipientSchema).optional().default([]),
    bcc: z.array(recipientSchema).optional().default([]),
    subject: z.string().max(20_000).optional(),
    body: z.string().max(20_000).optional(),
  }),
  z.object({
    action: z.literal("outgoing_update"),
    draftId: z.string(),
    to: z.array(recipientSchema).optional(),
    cc: z.array(recipientSchema).optional(),
    bcc: z.array(recipientSchema).optional(),
    subject: z.string().min(1).max(20_000).optional(),
    body: z.string().min(1).max(20_000).optional(),
  }),
  z.object({ action: z.literal("outgoing_cancel"), draftId: z.string() }),
  z.object({ action: z.literal("reply_outgoing_create"), draftId: z.string() }),
]);

export async function GET(request: Request) {
  return authenticated(request, async () => {
    const url = new URL(request.url);
    if (url.searchParams.get("kind") === "outgoing") {
      return getOutgoingDrafts({ workspaceId: url.searchParams.get("workspaceId") || undefined });
    }
    return getDraftWorkspace();
  });
}

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = schema.parse(await request.json());
    if (body.action === "prepare") {
      return prepareReplyDraft(body.messageId, body.context, body.previousDraft);
    }
    if (body.action === "prepare_reply") {
      return prepareReplyDraft(body.messageId, body.context, body.previousDraft, body.replyMode);
    }
    if (body.action === "polish_reply") {
      return polishReplyDraft(body);
    }
    if (body.action === "create_reply_outgoing") {
      if (body.context?.trim()) await addMessageContext(body.messageId, body.context);
      return createReplyOutgoingDraftFromMessage({
        messageId: body.messageId,
        replyMode: body.replyMode,
        body: body.body,
      });
    }
    if (body.action === "save") {
      return saveReplyDraft(body.messageId, body.content, body.context);
    }
    if (body.action === "update") return updateReplyDraft(body.draftId, body.content);
    if (body.action === "request_send") return requestSendApproval(body.draftId);
    if (body.action === "approve_send") return approveAndSendDraft(body.draftId);
    if (body.action === "new_email_create") {
      return createNewEmailDraft({
        accountId: body.accountId,
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        subject: body.subject,
        body: body.body,
      });
    }
    if (body.action === "forward_create") {
      return createForwardDraft({
        messageId: body.messageId,
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        subject: body.subject,
        body: body.body,
      });
    }
    if (body.action === "outgoing_update") {
      return updateOutgoingDraft({
        draftId: body.draftId,
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        subject: body.subject,
        body: body.body,
      });
    }
    if (body.action === "outgoing_cancel") return cancelOutgoingDraft(body.draftId);
    if (body.action === "reply_outgoing_create") return createReplyOutgoingDraft(body.draftId);
    return cancelDraft(body.draftId);
  });
}
