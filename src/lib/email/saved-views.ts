import { execute, newId, nowIso } from "./database";
import type {
  SavedView,
  SavedViewDefinition,
  SavedViewMailFilters,
  SavedViewPage,
} from "./types";
import {
  ALL_WORKSPACE_ID,
  GMAIL_WORKSPACE_ID,
  MICROSOFT_WORKSPACE_ID,
} from "./workspaces";

type Row = Awaited<ReturnType<typeof execute>>["rows"][number];

type BuiltInSavedViewTemplate = {
  id: string;
  label: string;
  description: string;
  definition: SavedViewDefinition;
  sortOrder: number;
};

export type SavedViewInput = {
  workspaceId?: string | null;
};

export type CreateSavedViewInput = {
  workspaceId?: string | null;
  label: string;
  description?: string | null;
  definition: SavedViewDefinition;
  sortOrder?: number | null;
};

export type UpdateSavedViewInput = {
  id: string;
  label?: string | null;
  description?: string | null;
  definition?: SavedViewDefinition;
  isEnabled?: boolean;
  sortOrder?: number | null;
};

const BUILT_IN_SAVED_VIEWS: BuiltInSavedViewTemplate[] = [
  {
    id: "builtin:job-search",
    label: "Job search",
    description: "Recruiters, applications, interviews, job alerts, and hiring follow-ups.",
    sortOrder: 10,
    definition: {
      kind: "mail",
      semanticKey: "job_search",
      sort: "priority",
      filters: {
        folder: "inbox",
        categories: ["job application", "job alert", "career", "interview request"],
        search: "job recruiter interview application hiring",
        handled: "active",
      },
    },
  },
  {
    id: "builtin:people",
    label: "People",
    description: "Human correspondence that should not get buried under automated mail.",
    sortOrder: 20,
    definition: {
      kind: "mail",
      semanticKey: "people",
      sort: "newest",
      filters: {
        folder: "inbox",
        categories: ["personal", "relationship", "direct-human", "conversation"],
        search: "reply conversation meeting following up",
        handled: "active",
      },
    },
  },
  {
    id: "builtin:money-bills",
    label: "Money / Bills",
    description: "Bills, payment notices, receipts, account balances, and financial mail.",
    sortOrder: 30,
    definition: {
      kind: "mail",
      semanticKey: "money_bills",
      sort: "priority",
      filters: {
        folder: "inbox",
        categories: ["finance", "financial", "receipt", "transaction", "payment", "bill"],
        search: "bill payment receipt invoice balance transaction",
        handled: "active",
      },
    },
  },
  {
    id: "builtin:security",
    label: "Security",
    description: "Sign-in alerts, account protection, verification, fraud, and security notices.",
    sortOrder: 40,
    definition: {
      kind: "mail",
      semanticKey: "security",
      sort: "priority",
      filters: {
        folder: "inbox",
        categories: ["account-security", "account-verification", "fraud", "authentication"],
        search: "security sign-in verification password fraud suspicious",
        handled: "active",
      },
    },
  },
  {
    id: "builtin:submissions",
    label: "Submissions",
    description: "Book submissions, publication replies, creative opportunities, and editor mail.",
    sortOrder: 50,
    definition: {
      kind: "mail",
      semanticKey: "submissions",
      sort: "priority",
      filters: {
        folder: "inbox",
        categories: ["submission", "publishing", "editor", "creative", "book"],
        search: "submission manuscript editor publisher query",
        handled: "active",
      },
    },
  },
  {
    id: "builtin:newsletters",
    label: "Newsletters",
    description: "Recurring bulk reading, newsletters, promotions, and low-priority subscriptions.",
    sortOrder: 60,
    definition: {
      kind: "mail",
      semanticKey: "newsletters",
      sort: "newest",
      filters: {
        folder: "inbox",
        categories: ["newsletter", "marketing/promotional", "bulk-mail", "promotions"],
        priority: "suppress",
        search: "newsletter unsubscribe sale digest",
        handled: "any",
      },
    },
  },
  {
    id: "builtin:waiting-on-reply",
    label: "Waiting on reply",
    description: "Threads where the next useful state is someone else responding.",
    sortOrder: 70,
    definition: {
      kind: "mail",
      semanticKey: "waiting_on_reply",
      sort: "newest",
      filters: {
        folder: "all",
        search: "waiting on reply following up sent",
        handled: "any",
      },
    },
  },
  {
    id: "builtin:recently-handled",
    label: "Recently handled",
    description: "Mail you already acknowledged, read, quieted, or otherwise handled recently.",
    sortOrder: 80,
    definition: {
      kind: "mail",
      semanticKey: "recently_handled",
      sort: "newest",
      filters: {
        folder: "all",
        date: "last7",
        handled: "handled",
      },
    },
  },
  {
    id: "builtin:needs-reply",
    label: "Needs reply",
    description: "Messages Ezra thinks may need a response from you.",
    sortOrder: 90,
    definition: {
      kind: "mail",
      semanticKey: "needs_reply",
      sort: "priority",
      filters: {
        folder: "inbox",
        needsReply: true,
        handled: "active",
      },
    },
  },
  {
    id: "builtin:attachments",
    label: "Attachments",
    description: "Mail with files, forms, tickets, documents, or other attached material.",
    sortOrder: 100,
    definition: {
      kind: "mail",
      semanticKey: "attachments",
      sort: "newest",
      filters: {
        folder: "all",
        attachments: true,
        handled: "any",
      },
    },
  },
];

export function builtInSavedViewTemplates() {
  return BUILT_IN_SAVED_VIEWS.map((item) => cloneTemplate(item));
}

export async function getSavedViews(input: SavedViewInput = {}): Promise<SavedViewPage> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const custom = await execute(
    `SELECT *
     FROM saved_views
     WHERE COALESCE(workspace_id, ?) = ?
       AND is_builtin = 0
     ORDER BY sort_order ASC, lower(label) ASC, created_at ASC`,
    [workspaceId, workspaceId],
  );
  const items = [
    ...BUILT_IN_SAVED_VIEWS.map((template) => savedViewFromTemplate(template, workspaceId)),
    ...custom.rows.map((row) => savedViewFromRow(row, workspaceId)),
  ].filter((view) => view.isEnabled);
  return {
    generatedAt: nowIso(),
    workspaceId,
    items,
  };
}

export async function getSavedView(id: string, input: SavedViewInput = {}): Promise<SavedView> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const builtIn = BUILT_IN_SAVED_VIEWS.find((template) => template.id === id);
  if (builtIn) return savedViewFromTemplate(builtIn, workspaceId);
  const row = await getSavedViewRow(id);
  if (!row) throw new Error("Saved view was not found.");
  const rowWorkspaceId = normalizeWorkspaceId(row.workspace_id);
  if (input.workspaceId && rowWorkspaceId !== workspaceId) {
    throw new Error("Saved view was not found in this workspace.");
  }
  return savedViewFromRow(row, rowWorkspaceId);
}

export async function createSavedView(input: CreateSavedViewInput): Promise<SavedView> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const definition = normalizeDefinition(input.definition);
  const label = cleanRequiredText(input.label, "Saved view label");
  const description = cleanText(input.description || "");
  const now = nowIso();
  const id = newId("view");
  const sortOrder = Number.isFinite(input.sortOrder)
    ? Number(input.sortOrder)
    : await nextCustomSortOrder(workspaceId);
  await execute(
    `INSERT INTO saved_views
      (id, workspace_id, label, description, definition_json, is_builtin,
       is_enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`,
    [id, workspaceId, label, description, JSON.stringify(definition), sortOrder, now, now],
  );
  return getSavedView(id, { workspaceId });
}

export async function updateSavedView(input: UpdateSavedViewInput): Promise<SavedView> {
  const current = await getSavedViewRow(input.id);
  if (!current) throw new Error("Saved view was not found.");
  if (Number(current.is_builtin || 0) === 1) {
    throw new Error("Built-in saved views cannot be edited directly.");
  }
  const label = input.label === undefined
    ? String(current.label)
    : cleanRequiredText(input.label, "Saved view label");
  const description = input.description === undefined
    ? String(current.description || "")
    : cleanText(input.description || "");
  const definition = input.definition === undefined
    ? parseDefinition(current.definition_json)
    : normalizeDefinition(input.definition);
  const isEnabled = input.isEnabled === undefined
    ? Number(current.is_enabled || 0) === 1
    : input.isEnabled;
  const sortOrder = input.sortOrder === undefined || input.sortOrder === null
    ? Number(current.sort_order || 0)
    : Number(input.sortOrder);
  await execute(
    `UPDATE saved_views
     SET label = ?, description = ?, definition_json = ?, is_enabled = ?,
       sort_order = ?, updated_at = ?
     WHERE id = ?`,
    [
      label,
      description,
      JSON.stringify(definition),
      isEnabled ? 1 : 0,
      Number.isFinite(sortOrder) ? sortOrder : Number(current.sort_order || 0),
      nowIso(),
      input.id,
    ],
  );
  return getSavedView(input.id, { workspaceId: current.workspace_id ? String(current.workspace_id) : undefined });
}

export async function deleteSavedView(id: string) {
  const current = await getSavedViewRow(id);
  if (!current) throw new Error("Saved view was not found.");
  if (Number(current.is_builtin || 0) === 1) {
    throw new Error("Built-in saved views cannot be deleted.");
  }
  await execute(`DELETE FROM saved_views WHERE id = ?`, [id]);
  return { ok: true, id };
}

export function savedViewToMailFilters(view: SavedView): SavedViewMailFilters {
  return { ...view.definition.filters };
}

async function getSavedViewRow(id: string) {
  const result = await execute(`SELECT * FROM saved_views WHERE id = ?`, [id]);
  return result.rows[0] || null;
}

async function nextCustomSortOrder(workspaceId: string) {
  const result = await execute(
    `SELECT MAX(sort_order) AS max_sort_order
     FROM saved_views
     WHERE COALESCE(workspace_id, ?) = ? AND is_builtin = 0`,
    [workspaceId, workspaceId],
  );
  return Math.max(1000, Number(result.rows[0]?.max_sort_order || 999) + 1);
}

function savedViewFromTemplate(template: BuiltInSavedViewTemplate, workspaceId: string): SavedView {
  return {
    id: template.id,
    workspaceId,
    label: template.label,
    description: template.description,
    definition: cloneDefinition(template.definition),
    isBuiltin: true,
    isEnabled: true,
    isAllAccounts: workspaceId === ALL_WORKSPACE_ID,
    accountScopeLabel: accountScopeLabel(workspaceId),
    sortOrder: template.sortOrder,
    createdAt: "builtin",
    updatedAt: "builtin",
  };
}

function savedViewFromRow(row: Row, fallbackWorkspaceId: string): SavedView {
  const workspaceId = normalizeWorkspaceId(row.workspace_id || fallbackWorkspaceId);
  return {
    id: String(row.id),
    workspaceId,
    label: String(row.label),
    description: String(row.description || ""),
    definition: parseDefinition(row.definition_json),
    isBuiltin: Number(row.is_builtin || 0) === 1,
    isEnabled: Number(row.is_enabled || 0) === 1,
    isAllAccounts: workspaceId === ALL_WORKSPACE_ID,
    accountScopeLabel: accountScopeLabel(workspaceId),
    sortOrder: Number(row.sort_order || 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeWorkspaceId(value: unknown) {
  if (value === MICROSOFT_WORKSPACE_ID) return MICROSOFT_WORKSPACE_ID;
  if (value === ALL_WORKSPACE_ID) return ALL_WORKSPACE_ID;
  return GMAIL_WORKSPACE_ID;
}

function accountScopeLabel(workspaceId: string) {
  if (workspaceId === ALL_WORKSPACE_ID) return "All accounts · explicit blend";
  if (workspaceId === MICROSOFT_WORKSPACE_ID) return "Hotmail workspace";
  return "Gmail workspace";
}

function normalizeDefinition(value: SavedViewDefinition): SavedViewDefinition {
  if (!value || value.kind !== "mail") throw new Error("Saved view definition must target mail.");
  return {
    kind: "mail",
    semanticKey: cleanOptionalText(value.semanticKey),
    sort: value.sort === "oldest" || value.sort === "priority" ? value.sort : "newest",
    filters: normalizeFilters(value.filters || {}),
  };
}

function normalizeFilters(filters: SavedViewMailFilters): SavedViewMailFilters {
  const normalized: SavedViewMailFilters = {};
  if (filters.folder) normalized.folder = cleanText(filters.folder);
  if (filters.account) normalized.account = cleanText(filters.account);
  if (filters.inboxCategory) normalized.inboxCategory = cleanText(filters.inboxCategory);
  if (filters.priority === "interrupt" || filters.priority === "digest" || filters.priority === "suppress") {
    normalized.priority = filters.priority;
  }
  if (filters.category) normalized.category = cleanText(filters.category).toLowerCase();
  if (Array.isArray(filters.categories)) {
    normalized.categories = filters.categories
      .map((category) => cleanText(category).toLowerCase())
      .filter(Boolean)
      .slice(0, 12);
  }
  if (typeof filters.unread === "boolean") normalized.unread = filters.unread;
  if (typeof filters.attachments === "boolean") normalized.attachments = filters.attachments;
  if (
    filters.date === "today" ||
    filters.date === "week" ||
    filters.date === "month" ||
    filters.date === "recent" ||
    filters.date === "last7" ||
    filters.date === "last30"
  ) {
    normalized.date = filters.date;
  } else if (filters.date === "any") {
    normalized.date = "any";
  }
  if (filters.search) normalized.search = cleanText(filters.search);
  if (typeof filters.needsReply === "boolean") normalized.needsReply = filters.needsReply;
  if (typeof filters.hasDeadline === "boolean") normalized.hasDeadline = filters.hasDeadline;
  if (filters.handled === "active" || filters.handled === "handled" || filters.handled === "any") {
    normalized.handled = filters.handled;
  }
  return normalized;
}

function parseDefinition(value: unknown): SavedViewDefinition {
  try {
    return normalizeDefinition(JSON.parse(String(value || "{}")));
  } catch {
    return {
      kind: "mail",
      sort: "newest",
      filters: { folder: "inbox" },
    };
  }
}

function cleanRequiredText(value: unknown, label: string) {
  const text = cleanText(value);
  if (!text) throw new Error(`${label} is required.`);
  return text.slice(0, 100);
}

function cleanText(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanOptionalText(value: unknown) {
  const text = cleanText(value);
  return text || undefined;
}

function cloneTemplate(template: BuiltInSavedViewTemplate): BuiltInSavedViewTemplate {
  return {
    ...template,
    definition: cloneDefinition(template.definition),
  };
}

function cloneDefinition(definition: SavedViewDefinition): SavedViewDefinition {
  return JSON.parse(JSON.stringify(definition)) as SavedViewDefinition;
}
