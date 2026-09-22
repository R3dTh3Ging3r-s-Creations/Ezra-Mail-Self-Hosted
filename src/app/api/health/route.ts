import { NextResponse } from "next/server";
import { execute, getServiceState } from "@/lib/email/database";
import { readDeploymentRevision } from "@/lib/email/system-recovery";
import { recordOwnerRecoveryStartup } from "@/lib/email/auth-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await execute(`SELECT 1`);
    const [revision, workerRevision, workerHeartbeatAt, pollingPausedAt] = await Promise.all([
      readDeploymentRevision(),
      getServiceState("worker_revision"),
      getServiceState("worker_heartbeat"),
      getServiceState("polling_paused_at"),
    ]);
    const heartbeatMs = workerHeartbeatAt ? new Date(workerHeartbeatAt).getTime() : 0;
    await recordOwnerRecoveryStartup("web");
    return NextResponse.json({
      ok: true,
      service: "ezra-mail",
      revision,
      worker: {
        healthy: Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs < 180_000,
        revisionMatch: revision && workerRevision ? revision === workerRevision : null,
        pollingPaused: Boolean(pollingPausedAt),
      },
    });
  } catch {
    return NextResponse.json({ ok: false, service: "ezra-mail" }, { status: 503 });
  }
}
