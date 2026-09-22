import { authenticated } from "@/lib/email/api";
import { getProfessionalMessageDetail } from "@/lib/email/professional";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return authenticated(request, async () => {
    const { id } = await context.params;
    return getProfessionalMessageDetail(id);
  });
}
