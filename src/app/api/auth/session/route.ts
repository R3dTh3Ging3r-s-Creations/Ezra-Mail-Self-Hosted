import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/email/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return NextResponse.json(await getAuthSession(request));
}
