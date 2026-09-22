import { z } from "zod";
import crypto from "node:crypto";
import { apiError } from "@/lib/email/api";
import { AuthError, beginTrustedDeviceEnrollment, createAuthChallenge, getAuthSession, requestIdentity } from "@/lib/email/auth";
import { consumeStepUpReceipt } from "@/lib/email/passkeys";

export const runtime = "nodejs";

const schema = z.union([
  z.object({ password: z.string().min(1).max(1000) }),
  z.object({ receiptId: z.string().min(1).max(200) }),
]);

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    if ("password" in body) {
      return Response.json(await beginTrustedDeviceEnrollment({ password: body.password, ipAddress: requestIdentity(request).ipAddress }));
    }
    const session = await getAuthSession(request);
    if (!session.trustedDevice) throw new AuthError("Use a trusted device to authorize another device.", 403);
    await consumeStepUpReceipt({ receiptId: body.receiptId, action: "enroll_trusted_device", deviceId: session.trustedDevice.id });
    return Response.json(await createAuthChallenge({
      kind: "device_enrollment",
      action: "enroll_trusted_device",
      challenge: crypto.randomBytes(32).toString("base64url"),
    }));
  } catch (error) {
    return apiError(error);
  }
}
