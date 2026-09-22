import { authenticated } from "@/lib/email/api";
import { getOnboardingChecklist } from "@/lib/email/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticated(request, () => {
    const url = new URL(request.url);
    return getOnboardingChecklist({ workspaceId: url.searchParams.get("workspaceId") });
  });
}
