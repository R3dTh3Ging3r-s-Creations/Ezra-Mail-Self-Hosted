import type { ReplyMode } from "@/lib/email/types";

export function replyStudioStorageKey(messageId: string, mode: ReplyMode) {
  return `ezra.reply-studio.${messageId}.${mode}`;
}

export function shouldApplyGeneratedText(input: {
  requestGeneration: number;
  currentGeneration: number;
  requestBody: string;
  currentBody: string;
  requestMessageId: string;
  currentMessageId: string;
  requestMode: ReplyMode;
  currentMode: ReplyMode;
}) {
  return input.requestGeneration === input.currentGeneration
    && input.requestBody === input.currentBody
    && input.requestMessageId === input.currentMessageId
    && input.requestMode === input.currentMode;
}

export function appendSignature(body: string, signature: string, enabled: boolean) {
  const normalizedBody = body.trim();
  const normalizedSignature = signature.trim();
  if (!enabled || !normalizedSignature || normalizedBody.endsWith(normalizedSignature)) return normalizedBody;
  return `${normalizedBody}\n\n${normalizedSignature}`;
}

export function polishAcceptanceReady(warnings: string[], warningsReviewed: boolean) {
  return warnings.length === 0 || warningsReviewed;
}
