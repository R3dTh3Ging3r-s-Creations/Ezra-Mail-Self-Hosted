import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import {
  createSavedView,
  deleteSavedView,
  getSavedViews,
  updateSavedView,
} from "@/lib/email/saved-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dateFilterSchema = z.enum(["any", "today", "week", "month", "recent", "last7", "last30"]);
const prioritySchema = z.enum(["interrupt", "digest", "suppress", ""]);
const filtersSchema = z.object({
  folder: z.string().max(64).optional(),
  account: z.string().max(256).optional(),
  inboxCategory: z.string().max(64).optional(),
  priority: prioritySchema.optional(),
  category: z.string().max(128).optional(),
  categories: z.array(z.string().max(128)).max(12).optional(),
  unread: z.boolean().optional(),
  attachments: z.boolean().optional(),
  date: dateFilterSchema.optional(),
  search: z.string().max(500).optional(),
  needsReply: z.boolean().optional(),
  hasDeadline: z.boolean().optional(),
  handled: z.enum(["active", "handled", "any"]).optional(),
});
const definitionSchema = z.object({
  kind: z.literal("mail"),
  filters: filtersSchema,
  sort: z.enum(["newest", "oldest", "priority"]).optional(),
  semanticKey: z.string().max(100).optional(),
});
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    workspaceId: z.string().optional(),
    label: z.string().min(1).max(100),
    description: z.string().max(1000).nullable().optional(),
    definition: definitionSchema,
    sortOrder: z.number().nullable().optional(),
  }),
  z.object({
    action: z.literal("update"),
    id: z.string(),
    label: z.string().min(1).max(100).nullable().optional(),
    description: z.string().max(1000).nullable().optional(),
    definition: definitionSchema.optional(),
    isEnabled: z.boolean().optional(),
    sortOrder: z.number().nullable().optional(),
  }),
  z.object({
    action: z.literal("delete"),
    id: z.string(),
  }),
  z.object({
    action: z.literal("restore_builtin"),
    workspaceId: z.string().optional(),
  }),
]);

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = schema.parse(await request.json());
    if (body.action === "create") {
      return createSavedView({
        workspaceId: body.workspaceId,
        label: body.label,
        description: body.description,
        definition: body.definition,
        sortOrder: body.sortOrder,
      });
    }
    if (body.action === "update") {
      return updateSavedView({
        id: body.id,
        label: body.label,
        description: body.description,
        definition: body.definition,
        isEnabled: body.isEnabled,
        sortOrder: body.sortOrder,
      });
    }
    if (body.action === "delete") return deleteSavedView(body.id);
    return getSavedViews({ workspaceId: body.workspaceId });
  });
}
