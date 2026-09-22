import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/email/api";
import { finishTrustedDeviceEnrollment, linkCurrentSessionToDevice, requestIdentity } from "@/lib/email/auth";

export const runtime = "nodejs";

const schema = z.object({
  challengeId: z.string().min(1).max(200),
  label: z.string().min(1).max(80),
});

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const enrolled = await finishTrustedDeviceEnrollment({ ...body, ...requestIdentity(request) });
    await linkCurrentSessionToDevice(request, enrolled.device.id);
    const response = NextResponse.json({ ok: true, device: enrolled.device });
    response.headers.set("set-cookie", enrolled.cookie);
    return response;
  } catch (error) {
    return apiError(error);
  }
}
