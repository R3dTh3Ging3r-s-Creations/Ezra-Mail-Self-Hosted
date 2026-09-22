import { authenticated } from "@/lib/email/api";
import {
  cancelCalendarDraft,
  createCalendarDraft,
  createEventFromDraft,
  syncCalendarAccounts,
  updateCalendarDraft,
} from "@/lib/email/calendar";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const draftSchema = z.object({
  accountId: z.string(),
  calendarId: z.string().optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).optional(),
  location: z.string().max(500).optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  isAllDay: z.boolean().optional(),
  timezone: z.string().max(100).optional(),
  attendees: z.union([z.array(z.string()), z.string()]).optional(),
  reminderMinutes: z.number().int().min(0).max(40_320).nullable().optional(),
  isBusy: z.boolean().optional(),
  privacy: z.enum(["default", "private", "public"]).optional(),
  sendUpdates: z.boolean().optional(),
});

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("sync"),
    workspaceId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  }),
  z.object({
    action: z.literal("draft_create"),
    draft: draftSchema,
  }),
  z.object({
    action: z.literal("draft_update"),
    draftId: z.string(),
    draft: draftSchema,
  }),
  z.object({
    action: z.literal("draft_cancel"),
    draftId: z.string(),
  }),
  z.object({
    action: z.literal("create_event"),
    draftId: z.string(),
    confirmInvites: z.boolean().optional(),
    sendUpdates: z.boolean().optional(),
  }),
]);

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = schema.parse(await request.json());
    switch (body.action) {
      case "sync":
        return syncCalendarAccounts({ workspaceId: body.workspaceId, from: body.from, to: body.to });
      case "draft_create":
        return {
          ok: true,
          message: "Calendar draft saved.",
          draft: await createCalendarDraft(body.draft),
        };
      case "draft_update":
        return {
          ok: true,
          message: "Calendar draft updated.",
          draft: await updateCalendarDraft({ ...body.draft, draftId: body.draftId }),
        };
      case "draft_cancel":
        return cancelCalendarDraft(body.draftId);
      case "create_event":
        return createEventFromDraft({
          draftId: body.draftId,
          confirmInvites: body.confirmInvites,
          sendUpdates: body.sendUpdates,
        });
    }
  });
}
