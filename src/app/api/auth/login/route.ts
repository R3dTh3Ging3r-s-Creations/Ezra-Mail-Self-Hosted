import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/email/api";
import { getAuthSession, login, requestIdentity } from "@/lib/email/auth";

export const runtime = "nodejs";

const schema = z.object({ password: z.string().min(1).max(1000) });

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const current = await getAuthSession(request);
    const session = await login({ ...requestIdentity(request), password: body.password, trustedDeviceId: current.trustedDevice?.id });
    const response = NextResponse.json({ ok: true, expiresAt: session.expiresAt });
    response.headers.set("set-cookie", session.cookie);
    return response;
  } catch (error) {
    return apiError(error);
  }
}
