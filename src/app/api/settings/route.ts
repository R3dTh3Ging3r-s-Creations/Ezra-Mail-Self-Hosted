import { authenticated } from "@/lib/email/api";
import { getEmailDashboard } from "@/lib/email/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticated(request, getEmailDashboard);
}
