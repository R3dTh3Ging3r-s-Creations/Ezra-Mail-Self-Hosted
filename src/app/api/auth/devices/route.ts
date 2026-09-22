import { NextResponse } from "next/server";
import { authenticated } from "@/lib/email/api";
import { authBypassIsActive, getAuthSession, listTrustedDevices } from "@/lib/email/auth";
import { listOwnerPasskeys } from "@/lib/email/passkeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticated(request, async () => {
    const session = await getAuthSession(request);
    const [devices, passkeys] = await Promise.all([
      listTrustedDevices(session.trustedDevice?.id),
      listOwnerPasskeys(),
    ]);
    return {
      devices,
      passkeys,
      currentDeviceId: session.trustedDevice?.id || null,
      bypassActive: await authBypassIsActive(),
      configured: session.configured,
    };
  });
}
