import { NextResponse } from "next/server";
import { z } from "zod";
import {
  applyMaintenanceBatch,
  addMessageContext,
  applyMaintenanceAction,
  approveAndSendDraft,
  cancelDraft,
  clearMessageFromQueue,
  createReplyDraft,
  forgetPreference,
  getEmailDashboard,
  getMessageDetail,
  markMessageRead,
  notifyMessage,
  pauseUnreadBacklogReview,
  pollGmail,
  prepareReplyDraft,
  reanalyzeAllMessages,
  recordFeedback,
  requestSendApproval,
  seedSafeDemo,
  saveReplyDraft,
  sendScheduledDigest,
  snoozeMessage,
  completeGmailAccountConnection,
  completeMicrosoftAccountConnection,
  startGmailAccountConnection,
  startMicrosoftAccountConnection,
  startModelBenchmark,
  startModelUpdate,
  startUnreadBacklogReview,
  syncAuthorizedGmailAccounts,
  switchModel,
  updateReplyDraft,
  refreshUpdates,
} from "@/lib/email/service";
import { modelIds } from "@/lib/email/types";
import { AuthError, requireAuth } from "@/lib/email/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get_message_detail"), messageId: z.string() }),
  z.object({ action: z.literal("poll") }),
  z.object({ action: z.literal("sync_accounts") }),
  z.object({
    action: z.literal("connect_gmail"),
    email: z.string().email(),
    access: z.enum(["readonly", "maintenance", "calendar"]),
  }),
  z.object({
    action: z.literal("complete_gmail_auth"),
    email: z.string().email(),
    access: z.enum(["readonly", "maintenance", "calendar"]),
    authUrl: z.string().url(),
  }),
  z.object({
    action: z.literal("connect_microsoft"),
    email: z.string().email(),
    access: z.enum(["readonly", "maintenance", "calendar", "send", "full"]),
  }),
  z.object({
    action: z.literal("complete_microsoft_auth"),
    connectionId: z.string(),
  }),
  z.object({ action: z.literal("send_digest_now") }),
  z.object({ action: z.literal("start_backlog") }),
  z.object({ action: z.literal("pause_backlog") }),
  z.object({ action: z.literal("mark_read"), messageId: z.string() }),
  z.object({ action: z.literal("clear_message"), messageId: z.string() }),
  z.object({
    action: z.literal("apply_maintenance"),
    accountId: z.string(),
    senderEmail: z.string().email(),
    maintenanceAction: z.enum(["mark_read", "unsubscribe", "spam"]),
    remember: z.boolean(),
  }),
  z.object({
    action: z.literal("apply_maintenance_batch"),
    targets: z
      .array(z.object({ accountId: z.string(), senderEmail: z.string().email() }))
      .min(1)
      .max(50),
    maintenanceAction: z.enum(["mark_read", "unsubscribe", "spam"]),
    remember: z.boolean(),
  }),
  z.object({ action: z.literal("reanalyze_all") }),
  z.object({ action: z.literal("seed_demo") }),
  z.object({ action: z.literal("notify"), messageId: z.string() }),
  z.object({
    action: z.literal("add_context"),
    messageId: z.string(),
    content: z.string().min(1).max(20_000),
  }),
  z.object({
    action: z.literal("prepare_draft"),
    messageId: z.string(),
    context: z.string().max(20_000).optional(),
    previousDraft: z.string().max(20_000).optional(),
  }),
  z.object({
    action: z.literal("save_draft"),
    messageId: z.string(),
    content: z.string().min(1).max(20_000),
    context: z.string().max(20_000).optional(),
  }),
  z.object({
    action: z.literal("create_draft"),
    messageId: z.string(),
    context: z.string().max(20_000).optional(),
  }),
  z.object({
    action: z.literal("update_draft"),
    draftId: z.string(),
    content: z.string().min(1).max(20_000),
  }),
  z.object({ action: z.literal("request_send"), draftId: z.string() }),
  z.object({ action: z.literal("approve_send"), draftId: z.string() }),
  z.object({ action: z.literal("cancel_draft"), draftId: z.string() }),
  z.object({
    action: z.literal("feedback"),
    messageId: z.string(),
    value: z.enum(["interrupt", "digest", "suppress"]),
  }),
  z.object({ action: z.literal("forget_preference"), preferenceId: z.string() }),
  z.object({
    action: z.literal("switch_model"),
    model: z.enum(modelIds),
  }),
  z.object({ action: z.literal("start_model_benchmark") }),
  z.object({ action: z.literal("check_updates") }),
  z.object({ action: z.literal("update_model"), model: z.enum(modelIds) }),
  z.object({
    action: z.literal("snooze"),
    messageId: z.string(),
    minutes: z.number().int().min(5).max(10_080),
  }),
]);

export async function GET(request: Request) {
  try {
    await requireAuth(request);
    return NextResponse.json(await getEmailDashboard());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: message },
      { status: error instanceof AuthError ? error.status : 400 },
    );
  }
}

export async function POST(request: Request) {
  try {
    await requireAuth(request);
    const body = actionSchema.parse(await request.json());
    let result: unknown;
    switch (body.action) {
      case "get_message_detail":
        result = await getMessageDetail(body.messageId);
        break;
      case "poll":
        result = await pollGmail();
        break;
      case "sync_accounts":
        result = await syncAuthorizedGmailAccounts();
        break;
      case "connect_gmail":
        result = await startGmailAccountConnection({
          email: body.email,
          access: body.access,
        });
        break;
      case "complete_gmail_auth":
        result = await completeGmailAccountConnection({
          email: body.email,
          access: body.access,
          authUrl: body.authUrl,
        });
        break;
      case "connect_microsoft":
        result = await startMicrosoftAccountConnection({
          email: body.email,
          access: body.access,
        });
        break;
      case "complete_microsoft_auth":
        result = await completeMicrosoftAccountConnection(body.connectionId);
        break;
      case "send_digest_now":
        result = await sendScheduledDigest("Manual email brief");
        break;
      case "start_backlog":
        result = await startUnreadBacklogReview();
        break;
      case "pause_backlog":
        result = await pauseUnreadBacklogReview();
        break;
      case "mark_read":
        result = await markMessageRead(body.messageId);
        break;
      case "clear_message":
        result = await clearMessageFromQueue(body.messageId);
        break;
      case "apply_maintenance":
        result = await applyMaintenanceAction({
          accountId: body.accountId,
          senderEmail: body.senderEmail,
          action: body.maintenanceAction,
          remember: body.remember,
        });
        break;
      case "apply_maintenance_batch":
        result = await applyMaintenanceBatch({
          targets: body.targets,
          action: body.maintenanceAction,
          remember: body.remember,
        });
        break;
      case "reanalyze_all":
        result = await reanalyzeAllMessages();
        break;
      case "seed_demo":
        result = await seedSafeDemo();
        break;
      case "notify":
        result = await notifyMessage(body.messageId);
        break;
      case "add_context":
        result = await addMessageContext(body.messageId, body.content);
        break;
      case "prepare_draft":
        result = await prepareReplyDraft(body.messageId, body.context, body.previousDraft);
        break;
      case "save_draft":
        result = await saveReplyDraft(body.messageId, body.content, body.context);
        break;
      case "create_draft":
        result = await createReplyDraft(body.messageId, body.context);
        break;
      case "update_draft":
        result = await updateReplyDraft(body.draftId, body.content);
        break;
      case "request_send":
        result = await requestSendApproval(body.draftId);
        break;
      case "approve_send":
        result = await approveAndSendDraft(body.draftId);
        break;
      case "cancel_draft":
        result = await cancelDraft(body.draftId);
        break;
      case "feedback":
        result = await recordFeedback(body.messageId, body.value);
        break;
      case "forget_preference":
        result = await forgetPreference(body.preferenceId);
        break;
      case "switch_model":
        result = await switchModel(body.model);
        break;
      case "start_model_benchmark":
        result = await startModelBenchmark();
        break;
      case "check_updates":
        result = await refreshUpdates();
        break;
      case "update_model":
        result = await startModelUpdate(body.model);
        break;
      case "snooze":
        result = await snoozeMessage(body.messageId, body.minutes);
        break;
    }
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: message },
      { status: error instanceof AuthError ? error.status : 400 },
    );
  }
}
