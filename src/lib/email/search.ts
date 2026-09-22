import { nowIso } from "./database";
import { getMailPage, searchProviderMail } from "./professional";
import type {
  MailThreadItem,
  NaturalLanguageSearchAppliedFilter,
  NaturalLanguageSearchInterpretation,
  NaturalLanguageSearchPage,
  SavedViewMailFilters,
} from "./types";
import { ALL_WORKSPACE_ID, GMAIL_WORKSPACE_ID, MICROSOFT_WORKSPACE_ID } from "./workspaces";

type SearchInput = {
  query: string;
  workspaceId?: string | null;
  limit?: number;
  cursor?: string | null;
};

type SearchActionInput = {
  action: "interpret" | "provider_search";
  query: string;
  workspaceId?: string | null;
  accountId?: string | null;
  pageToken?: string | null;
};

type CategoryHint = {
  id: string;
  label: string;
  categories: string[];
  search: string;
  patterns: RegExp[];
};

const WORKSPACE_LABELS: Record<string, string> = {
  [GMAIL_WORKSPACE_ID]: "Gmail",
  [MICROSOFT_WORKSPACE_ID]: "Hotmail",
  [ALL_WORKSPACE_ID]: "All accounts",
};

const CATEGORY_HINTS: CategoryHint[] = [
  {
    id: "job_search",
    label: "job and recruiter mail",
    categories: ["job application", "job alert", "career", "interview request"],
    search: "job recruiter interview application hiring career",
    patterns: [/\b(job|jobs|career|careers|recruiter|recruiters|interview|interviews|application|applications|hiring|indeed|glassdoor)\b/i],
  },
  {
    id: "security",
    label: "security and account alerts",
    categories: ["account-security", "account security", "security alert", "fraud", "authentication", "account-verification"],
    search: "security sign in password verification account fraud authentication",
    patterns: [/\b(security|sign-?in|login|password|verification|verify|fraud|authentication|account protection)\b/i],
  },
  {
    id: "money",
    label: "money, bills, and receipts",
    categories: ["finance", "financial", "receipt", "transaction", "billing", "payment"],
    search: "bill billing payment invoice receipt bank card transaction",
    patterns: [/\b(bill|billing|payment|invoice|receipt|bank|card|transaction|refund|charge|money)\b/i],
  },
  {
    id: "submissions",
    label: "book submissions and publishing",
    categories: ["submission", "book submission", "publishing", "literary"],
    search: "submission manuscript publisher literary agent query book",
    patterns: [/\b(submission|submissions|manuscript|publisher|publishing|literary|agent|query letter|book)\b/i],
  },
  {
    id: "calendar",
    label: "calendar and scheduling mail",
    categories: ["calendar", "scheduling", "meeting", "appointment", "event"],
    search: "calendar schedule scheduling meeting appointment event invite invitation",
    patterns: [/\b(calendar|schedule|scheduling|meeting|appointment|event|invite|invitation)\b/i],
  },
  {
    id: "newsletters",
    label: "newsletters and promotional mail",
    categories: ["newsletter", "marketing/promotional", "marketing", "promotional", "promotion", "bulk-mail"],
    search: "newsletter promotion sale subscription marketing shopping offer",
    patterns: [/\b(newsletter|newsletters|promotion|promotional|promo|sale|shopping|subscription|marketing|offer|offers)\b/i],
  },
];

const STOP_WORDS = new Set([
  "a",
  "about",
  "all",
  "and",
  "any",
  "are",
  "around",
  "ask",
  "at",
  "attention",
  "attachment",
  "attachments",
  "did",
  "do",
  "does",
  "email",
  "emails",
  "ezra",
  "find",
  "for",
  "from",
  "get",
  "give",
  "gmail",
  "google",
  "handled",
  "has",
  "have",
  "hotmail",
  "i",
  "in",
  "inbox",
  "important",
  "is",
  "last",
  "mail",
  "me",
  "messages",
  "microsoft",
  "my",
  "need",
  "needed",
  "needs",
  "not",
  "of",
  "on",
  "one",
  "outlook",
  "please",
  "priority",
  "quiet",
  "quieted",
  "read",
  "reply",
  "respond",
  "response",
  "show",
  "silenced",
  "that",
  "the",
  "these",
  "this",
  "to",
  "today",
  "unhandled",
  "unread",
  "up",
  "urgent",
  "week",
  "what",
  "when",
  "where",
  "with",
]);

export function interpretNaturalLanguageSearch(input: {
  query: string;
  workspaceId?: string | null;
  providerSearchRequested?: boolean;
}): NaturalLanguageSearchInterpretation {
  const query = cleanQuery(input.query);
  if (query.length < 2) throw new Error("Enter a natural-language search query.");
  const text = query.toLowerCase();
  const applied: NaturalLanguageSearchAppliedFilter[] = [];
  const warnings: string[] = [];
  const ignoredTerms: string[] = [];
  const workspace = resolveWorkspace(text, input.workspaceId);
  const filters: SavedViewMailFilters = {};

  pushApplied(applied, "workspaceId", "Workspace", WORKSPACE_LABELS[workspace.id], workspace.reason);

  const folder = detectFolder(text);
  filters.folder = folder.value;
  pushApplied(applied, "folder", "Folder", folder.label, folder.reason);

  const date = detectDate(text);
  if (date) {
    filters.date = date.value;
    pushApplied(applied, "date", "Date", date.label, date.reason);
  }

  const handled = detectHandled(text);
  if (handled) {
    filters.handled = handled.value;
    pushApplied(applied, "handled", "Handled state", handled.label, handled.reason);
  }

  const priority = detectPriority(text);
  if (priority) {
    filters.priority = priority.value;
    if (!filters.handled && priority.value === "suppress") filters.handled = "any";
    pushApplied(applied, "priority", "Ezra attention", priority.label, priority.reason);
  }

  if (/\b(unread|not read)\b/i.test(query)) {
    filters.unread = true;
    pushApplied(applied, "unread", "Unread only", "Unread", "You asked for unread or not-read mail.");
  }

  if (/\b(needs? (a )?reply|need to reply|reply to|respond|response needed|owe .*reply|waiting on me|follow up with)\b/i.test(query)) {
    filters.needsReply = true;
    pushApplied(applied, "needsReply", "Needs reply", "Needs reply", "You asked for mail that needs a response.");
  }

  if (/\b(deadline|due|time-?bound|commitment|commitments)\b/i.test(query)) {
    filters.hasDeadline = true;
    pushApplied(applied, "hasDeadline", "Has deadline", "Has deadline", "You asked for deadline or time-bound mail.");
  }

  if (/\b(attachment|attachments|attached|file|files|pdf|resume|document|documents)\b/i.test(query)) {
    filters.attachments = true;
    pushApplied(applied, "attachments", "Attachments", "Has attachments", "You asked for mail with files or attachments.");
  }

  const categoryHints = matchingCategoryHints(text);
  if (categoryHints.length === 1) {
    filters.categories = categoryHints[0].categories;
    filters.search = categoryHints[0].search;
    pushApplied(applied, "categories", "Subject matter", categoryHints[0].label, "Your words matched Ezra's local topic hints.");
  } else if (categoryHints.length > 1) {
    filters.categories = Array.from(new Set(categoryHints.flatMap((hint) => hint.categories)));
    filters.search = Array.from(new Set(categoryHints.flatMap((hint) => hint.search.split(/\s+/)))).join(" ");
    pushApplied(
      applied,
      "categories",
      "Subject matter",
      categoryHints.map((hint) => hint.label).join(", "),
      "Your words matched multiple local topic hints.",
    );
  } else {
    const meaningful = meaningfulSearchTerms(text);
    if (meaningful.length) {
      filters.search = meaningful.join(" ");
      pushApplied(applied, "search", "Keyword search", filters.search, "Ezra kept the meaningful words for local full-text search.");
    } else {
      ignoredTerms.push(...query.split(/\s+/).slice(0, 12));
    }
  }

  if (input.providerSearchRequested) {
    warnings.push("Provider search is explicit and read-only; Ezra will not send, delete, or modify provider mail from this search.");
  }

  const filterParams = filtersToParams(workspace.id, filters);
  const confidence = applied.length >= 4 || categoryHints.length ? "high" : filters.search ? "medium" : "low";
  return {
    query,
    workspaceId: workspace.id,
    workspaceLabel: WORKSPACE_LABELS[workspace.id],
    mode: "local",
    confidence,
    filters,
    filterParams,
    applied,
    ignoredTerms,
    warnings,
    explanation: buildExplanation(workspace.id, filters, applied),
    providerSearch: {
      readOnly: true,
      available: workspace.id !== MICROSOFT_WORKSPACE_ID,
      requested: Boolean(input.providerSearchRequested),
      reason: input.providerSearchRequested
        ? "Provider search was explicitly requested and remains read-only."
        : "Ezra will search the local SQLite index first. Provider search is only used when explicitly requested.",
    },
  };
}

export async function getNaturalLanguageSearchPage(input: SearchInput): Promise<NaturalLanguageSearchPage> {
  const interpretation = interpretNaturalLanguageSearch(input);
  const limit = Math.min(50, Math.max(5, input.limit || 20));
  const results = await getMailPage({
    ...interpretation.filters,
    workspaceId: interpretation.workspaceId,
    limit,
    cursor: input.cursor || undefined,
  });
  return {
    generatedAt: nowIso(),
    query: interpretation.query,
    interpretation,
    results,
  };
}

export async function runNaturalLanguageSearchAction(input: SearchActionInput) {
  if (input.action === "interpret") {
    return {
      generatedAt: nowIso(),
      action: "interpret" as const,
      interpretation: interpretNaturalLanguageSearch(input),
    };
  }
  const interpretation = interpretNaturalLanguageSearch({
    query: input.query,
    workspaceId: input.workspaceId,
    providerSearchRequested: true,
  });
  if (!interpretation.providerSearch.available) {
    return {
      generatedAt: nowIso(),
      action: "provider_search" as const,
      interpretation,
      provider: {
        readOnly: true,
        items: [] as MailThreadItem[],
        nextPageToken: null,
        accountCount: 0,
        message: "Microsoft provider search is not enabled in this local-search slice. Use local Hotmail search for now.",
      },
    };
  }
  const provider = await searchProviderMail({
    query: interpretation.filters.search || interpretation.query,
    accountId: input.accountId || undefined,
    workspaceId: interpretation.workspaceId,
    pageToken: input.pageToken || undefined,
  });
  return {
    generatedAt: nowIso(),
    action: "provider_search" as const,
    interpretation,
    provider: {
      readOnly: true,
      ...provider,
      message: "Provider search was explicitly requested and completed as a read-only lookup.",
    },
  };
}

function cleanQuery(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function resolveWorkspace(text: string, requested?: string | null) {
  if (/\b(all accounts|both accounts|everything|combined)\b/i.test(text)) {
    return { id: ALL_WORKSPACE_ID, reason: "You explicitly asked for all accounts or a combined view." };
  }
  if (/\b(hotmail|outlook|microsoft)\b/i.test(text)) {
    return { id: MICROSOFT_WORKSPACE_ID, reason: "You mentioned Hotmail, Outlook, or Microsoft." };
  }
  if (/\b(gmail|google)\b/i.test(text)) {
    return { id: GMAIL_WORKSPACE_ID, reason: "You mentioned Gmail or Google." };
  }
  if (requested === MICROSOFT_WORKSPACE_ID) {
    return { id: MICROSOFT_WORKSPACE_ID, reason: "Using the selected Hotmail workspace." };
  }
  if (requested === ALL_WORKSPACE_ID) {
    return { id: ALL_WORKSPACE_ID, reason: "Using the explicit All accounts workspace." };
  }
  return { id: GMAIL_WORKSPACE_ID, reason: requested === GMAIL_WORKSPACE_ID ? "Using the selected Gmail workspace." : "Defaulting to the Gmail workspace." };
}

function detectFolder(text: string) {
  if (/\b(trash|deleted)\b/i.test(text)) return { value: "trash", label: "Trash", reason: "You asked for trash or deleted mail." };
  if (/\b(spam|junk)\b/i.test(text)) return { value: "spam", label: "Spam/Junk", reason: "You asked for spam or junk mail." };
  if (/\b(sent|sent mail)\b/i.test(text)) return { value: "sent", label: "Sent", reason: "You asked for sent mail." };
  if (/\b(archive|archived)\b/i.test(text)) return { value: "archive", label: "Archive", reason: "You asked for archived mail." };
  if (/\b(all mail|any folder|every folder)\b/i.test(text)) return { value: "all", label: "All folders", reason: "You asked across all folders." };
  return { value: "inbox", label: "Inbox", reason: "Natural-language search starts in Inbox unless you ask for another folder." };
}

function detectDate(text: string): { value: SavedViewMailFilters["date"]; label: string; reason: string } | null {
  if (/\btoday\b/i.test(text)) return { value: "today", label: "Today", reason: "You mentioned today." };
  if (/\b(last|past|this)\s+(week|7 days)|\bweek\b/i.test(text)) return { value: "last7", label: "Last 7 days", reason: "You mentioned a week or last week." };
  if (/\b(last|past|this)\s+(month|30 days)|\bmonth\b/i.test(text)) return { value: "last30", label: "Last 30 days", reason: "You mentioned a month or last month." };
  if (/\brecent|recently\b/i.test(text)) return { value: "recent", label: "Recent", reason: "You asked for recent mail." };
  return null;
}

function detectHandled(text: string): { value: "active" | "handled" | "any"; label: string; reason: string } | null {
  if (/\b(unhandled|not handled|not done|not acknowledged|still needs?|still need|needs attention|need to deal|active)\b/i.test(text)) {
    return { value: "active", label: "Still active", reason: "You asked for mail that is not handled yet." };
  }
  if (/\b(already handled|handled|acknowledged|done|marked read|read)\b/i.test(text)) {
    return { value: "handled", label: "Handled/read", reason: "You asked for mail you already handled or read." };
  }
  return null;
}

function detectPriority(text: string): { value: "interrupt" | "digest" | "suppress"; label: string; reason: string } | null {
  if (/\b(urgent|important|high priority|priority|needs attention|alert|alerts)\b/i.test(text)) {
    return { value: "interrupt", label: "Needs attention", reason: "You asked for important or urgent mail." };
  }
  if (/\b(quiet|quieted|silenced|suppressed|ignored|low priority|cleanup|clean up|junk)\b/i.test(text)) {
    return { value: "suppress", label: "Quiet / low priority", reason: "You asked for quieted, suppressed, or cleanup mail." };
  }
  if (/\b(fyi|digest|worth knowing|for your information)\b/i.test(text)) {
    return { value: "digest", label: "Worth knowing", reason: "You asked for FYI or digest mail." };
  }
  return null;
}

function matchingCategoryHints(text: string) {
  return CATEGORY_HINTS.filter((hint) => hint.patterns.some((pattern) => pattern.test(text)));
}

function meaningfulSearchTerms(text: string) {
  return Array.from(new Set(
    text
      .split(/[^a-z0-9@._-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
      .slice(0, 8),
  ));
}

function filtersToParams(workspaceId: string, filters: SavedViewMailFilters) {
  const params: Record<string, string> = { workspaceId };
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return params;
}

function pushApplied(
  applied: NaturalLanguageSearchAppliedFilter[],
  field: string,
  label: string,
  value: string,
  reason: string,
) {
  applied.push({ field, label, value, reason });
}

function buildExplanation(
  workspaceId: string,
  filters: SavedViewMailFilters,
  applied: NaturalLanguageSearchAppliedFilter[],
) {
  const workspace = WORKSPACE_LABELS[workspaceId] || "selected workspace";
  const pieces = [`Ezra will search ${workspace}`];
  if (filters.folder) pieces.push(`${filters.folder} mail`);
  if (filters.handled === "active") pieces.push("that is still active");
  if (filters.handled === "handled") pieces.push("that has already been handled or read");
  if (filters.priority === "interrupt") pieces.push("marked as needing attention");
  if (filters.priority === "digest") pieces.push("marked worth knowing");
  if (filters.priority === "suppress") pieces.push("that Ezra kept quiet");
  if (filters.needsReply) pieces.push("that needs a reply");
  if (filters.hasDeadline) pieces.push("with a deadline");
  if (filters.attachments) pieces.push("with attachments");
  if (filters.date && filters.date !== "any") pieces.push(`from ${dateLabel(filters.date)}`);
  if (filters.categories?.length) pieces.push(`matching ${applied.find((item) => item.field === "categories")?.value || "selected topics"}`);
  if (filters.search && !filters.categories?.length) pieces.push(`containing "${filters.search}"`);
  return `${pieces.join(", ")}.`;
}

function dateLabel(value: SavedViewMailFilters["date"]) {
  if (value === "today") return "today";
  if (value === "last7" || value === "week") return "the last 7 days";
  if (value === "last30" || value === "month") return "the last 30 days";
  return "recent mail";
}
