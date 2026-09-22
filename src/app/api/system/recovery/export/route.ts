import { NextResponse } from "next/server";
import { apiError } from "@/lib/email/api";
import { requireAuth } from "@/lib/email/auth";
import { getSafeSettingsExport } from "@/lib/email/system-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAuth(request);
    const payload = await getSafeSettingsExport();
    const date = payload.exportedAt.slice(0, 10);
    return new NextResponse(`${JSON.stringify(payload, null, 2)}\n`, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="ezra-mail-settings-${date}.json"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
