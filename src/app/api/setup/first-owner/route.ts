import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/email/api";
import { AuthError, requestIdentity } from "@/lib/email/auth";
import { completeFirstOwnerSetup, inspectFirstOwnerSetupChallenge } from "@/lib/email/first-owner-setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const challengeSchema = z.string().min(32).max(200);
const completionSchema = z.object({
  challenge: challengeSchema,
  ownerPassword: z.string().min(12).max(1000),
  confirmPassword: z.string().min(12).max(1000),
  deviceLabel: z.string().min(1).max(80),
});

export async function GET(request: Request) {
  try {
    const challenge = challengeSchema.parse(new URL(request.url).searchParams.get("challenge"));
    const state = await inspectFirstOwnerSetupChallenge(challenge);
    return NextResponse.json({
      active: state.active,
      expiresAt: state.expiresAt,
      passkeyAvailable: supportsPasskeys(request),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = completionSchema.parse(await request.json());
    if (body.ownerPassword !== body.confirmPassword) {
      throw new AuthError("The owner passwords do not match.", 400);
    }
    const completed = await completeFirstOwnerSetup({ ...body, ...requestIdentity(request) });
    const response = NextResponse.json({
      ok: true,
      ownerCreated: completed.ownerCreated,
      device: completed.device,
      recoveryKit: completed.recoveryKit,
    });
    response.headers.set("set-cookie", completed.deviceCookie);
    return response;
  } catch (error) {
    return apiError(error);
  }
}

function supportsPasskeys(request: Request) {
  const url = new URL(request.url);
  return url.protocol === "https:" || ["localhost", "127.0.0.1"].includes(url.hostname);
}
