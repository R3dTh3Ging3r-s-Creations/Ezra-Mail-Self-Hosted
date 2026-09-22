export type BulkSelectableMessage = {
  id: string;
  senderEmail: string;
};

export function resolveBulkSelectionTargets(
  items: BulkSelectableMessage[],
  explicitSelection: Iterable<string>,
  sweepBySender: boolean,
) {
  const explicitIds = Array.from(explicitSelection);
  if (!sweepBySender) return explicitIds;

  const explicit = new Set(explicitIds);
  const selectedSenders = new Set(
    items
      .filter((item) => explicit.has(item.id))
      .map((item) => item.senderEmail.toLowerCase()),
  );

  if (!selectedSenders.size) return [];
  return items
    .filter((item) => selectedSenders.has(item.senderEmail.toLowerCase()))
    .map((item) => item.id);
}

export function bulkSelectionLabel(explicitCount: number, targetCount: number, sweepBySender: boolean) {
  if (!explicitCount) return "No conversations selected";
  if (sweepBySender && targetCount > explicitCount) {
    return `${explicitCount} checked · ${targetCount} sender matches`;
  }
  return `${targetCount} selected`;
}

export function bulkConfirmationSentence(explicitCount: number, targetCount: number, sweepBySender: boolean) {
  const conversationWord = targetCount === 1 ? "conversation" : "conversations";
  if (sweepBySender && explicitCount > 0 && targetCount > explicitCount) {
    const additional = targetCount - explicitCount;
    return `This will affect ${targetCount} ${conversationWord}: ${explicitCount} explicitly selected and ${additional} additional sender match${additional === 1 ? "" : "es"}.`;
  }
  if (!explicitCount) return `This will affect ${targetCount} ${conversationWord}.`;
  return `This will affect ${targetCount} selected ${conversationWord}.`;
}
