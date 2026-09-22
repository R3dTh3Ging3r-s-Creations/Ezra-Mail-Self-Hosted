import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import {
  approveOutboxItem,
  cancelOutboxItem,
  requestOutboxApproval,
  requestOutboxSend,
  reconcileOutboxSend,
  retryOutboxSend,
} from "@/lib/email/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel"), draftId: z.string() }),
  z.object({ action: z.literal("request_approval"), draftId: z.string() }),
  z.object({ action: z.literal("approve"), draftId: z.string(), contentHash: z.string().min(12).max(128) }),
  z.object({ action: z.literal("send"), draftId: z.string() }),
  z.object({ action: z.literal("retry"), draftId: z.string() }),
  z.object({ action: z.literal("reconcile"), draftId: z.string() }),
]);

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = schema.parse(await request.json());
    if (body.action === "cancel") return cancelOutboxItem(body.draftId);
    if (body.action === "request_approval") return requestOutboxApproval(body.draftId);
    if (body.action === "approve") return approveOutboxItem({ draftId: body.draftId, contentHash: body.contentHash });
    if (body.action === "retry") return retryOutboxSend(body.draftId);
    if (body.action === "reconcile") return reconcileOutboxSend(body.draftId);
    return requestOutboxSend(body.draftId);
  });
}
