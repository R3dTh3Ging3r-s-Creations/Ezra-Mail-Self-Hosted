import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { getProviderPermissions } from "@/lib/email/permissions";

export const runtime = "nodejs";

const querySchema = z.object({
  workspaceId: z.string().optional(),
});

export async function GET(request: Request) {
  return authenticated(request, () => {
    const url = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams.entries()));
    return getProviderPermissions(query);
  });
}
