import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import {
  getSystemRecoveryStatus,
  pauseProviderPolling,
  resumeProviderPolling,
  verifyLatestBackup,
} from "@/lib/email/system-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("verify_latest_backup") }),
  z.object({
    action: z.literal("pause_polling"),
    confirmation: z.string(),
    reason: z.string().max(240).optional(),
  }),
  z.object({ action: z.literal("resume_polling") }),
]);

export async function GET(request: Request) {
  return authenticated(request, getSystemRecoveryStatus);
}

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = actionSchema.parse(await request.json());
    if (body.action === "verify_latest_backup") return verifyLatestBackup();
    if (body.action === "pause_polling") return pauseProviderPolling(body);
    return resumeProviderPolling();
  });
}
