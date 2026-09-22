"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Bookmark,
  Check,
  ChevronDown,
  FileSearch,
  Inbox,
  LoaderCircle,
  Mail,
  MailOpen,
  MailSearch,
  Paperclip,
  Pencil,
  Plus,
  SlidersHorizontal,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  VolumeX,
  X,
} from "lucide-react";
import type { AskEzraResult, MailActionResult, MailPage, MailThreadItem, MailWorkspace, NaturalLanguageSearchInterpretation, NaturalLanguageSearchPage, SavedViewPage, SavedView, SavedViewDefinition } from "@/lib/email/types";
import { mailActionCopy } from "@/lib/email/vocabulary";
import { api, post } from "./api";
import { bulkConfirmationSentence, bulkSelectionLabel, resolveBulkSelectionTargets } from "./mailSelection";
import { MessagePane } from "./MessagePane";
import { isInitialPanelLoad } from "./refreshState";
import { isAbortError, useLatestRequest } from "./useLatestRequest";
import styles from "./EzraMail.module.css";

type SearchMode = "local" | "natural" | "provider" | "ask";
type InboxCategory = "all" | "primary" | "promotions" | "updates" | "social" | "forums";
type Filters = {
  folder: string;
  inboxCategory: InboxCategory;
  account: string;
  category: string;
  priority: string;
  date: string;
  unread: boolean;
  attachments: boolean;
  handled: "" | "active" | "handled" | "any";
  needsReply: boolean;
  hasDeadline: boolean;
  messageIds: string[];
  todaySection: "" | "action" | "reply" | "deadline" | "fyi";
};
type MailMeta = {
  accounts: Array<{ id: string; provider: "gmail" | "microsoft"; label: string; email: string; purpose?: string }>;
  workspaces: MailWorkspace[];
  categories: string[];
};

const DEFAULT_FILTERS: Filters = {
  folder: "inbox",
  inboxCategory: "all",
  account: "",
  category: "",
  priority: "",
  date: "any",
  unread: false,
  attachments: false,
  handled: "",
  needsReply: false,
  hasDeadline: false,
  messageIds: [],
  todaySection: "",
};

export function MailView(props: {
  initialMessageId: string | null;
  workspaceId: string;
  workspace: MailWorkspace | null;
  onSelectedMessage: (id: string | null) => void;
  onAction: (action: string, ids: string[], label?: string, payload?: Record<string, unknown>) => Promise<MailActionResult>;
  onMailStateChanged: () => void;
  onOpenOutbox?: (draftId: string) => void;
  onSelectWorkspace?: (workspaceId: string) => void;
}) {
  const [items, setItems] = useState<MailThreadItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [meta, setMeta] = useState<MailMeta>({ accounts: [], workspaces: [], categories: [] });
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedViewsError, setSavedViewsError] = useState("");
  const [laneDialog, setLaneDialog] = useState<"create" | "edit" | null>(null);
  const [laneLabel, setLaneLabel] = useState("");
  const [laneDescription, setLaneDescription] = useState("");
  const [laneReplaceFilters, setLaneReplaceFilters] = useState(false);
  const [laneBusy, setLaneBusy] = useState(false);
  const [laneError, setLaneError] = useState("");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [filtersReady, setFiltersReady] = useState(false);
  const [selectedViewId, setSelectedViewId] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("local");
  const [askResult, setAskResult] = useState<AskEzraResult | null>(null);
  const [naturalInterpretation, setNaturalInterpretation] = useState<NaturalLanguageSearchInterpretation | null>(null);
  const [naturalActiveQuery, setNaturalActiveQuery] = useState("");
  const [naturalWorkspaceId, setNaturalWorkspaceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(props.initialMessageId);
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const [keyboardCursorId, setKeyboardCursorId] = useState<string | null>(null);
  const [sweepBySender, setSweepBySender] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const previousWorkspaceId = useRef(props.workspaceId);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const beginMailRequest = useLatestRequest();
  const beginSavedViewsRequest = useLatestRequest();
  const beginMetaRequest = useLatestRequest();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const restored = localStorage.getItem("ezra-mail-filters");
    const useUrlDrilldown = params.get("drill") === "1";
    let restoredFilters: Partial<Filters> = {};
    if (restored && !useUrlDrilldown) {
      try { restoredFilters = JSON.parse(restored) as Partial<Filters>; } catch { /* Ignore stale state. */ }
    }
    const urlFilters = filtersFromParams(params);
    if (Object.keys(restoredFilters).length || Object.keys(urlFilters).length) {
      setFilters({ ...DEFAULT_FILTERS, ...restoredFilters, ...urlFilters });
    }
    const viewId = params.get("viewId") || (!useUrlDrilldown ? localStorage.getItem("ezra-mail-view-id") || "" : "");
    if (viewId) setSelectedViewId(viewId);
    const q = params.get("q") || "";
    if (q && params.get("searchMode") === "natural") {
      setSearchInput(q);
      setSearchMode("natural");
    } else if (q) {
      setSearchInput(q);
      setSearch(q);
    }
    setFiltersReady(true);
  }, []);

  useEffect(() => {
    setSelectedMessageId(props.initialMessageId);
  }, [props.initialMessageId]);

  const loadMail = useCallback(async (
    cursor: string | null = null,
    options: { append?: boolean; quiet?: boolean } = {},
  ) => {
    const append = options.append || false;
    const request = beginMailRequest();
    if (append) setLoadingMore(true);
    else if (options.quiet) setRefreshing(true);
    else if (!options.quiet) setLoading(true);
    if (!options.quiet) setError("");
    try {
      if (naturalActiveQuery) {
        const params = new URLSearchParams({
          q: naturalActiveQuery,
          workspaceId: naturalWorkspaceId || props.workspaceId,
          limit: "40",
        });
        if (cursor) params.set("cursor", cursor);
        const page = await api<NaturalLanguageSearchPage>(`/api/search?${params.toString()}`, { signal: request.signal });
        if (!request.isLatest()) return;
        setNaturalInterpretation(page.interpretation);
        setItems((current) => append ? [...current, ...page.results.items] : page.results.items);
        setNextCursor(page.results.nextCursor);
        setTotal(page.results.total);
        return;
      }
      const params = new URLSearchParams({
        limit: "40",
        workspaceId: props.workspaceId,
      });
      if (selectedViewId) {
        params.set("viewId", selectedViewId);
      } else {
        params.set("folder", filters.folder);
        params.set("date", filters.date);
      }
      if (selectedViewId && filters.folder !== DEFAULT_FILTERS.folder) params.set("folder", filters.folder);
      if (selectedViewId && filters.date !== DEFAULT_FILTERS.date) params.set("date", filters.date);
      if (filters.folder === "inbox" && filters.inboxCategory !== "all") {
        params.set("inboxCategory", filters.inboxCategory);
      }
      if (cursor) params.set("cursor", cursor);
      if (search) params.set("search", search);
      if (filters.account) params.set("account", filters.account);
      if (filters.category) params.set("category", filters.category);
      if (filters.priority) params.set("priority", filters.priority);
      if (filters.unread) params.set("unread", "true");
      if (filters.attachments) params.set("attachments", "true");
      if (filters.handled) params.set("handled", filters.handled);
      if (filters.needsReply) params.set("needsReply", "true");
      if (filters.hasDeadline) params.set("hasDeadline", "true");
      for (const messageId of filters.messageIds) params.append("messageId", messageId);
      const page = await api<MailPage>(`/api/mail?${params.toString()}`, { signal: request.signal });
      if (!request.isLatest()) return;
      setItems((current) => append ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
      setTotal(page.total);
    } catch (nextError) {
      if (request.isLatest() && !isAbortError(nextError)) setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (request.isLatest()) {
        if (options.quiet) setRefreshing(false);
        else setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [beginMailRequest, filters, naturalActiveQuery, naturalWorkspaceId, props.workspaceId, search, selectedViewId]);

  useEffect(() => {
    const request = beginMetaRequest();
    void api<MailMeta>("/api/mail/meta", { signal: request.signal })
      .then((next) => request.isLatest() && setMeta(next))
      .catch(() => undefined);
  }, [beginMetaRequest]);

  const loadSavedViews = useCallback(async () => {
    const request = beginSavedViewsRequest();
    setSavedViewsError("");
    try {
      const page = await api<SavedViewPage>(`/api/views?workspaceId=${encodeURIComponent(props.workspaceId)}`, { signal: request.signal });
      if (!request.isLatest()) return [];
      setSavedViews(page.items);
      return page.items;
    } catch (nextError) {
      if (!request.isLatest() || isAbortError(nextError)) return [];
      setSavedViews([]);
      setSavedViewsError(nextError instanceof Error ? nextError.message : String(nextError));
      return [];
    }
  }, [beginSavedViewsRequest, props.workspaceId]);

  useEffect(() => {
    void loadSavedViews();
  }, [loadSavedViews]);

  useEffect(() => {
    if (!selectedViewId || !savedViews.length) return;
    if (savedViews.some((view) => view.id === selectedViewId)) return;
    setSelectedViewId("");
  }, [savedViews, selectedViewId]);

  useEffect(() => {
    if (!filtersReady) return;
    localStorage.setItem("ezra-mail-filters", JSON.stringify({ ...filters, messageIds: [], todaySection: "" }));
    if (selectedViewId) localStorage.setItem("ezra-mail-view-id", selectedViewId);
    else localStorage.removeItem("ezra-mail-view-id");
    void loadMail();
  }, [filters, filtersReady, loadMail, search, selectedViewId]);

  useEffect(() => {
    if (!filtersReady) return undefined;
    const refresh = () => void loadMail(null, { quiet: true });
    window.addEventListener("ezra:refresh", refresh);
    return () => window.removeEventListener("ezra:refresh", refresh);
  }, [filtersReady, loadMail]);

  const currentWorkspace = props.workspace || meta.workspaces.find((workspace) => workspace.id === props.workspaceId) || null;
  const visibleAccounts = useMemo(() => {
    if (!currentWorkspace || currentWorkspace.isAllAccounts) return meta.accounts;
    return meta.accounts.filter((account) => currentWorkspace.accountIds.includes(account.id));
  }, [currentWorkspace, meta.accounts]);
  const hasHotmailWorkspace = currentWorkspace?.provider === "microsoft";
  const activeSavedView = savedViews.find((view) => view.id === selectedViewId) || null;
  const naturalTargetAvailable = !naturalInterpretation || naturalInterpretation.workspaceId === props.workspaceId || meta.workspaces.some((workspace) => (
    workspace.id === naturalInterpretation.workspaceId && (workspace.isAllAccounts || workspace.accountIds.length > 0)
  ));

  const selectedIds = useMemo(() => {
    return resolveBulkSelectionTargets(items, selected, sweepBySender);
  }, [items, selected, sweepBySender]);

  const selectionLabel = bulkSelectionLabel(selected.size, selectedIds.length, sweepBySender);

  useEffect(() => {
    if (!selected.size) {
      if (sweepBySender) setSweepBySender(false);
      return;
    }
    const visibleIds = new Set(items.map((item) => item.id));
    const staleIds = Array.from(selected).filter((id) => !visibleIds.has(id));
    if (!staleIds.length) return;
    const next = new Set(Array.from(selected).filter((id) => visibleIds.has(id)));
    setSelected(next);
    if (!next.size) setSweepBySender(false);
  }, [items, selected, sweepBySender]);

  useEffect(() => {
    if (previousWorkspaceId.current === props.workspaceId) return;
    previousWorkspaceId.current = props.workspaceId;
    clearBulkSelection();
    setSelectedMessageId(null);
    props.onSelectedMessage(null);
    if (naturalActiveQuery && naturalWorkspaceId !== props.workspaceId) {
      setNaturalActiveQuery("");
      setNaturalWorkspaceId("");
      setNaturalInterpretation(null);
    }
  }, [props.workspaceId]);

  useEffect(() => {
    setFilters((current) => {
      if (!current.account || visibleAccounts.some((account) => account.id === current.account)) {
        return current;
      }
      return { ...current, account: "" };
    });
  }, [props.workspaceId, visibleAccounts]);

  useEffect(() => {
    if (hasHotmailWorkspace && searchMode === "provider") setSearchMode("local");
  }, [hasHotmailWorkspace, searchMode]);

  function selectMessage(id: string | null) {
    if (id !== selectedMessageId) clearBulkSelection();
    setSelectedMessageId(id);
    setKeyboardCursorId(id);
    props.onSelectedMessage(id);
    if (!id) return;
    const opening = items.find((item) => item.id === id);
    if (!opening?.isUnread) return;
    void post<MailActionResult>("/api/mail/actions", { action: "mark_read", messageIds: [id] })
      .then((result) => {
        if (result.failureCount) {
          setError(friendlyFailure(result.failures[0]?.error || "This message could not be marked read."));
          return;
        }
        props.onMailStateChanged();
        if (filters.unread || filters.handled === "active") {
          setItems((current) => current.filter((item) => item.id !== id));
          setTotal((current) => Math.max(0, current - 1));
        } else {
          setItems((current) => current.map((item) => item.id === id ? { ...item, isUnread: false } : item));
        }
        void loadMail(null, { quiet: true });
      })
      .catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
        void loadMail();
      });
  }

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => {
      const next: Filters = { ...current, [key]: value, messageIds: [], todaySection: "" };
      if (key === "folder" && value !== "inbox") next.inboxCategory = "all";
      return next;
    });
    const params = new URLSearchParams(window.location.search);
    params.delete("messageId");
    params.delete("todaySection");
    params.delete("drill");
    replaceCurrentLocation(params);
    clearBulkSelection();
  }

  function clearDrilldownFilter(key: "handled" | "needsReply" | "hasDeadline" | "todaySection") {
    setFilters((current) => key === "todaySection"
      ? { ...current, messageIds: [], todaySection: "" }
      : { ...current, [key]: key === "handled" ? "" : false });
    const params = new URLSearchParams(window.location.search);
    if (key === "todaySection") {
      params.delete("messageId");
      params.delete("todaySection");
    } else {
      params.delete(key);
    }
    replaceCurrentLocation(params);
    clearBulkSelection();
  }

  function selectSavedView(viewId: string) {
    const nextViewId = selectedViewId === viewId ? "" : viewId;
    clearBulkSelection();
    setAskResult(null);
    setNaturalInterpretation(null);
    setNaturalActiveQuery("");
    setNaturalWorkspaceId("");
    setSearch("");
    setSearchInput("");
    setSearchMode("local");
    setFilters(DEFAULT_FILTERS);
    setSelectedViewId(nextViewId);
    const params = new URLSearchParams(window.location.search);
    if (nextViewId) params.set("viewId", nextViewId); else params.delete("viewId");
    params.delete("q");
    replaceCurrentLocation(params);
  }

  function openCreateLane() {
    setLaneDialog("create");
    setLaneLabel(defaultLaneLabel());
    setLaneDescription(defaultLaneDescription());
    setLaneReplaceFilters(true);
    setLaneError("");
  }

  function openEditLane() {
    if (!activeSavedView || activeSavedView.isBuiltin) return;
    setLaneDialog("edit");
    setLaneLabel(activeSavedView.label);
    setLaneDescription(activeSavedView.description);
    setLaneReplaceFilters(false);
    setLaneError("");
  }

  async function saveLane(event: FormEvent) {
    event.preventDefault();
    const label = laneLabel.trim();
    if (!label) {
      setLaneError("Give this lane a short name.");
      return;
    }
    setLaneBusy(true);
    setLaneError("");
    try {
      if (laneDialog === "edit" && activeSavedView && !activeSavedView.isBuiltin) {
        const updated = await post<SavedView>("/api/views/actions", {
          action: "update",
          id: activeSavedView.id,
          label,
          description: laneDescription.trim(),
          ...(laneReplaceFilters ? { definition: currentSavedViewDefinition() } : {}),
        });
        setSavedViews((current) => current.map((view) => (view.id === updated.id ? updated : view)));
        setSelectedViewId(updated.id);
        void loadSavedViews();
      } else {
        const created = await post<SavedView>("/api/views/actions", {
          action: "create",
          workspaceId: props.workspaceId,
          label,
          description: laneDescription.trim(),
          definition: currentSavedViewDefinition(),
        });
        setSavedViews((current) => [...current.filter((view) => view.id !== created.id), created]);
        setSelectedViewId(created.id);
        const params = new URLSearchParams(window.location.search);
        params.set("viewId", created.id);
        params.delete("q");
        replaceCurrentLocation(params);
        void loadSavedViews();
      }
      setLaneDialog(null);
      void loadMail(null, { quiet: true });
    } catch (nextError) {
      setLaneError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLaneBusy(false);
    }
  }

  async function deleteActiveLane() {
    if (!activeSavedView || activeSavedView.isBuiltin) return;
    setLaneBusy(true);
    setLaneError("");
    try {
      await post<{ ok: boolean }>("/api/views/actions", { action: "delete", id: activeSavedView.id });
      setSavedViews((current) => current.filter((view) => view.id !== activeSavedView.id));
      setSelectedViewId("");
      const params = new URLSearchParams(window.location.search);
      params.delete("viewId");
      replaceCurrentLocation(params);
      setLaneDialog(null);
      void loadSavedViews();
      void loadMail(null, { quiet: true });
    } catch (nextError) {
      setLaneError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLaneBusy(false);
    }
  }

  function updateInboxCategory(value: InboxCategory) {
    setFilters((current) => ({ ...current, folder: "inbox", inboxCategory: value }));
    clearBulkSelection();
  }

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    setAskResult(null);
    setError("");
    clearBulkSelection();
    const query = searchInput.trim();
    const params = new URLSearchParams(window.location.search);
    if (query) params.set("q", query); else params.delete("q");
    if (query) {
      params.delete("viewId");
      setSelectedViewId("");
    }
    replaceCurrentLocation(params);
    if (searchMode === "local") {
      setSearch(query);
      return;
    }
    if (!query) return;
    setLoading(true);
    try {
      if (searchMode === "natural") {
        const result = await post<{ interpretation: NaturalLanguageSearchInterpretation }>("/api/search/actions", {
          action: "interpret",
          query,
          workspaceId: props.workspaceId,
        });
        setNaturalInterpretation(result.interpretation);
        setNaturalActiveQuery("");
        setNaturalWorkspaceId(result.interpretation.workspaceId);
      } else if (searchMode === "provider") {
        const result = await post<{ items: MailThreadItem[] }>("/api/mail/search-provider", { query, accountId: filters.account || undefined, workspaceId: props.workspaceId });
        setItems(result.items);
        setTotal(result.items.length);
        setNextCursor(null);
        if (result.items[0]) selectMessage(result.items[0].id);
      } else {
        const result = await post<AskEzraResult>("/api/mail/ask", { query });
        setAskResult(result);
        setItems([]);
        setTotal(result.sources.length);
        setNextCursor(null);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }

  async function performAction(action: string, ids = selectedIds, payload: Record<string, unknown> = {}) {
    if (["quiet", "unsubscribe", "spam", "delete_and_teach"].includes(action)) {
      setPendingIds(ids);
      setPendingAction(action);
      return { actionId: "pending", action: action as MailActionResult["action"], successCount: 0, failureCount: 0, reversible: false, failures: [] };
    }
    const targetIds = ids.length ? ids : selectedIds;
    setBusyIds((current) => new Set([...current, ...targetIds]));
    try {
      const result = await props.onAction(action, targetIds, undefined, payload);
      const settled = new Set([...(result.changedIds || []), ...(result.unchangedIds || [])]);
      const refreshOpenReader = ["pin", "unpin", "flag", "unflag"].includes(action)
        && Boolean(selectedMessageId && targetIds.includes(selectedMessageId) && settled.has(selectedMessageId));
      if (settled.size && actionRemovesFromActiveMail(action, filters)) {
        setItems((current) => {
          const removed = current.filter((item) => settled.has(item.id)).length;
          if (removed) setTotal((total) => Math.max(0, total - removed));
          return current.filter((item) => !settled.has(item.id));
        });
        if (selectedMessageId && settled.has(selectedMessageId)) selectMessage(null);
      }
      clearBulkSelection();
      if (action === "delete" && selectedMessageId && targetIds.includes(selectedMessageId)) {
        selectMessage(null);
      }
      await loadMail(null, { quiet: true });
      if (refreshOpenReader) setDetailRefreshToken((current) => current + 1);
      return result;
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        for (const id of targetIds) next.delete(id);
        return next;
      });
    }
  }

  async function confirmAction() {
    if (!pendingAction) return;
    const ids = pendingIds.length ? pendingIds : selectedIds.length ? selectedIds : selectedMessageId ? [selectedMessageId] : [];
    setActionBusy(true);
    try {
      const result = await props.onAction(pendingAction, ids);
      const settled = new Set([...(result.changedIds || []), ...(result.unchangedIds || [])]);
      if (settled.size && actionRemovesFromActiveMail(pendingAction, filters)) {
        setItems((current) => {
          const removed = current.filter((item) => settled.has(item.id)).length;
          if (removed) setTotal((total) => Math.max(0, total - removed));
          return current.filter((item) => !settled.has(item.id));
        });
      }
      setPendingAction(null);
      setPendingIds([]);
      clearBulkSelection();
      if (["delete", "delete_and_teach"].includes(pendingAction) && selectedMessageId && ids.includes(selectedMessageId)) {
        selectMessage(null);
      }
      await loadMail(null, { quiet: true });
    } finally {
      setActionBusy(false);
    }
  }

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      if (!next.size) setSweepBySender(false);
      return next;
    });
  }

  function clearBulkSelection() {
    setSelected(new Set());
    setSweepBySender(false);
  }

  function switchSearchMode(mode: SearchMode) {
    clearBulkSelection();
    setSearchMode(mode);
    if (mode !== "natural") {
      setNaturalInterpretation(null);
      setNaturalActiveQuery("");
      setNaturalWorkspaceId("");
      const params = new URLSearchParams(window.location.search);
      params.delete("searchMode");
      if (naturalActiveQuery) params.delete("q");
      replaceCurrentLocation(params);
    }
  }

  function clearSearch() {
    clearBulkSelection();
    setSearchInput("");
    setSearch("");
    setNaturalInterpretation(null);
    setNaturalActiveQuery("");
    setNaturalWorkspaceId("");
    const params = new URLSearchParams(window.location.search);
    params.delete("q");
    params.delete("searchMode");
    replaceCurrentLocation(params);
  }

  function openNaturalResults() {
    if (!naturalInterpretation || !naturalTargetAvailable) return;
    setAskResult(null);
    setSearch("");
    setSelectedViewId("");
    setFilters(DEFAULT_FILTERS);
    setNaturalWorkspaceId(naturalInterpretation.workspaceId);
    setNaturalActiveQuery(naturalInterpretation.query);
    if (naturalInterpretation.workspaceId !== props.workspaceId) {
      props.onSelectWorkspace?.(naturalInterpretation.workspaceId);
    }
    const params = new URLSearchParams(window.location.search);
    params.set("q", naturalInterpretation.query);
    params.set("searchMode", "natural");
    params.delete("viewId");
    replaceCurrentLocation(params);
  }

  function currentSavedViewDefinition(): SavedViewDefinition {
    const nextFilters: SavedViewDefinition["filters"] = {
      folder: filters.folder,
      handled: "any",
    };
    if (filters.folder === "inbox" && filters.inboxCategory !== "all") nextFilters.inboxCategory = filters.inboxCategory;
    if (filters.account) nextFilters.account = filters.account;
    if (filters.category) nextFilters.category = filters.category;
    if (filters.priority === "interrupt" || filters.priority === "digest" || filters.priority === "suppress") {
      nextFilters.priority = filters.priority;
    }
    if (filters.date && filters.date !== "any") nextFilters.date = filters.date as SavedViewDefinition["filters"]["date"];
    if (filters.unread) nextFilters.unread = true;
    if (filters.attachments) nextFilters.attachments = true;
    if (filters.handled) nextFilters.handled = filters.handled;
    if (filters.needsReply) nextFilters.needsReply = true;
    if (filters.hasDeadline) nextFilters.hasDeadline = true;
    const query = (search || searchInput).trim();
    if (query) nextFilters.search = query;
    return { kind: "mail", sort: "newest", filters: nextFilters };
  }

  function defaultLaneLabel() {
    if (search.trim()) return `Search: ${search.trim().slice(0, 40)}`;
    if (filters.category) return humanize(filters.category);
    if (filters.priority) return `${humanize(filters.priority)} mail`;
    if (filters.attachments) return "Mail with attachments";
    if (filters.unread) return "Unread mail";
    return "My mail lane";
  }

  function defaultLaneDescription() {
    const parts = [
      currentWorkspace?.label || "Current workspace",
      filters.folder !== "inbox" ? humanize(filters.folder) : "Inbox",
      filters.category ? humanize(filters.category) : "",
      filters.priority ? humanize(filters.priority) : "",
      filters.unread ? "Unread" : "",
      filters.attachments ? "Attachments" : "",
      filters.handled === "handled" ? "Handled" : filters.handled === "active" ? "Still active" : "",
      filters.needsReply ? "Needs reply" : "",
      filters.hasDeadline ? "Has deadline" : "",
      search.trim() ? `Search: ${search.trim()}` : "",
    ].filter(Boolean);
    return parts.join(" · ");
  }

  useEffect(() => {
    const focusSearch = () => searchInputRef.current?.focus();
    const runCommand = (event: Event) => {
      const command = (event as CustomEvent<{ command?: string }>).detail?.command;
      const currentId = keyboardCursorId || selectedMessageId;
      const currentIndex = currentId ? items.findIndex((item) => item.id === currentId) : -1;
      if (command === "next" || command === "previous") {
        if (!items.length) return;
        const direction = command === "next" ? 1 : -1;
        const fallback = command === "next" ? 0 : items.length - 1;
        const nextIndex = currentIndex < 0 ? fallback : Math.max(0, Math.min(items.length - 1, currentIndex + direction));
        const nextId = items[nextIndex]?.id || null;
        setKeyboardCursorId(nextId);
        window.setTimeout(() => document.querySelector<HTMLElement>(`[data-mail-id='${CSS.escape(nextId || "")}']`)?.focus(), 0);
        return;
      }
      if (command === "open" && currentId) {
        selectMessage(currentId);
        return;
      }
      if (command === "escape") {
        if (selectedMessageId) selectMessage(null);
        else {
          setKeyboardCursorId(null);
          clearBulkSelection();
        }
        return;
      }
      if (!currentId) return;
      if (command === "acknowledge") void performAction("done", [currentId]);
      if (command === "care_more") void performAction("raise_priority", [currentId]);
      if (command === "care_less") void performAction("lower_priority", [currentId]);
      if (command === "trash") void performAction("delete", [currentId]);
    };
    window.addEventListener("ezra:focus-mail-search", focusSearch);
    window.addEventListener("ezra:mail-command", runCommand);
    return () => {
      window.removeEventListener("ezra:focus-mail-search", focusSearch);
      window.removeEventListener("ezra:mail-command", runCommand);
    };
  }, [items, keyboardCursorId, selectedMessageId, selectedIds]);

  return (
    <div className={styles.mailView} aria-busy={refreshing || loading || loadingMore}>
      <section className={styles.mailControls} aria-label="Mail search and filters">
        <form className={styles.searchBar} onSubmit={submitSearch}>
          <Search aria-hidden="true" />
          <input ref={searchInputRef} value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder={searchMode === "ask" ? "Ask about your mail" : searchMode === "natural" ? "Try: unhandled recruiter mail from last week" : "Search sender, subject, summary, or category"} aria-label="Search mail" />
          {searchInput ? <button type="button" onClick={clearSearch} aria-label="Clear search"><X aria-hidden="true" /></button> : null}
          <button type="submit" className={styles.searchSubmit}>{searchMode === "local" ? "Search" : searchMode === "natural" ? "Interpret" : searchMode === "provider" ? "Search Gmail" : "Ask Ezra"}</button>
        </form>
        <div className={styles.searchModes} role="group" aria-label="Search mode">
          <button className={searchMode === "local" ? styles.segmentActive : ""} onClick={() => switchSearchMode("local")}><FileSearch aria-hidden="true" /> Local</button>
          <button className={searchMode === "natural" ? styles.segmentActive : ""} onClick={() => switchSearchMode("natural")}><SlidersHorizontal aria-hidden="true" /> Natural language</button>
          <button disabled={hasHotmailWorkspace} className={searchMode === "provider" ? styles.segmentActive : ""} onClick={() => switchSearchMode("provider")}><MailSearch aria-hidden="true" /> Gmail</button>
          <button className={searchMode === "ask" ? styles.segmentActive : ""} onClick={() => switchSearchMode("ask")}><Sparkles aria-hidden="true" /> Ask Ezra</button>
        </div>
        {currentWorkspace ? (
          <div className={`${styles.workspaceNotice} ${currentWorkspace.provider === "microsoft" ? styles.workspaceNoticeMicrosoft : ""}`}>
            <strong>{currentWorkspace.label}</strong>
            <span>{currentWorkspace.isAllAccounts ? "All accounts is an explicit combined view." : currentWorkspace.purpose}</span>
            {currentWorkspace.provider === "microsoft" ? <small>Microsoft Graph actions enabled. Send remains disabled.</small> : null}
          </div>
        ) : null}
        <section className={styles.smartLanes} aria-label="Smart Lanes">
          <div className={styles.smartLaneHeader}>
            <span><Bookmark aria-hidden="true" /> Smart Lanes</span>
            <div className={styles.smartLaneHeaderActions}>
              <button onClick={openCreateLane}><Plus aria-hidden="true" /> Save lane</button>
              {activeSavedView && !activeSavedView.isBuiltin ? <button onClick={openEditLane}><Pencil aria-hidden="true" /> Edit lane</button> : null}
              {activeSavedView ? <button onClick={() => selectSavedView("")}>Clear lane</button> : null}
            </div>
          </div>
          {savedViewsError ? <p className={styles.smartLaneError}>{savedViewsError}</p> : null}
          <div className={styles.smartLaneList} role="group" aria-label="Saved Views and Smart Lanes">
            {savedViews.map((view) => (
              <button
                key={view.id}
                className={`${styles.smartLaneButton} ${selectedViewId === view.id ? styles.smartLaneActive : ""} ${view.isAllAccounts ? styles.smartLaneAllAccounts : ""}`}
                onClick={() => selectSavedView(view.id)}
                title={view.description}
              >
                <strong>{view.label}</strong>
                <small>{view.accountScopeLabel}</small>
              </button>
            ))}
          </div>
          {activeSavedView ? (
            <p className={`${styles.activeLaneNotice} ${activeSavedView.isAllAccounts ? styles.activeLaneNoticeAll : ""}`}>
              Showing <strong>{activeSavedView.label}</strong> · {activeSavedView.description}
            </p>
          ) : null}
        </section>
        <div className={styles.inboxTabs} role="group" aria-label="Gmail inbox tabs">
          {INBOX_CATEGORIES.map((category) => (
            <button
              key={category.id}
              className={filters.folder === "inbox" && filters.inboxCategory === category.id ? styles.inboxTabActive : ""}
              onClick={() => updateInboxCategory(category.id)}
            >
              {category.label}
            </button>
          ))}
        </div>
        <div className={styles.filterBar}>
          <SelectFilter label="Folder" value={filters.folder} onChange={(value) => updateFilter("folder", value)} options={[["inbox", "Inbox"], ["all", "All mail"], ["archive", "Archive"], ["sent", "Sent"], ["spam", "Spam"], ["trash", "Trash"]]} />
          <SelectFilter label="Account" value={filters.account} onChange={(value) => updateFilter("account", value)} options={[[ "", currentWorkspace?.isAllAccounts ? "All accounts" : `All ${currentWorkspace?.label || "workspace"} mail`], ...visibleAccounts.map((account) => [account.id, account.label] as [string, string])]} />
          <SelectFilter label="Priority" value={filters.priority} onChange={(value) => updateFilter("priority", value)} options={[["", "Any priority"], ["interrupt", "Priority"], ["digest", "Brief"], ["suppress", "Quiet"]]} />
          <SelectFilter label="Date" value={filters.date} onChange={(value) => updateFilter("date", value)} options={[["any", "Any time"], ["today", "Today"], ["week", "Past week"], ["month", "Past month"]]} />
          <SelectFilter label="Category" value={filters.category} onChange={(value) => updateFilter("category", value)} options={[["", "Any category"], ...meta.categories.map((category) => [category, humanize(category)] as [string, string])]} />
          <label className={styles.checkFilter}><input type="checkbox" checked={filters.unread} onChange={(event) => updateFilter("unread", event.target.checked)} /> Unread</label>
          <label className={styles.checkFilter}><input type="checkbox" checked={filters.attachments} onChange={(event) => updateFilter("attachments", event.target.checked)} /> Attachments</label>
        </div>
        {filters.handled || filters.needsReply || filters.hasDeadline || filters.todaySection ? (
          <div className={styles.drilldownChips} aria-label="Today drilldown filters">
            {filters.todaySection ? <button onClick={() => clearDrilldownFilter("todaySection")}>Today: {todaySectionLabel(filters.todaySection)} ({filters.messageIds.length}) <X aria-hidden="true" /></button> : null}
            {filters.handled ? <button onClick={() => clearDrilldownFilter("handled")}>{filters.handled === "handled" ? "Handled" : filters.handled === "active" ? "Still active" : "Any handled state"} <X aria-hidden="true" /></button> : null}
            {filters.needsReply ? <button onClick={() => clearDrilldownFilter("needsReply")}>Needs reply <X aria-hidden="true" /></button> : null}
            {filters.hasDeadline ? <button onClick={() => clearDrilldownFilter("hasDeadline")}>Has deadline <X aria-hidden="true" /></button> : null}
          </div>
        ) : null}
      </section>

      {naturalInterpretation ? (
        <section className={styles.naturalSearchReview} aria-labelledby="natural-search-heading">
          <header>
            <SlidersHorizontal aria-hidden="true" />
            <div>
              <p>Review before opening results</p>
              <h2 id="natural-search-heading">Ezra interpreted your search</h2>
            </div>
            <span className={styles.naturalConfidence}>{naturalInterpretation.confidence} confidence</span>
          </header>
          <p className={styles.naturalExplanation}>{naturalInterpretation.explanation}</p>
          <div className={styles.naturalFilterGrid}>
            {naturalInterpretation.applied.map((item) => (
              <div key={`${item.field}:${item.value}`}>
                <strong>{item.label}</strong>
                <span>{item.value}</span>
                <small>{item.reason}</small>
              </div>
            ))}
          </div>
          <div className={styles.naturalSafetyNote}>
            <ShieldAlert aria-hidden="true" />
            <span><strong>Local and read-only.</strong> Opening these results cannot send, delete, mark read, or change provider mail. Any later mail action keeps its normal confirmation rules.</span>
          </div>
          {!naturalTargetAvailable ? <p className={styles.inlineError} role="alert">Connect {naturalInterpretation.workspaceLabel} before opening results from that workspace.</p> : null}
          {naturalInterpretation.warnings.map((warning) => <p className={styles.inlineError} key={warning}>{warning}</p>)}
          <div className={styles.naturalReviewActions}>
            <button className={styles.secondaryButton} onClick={() => setNaturalInterpretation(null)}>Revise query</button>
            <button className={styles.primaryButton} disabled={!naturalTargetAvailable} onClick={openNaturalResults}>{!naturalTargetAvailable ? `${naturalInterpretation.workspaceLabel} not connected` : naturalInterpretation.workspaceId !== props.workspaceId ? `Switch to ${naturalInterpretation.workspaceLabel} and open results` : naturalActiveQuery ? "Refresh results" : "Open results"}</button>
          </div>
        </section>
      ) : null}

      {selected.size ? (
        <div className={styles.bulkToolbar}>
          <strong>{selectionLabel}</strong>
          <label><input type="checkbox" checked={sweepBySender} onChange={(event) => setSweepBySender(event.target.checked)} /> Sweep matching senders</label>
          <span className={styles.toolbarSpacer} />
          <button disabled={Boolean(busyIds.size)} onClick={() => performAction("done")}><Check aria-hidden="true" /> {busyIds.size ? "Working..." : mailActionCopy("done").label}</button>
          <button disabled={Boolean(busyIds.size)} onClick={() => performAction("lower_priority")}>{mailActionCopy("lower_priority").label}</button>
          <button disabled={Boolean(busyIds.size)} onClick={() => performAction("quiet")}><VolumeX aria-hidden="true" /> {mailActionCopy("quiet").label}</button>
          <button disabled={Boolean(busyIds.size)} className={styles.dangerButtonText} onClick={() => performAction("delete")}><Trash2 aria-hidden="true" /> {mailActionCopy("delete").label}</button>
          <button disabled={Boolean(busyIds.size)} className={styles.dangerButtonText} onClick={() => performAction("delete_and_teach")}><Sparkles aria-hidden="true" /> {mailActionCopy("delete_and_teach").label}</button>
          <button disabled={Boolean(busyIds.size)} className={styles.dangerButtonText} onClick={() => performAction("spam")}><ShieldAlert aria-hidden="true" /> {mailActionCopy("spam").label}</button>
          <button className={styles.iconButtonSmall} onClick={clearBulkSelection} aria-label="Clear selection"><X aria-hidden="true" /></button>
        </div>
      ) : null}

      {askResult ? (
        <section className={styles.askResult} aria-labelledby="ask-result-heading">
          <header><Sparkles aria-hidden="true" /><div><h2 id="ask-result-heading">Ezra's answer</h2><p>{searchInput}</p></div></header>
          <p>{askResult.answer}</p>
          <div className={styles.sourceList}>
            {askResult.sources.map((source, index) => (
              <button key={source.id} onClick={() => selectMessage(source.id)}><b>{index + 1}</b><span><strong>{source.subject}</strong><small>{source.senderName} · {formatShortDate(source.receivedAt)}</small></span></button>
            ))}
          </div>
        </section>
      ) : null}

      <div className={`${styles.mailWorkspace} ${selectedMessageId ? styles.mailWorkspaceSelected : ""}`}>
        <section className={styles.mailListPane} aria-label="Mail conversations">
          <header className={styles.listHeader}>
            <div><h2>{naturalActiveQuery ? "Interpreted search results" : activeSavedView ? activeSavedView.label : searchMode === "provider" && searchInput ? "Gmail results" : filters.folder === "inbox" ? "Inbox" : "Conversations"}</h2><span>{total} thread{total === 1 ? "" : "s"}{naturalActiveQuery ? ` · ${naturalInterpretation?.workspaceLabel || "local index"}` : activeSavedView ? ` · ${activeSavedView.accountScopeLabel}` : ""}</span></div>
            {items.length ? <button onClick={() => { setSweepBySender(false); setSelected(new Set(items.map((item) => item.id))); }}>Select visible</button> : null}
          </header>
          {isInitialPanelLoad(loading, Boolean(items.length || askResult)) ? <div className={styles.listLoading}><LoaderCircle aria-hidden="true" /> Finding conversations...</div> : null}
          {error ? <div className={styles.inlineError} role="alert">{error}</div> : null}
          {!loading && !items.length && !askResult ? <div className={styles.mailEmpty}><Inbox aria-hidden="true" /><h3>No matching mail</h3><p>Adjust the filters or explicitly search Gmail for older messages.</p></div> : null}
          <div className={styles.threadList}>
            {items.map((item) => (
              <article data-mail-id={item.id} tabIndex={keyboardCursorId === item.id ? 0 : -1} className={`${styles.threadRow} ${selectedMessageId === item.id ? styles.threadRowActive : ""} ${keyboardCursorId === item.id ? styles.threadRowKeyboard : ""} ${item.isUnread ? styles.threadRowUnread : ""} ${item.accountProvider === "microsoft" ? styles.threadRowMicrosoft : ""}`} key={item.id}>
                <label className={styles.rowCheckbox} aria-label={`Select ${item.subject}`}><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelected(item.id)} /></label>
                <button className={styles.threadOpen} onClick={() => selectMessage(item.id)}>
                  <span className={styles.threadSender}>
                    <span className={styles.threadSenderIdentity}>
                      <span className={styles.readState} aria-label={item.isUnread ? "Unread" : "Read"} title={item.isUnread ? "Unread" : "Read"}>
                        {item.isUnread ? <Mail aria-hidden="true" /> : <MailOpen aria-hidden="true" />}
                      </span>
                      <strong>{item.senderName}</strong>
                    </span>
                    <time>{relativeTime(item.receivedAt)}</time>
                  </span>
                  <span className={styles.threadSubject}>{item.subject}{item.threadCount > 1 ? <b>{item.threadCount}</b> : null}</span>
                  <span className={styles.threadSnippet}>{item.summary || item.snippet}</span>
                    <span className={styles.threadMeta}>
                    <span className={`${styles.accountBadge} ${item.accountProvider === "microsoft" ? styles.accountBadgeMicrosoft : styles.accountBadgeGmail}`}>{item.accountLabel}</span>
                    {item.isPinned ? <span aria-label="Pinned">Pinned</span> : null}
                    {item.isFlagged ? <span aria-label="Flagged">Flagged</span> : null}
                    {item.category ? ` · ${humanize(item.category)}` : ""}
                    {item.hasAttachments ? <Paperclip aria-hidden="true" /> : null}
                  </span>
                </button>
                <div className={styles.rowQuickActions} aria-label={`Quick actions for ${item.subject}`}>
                  {item.organizationCapabilities?.pin.state === "supported" ? (
                    <button disabled={busyIds.has(item.id)} onClick={() => performAction(item.isPinned ? "unpin" : "pin", [item.id])}>{mailActionCopy(item.isPinned ? "unpin" : "pin").label}</button>
                  ) : (
                    <button disabled title={item.organizationCapabilities?.pin.reason || "Ezra cannot safely map Pin for this account yet."}>{item.organizationCapabilities?.pin.state === "reconnect_required" ? "Reconnect to Pin" : "Pin unavailable"}</button>
                  )}
                  {item.organizationCapabilities?.flag.state === "supported" ? (
                    <button disabled={busyIds.has(item.id)} onClick={() => performAction(item.isFlagged ? "unflag" : "flag", [item.id])}>{mailActionCopy(item.isFlagged ? "unflag" : "flag").label}</button>
                  ) : (
                    <button disabled title={item.organizationCapabilities?.flag.reason || "Ezra cannot safely map Flag for this account yet."}>{item.organizationCapabilities?.flag.state === "reconnect_required" ? "Reconnect to Flag" : "Flag unavailable"}</button>
                  )}
                  <button disabled={busyIds.has(item.id)} onClick={() => performAction("delete", [item.id])}><Trash2 aria-hidden="true" /> {busyIds.has(item.id) ? "Working..." : mailActionCopy("delete").label}</button>
                  <button disabled={busyIds.has(item.id)} onClick={() => performAction("delete_and_teach", [item.id])}><Sparkles aria-hidden="true" /> {busyIds.has(item.id) ? "Working..." : mailActionCopy("delete_and_teach").label}</button>
                </div>
              </article>
            ))}
          </div>
          {nextCursor ? <button className={styles.loadMore} disabled={loadingMore} onClick={() => loadMail(nextCursor, { append: true })}>{loadingMore ? "Loading..." : "Load more"}</button> : null}
        </section>
        <MessagePane messageId={selectedMessageId} refreshToken={detailRefreshToken} workspaceId={props.workspaceId} onClose={() => selectMessage(null)} onOpenOutbox={props.onOpenOutbox} onRequestAction={performAction} />
      </div>

      {pendingAction ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => { if (!actionBusy) { setPendingAction(null); setPendingIds([]); } }}>
          <section className={styles.confirmDialog} role="alertdialog" aria-modal="true" aria-labelledby="mail-action-confirm" onMouseDown={(event) => event.stopPropagation()}>
            <h2 id="mail-action-confirm">Approve {mailActionCopy(pendingAction).confirmationLabel}?</h2>
            <p>{bulkConfirmationSentence(selected.size, pendingIds.length || selectedIds.length || 1, sweepBySender)}</p>
            <div className={styles.actionPreview}><strong>Action preview</strong><span>{mailActionCopy(pendingAction).description}</span><small>{pendingAction === "unsubscribe" ? "Unsubscribe cannot be undone." : "Reversible provider changes can be undone from the confirmation notice."}</small></div>
            <div className={styles.dialogActions}><button className={styles.secondaryButton} disabled={actionBusy} onClick={() => { setPendingAction(null); setPendingIds([]); }}>Cancel</button><button className={mailActionCopy(pendingAction).destructive ? styles.dangerButton : styles.primaryButton} disabled={actionBusy} onClick={confirmAction}>{actionBusy ? mailActionCopy(pendingAction).progressLabel : "Approve"}</button></div>
          </section>
        </div>
      ) : null}
      {laneDialog ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => { if (!laneBusy) setLaneDialog(null); }}>
          <form className={`${styles.confirmDialog} ${styles.laneDialog}`} aria-label={laneDialog === "edit" ? "Edit Smart Lane" : "Save Smart Lane"} onSubmit={saveLane} onMouseDown={(event) => event.stopPropagation()}>
            <h2>{laneDialog === "edit" ? "Edit Smart Lane" : "Save current view as a Smart Lane"}</h2>
            <p>{laneDialog === "edit" ? "Rename this custom lane, or explicitly replace its filters with your current Mail setup." : "Save the current workspace, filters, and local search as a reusable lane."}</p>
            <label>Lane name<input value={laneLabel} onChange={(event) => setLaneLabel(event.target.value)} maxLength={100} required autoFocus /></label>
            <label>Description<textarea value={laneDescription} onChange={(event) => setLaneDescription(event.target.value)} rows={3} maxLength={1000} /></label>
            {laneDialog === "edit" ? (
              <label className={styles.confirmCheck}><input type="checkbox" checked={laneReplaceFilters} onChange={(event) => setLaneReplaceFilters(event.target.checked)} /> Replace this lane&apos;s filters with the current Mail view</label>
            ) : null}
            <div className={styles.actionPreview}>
              <strong>Lane scope</strong>
              <span>{currentWorkspace?.isAllAccounts ? "All accounts · explicit blended view" : `${currentWorkspace?.label || "Current workspace"} only`}</span>
              <small>{laneReplaceFilters || laneDialog === "create" ? defaultLaneDescription() : "Keeping the existing saved filters."}</small>
            </div>
            {laneError ? <p className={styles.inlineError} role="alert">{laneError}</p> : null}
            <div className={styles.dialogActions}>
              {laneDialog === "edit" && activeSavedView && !activeSavedView.isBuiltin ? <button type="button" className={styles.dangerButton} disabled={laneBusy} onClick={deleteActiveLane}>Delete lane</button> : null}
              <button type="button" className={styles.secondaryButton} disabled={laneBusy} onClick={() => setLaneDialog(null)}>Cancel</button>
              <button type="submit" className={styles.primaryButton} disabled={laneBusy}>{laneBusy ? "Saving..." : laneDialog === "edit" ? "Save lane" : "Create lane"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function SelectFilter(props: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return <label className={styles.selectFilter}><span>{props.label}</span><select aria-label={props.label} value={props.value} onChange={(event) => props.onChange(event.target.value)}>{props.options.map(([value, label]) => <option key={value || "all"} value={value}>{label}</option>)}</select><ChevronDown aria-hidden="true" /></label>;
}

const INBOX_CATEGORIES: Array<{ id: InboxCategory; label: string }> = [
  { id: "all", label: "All Inbox" },
  { id: "primary", label: "Primary" },
  { id: "promotions", label: "Promotions" },
  { id: "updates", label: "Updates" },
  { id: "social", label: "Social" },
  { id: "forums", label: "Forums" },
];

function filtersFromParams(params: URLSearchParams): Partial<Filters> {
  const next: Partial<Filters> = {};
  const folder = params.get("folder");
  if (folder) next.folder = folder;
  const date = params.get("date");
  if (date) next.date = date;
  const priority = params.get("priority");
  if (priority) next.priority = priority;
  const category = params.get("category");
  if (category) next.category = category;
  const account = params.get("account");
  if (account) next.account = account;
  const inboxCategory = params.get("inboxCategory");
  if (inboxCategory && ["all", "primary", "promotions", "updates", "social", "forums"].includes(inboxCategory)) {
    next.inboxCategory = inboxCategory as InboxCategory;
  }
  if (params.get("unread") === "true") next.unread = true;
  if (params.get("attachments") === "true") next.attachments = true;
  const handled = params.get("handled");
  if (handled === "active" || handled === "handled" || handled === "any") next.handled = handled;
  if (params.get("needsReply") === "true") next.needsReply = true;
  if (params.get("hasDeadline") === "true") next.hasDeadline = true;
  next.messageIds = Array.from(new Set(params.getAll("messageId").map((id) => id.trim()).filter(Boolean))).slice(0, 12);
  const todaySection = params.get("todaySection");
  if (todaySection === "action" || todaySection === "reply" || todaySection === "deadline" || todaySection === "fyi") next.todaySection = todaySection;
  return next;
}

function todaySectionLabel(section: Filters["todaySection"]) {
  if (section === "action") return "Action now";
  if (section === "reply") return "Needs reply";
  if (section === "deadline") return "Deadlines";
  return "Worth knowing";
}

function actionRemovesFromActiveMail(action: string, filters: Filters) {
  if (filters.handled === "active" || filters.unread) {
    return ["done", "mark_read", "delete", "delete_and_teach", "spam", "quiet"].includes(action);
  }
  if (filters.folder === "inbox") return ["delete", "delete_and_teach", "spam"].includes(action);
  return false;
}

function replaceCurrentLocation(params: URLSearchParams) {
  window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
}

function friendlyFailure(error: string) {
  if (/Reconnect Hotmail/i.test(error)) {
    return "Reconnect Hotmail from Settings to grant Microsoft Mail.ReadWrite access.";
  }
  return error.split(/\s+Trace ID:/i)[0] || error;
}

function humanize(value: string) { return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatShortDate(value: string) { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)); }
function relativeTime(value: string) { const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000)); if (minutes < 60) return `${Math.max(1, minutes)}m`; if (minutes < 1_440) return `${Math.round(minutes / 60)}h`; if (minutes < 10_080) return `${Math.round(minutes / 1_440)}d`; return formatShortDate(value); }
