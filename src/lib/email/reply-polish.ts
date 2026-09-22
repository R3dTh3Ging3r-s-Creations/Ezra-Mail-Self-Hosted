import type { WritingTone } from "./writing-settings";

export type PolishReplyInput = {
  body: string;
  mode: WritingTone;
  direction?: string;
  messageId: string;
  threadId: string;
};

export type PolishPreservationCheck = {
  category: "name" | "date" | "amount" | "link" | "commitment";
  value: string;
  preserved: boolean;
};

export type PolishReplyResult = {
  original: string;
  proposed: string;
  mode: WritingTone;
  appliedContext: string[];
  preservationChecks: PolishPreservationCheck[];
  factualChangesDetected: boolean;
  warnings: string[];
};

export function buildPolishInstruction(mode: WritingTone) {
  const instructions: Record<WritingTone, string> = {
    grammar: "Correct grammar and punctuation only; preserve wording whenever it is already correct.",
    clearer: "Make the message easier to understand without changing its meaning or level of commitment.",
    concise: "Make the message shorter while preserving every fact, request, and commitment.",
    warmer: "Make the message warmer without adding intimacy, promises, or facts.",
    professional: "Make the message professionally polished while keeping the owner's natural voice.",
    firmer: "Make the message respectfully firmer without adding threats, deadlines, or commitments.",
  };
  return instructions[mode];
}

export function analyzeReplyPreservation(original: string, proposed: string) {
  const checks = extractFacts(original).map<PolishPreservationCheck>((fact) => ({
    ...fact,
    preserved: includesFact(proposed, fact.value),
  }));
  const warnings = checks
    .filter((check) => !check.preserved)
    .map((check) => `The proposed version may have changed or removed ${check.category} “${check.value}”.`);
  return {
    preservationChecks: checks,
    factualChangesDetected: warnings.length > 0,
    warnings,
  };
}

export async function polishReply(
  input: PolishReplyInput,
  generate: (request: {
    original: string;
    instruction: string;
    direction: string;
    messageId: string;
    threadId: string;
  }) => Promise<string>,
): Promise<PolishReplyResult> {
  const original = input.body.trim();
  if (!original) throw new Error("Write a reply before asking Ezra to polish it.");
  const direction = input.direction?.trim().slice(0, 2_000) || "";
  const proposed = (await generate({
    original,
    instruction: buildPolishInstruction(input.mode),
    direction,
    messageId: input.messageId,
    threadId: input.threadId,
  })).trim();
  if (!proposed) throw new Error("Ezra did not return a polished version.");
  const preservation = analyzeReplyPreservation(original, proposed);
  return {
    original,
    proposed,
    mode: input.mode,
    appliedContext: [`Mode: ${input.mode}`, ...(direction ? [direction] : [])],
    ...preservation,
  };
}

function extractFacts(value: string) {
  const facts: Array<Omit<PolishPreservationCheck, "preserved">> = [];
  const add = (category: PolishPreservationCheck["category"], values: string[]) => {
    for (const fact of new Set(values.map((item) => item.trim()).filter(Boolean))) facts.push({ category, value: fact });
  };
  add("name", Array.from(value.matchAll(/^(?:hi|hello|dear)\s+([\p{L}][\p{L}'-]{1,60})\b/gimu), (match) => match[1]));
  add("amount", value.match(/(?:[$€£]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:USD|EUR|GBP)\b)/gi) || []);
  add("date", value.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/gi) || []);
  add("date", value.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g) || []);
  add("link", value.match(/https?:\/\/[^\s<>()]+/gi)?.map((link) => link.replace(/[.,;!?]+$/, "")) || []);
  add("commitment", value.match(/\bI\s+(?:will|can|agree|confirm|promise|plan to|intend to)\b/gi) || []);
  return facts;
}

function includesFact(proposed: string, fact: string) {
  return proposed.toLocaleLowerCase().includes(fact.toLocaleLowerCase());
}
