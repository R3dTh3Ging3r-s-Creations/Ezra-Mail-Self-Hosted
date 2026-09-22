import { authenticated } from "@/lib/email/api";
import { listProviderInventory } from "@/lib/email/provider-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticated(request, async () => ({ providers: listProviderInventory() }));
}
