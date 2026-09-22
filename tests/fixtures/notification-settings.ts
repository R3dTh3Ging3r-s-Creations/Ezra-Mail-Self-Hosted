/** Minimal synthetic responses shared by notification Settings compositions. */
export const notificationSettingsReads: Record<string, unknown> = {
  "/api/rules": [],
  "/api/calendar": { accounts: [], events: [], drafts: [] },
  "/api/permissions": { generatedAt: "2026-09-14T12:00:00.000Z", workspaceId: "workspace:all", accounts: [], summary: { accounts: 0, connectedAccounts: 0, needsSetup: 0, errors: 0, readOnly: 0, disabled: 0 } },
  "/api/onboarding": { generatedAt: "2026-09-14T12:00:00.000Z", workspaceId: "workspace:all", items: [], summary: { total: 0, complete: 0, needsAttention: 0, planned: 0, percentComplete: 0 } },
  "/api/system/recovery": {
    generatedAt: "2026-09-14T12:00:00.000Z",
    database: { kind: "file", sizeBytes: 0, schemaVersion: 9 },
    backup: { latest: null, verified: false, verifiedAt: null, sha256: null, detail: "Synthetic fixture." },
    runtime: { webRevision: null, workerRevision: null, revisionsMatch: null, workerHeartbeatAt: null, workerHealthy: false },
    polling: { paused: false, pausedAt: null, reason: null },
  },
};
