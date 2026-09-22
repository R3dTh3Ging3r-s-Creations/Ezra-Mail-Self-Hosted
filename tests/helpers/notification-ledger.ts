import { withNotificationStoreWrite, getNotificationClaimCandidateInTransaction, claimNotificationDeliveryInTransaction } from "@/lib/email/notification-store";

/** Ledger-only fixtures deliberately bypass mail policy; production has no such wrapper. */
export async function claimNotificationDelivery(input: Omit<Parameters<typeof claimNotificationDeliveryInTransaction>[1], "resolvedTarget">) {
  return withNotificationStoreWrite(async tx => {
    const event = await getNotificationClaimCandidateInTransaction(tx, input.deliveryId);
    return event ? claimNotificationDeliveryInTransaction(tx, { ...input, resolvedTarget: event.target }) : null;
  });
}
