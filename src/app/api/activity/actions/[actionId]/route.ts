import { authenticated } from "@/lib/email/api";
import { getMailActionDetail } from "@/lib/email/activity";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ actionId: string }> }) {
  return authenticated(_request, async () => {
    const { actionId } = await context.params;
    return getMailActionDetail(actionId);
  });
}
