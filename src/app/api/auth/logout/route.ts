import { NextResponse } from "next/server";
import { clearTrustedDeviceCookie, logout } from "@/lib/email/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const cookie = await logout(request);
  const response = NextResponse.json({ ok: true });
  response.headers.set("set-cookie", cookie);
  response.headers.append("set-cookie", clearTrustedDeviceCookie());
  return response;
}
