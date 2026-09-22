import type { LivingBriefItem } from "./types";

export function briefItemStateTimestamp(item: Pick<LivingBriefItem, "state" | "completedAt" | "dismissedAt" | "restoredAt" | "lastSeenAt">): string {
  if (item.state === "completed") return item.completedAt ?? item.lastSeenAt;
  if (item.state === "dismissed") return item.dismissedAt ?? item.lastSeenAt;
  return item.restoredAt ?? item.lastSeenAt;
}
