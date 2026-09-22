import { authenticated } from "@/lib/email/api";
import { getMailMeta } from "@/lib/email/professional";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticated(request, getMailMeta);
}
