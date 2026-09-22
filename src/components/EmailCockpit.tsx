"use client";

import {
  Activity,
  ArrowDownToLine,
  Ban,
  BellRing,
  Brain,
  Check,
  CheckSquare,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileText,
  History,
  Inbox,
  LoaderCircle,
  ListChecks,
  Mail,
  MailCheck,
  MailOpen,
  MessageSquareText,
  Paperclip,
  PencilLine,
  Pause,
  Play,
  RefreshCcw,
  Reply,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  UserPlus,
  Wifi,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { modelDefinitions } from "@/lib/email/models";
import type {
  AccountStatus,
  DashboardState,
  DraftPreparation,
  DraftItem,
  InboxItem,
  MaintenanceAction,
  MaintenanceGroup,
  MessageDetail,
  ModelId,
} from "@/lib/email/types";

type View =
  | "inbox"
  | "mailbox"
  | "accounts"
  | "digests"
  | "maintenance"
  | "replies"
  | "learning"
  | "models"
  | "settings";
type InboxMode = "priority" | "digest" | "all";
type GmailAccessMode = "readonly" | "maintenance";
type MicrosoftAuthChallenge = {
  connectionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: string;
  message: string | null;
  interval: number;
};
type DraftComposerState = {
  item: InboxItem;
  content: string;
  instruction: string;
  memorySummary: string;
  loading: boolean;
  manualFirst: boolean;
  error: string | null;
};

const nav: Array<{ id: View; label: string; icon: typeof Inbox }> = [
  { id: "inbox", label: "Priority inbox", icon: Inbox },
  { id: "mailbox", label: "All mail", icon: MailOpen },
  { id: "accounts", label: "Accounts", icon: UserPlus },
  { id: "digests", label: "Digests", icon: FileText },
  { id: "maintenance", label: "Maintenance", icon: MailCheck },
  { id: "replies", label: "Reply queue", icon: Reply },
  { id: "learning", label: "Learning", icon: Brain },
  { id: "models", label: "Models", icon: Activity },
  { id: "settings", label: "Settings", icon: Settings },
];

export function EmailCockpit() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [view, setView] = useState<View>("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftComposer, setDraftComposer] = useState<DraftComposerState | null>(null);
  const [editingDraft, setEditingDraft] = useState<DraftItem | null>(null);
  const [draftText, setDraftText] = useState("");
  const [confirmDraft, setConfirmDraft] = useState<DraftItem | null>(null);
  const [messageDetails, setMessageDetails] = useState<Record<string, MessageDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [detailModalId, setDetailModalId] = useState<string | null>(null);
  const draftInstructionRef = useRef<HTMLTextAreaElement>(null);
  const [maintenanceConfirm, setMaintenanceConfirm] = useState<{
    groups: MaintenanceGroup[];
    action: MaintenanceAction;
  } | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/email", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load the email cockpit.");
    const next = (await response.json()) as DashboardState;
    setState(next);
    setSelectedId((current) => current || next.inbox[0]?.id || next.mailbox[0]?.id || null);
  }, []);

  useEffect(() => {
    void refresh().catch((error) => setNotice(error.message));
    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function act(
    payload: Record<string, unknown>,
    label: string,
    successMessage?: string,
  ) {
    setBusy(label);
    setNotice(null);
    try {
      const response = await fetch("/api/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as { ok: boolean; result?: unknown; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error || "The action failed.");
      await refresh();
      if (successMessage) setNotice(successMessage);
      return body.result ?? true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function prepareDraft(
    item: InboxItem,
    instruction = "",
    previousDraft = "",
    focusInstruction = false,
  ) {
    setDraftComposer({
      item,
      content: previousDraft,
      instruction,
      memorySummary: "",
      loading: true,
      manualFirst: false,
      error: null,
    });
    if (focusInstruction) {
      window.setTimeout(() => draftInstructionRef.current?.focus(), 0);
    }
    try {
      const response = await fetch("/api/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "prepare_draft",
          messageId: item.id,
          context: instruction,
          previousDraft,
        }),
      });
      const body = (await response.json()) as {
        ok: boolean;
        result?: DraftPreparation;
        error?: string;
      };
      if (!response.ok || !body.ok || !body.result) {
        throw new Error(body.error || "Ezra could not prepare the draft.");
      }
      setDraftComposer((current) =>
        current?.item.id === item.id
          ? {
              ...current,
              content: body.result!.content,
              memorySummary: body.result!.contactMemorySummary,
              loading: false,
              error: null,
            }
          : current,
      );
    } catch (error) {
      setDraftComposer((current) =>
        current?.item.id === item.id
          ? {
              ...current,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    }
  }

  function startManualReply(item: InboxItem) {
    setDraftComposer({
      item,
      content: "",
      instruction: "Polish this into a clear reply while keeping my intent and not adding promises I did not make.",
      memorySummary: item.summary || item.recommendation || "",
      loading: false,
      manualFirst: true,
      error: null,
    });
    window.setTimeout(() => document.getElementById("draft-content")?.focus(), 0);
  }

  async function manualRefresh() {
    setBusy("refresh");
    setNotice(null);
    try {
      await refresh();
      setNotice("Mailbox refreshed.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  const loadMessageDetail = useCallback(async (messageId: string) => {
    setDetailLoading(messageId);
    setNotice(null);
    try {
      const response = await fetch("/api/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "get_message_detail", messageId }),
      });
      const body = (await response.json()) as {
        ok: boolean;
        result?: MessageDetail;
        error?: string;
      };
      if (!response.ok || !body.ok || !body.result) {
        throw new Error(body.error || "Could not load the email.");
      }
      setMessageDetails((current) => ({ ...current, [messageId]: body.result! }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading((current) => (current === messageId ? null : current));
    }
  }, []);

  const openMessageModal = useCallback(
    (messageId: string) => {
      setDetailModalId(messageId);
      void loadMessageDetail(messageId);
    },
    [loadMessageDetail],
  );

  const selected = useMemo(
    () =>
      state
        ? [...state.inbox, ...state.mailbox].find((item) => item.id === selectedId) || null
        : null,
    [selectedId, state],
  );

  useEffect(() => {
    if (selected?.id && !messageDetails[selected.id]) {
      void loadMessageDetail(selected.id);
    }
  }, [loadMessageDetail, selected?.id]);

  if (!state) {
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" size={24} />
        <span>Opening Ezra Mail</span>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Mail size={22} /></div>
          <div>
            <strong>Ezra Mail</strong>
            <span>Private email agent</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Main navigation">
          {nav.map((item) => {
            const Icon = item.icon;
            const badge =
              item.id === "inbox"
                ? state.counts.interrupt
                : item.id === "digests"
                  ? state.counts.digest
                : item.id === "maintenance"
                  ? state.counts.maintenance
                : item.id === "replies"
                  ? state.counts.awaitingApproval
                  : 0;
            return (
              <button
                key={item.id}
                className={view === item.id ? "nav-button active" : "nav-button"}
                onClick={() => setView(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {badge > 0 && <b>{badge}</b>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-status">
          <StatusDot good={state.health.worker === "running"} label="Worker" />
          <StatusDot good={state.health.ollama} label="Ollama" />
          <StatusDot good={state.health.telegramConfigured} label="Telegram" />
          <StatusDot good={state.health.gogInstalled} label="Gmail bridge" />
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Email operations</p>
            <h1>{nav.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="topbar-actions">
            <div className="model-pill" title={state.effectiveModel || state.activeModel}>
              <Sparkles size={15} />
              {formatModelLabel(state.effectiveModel || state.activeModel)}
            </div>
            <button
              className="icon-button"
              title="Refresh"
              aria-label="Refresh"
              disabled={busy === "refresh"}
              onClick={() => void manualRefresh()}
            >
              <RefreshCcw className={busy === "refresh" ? "spin" : ""} size={18} />
            </button>
          </div>
        </header>

        {notice && (
          <div className="notice" role="status">
            <CircleAlert size={17} />
            <span>{notice}</span>
            <button aria-label="Dismiss" onClick={() => setNotice(null)}><X size={16} /></button>
          </div>
        )}

        {view === "inbox" && (
          <InboxView
            state={state}
            selected={selected}
            detail={selected ? messageDetails[selected.id] || null : null}
            detailLoading={selected ? detailLoading === selected.id : false}
            onSelect={setSelectedId}
            onContext={(item) => void prepareDraft(item, "", "", true)}
            onDraft={(item) => void prepareDraft(item)}
            onManualReply={startManualReply}
            onMarkRead={(messageId) =>
              void act(
                { action: "mark_read", messageId },
                `mark-read:${messageId}`,
                "Marked read and cleared from Priority.",
              )
            }
            onClear={(messageId) =>
              void act(
                { action: "clear_message", messageId },
                `clear:${messageId}`,
                "Cleared from Priority without changing future handling.",
              )
            }
            onFeedback={(messageId, value) =>
              void act(
                { action: "feedback", messageId, value },
                `feedback:${messageId}`,
                value === "suppress"
                  ? "Moved out of Priority and learned as lower priority."
                  : "This sender will now be treated as priority.",
              )
            }
            onSnooze={(messageId) =>
              void act(
                { action: "snooze", messageId, minutes: 60 },
                `snooze:${messageId}`,
                "Snoozed for one hour.",
              )
            }
            onStartBacklog={() =>
              void act({ action: "start_backlog" }, "start-backlog", "Backlog review started.")
            }
            onPauseBacklog={() =>
              void act({ action: "pause_backlog" }, "pause-backlog", "Backlog review paused.")
            }
            busy={busy}
          />
        )}

        {view === "mailbox" && (
          <MailboxView
            state={state}
            selected={selected}
            detail={selected ? messageDetails[selected.id] || null : null}
            detailLoading={selected ? detailLoading === selected.id : false}
            onSelect={setSelectedId}
            onDraft={(item) => void prepareDraft(item)}
            onManualReply={startManualReply}
            onContext={(item) => void prepareDraft(item, "", "", true)}
            onMarkRead={(messageId) =>
              void act(
                { action: "mark_read", messageId },
                `mark-read:${messageId}`,
                "Marked read in Gmail.",
              )
            }
            busy={busy}
          />
        )}

        {view === "accounts" && (
          <AccountsView
            state={state}
            busy={busy}
            onConnectGmail={(email, access) =>
              void act(
                { action: "connect_gmail", email, access },
                "connect-gmail",
                "Google sign-in opened. Finish the browser prompt, then refresh accounts.",
              )
            }
            onConnectMicrosoft={async (email, access) => {
              const result = await act(
                { action: "connect_microsoft", email, access },
                "connect-microsoft",
                "Microsoft sign-in code created. Finish the browser prompt, then check the connection.",
              );
              return result ? (result as MicrosoftAuthChallenge) : null;
            }}
            onCompleteMicrosoft={async (connectionId) => {
              const result = await act(
                { action: "complete_microsoft_auth", connectionId },
                `complete-microsoft:${connectionId}`,
              );
              if (!result) return null;
              const completion = result as {
                status: "pending" | "connected";
                message?: string;
                email?: string;
              };
              if (completion.status === "pending") {
                setNotice(completion.message || "Microsoft sign-in is still waiting.");
              } else {
                setNotice(
                  completion.email
                    ? `Microsoft mailbox connected: ${completion.email}.`
                    : "Microsoft mailbox connected.",
                );
              }
              return completion;
            }}
            onSyncAccounts={() =>
              void act(
                { action: "sync_accounts" },
                "sync-accounts",
                "Authorized Gmail accounts refreshed.",
              )
            }
            onPoll={() => void act({ action: "poll" }, "poll", "Gmail check complete.")}
          />
        )}

        {view === "digests" && (
          <DigestsView
            state={state}
            busy={busy}
            onSendNow={() =>
              void act(
                { action: "send_digest_now" },
                "send-digest",
                "Digest run recorded. Telegram delivery status is in the digest history.",
              )
            }
            onOpenEmail={openMessageModal}
            onDraft={(item) => void prepareDraft(item)}
          />
        )}

        {view === "replies" && (
          <RepliesView
            drafts={state.drafts}
            busy={busy}
            onEdit={(draft) => {
              setEditingDraft(draft);
              setDraftText(draft.content);
            }}
            onRequest={(draft) =>
              void act(
                { action: "request_send", draftId: draft.id },
                `request:${draft.id}`,
                "Draft locked for exact send confirmation.",
              )
            }
            onApprove={setConfirmDraft}
            onCancel={(draft) =>
              void act(
                { action: "cancel_draft", draftId: draft.id },
                `cancel:${draft.id}`,
                "Draft cancelled.",
              )
            }
            onOpenEmail={openMessageModal}
          />
        )}

        {view === "maintenance" && (
          <MaintenanceView
            state={state}
            busy={busy}
            onAction={(groups, action) => setMaintenanceConfirm({ groups, action })}
            onOpenEmail={(group) => openMessageModal(group.latestMessageId)}
          />
        )}

        {view === "learning" && (
          <LearningView
            state={state}
            onForget={(preferenceId) =>
              void act(
                { action: "forget_preference", preferenceId },
                `forget:${preferenceId}`,
                "Learned preference forgotten.",
              )
            }
          />
        )}

        {view === "models" && (
          <ModelsViewV2
            state={state}
            busy={busy}
            onSwitch={(model) =>
              void act(
                { action: "switch_model", model },
                `model:${model}`,
                `${model.replace("-maxctx", "")} is now active.`,
              )
            }
            onBenchmark={() =>
              void act(
                { action: "start_model_benchmark" },
                "model-benchmark",
                "Model comparison started. Results will appear as each model finishes.",
              )
            }
            onUpdateModel={(model) =>
              void act(
                { action: "update_model", model },
                `update-model:${model}`,
                `${model.replace("-maxctx", "")} is updating in the background.`,
              )
            }
          />
        )}

        {view === "settings" && (
          <SettingsView
            state={state}
            busy={busy}
            onPoll={() => void act({ action: "poll" }, "poll", "Gmail check complete.")}
            onSyncAccounts={() =>
              void act(
                { action: "sync_accounts" },
                "sync-accounts",
                "Authorized Gmail accounts refreshed.",
              )
            }
            onDemo={() => void act({ action: "seed_demo" }, "demo", "Safe demo messages loaded.")}
            onCheckUpdates={() =>
              void act(
                { action: "check_updates" },
                "check-updates",
                "Software and model status refreshed.",
              )
            }
          />
        )}
      </main>

      {detailModalId && (
        <MessageDetailModal
          detail={messageDetails[detailModalId] || null}
          loading={detailLoading === detailModalId}
          onClose={() => setDetailModalId(null)}
        />
      )}

      {draftComposer && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal wide draft-composer-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="composer-title"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">AI-assisted reply</p>
                <h2 id="composer-title">{draftComposer.item.subject}</h2>
                <span className="composer-recipient">
                  To {draftComposer.item.senderName} &lt;{draftComposer.item.senderEmail}&gt;
                </span>
              </div>
              <button className="icon-button" aria-label="Close" onClick={() => setDraftComposer(null)}>
                <X size={18} />
              </button>
            </div>
            {draftComposer.memorySummary && (
              <div className="composer-memory">
                <History size={17} />
                <span>{draftComposer.memorySummary}</span>
              </div>
            )}
            <div className="composer-context-grid">
              <div>
                <span>Original email</span>
                <p>{draftComposer.item.summary || draftComposer.item.snippet || "No summary available."}</p>
              </div>
              <div>
                <span>Suggested move</span>
                <p>{draftComposer.item.recommendation || "Review and respond only if needed."}</p>
              </div>
            </div>
            {!draftComposer.item.needsReply && (
              <div className="composer-caution">
                <CircleAlert size={17} />
                <span>
                  Ezra did not identify a reply as necessary. Review the recipient and purpose
                  carefully before saving.
                </span>
              </div>
            )}
            <label htmlFor="draft-content">
              {draftComposer.manualFirst ? "Your reply draft" : "Ezra's draft"}
            </label>
            <div className="draft-composer-editor">
              {draftComposer.loading && (
                <div className="draft-generating" role="status">
                  <LoaderCircle className="spin" size={20} />
                  <span>
                    {draftComposer.content
                      ? "Ezra is revising the draft"
                      : "Ezra is reading the email and contact memory. Local drafting can take up to a minute."}
                  </span>
                </div>
              )}
              <textarea
                id="draft-content"
                className="draft-editor"
                rows={12}
                value={draftComposer.content}
                disabled={draftComposer.loading && !draftComposer.content}
                onChange={(event) =>
                  setDraftComposer((current) =>
                    current ? { ...current, content: event.target.value } : current,
                  )
                }
                placeholder={
                  draftComposer.manualFirst
                    ? "Type your reply here first. Ezra can polish it when you are ready."
                    : "Ezra's suggested reply will appear here."
                }
                aria-label={draftComposer.manualFirst ? "Your reply draft" : "Ezra's draft"}
              />
            </div>
            <label htmlFor="draft-instruction">Tell Ezra what to add or change</label>
            <textarea
              ref={draftInstructionRef}
              id="draft-instruction"
              rows={4}
              value={draftComposer.instruction}
              onChange={(event) =>
                setDraftComposer((current) =>
                  current ? { ...current, instruction: event.target.value } : current,
                )
              }
              placeholder="For example: keep it warm, confirm Friday afternoon, and do not promise a final delivery date."
            />
            {draftComposer.error && (
              <div className="composer-error" role="alert">
                <CircleAlert size={17} />
                <span>{draftComposer.error}</span>
              </div>
            )}
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setDraftComposer(null)}>
                Cancel
              </button>
              <button
                className="secondary-button"
                disabled={draftComposer.loading}
                onClick={() =>
                  void prepareDraft(
                    draftComposer.item,
                    draftComposer.instruction,
                    draftComposer.content,
                    true,
                  )
                }
              >
                <RefreshCcw className={draftComposer.loading ? "spin" : ""} size={17} />
                Revise with Ezra
              </button>
              <button
                className="primary-button"
                disabled={
                  draftComposer.loading ||
                  !draftComposer.content.trim() ||
                  busy === `save-draft:${draftComposer.item.id}`
                }
                onClick={async () => {
                  const ok = await act(
                    {
                      action: "save_draft",
                      messageId: draftComposer.item.id,
                      content: draftComposer.content,
                      context: draftComposer.instruction,
                    },
                    `save-draft:${draftComposer.item.id}`,
                    "Draft saved to the reply queue.",
                  );
                  if (ok) {
                    setDraftComposer(null);
                    setView("replies");
                  }
                }}
              >
                <Check size={17} />
                Save to reply queue
              </button>
            </div>
          </section>
        </div>
      )}

      {editingDraft && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal wide" role="dialog" aria-modal="true" aria-labelledby="edit-title">
            <div className="modal-header">
              <div>
                <p className="eyebrow">Version {editingDraft.version}</p>
                <h2 id="edit-title">{editingDraft.subject}</h2>
              </div>
              <button className="icon-button" aria-label="Close" onClick={() => setEditingDraft(null)}>
                <X size={18} />
              </button>
            </div>
            <textarea
              className="draft-editor"
              rows={14}
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
            />
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setEditingDraft(null)}>Cancel</button>
              <button
                className="primary-button"
                onClick={async () => {
                  const ok = await act(
                    { action: "update_draft", draftId: editingDraft.id, content: draftText },
                    `edit:${editingDraft.id}`,
                    "New draft version saved. Send approval must be requested again.",
                  );
                  if (ok) setEditingDraft(null);
                }}
              >
                <Check size={17} />
                Save new version
              </button>
            </div>
          </section>
        </div>
      )}

      {confirmDraft && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="send-title">
            <div className="confirm-icon"><Send size={22} /></div>
            <h2 id="send-title">Send this exact draft?</h2>
            <p>
              This will reply to <strong>{confirmDraft.senderEmail}</strong>. Ezra cannot undo a
              sent email.
            </p>
            <pre className="confirm-preview">{confirmDraft.content}</pre>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setConfirmDraft(null)}>Cancel</button>
              <button
                className="danger-button"
                onClick={async () => {
                  const ok = await act(
                    { action: "approve_send", draftId: confirmDraft.id },
                    `send:${confirmDraft.id}`,
                    "Email sent.",
                  );
                  if (ok) setConfirmDraft(null);
                }}
              >
                <Send size={17} />
                Send email
              </button>
            </div>
          </section>
        </div>
      )}

      {maintenanceConfirm && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="maintenance-title"
          >
            <div className="confirm-icon">
              {maintenanceConfirm.action === "spam" ? <Ban size={22} /> : <MailCheck size={22} />}
            </div>
            <h2 id="maintenance-title">
              {maintenanceActionTitle(maintenanceConfirm.action)}
            </h2>
            <p>
              Apply this to <strong>{sumMaintenanceMessages(maintenanceConfirm.groups)}</strong>{" "}
              unread message{sumMaintenanceMessages(maintenanceConfirm.groups) === 1 ? "" : "s"} from{" "}
              <strong>{maintenanceConfirm.groups.length}</strong> sender
              {maintenanceConfirm.groups.length === 1 ? "" : "s"}?
            </p>
            {maintenanceConfirm.groups.length === 1 && (
              <p>
                Sender: <strong>{maintenanceConfirm.groups[0].senderEmail}</strong>
              </p>
            )}
            <p className="maintenance-explanation">
              {maintenanceActionExplanation(maintenanceConfirm.action)}
            </p>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setMaintenanceConfirm(null)}>
                Cancel
              </button>
              <button
                className={maintenanceConfirm.action === "spam" ? "danger-button" : "primary-button"}
                disabled={busy === "maintenance:batch"}
                onClick={async () => {
                  const current = maintenanceConfirm;
                  setMaintenanceConfirm(null);
                  const result = (await act(
                    {
                      action: "apply_maintenance_batch",
                      targets: current.groups.map((group) => ({
                        accountId: group.accountId,
                        senderEmail: group.senderEmail,
                      })),
                      maintenanceAction: current.action,
                      remember: true,
                    },
                    "maintenance:batch",
                  )) as
                    | {
                        successCount: number;
                        failureCount: number;
                        messageCount: number;
                      }
                    | false;
                  if (result) {
                    setNotice(
                      `${maintenanceActionPastTense(current.action)} ${result.messageCount} message${
                        result.messageCount === 1 ? "" : "s"
                      } across ${result.successCount} sender${
                        result.successCount === 1 ? "" : "s"
                      }${result.failureCount ? `; ${result.failureCount} failed.` : "."}`,
                    );
                  }
                }}
              >
                {maintenanceConfirm.action === "spam" ? <Ban size={17} /> : <Check size={17} />}
                Confirm
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function InboxView({
  state,
  selected,
  detail,
  detailLoading,
  onSelect,
  onContext,
  onDraft,
  onManualReply,
  onMarkRead,
  onClear,
  onFeedback,
  onSnooze,
  onStartBacklog,
  onPauseBacklog,
  busy,
}: {
  state: DashboardState;
  selected: InboxItem | null;
  detail: MessageDetail | null;
  detailLoading: boolean;
  onSelect: (id: string) => void;
  onContext: (item: InboxItem) => void;
  onDraft: (item: InboxItem) => void;
  onManualReply: (item: InboxItem) => void;
  onMarkRead: (id: string) => void;
  onClear: (id: string) => void;
  onFeedback: (id: string, value: "interrupt" | "suppress") => void;
  onSnooze: (id: string) => void;
  onStartBacklog: () => void;
  onPauseBacklog: () => void;
  busy: string | null;
}) {
  const [mode, setMode] = useState<InboxMode>("priority");
  const detailPaneRef = useRef<HTMLDivElement>(null);
  const orderedItems = useMemo(
    () => [...state.inbox].sort(compareInboxItems),
    [state.inbox],
  );
  const visibleItems = useMemo(
    () =>
      mode === "priority"
        ? orderedItems.filter((item) => item.attention === "interrupt")
        : mode === "digest"
          ? orderedItems.filter((item) => item.attention === "digest")
          : orderedItems,
    [mode, orderedItems],
  );
  const displayedSelected =
    visibleItems.find((item) => item.id === selected?.id) || visibleItems[0] || null;

  useEffect(() => {
    if (displayedSelected && displayedSelected.id !== selected?.id) {
      onSelect(displayedSelected.id);
    }
  }, [displayedSelected, onSelect, selected?.id]);

  const openInlineDetail = (messageId: string) => {
    onSelect(messageId);
    if (window.matchMedia("(max-width: 780px)").matches) {
      window.setTimeout(
        () => detailPaneRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
        0,
      );
    }
  };

  return (
    <>
      <section className="metrics-strip">
        <Metric label="Needs attention" value={state.counts.interrupt} tone="red" icon={BellRing} />
        <Metric label="Next digest" value={state.counts.digest} tone="amber" icon={Clock3} />
        <Metric label="Quietly handled" value={state.counts.suppress} tone="green" icon={ShieldCheck} />
        <Metric label="Awaiting send" value={state.counts.awaitingApproval} tone="blue" icon={Send} />
      </section>

      <section className="inbox-layout">
        <div className="message-list">
          <div className="section-heading">
            <div>
              <h2>{inboxModeTitle(mode)}</h2>
              <span>{inboxModeCount(state, mode)} messages</span>
            </div>
            <div className="queue-modes" role="group" aria-label="Inbox view">
              {(["priority", "digest", "all"] as InboxMode[]).map((item) => (
                <button
                  key={item}
                  className={mode === item ? "active" : ""}
                  aria-pressed={mode === item}
                  onClick={() => setMode(item)}
                >
                  {inboxModeLabel(item)}
                </button>
              ))}
            </div>
          </div>
          {visibleItems.length === 0 ? (
            <EmptyState
              icon={mode === "priority" ? ShieldCheck : Inbox}
              title={mode === "priority" ? "Nothing needs attention" : "No messages in this view"}
              body={
                mode === "priority"
                  ? "Ezra has not found anything that currently requires your attention."
                  : "Choose another view to see the rest of Ezra's decisions."
              }
            />
          ) : (
            visibleItems.map((item) => (
              <button
                key={item.id}
                className={displayedSelected?.id === item.id ? "message-row selected" : "message-row"}
                onClick={() => openInlineDetail(item.id)}
              >
                <span className={`priority-bar ${item.attention || "pending"}`} />
                <span className="message-copy">
                  <span className="message-topline">
                    <strong>{item.senderName}</strong>
                    <span className="message-signals">
                      {item.deadline && <b>{formatDeadline(item.deadline)}</b>}
                      {item.attention === "interrupt" && item.urgency !== null && (
                        <i aria-label={`Priority score ${item.urgency}`}>{item.urgency}</i>
                      )}
                      <time>{formatRelative(item.receivedAt)}</time>
                    </span>
                  </span>
                  <b>{item.subject}</b>
                  <span>{item.summary || item.snippet || "Awaiting analysis"}</span>
                  <span className="mailbox-chip-row">
                    <AccountChip accountId={item.accountId} label={item.accountLabel} />
                  </span>
                </span>
                <ChevronRight size={17} />
              </button>
            ))
          )}
        </div>

        <div className="detail-pane" ref={detailPaneRef}>
          {!displayedSelected ? (
            <EmptyState icon={Mail} title="Select a message" body="Ezra's decision will appear here." />
          ) : (
            <MessageDetailContent
              item={displayedSelected}
              detail={detail?.message.id === displayedSelected.id ? detail : null}
              loading={detailLoading}
              actions={
                <div className="action-bar">
                <button className="primary-button" onClick={() => onDraft(displayedSelected)}>
                  <Reply size={17} />
                  Draft reply
                </button>
                <button className="secondary-button" onClick={() => onManualReply(displayedSelected)}>
                  <PencilLine size={17} />
                  Write reply
                </button>
                <button className="secondary-button" onClick={() => onContext(displayedSelected)}>
                  <MessageSquareText size={17} />
                  Add context
                </button>
                <button
                  className="secondary-button"
                  disabled={busy === `mark-read:${displayedSelected.id}`}
                  onClick={() => onMarkRead(displayedSelected.id)}
                >
                  <MailCheck size={17} />
                  Mark read
                </button>
                <button
                  className="secondary-button"
                  disabled={busy === `clear:${displayedSelected.id}`}
                  onClick={() => onClear(displayedSelected.id)}
                >
                  <Check size={17} />
                  Clear
                </button>
                <button
                  className="icon-button"
                  title="Not important"
                  aria-label="Not important"
                  disabled={busy === `feedback:${displayedSelected.id}`}
                  onClick={() => onFeedback(displayedSelected.id, "suppress")}
                >
                  <Trash2 size={17} />
                </button>
                <button
                  className="icon-button"
                  title="Always alert for this sender"
                  aria-label="Always alert for this sender"
                  disabled={busy === `feedback:${displayedSelected.id}`}
                  onClick={() => onFeedback(displayedSelected.id, "interrupt")}
                >
                  <BellRing size={17} />
                </button>
                <button
                  className="icon-button"
                  title="Snooze one hour"
                  aria-label="Snooze one hour"
                  disabled={busy === `snooze:${displayedSelected.id}`}
                  onClick={() => onSnooze(displayedSelected.id)}
                >
                  <Clock3 size={17} />
                </button>
                </div>
              }
            />
          )}
        </div>
      </section>

      <section className="backlog-band">
        <div className="backlog-heading">
          <span className="backlog-icon"><ListChecks size={19} /></span>
          <div>
            <p className="eyebrow">Mailbox coverage</p>
            <h2>Unread backlog review</h2>
            <span>{backlogStatusLine(state)}</span>
          </div>
        </div>
        <div className="backlog-stats">
          <span><b>{state.backlog.discovered}</b><small>Discovered</small></span>
          <span><b>{state.backlog.ruleHandled}</b><small>Rules handled</small></span>
          <span><b>{state.backlog.modelHandled}</b><small>Model reviewed</small></span>
          <span><b>{state.backlog.queued}</b><small>Queued</small></span>
        </div>
        {state.backlog.status === "running" ? (
          <button
            className="secondary-button"
            disabled={busy === "pause-backlog"}
            onClick={onPauseBacklog}
          >
            <Pause size={17} />
            Pause review
          </button>
        ) : (
          <button
            className="primary-button"
            disabled={busy === "start-backlog"}
            onClick={onStartBacklog}
          >
            <Play size={17} />
            {state.backlog.status === "paused" ? "Resume review" : "Start review"}
          </button>
        )}
      </section>
    </>
  );
}

type MailboxMode = "all" | "unread" | "inbox" | "spam" | "sent";

function MailboxView({
  state,
  selected,
  detail,
  detailLoading,
  onSelect,
  onDraft,
  onManualReply,
  onContext,
  onMarkRead,
  busy,
}: {
  state: DashboardState;
  selected: InboxItem | null;
  detail: MessageDetail | null;
  detailLoading: boolean;
  onSelect: (id: string) => void;
  onDraft: (item: InboxItem) => void;
  onManualReply: (item: InboxItem) => void;
  onContext: (item: InboxItem) => void;
  onMarkRead: (id: string) => void;
  busy: string | null;
}) {
  const [mode, setMode] = useState<MailboxMode>("all");
  const detailPaneRef = useRef<HTMLDivElement>(null);
  const visibleItems = useMemo(
    () => state.mailbox.filter((item) => mailboxModeIncludes(item, mode)),
    [mode, state.mailbox],
  );
  const displayedSelected =
    visibleItems.find((item) => item.id === selected?.id) || visibleItems[0] || null;

  useEffect(() => {
    if (displayedSelected && displayedSelected.id !== selected?.id) {
      onSelect(displayedSelected.id);
    }
  }, [displayedSelected, onSelect, selected?.id]);

  const openInlineDetail = (messageId: string) => {
    onSelect(messageId);
    if (window.matchMedia("(max-width: 780px)").matches) {
      window.setTimeout(
        () => detailPaneRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
        0,
      );
    }
  };

  return (
    <section className="inbox-layout mailbox-layout">
      <div className="message-list">
        <div className="section-heading">
          <div>
            <h2>Recent mail</h2>
            <span>{visibleItems.length} messages from connected Gmail accounts</span>
          </div>
          <div className="queue-modes mailbox-modes" role="group" aria-label="Mailbox view">
            {(["all", "unread", "inbox", "spam", "sent"] as MailboxMode[]).map((item) => (
              <button
                key={item}
                className={mode === item ? "active" : ""}
                aria-pressed={mode === item}
                onClick={() => setMode(item)}
              >
                {mailboxModeLabel(item)}
              </button>
            ))}
          </div>
        </div>
        {visibleItems.length === 0 ? (
          <EmptyState
            icon={MailOpen}
            title="No mail in this slice"
            body="Choose another mailbox view or run a Gmail poll from Settings."
          />
        ) : (
          visibleItems.map((item) => (
            <button
              key={item.id}
              className={displayedSelected?.id === item.id ? "message-row selected" : "message-row"}
              onClick={() => openInlineDetail(item.id)}
            >
              <span className={`priority-bar ${item.attention || "pending"}`} />
              <span className="message-copy">
                <span className="message-topline">
                  <strong>
                    {item.isUnread && <i className="unread-dot" aria-label="Unread" />}
                    {item.senderName}
                  </strong>
                  <span className="message-signals">
                    <b>{primaryMailboxLabel(item)}</b>
                    <time>{formatRelative(item.receivedAt)}</time>
                  </span>
                </span>
                <b>{item.subject}</b>
                <span>{item.summary || item.snippet || "Awaiting analysis"}</span>
                <span className="mailbox-chip-row">
                  <AccountChip accountId={item.accountId} label={item.accountLabel} />
                  {displayMailboxLabels(item).map((label) => (
                    <small key={label}>{label}</small>
                  ))}
                  {item.status !== "triaged" && <small>{humanize(item.status)}</small>}
                </span>
              </span>
              <ChevronRight size={17} />
            </button>
          ))
        )}
      </div>

      <div className="detail-pane" ref={detailPaneRef}>
        {!displayedSelected ? (
          <EmptyState icon={Mail} title="Select a message" body="The email and Ezra's read will appear here." />
        ) : (
          <MessageDetailContent
            item={displayedSelected}
            detail={detail?.message.id === displayedSelected.id ? detail : null}
            loading={detailLoading}
            actions={
              <div className="action-bar">
                <button className="primary-button" onClick={() => onDraft(displayedSelected)}>
                  <Reply size={17} />
                  Draft reply
                </button>
                <button className="secondary-button" onClick={() => onManualReply(displayedSelected)}>
                  <PencilLine size={17} />
                  Write reply
                </button>
                <button className="secondary-button" onClick={() => onContext(displayedSelected)}>
                  <MessageSquareText size={17} />
                  Add context
                </button>
                <button
                  className="secondary-button"
                  disabled={!displayedSelected.isUnread || busy === `mark-read:${displayedSelected.id}`}
                  onClick={() => onMarkRead(displayedSelected.id)}
                >
                  <MailCheck size={17} />
                  Mark read
                </button>
              </div>
            }
          />
        )}
      </div>
    </section>
  );
}

function AccountsView({
  state,
  busy,
  onConnectGmail,
  onConnectMicrosoft,
  onCompleteMicrosoft,
  onSyncAccounts,
  onPoll,
}: {
  state: DashboardState;
  busy: string | null;
  onConnectGmail: (email: string, access: GmailAccessMode) => void;
  onConnectMicrosoft: (
    email: string,
    access: GmailAccessMode,
  ) => Promise<MicrosoftAuthChallenge | null>;
  onCompleteMicrosoft: (
    connectionId: string,
  ) => Promise<{ status: "pending" | "connected"; message?: string; email?: string } | null>;
  onSyncAccounts: () => void;
  onPoll: () => void;
}) {
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<GmailAccessMode>("readonly");
  const [microsoftEmail, setMicrosoftEmail] = useState("");
  const [microsoftAccess, setMicrosoftAccess] = useState<GmailAccessMode>("readonly");
  const [microsoftChallenge, setMicrosoftChallenge] = useState<MicrosoftAuthChallenge | null>(null);
  const [checkingMicrosoft, setCheckingMicrosoft] = useState(false);
  const canConnect = Boolean(email.trim()) && busy !== "connect-gmail" && state.health.gogInstalled;
  const canConnectMicrosoft = Boolean(microsoftEmail.trim()) && busy !== "connect-microsoft";

  async function checkMicrosoftConnection() {
    if (!microsoftChallenge) return;
    setCheckingMicrosoft(true);
    try {
      const result = await onCompleteMicrosoft(microsoftChallenge.connectionId);
      if (result?.status === "connected") setMicrosoftChallenge(null);
    } finally {
      setCheckingMicrosoft(false);
    }
  }

  return (
    <section className="accounts-layout">
      <div className="content-section connect-panel">
        <div className="section-heading large">
          <div>
            <h2>Connect mail accounts</h2>
            <span>Provider sign-in stays in the browser. Ezra stores no mailbox passwords.</span>
          </div>
        </div>
        {!state.health.gogInstalled && (
          <div className="permission-banner">
            <CircleAlert size={18} />
            <span>
              <strong>Gmail bridge needed</strong>
              <span>Install gog or configure GOG_PATH before connecting mail accounts.</span>
            </span>
          </div>
        )}
        <div className="provider-connect-list">
          <form
            className="connect-form provider-connect-card"
            onSubmit={(event) => {
              event.preventDefault();
              if (canConnect) onConnectGmail(email.trim(), access);
            }}
          >
            <h3>Gmail</h3>
            <label htmlFor="gmail-account-email">Gmail address</label>
            <div className="connect-row">
              <input
                id="gmail-account-email"
                type="email"
                value={email}
                placeholder="user@example.com"
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
              />
              <button className="primary-button" disabled={!canConnect} type="submit">
                <UserPlus size={17} />
                Connect Gmail
              </button>
            </div>
            <div className="permission-grid" role="group" aria-label="Gmail permission level">
              <button
                type="button"
                className={access === "readonly" ? "permission-option active" : "permission-option"}
                onClick={() => setAccess("readonly")}
              >
                <MailOpen size={18} />
                <span><b>Read only</b><small>Triage, summaries, digests</small></span>
              </button>
              <button
                type="button"
                className={access === "maintenance" ? "permission-option active" : "permission-option"}
                onClick={() => setAccess("maintenance")}
              >
                <MailCheck size={18} />
                <span><b>Maintenance</b><small>Mark read, spam, unsubscribe</small></span>
              </button>
            </div>
          </form>

          <form
            className="connect-form provider-connect-card"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!canConnectMicrosoft) return;
              const challenge = await onConnectMicrosoft(
                microsoftEmail.trim(),
                microsoftAccess,
              );
              if (challenge) setMicrosoftChallenge(challenge);
            }}
          >
            <h3>Hotmail / Outlook</h3>
            <label htmlFor="microsoft-account-email">Microsoft email address</label>
            <div className="connect-row">
              <input
                id="microsoft-account-email"
                type="email"
                value={microsoftEmail}
                placeholder="outlook-user@example.com"
                autoComplete="email"
                onChange={(event) => setMicrosoftEmail(event.target.value)}
              />
              <button
                className="primary-button"
                disabled={!canConnectMicrosoft}
                type="submit"
              >
                <UserPlus size={17} />
                Connect Microsoft
              </button>
            </div>
            <div className="permission-grid" role="group" aria-label="Microsoft permission level">
              <button
                type="button"
                className={
                  microsoftAccess === "readonly" ? "permission-option active" : "permission-option"
                }
                onClick={() => setMicrosoftAccess("readonly")}
              >
                <MailOpen size={18} />
                <span><b>Read only</b><small>Triage, summaries, digests</small></span>
              </button>
              <button
                type="button"
                className={
                  microsoftAccess === "maintenance"
                    ? "permission-option active"
                    : "permission-option"
                }
                onClick={() => setMicrosoftAccess("maintenance")}
              >
                <MailCheck size={18} />
                <span><b>Maintenance</b><small>Future mail cleanup actions</small></span>
              </button>
            </div>
            {microsoftChallenge && (
              <div className="microsoft-challenge">
                <span>Microsoft code</span>
                <strong>{microsoftChallenge.userCode}</strong>
                <small>
                  Expires {formatDigestTime(microsoftChallenge.expiresAt)}. Sign in, then check
                  the connection here.
                </small>
                <div className="challenge-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      window.open(
                        microsoftChallenge.verificationUriComplete ||
                          microsoftChallenge.verificationUri,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    <ExternalLink size={16} />
                    Open Microsoft sign-in
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={checkingMicrosoft}
                    onClick={() => void checkMicrosoftConnection()}
                  >
                    <RefreshCcw className={checkingMicrosoft ? "spin" : ""} size={16} />
                    Check connection
                  </button>
                </div>
              </div>
            )}
          </form>
        </div>
        <div className="account-note">
          <ShieldCheck size={17} />
          <span>Send access remains separate and every outbound email still needs exact draft approval.</span>
        </div>
      </div>

      <div className="content-section">
        <div className="section-heading large">
          <div>
            <h2>Connected mailboxes</h2>
            <span>{state.accounts.length} mail account{state.accounts.length === 1 ? "" : "s"}</span>
          </div>
          <div className="account-toolbar">
            <button
              className="secondary-button"
              disabled={busy === "sync-accounts"}
              onClick={onSyncAccounts}
            >
              <RefreshCcw className={busy === "sync-accounts" ? "spin" : ""} size={17} />
              Refresh accounts
            </button>
            <button className="secondary-button" disabled={busy === "poll"} onClick={onPoll}>
              <RefreshCcw className={busy === "poll" ? "spin" : ""} size={17} />
              Poll now
            </button>
          </div>
        </div>
        <div className="account-service-strip">
          <span><b>Gmail bridge</b>{state.health.gogInstalled ? "Ready" : "Missing"}</span>
          <span><b>Microsoft</b>Browser sign-in</span>
          <span>
            <b>Permission</b>
            {state.health.gmailModifyAuthorized ? "Maintenance enabled" : "Read only"}
          </span>
        </div>
        {state.accounts.length === 0 ? (
          <EmptyState
            icon={Mail}
            title="No mailboxes connected"
            body="Connect Gmail, finish Google's prompt, then refresh accounts."
          />
        ) : (
          <div className="account-lanes account-lanes-large">
            {state.accounts.map((account) => <AccountCard account={account} key={account.id} />)}
          </div>
        )}
      </div>
    </section>
  );
}

function DigestsView({
  state,
  busy,
  onSendNow,
  onOpenEmail,
  onDraft,
}: {
  state: DashboardState;
  busy: string | null;
  onSendNow: () => void;
  onOpenEmail: (messageId: string) => void;
  onDraft: (item: InboxItem) => void;
}) {
  const upcoming = state.digests.upcoming[0];
  return (
    <section className="digest-layout">
      <div className="content-section digest-preview-panel">
        <div className="section-heading large">
          <div>
            <h2>Next digest</h2>
            <span>
              {upcoming
                ? `${upcoming.label} / ${formatDigestTime(upcoming.scheduledFor)}`
                : "Digest schedule is not configured."}
            </span>
          </div>
          <button
            className="primary-button"
            disabled={busy === "send-digest"}
            onClick={onSendNow}
          >
            <Send size={17} />
            Send now
          </button>
        </div>
        {!upcoming || upcoming.items.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="Nothing queued for digest"
            body="Messages Ezra classifies as useful but not urgent will collect here before Telegram delivery."
          />
        ) : (
          <div className="digest-item-list">
            {upcoming.items.map((item, index) => (
              <DigestMessageRow
                key={item.id}
                item={item}
                index={index}
                onOpenEmail={onOpenEmail}
                onDraft={onDraft}
              />
            ))}
          </div>
        )}
      </div>

      <div className="content-section">
        <div className="section-heading large">
          <div>
            <h2>Digest history</h2>
            <span>Telegram delivery and skipped runs are recorded here.</span>
          </div>
        </div>
        {state.digests.history.length === 0 ? (
          <EmptyState
            icon={History}
            title="No digests recorded yet"
            body="Scheduled or manual digest runs will appear here with their included messages."
          />
        ) : (
          <div className="digest-history-list">
            {state.digests.history.map((digest) => (
              <article className="digest-card" key={digest.id}>
                <div className="digest-card-header">
                  <div>
                    <span className={`digest-status ${digest.status}`}>{digest.status}</span>
                    <h3>{digest.label}</h3>
                    <small>
                      {formatDigestTime(digest.sentAt || digest.scheduledFor || digest.createdAt)}
                      {" / "}
                      {digest.itemCount} message{digest.itemCount === 1 ? "" : "s"}
                    </small>
                  </div>
                  <span className="digest-channel">Telegram</span>
                </div>
                {digest.error && <p className="digest-error">{digest.error}</p>}
                {digest.items.length > 0 && (
                  <div className="digest-item-list compact">
                    {digest.items.slice(0, 8).map((item, index) => (
                      <DigestMessageRow
                        key={`${digest.id}:${item.id}`}
                        item={item}
                        index={index}
                        onOpenEmail={onOpenEmail}
                        onDraft={onDraft}
                      />
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function DigestMessageRow({
  item,
  index,
  onOpenEmail,
  onDraft,
}: {
  item: InboxItem;
  index: number;
  onOpenEmail: (messageId: string) => void;
  onDraft: (item: InboxItem) => void;
}) {
  return (
    <article className="digest-message-row">
      <span className="digest-number">{index + 1}</span>
      <button
        className="digest-message-main"
        onClick={() => onOpenEmail(item.id)}
        aria-label={`Open digest email: ${item.subject}`}
      >
        <strong>{item.subject}</strong>
        <span>
          {item.senderName} / {item.summary || item.snippet || "No summary available."}
        </span>
        <AccountChip accountId={item.accountId} label={item.accountLabel} />
      </button>
      <button className="secondary-button" onClick={() => onDraft(item)}>
        <Reply size={16} />
        Draft
      </button>
    </article>
  );
}

function MaintenanceView({
  state,
  busy,
  onAction,
  onOpenEmail,
}: {
  state: DashboardState;
  busy: string | null;
  onAction: (groups: MaintenanceGroup[], action: MaintenanceAction) => void;
  onOpenEmail: (group: MaintenanceGroup) => void;
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const selectedGroups = useMemo(
    () => state.maintenance.filter((group) => selectedKeys.has(maintenanceKey(group))),
    [selectedKeys, state.maintenance],
  );
  useEffect(() => {
    setSelectedKeys((current) => {
      if (current.size === 0) return current;
      const visibleKeys = new Set(state.maintenance.map(maintenanceKey));
      const next = new Set([...current].filter((key) => visibleKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [state.maintenance]);
  const allVisibleSelected =
    state.maintenance.length > 0 &&
    state.maintenance.every((group) => selectedKeys.has(maintenanceKey(group)));

  const toggleGroup = (group: MaintenanceGroup) => {
    const key = maintenanceKey(group);
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedKeys((current) => {
      if (state.maintenance.every((group) => current.has(maintenanceKey(group)))) return new Set();
      return new Set(state.maintenance.map(maintenanceKey));
    });
  };

  return (
    <section className="content-section">
      <div className="section-heading large">
        <div>
          <h2>Unread maintenance queue</h2>
          <span>
            Low-priority unread mail grouped by sender. Approved rules update Gmail on every
            device.
          </span>
          {state.maintenance.length < state.counts.maintenance && (
            <span>
              Showing {state.maintenance.length} of {state.counts.maintenance} sender groups.
            </span>
          )}
          {state.backlog.status === "running" && (
            <span>
              Gmail backfill is still reviewing older mail: {state.backlog.discovered} found,
              {` ${state.backlog.modelHandled + state.backlog.ruleHandled} reviewed, `}
              {state.backlog.queued} queued. This list can change while it finishes.
            </span>
          )}
        </div>
      </div>
      {state.maintenance.length > 0 && (
        <div className="batch-toolbar">
          <button className="secondary-button" onClick={toggleAll}>
            {allVisibleSelected ? <CheckSquare size={16} /> : <Square size={16} />}
            {allVisibleSelected ? "Clear selection" : "Select all"}
          </button>
          <span>
            {selectedGroups.length} sender{selectedGroups.length === 1 ? "" : "s"} selected
          </span>
          <div className="batch-actions">
            <button
              className="secondary-button"
              disabled={
                !state.health.gmailModifyAuthorized ||
                selectedGroups.length === 0 ||
                busy === "maintenance:batch"
              }
              onClick={() => onAction(selectedGroups, "mark_read")}
            >
              <MailCheck size={16} />
              Mark read
            </button>
            <button
              className="secondary-button"
              disabled={
                !state.health.gmailModifyAuthorized ||
                selectedGroups.length === 0 ||
                busy === "maintenance:batch"
              }
              onClick={() => onAction(selectedGroups, "unsubscribe")}
            >
              <X size={16} />
              Unsubscribe
            </button>
            <button
              className="danger-button"
              disabled={
                !state.health.gmailModifyAuthorized ||
                selectedGroups.length === 0 ||
                busy === "maintenance:batch"
              }
              onClick={() => onAction(selectedGroups, "spam")}
            >
              <Ban size={16} />
              Spam
            </button>
          </div>
        </div>
      )}
      {!state.health.gmailModifyAuthorized && (
        <div className="permission-banner">
          <ShieldCheck size={19} />
          <div>
            <strong>Gmail maintenance permission needed</strong>
            <span>
              The queue is ready, but Gmail is connected read-only. Mailbox-changing actions
              remain disabled until modify access is authorized.
            </span>
          </div>
        </div>
      )}
      {state.maintenance.length === 0 ? (
        <EmptyState
          icon={MailCheck}
          title="No maintenance waiting"
          body="Unread mail Ezra suppresses will appear here for sender-level cleanup."
        />
      ) : (
        <div className="maintenance-list">
          {state.maintenance.map((group) => (
            <article
              className={
                selectedKeys.has(maintenanceKey(group))
                  ? "maintenance-row selected"
                  : "maintenance-row"
              }
              key={`${group.accountId}:${group.senderEmail}`}
            >
              <button
                className="selection-toggle"
                aria-label={`Select ${group.senderName}`}
                aria-pressed={selectedKeys.has(maintenanceKey(group))}
                onClick={() => toggleGroup(group)}
              >
                {selectedKeys.has(maintenanceKey(group)) ? (
                  <CheckSquare size={18} />
                ) : (
                  <Square size={18} />
                )}
              </button>
              <button
                className="maintenance-copy maintenance-email-trigger"
                onClick={() => onOpenEmail(group)}
                aria-label={`Open latest email from ${group.senderName}: ${group.latestSubject}`}
              >
                <div className="maintenance-topline">
                  <strong>{group.senderName}</strong>
                  <span>{group.messageCount} unread</span>
                </div>
                <b>{group.latestSubject}</b>
                <span>{group.senderEmail}</span>
                <small>{group.accountEmail}</small>
                <small>{group.categories.join(", ")}</small>
              </button>
              <div className="maintenance-actions">
                <button
                  className="secondary-button"
                  disabled={
                    !state.health.gmailModifyAuthorized ||
                    busy === `maintenance:${group.senderEmail}` ||
                    busy === "maintenance:batch"
                  }
                  onClick={() => onAction([group], "mark_read")}
                >
                  <MailCheck size={16} />
                  Mark read
                </button>
                <button
                  className="secondary-button"
                  disabled={
                    !state.health.gmailModifyAuthorized ||
                    busy === `maintenance:${group.senderEmail}` ||
                    busy === "maintenance:batch"
                  }
                  onClick={() => onAction([group], "unsubscribe")}
                >
                  <X size={16} />
                  Unsubscribe
                </button>
                <button
                  className="danger-button"
                  disabled={
                    !state.health.gmailModifyAuthorized ||
                    busy === `maintenance:${group.senderEmail}` ||
                    busy === "maintenance:batch"
                  }
                  onClick={() => onAction([group], "spam")}
                >
                  <Ban size={16} />
                  Spam
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function RepliesView({
  drafts,
  busy,
  onEdit,
  onRequest,
  onApprove,
  onCancel,
  onOpenEmail,
}: {
  drafts: DraftItem[];
  busy: string | null;
  onEdit: (draft: DraftItem) => void;
  onRequest: (draft: DraftItem) => void;
  onApprove: (draft: DraftItem) => void;
  onCancel: (draft: DraftItem) => void;
  onOpenEmail: (messageId: string) => void;
}) {
  return (
    <section className="content-section">
      <div className="section-heading large">
        <div>
          <h2>Drafts and approvals</h2>
          <span>Every final version requires its own send confirmation.</span>
        </div>
      </div>
      {drafts.length === 0 ? (
        <EmptyState icon={Reply} title="No replies waiting" body="Draft from any inbox message." />
      ) : (
        <div className="draft-list">
          {drafts.map((draft) => (
            <article className="draft-row" key={draft.id}>
              <button
                className="draft-email-trigger"
                onClick={() => onOpenEmail(draft.messageId)}
                aria-label={`Open original email: ${draft.subject}`}
              >
                <span className="draft-meta">
                  <span className={`draft-status ${draft.status}`}>{draft.status.replace("_", " ")}</span>
                  <span>Version {draft.version}</span>
                  <span>{formatRelative(draft.updatedAt)}</span>
                </span>
                <strong>{draft.subject}</strong>
                <span className="sender-line">From {draft.senderName} &lt;{draft.senderEmail}&gt;</span>
                <ChevronRight size={17} />
              </button>
              <pre>{draft.content}</pre>
              <div className="draft-actions">
                <button className="secondary-button" onClick={() => onEdit(draft)}>Edit</button>
                {draft.status === "draft" && (
                  <button
                    className="primary-button"
                    disabled={busy === `request:${draft.id}`}
                    onClick={() => onRequest(draft)}
                  >
                    <ShieldCheck size={17} />
                    Request send
                  </button>
                )}
                {draft.status === "awaiting_approval" && (
                  <button className="danger-button" onClick={() => onApprove(draft)}>
                    <Send size={17} />
                    Review and send
                  </button>
                )}
                {!["sent", "cancelled"].includes(draft.status) && (
                  <button className="icon-button" title="Cancel draft" onClick={() => onCancel(draft)}>
                    <X size={17} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function MessageDetailModal({
  detail,
  loading,
  onClose,
}: {
  detail: MessageDetail | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal wide message-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-detail-title"
      >
        <div className="modal-header">
          <div>
            <p className="eyebrow">{detail?.message.accountLabel || "Email detail"}</p>
            <h2 id="message-detail-title">Message detail</h2>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {detail ? (
          <MessageDetailContent item={detail.message} detail={detail} loading={loading} />
        ) : loading ? (
          <div className="detail-loading" role="status">
            <LoaderCircle className="spin" size={21} />
            <span>Fetching the sanitized email and contact history</span>
          </div>
        ) : (
          <EmptyState
            icon={Mail}
            title="Email detail unavailable"
            body="Ezra could not load this message."
          />
        )}
      </section>
    </div>
  );
}

function MessageDetailContent({
  item,
  detail,
  loading,
  actions,
}: {
  item: InboxItem;
  detail: MessageDetail | null;
  loading: boolean;
  actions?: ReactNode;
}) {
  const bodyText = detail?.bodyText || item.snippet || "No readable message text was returned.";
  return (
    <div className="message-detail-content">
      <div className="detail-header">
        <span className={`attention-badge ${item.attention || "pending"}`}>
          {item.attention || "analyzing"}
          {item.urgency !== null && ` ${item.urgency}`}
        </span>
        <div className="detail-actions">
          <button
            className="icon-button"
            title="Open in Gmail"
            aria-label="Open in Gmail"
            disabled={item.gmailUrl === "#"}
            onClick={() => window.open(item.gmailUrl, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink size={17} />
          </button>
        </div>
      </div>
      <p className="eyebrow">{item.accountLabel}</p>
      <h2>{item.subject}</h2>
      <p className="sender-line">
        {item.senderName} <span>&lt;{item.senderEmail}&gt;</span>
      </p>
      <div className="analysis-signals" aria-label="Ezra analysis signals">
        {item.isUnread && <span>Unread</span>}
        {displayMailboxLabels(item).map((label) => (
          <span key={label}>{label}</span>
        ))}
        {item.category && <span>{humanize(item.category)}</span>}
        {item.confidence !== null && <span>{formatConfidence(item.confidence)} confidence</span>}
        {item.needsReply && <span>Reply likely</span>}
        {item.deadline && <span>Due {formatDeadline(item.deadline)}</span>}
      </div>
      {actions}

      <section className="email-copy-section">
        <div className="detail-section-heading">
          <FileText size={17} />
          <div>
            <h3>{detail?.bodyIsExcerpt ? "Email excerpt" : "Original email"}</h3>
            <span>
              {detail?.bodyIsExcerpt
                ? "The provider returned a stored excerpt."
                : "Sanitized plain text fetched when you opened this message."}
            </span>
          </div>
        </div>
        {loading && !detail ? (
          <div className="inline-loading"><LoaderCircle className="spin" size={17} /> Loading email</div>
        ) : (
          <div className="email-body">{bodyText}</div>
        )}
        {detail && detail.attachments.length > 0 && (
          <div className="attachment-list">
            {detail.attachments.map((attachment) => (
              <span key={attachment.id}>
                <Paperclip size={14} />
                {attachment.name}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="ai-breakdown-section">
        <div className="detail-section-heading">
          <Sparkles size={17} />
          <div>
            <h3>Ezra's breakdown</h3>
            <span>The model's current interpretation and recommended next move.</span>
          </div>
        </div>
        <div className="decision-block">
          <div>
            <span>Ezra's read</span>
            <p>{item.summary || item.snippet}</p>
          </div>
          <div>
            <span>Why it landed here</span>
            <p>{item.reason || "Analysis is pending."}</p>
          </div>
          <div>
            <span>Suggested move</span>
            <p>{item.recommendation || "Review the message."}</p>
          </div>
        </div>
      </section>

      {item.injectionFlags.length > 0 && (
        <div className="security-warning">
          <ShieldCheck size={18} />
          <div>
            <strong>Untrusted instruction detected</strong>
            <span>{item.injectionFlags.join(", ")}</span>
          </div>
        </div>
      )}

      <section className="contact-memory-section">
        <div className="detail-section-heading">
          <History size={17} />
          <div>
            <h3>Contact memory</h3>
            <span>
              {detail
                ? detail.contactMemory.summary
                : "Loading Ezra's evidence-based history with this contact."}
            </span>
          </div>
        </div>
        {detail ? (
          <div className="memory-categories">
            {detail.contactMemory.categories.map((category) => (
              <div className="memory-row" key={category.label}>
                <span>{category.label}</span>
                <p>{category.summary}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="inline-loading">
            <LoaderCircle className="spin" size={17} />
            Reviewing contact history
          </div>
        )}
      </section>
    </div>
  );
}

function LearningView({
  state,
  onForget,
}: {
  state: DashboardState;
  onForget: (id: string) => void;
}) {
  return (
    <section className="content-section">
      <div className="section-heading large">
        <div>
          <h2>Learned preferences</h2>
          <span>Corrections become local ranking signals, never model weight training.</span>
        </div>
      </div>
      {state.preferences.length === 0 ? (
        <EmptyState
          icon={Brain}
          title="Still learning your signal"
          body="Correct an inbox decision to create the first preference."
        />
      ) : (
        <div className="data-table">
          <div className="table-row table-head">
            <span>Rule</span><span>Action</span><span>Evidence</span><span>Weight</span><span />
          </div>
          {state.preferences.map((preference) => (
            <div className="table-row" key={preference.id}>
              <span><b>{preference.kind}</b><small>{preference.pattern}</small></span>
              <span className={`attention-badge ${preference.action}`}>{preference.action}</span>
              <span>{preference.evidenceCount}</span>
              <span>{preference.weight.toFixed(1)}</span>
              <button
                className="icon-button"
                title="Forget rule"
                aria-label="Forget rule"
                onClick={() => onForget(preference.id)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ModelsView({
  state,
  busy,
  onSwitch,
}: {
  state: DashboardState;
  busy: string | null;
  onSwitch: (model: ModelId) => void;
}) {
  const stats = (model: ModelId) => {
    const runs = state.modelRuns.filter((run) => run.model === model);
    const memoryRuns = runs.filter((run) => run.memoryMb !== null);
    return {
      runs: runs.length,
      valid: runs.length ? Math.round((runs.filter((run) => run.valid).length / runs.length) * 100) : 0,
      average: runs.length ? Math.round(runs.reduce((sum, run) => sum + run.durationMs, 0) / runs.length) : 0,
      memory: memoryRuns.length
        ? Math.round(
            memoryRuns.reduce((sum, run) => sum + (run.memoryMb || 0), 0) /
              memoryRuns.length,
          )
        : 0,
    };
  };
  return (
    <section className="content-section">
      <div className="section-heading large">
        <div>
          <h2>Local model comparison</h2>
          <span>One active model at a time, both using their native maximum context.</span>
        </div>
      </div>
      <div className="model-grid">
        {(["qwen3:8b-maxctx", "qwen3:14b-maxctx"] as ModelId[]).map((model) => {
          const metric = stats(model);
          const active = state.activeModel === model;
          return (
            <article className={active ? "model-panel active" : "model-panel"} key={model}>
              <div className="model-heading">
                <div>
                  <p className="eyebrow">{active ? "Active" : "Available"}</p>
                  <h2>{model.includes("14b") ? "Qwen3 14B" : "Qwen3 8B"}</h2>
                </div>
                {active && <Check size={19} />}
              </div>
              <div className="model-metrics">
                <span><b>{metric.runs}</b> runs</span>
                <span><b>{metric.valid}%</b> valid</span>
                <span><b>{formatDuration(metric.average)}</b> average</span>
                <span><b>{formatMemory(metric.memory)}</b> loaded</span>
                <span><b>40,960</b> context</span>
              </div>
              <button
                className={active ? "secondary-button" : "primary-button"}
                disabled={active || busy === `model:${model}`}
                onClick={() => onSwitch(model)}
              >
                {active ? "Currently active" : "Use this model"}
              </button>
            </article>
          );
        })}
      </div>
      <div className="run-log">
        <div className="section-heading"><h3>Recent runs</h3></div>
        {state.modelRuns.slice(0, 12).map((run) => (
          <div className="run-row" key={run.id}>
            <span className={run.valid ? "run-dot valid" : "run-dot invalid"} />
            <b>{run.model.replace("-maxctx", "")}</b>
            <span>{run.classification ? `${run.purpose} / ${run.classification}` : run.purpose}</span>
            <span>
              {formatDuration(run.durationMs)}
              {run.memoryMb ? ` / ${formatMemory(run.memoryMb)}` : ""}
            </span>
            <time>{formatRelative(run.createdAt)}</time>
          </div>
        ))}
      </div>
    </section>
  );
}

function ModelsViewV2({
  state,
  busy,
  onSwitch,
  onBenchmark,
  onUpdateModel,
}: {
  state: DashboardState;
  busy: string | null;
  onSwitch: (model: ModelId) => void;
  onBenchmark: () => void;
  onUpdateModel: (model: ModelId) => void;
}) {
  const stats = (model: ModelId) => {
    const runs = state.modelRuns.filter(
      (run) => run.model === model && !run.purpose.startsWith("benchmark:"),
    );
    const memoryRuns = runs.filter((run) => run.memoryMb !== null);
    return {
      runs: runs.length,
      valid: runs.length
        ? Math.round((runs.filter((run) => run.valid).length / runs.length) * 100)
        : 0,
      average: runs.length
        ? Math.round(runs.reduce((sum, run) => sum + run.durationMs, 0) / runs.length)
        : 0,
      memory: memoryRuns.length
        ? Math.round(
            memoryRuns.reduce((sum, run) => sum + (run.memoryMb || 0), 0) /
              memoryRuns.length,
          )
        : 0,
    };
  };

  return (
    <section className="content-section">
      <div className="section-heading large">
        <div>
          <h2>Local model comparison</h2>
          <span>One active model at a time at Ezra's 40,960-token operating context.</span>
        </div>
        <button
          className="primary-button"
          disabled={busy === "model-benchmark" || state.benchmarks.status === "running"}
          onClick={onBenchmark}
        >
          {state.benchmarks.status === "running" ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Play size={17} />
          )}
          {state.benchmarks.status === "running" ? "Comparing" : "Run comparison"}
        </button>
      </div>

      {state.benchmarks.status === "running" && (
        <div className="benchmark-progress" role="status">
          <Activity size={17} />
          <span>{state.benchmarks.progress || "Running the fixed email test set"}</span>
        </div>
      )}

      <div className="model-grid">
        {modelDefinitions.map((definition) => {
          const model = definition.id;
          const metric = stats(model);
          const active = state.activeModel === model;
          const installation = state.updates.models.find((item) => item.id === model);
          const benchmark = state.benchmarks.summaries.find(
            (summary) => summary.model === model,
          );
          return (
            <article className={active ? "model-panel active" : "model-panel"} key={model}>
              <div className="model-heading">
                <div>
                  <p className="eyebrow">
                    {active ? "Active" : installation?.installed ? "Available" : "Install needed"}
                  </p>
                  <h2>{definition.label}</h2>
                  <span>{definition.description}</span>
                </div>
                {active && <Check size={19} />}
              </div>
              <div className="model-metrics">
                <span><b>{benchmark ? `${benchmark.score}/100` : "-"}</b> benchmark</span>
                <span><b>{benchmark ? `${benchmark.attentionAccuracy}%` : "-"}</b> triage accuracy</span>
                <span><b>{metric.runs}</b> live runs</span>
                <span><b>{metric.valid}%</b> live valid</span>
                <span><b>{formatDuration(metric.average)}</b> live average</span>
                <span><b>{formatMemory(metric.memory)}</b> loaded</span>
                <span><b>{definition.configuredContext.toLocaleString()}</b> context</span>
                <span><b>{definition.parameters}</b> parameters</span>
              </div>
              <div className="model-actions">
                <button
                  className={active ? "secondary-button" : "primary-button"}
                  disabled={active || !installation?.installed || busy === `model:${model}`}
                  onClick={() => onSwitch(model)}
                >
                  {active
                    ? "Currently active"
                    : installation?.installed
                      ? "Use this model"
                      : "Not installed"}
                </button>
                <button
                  className="secondary-button"
                  disabled={
                    busy === `update-model:${model}` || installation?.updateState === "running"
                  }
                  onClick={() => onUpdateModel(model)}
                >
                  {installation?.updateState === "running" ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <ArrowDownToLine size={16} />
                  )}
                  {installation?.installed ? "Refresh model" : "Install model"}
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {state.benchmarks.summaries.length > 0 && (
        <div className="benchmark-results">
          <div className="section-heading">
            <div>
              <h3>Fixed email benchmark</h3>
              <span>{state.benchmarks.summaries[0]?.cases || 0} cases per model</span>
            </div>
          </div>
          <div className="benchmark-table">
            <div className="benchmark-row benchmark-head">
              <span>Model</span>
              <span>Score</span>
              <span>Triage</span>
              <span>Valid</span>
              <span>Average</span>
              <span>Memory</span>
            </div>
            {[...state.benchmarks.summaries]
              .sort((left, right) => right.score - left.score)
              .map((summary) => (
                <div className="benchmark-row" key={summary.model}>
                  <b>{modelDefinitions.find((item) => item.id === summary.model)?.label}</b>
                  <span>{summary.score}/100</span>
                  <span>{summary.attentionAccuracy}%</span>
                  <span>{summary.validPercent}%</span>
                  <span>{formatDuration(summary.averageDurationMs)}</span>
                  <span>{formatMemory(summary.averageMemoryMb)}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="run-log">
        <div className="section-heading"><h3>Recent runs</h3></div>
        {state.modelRuns.slice(0, 12).map((run) => (
          <div className="run-row" key={run.id}>
            <span className={run.valid ? "run-dot valid" : "run-dot invalid"} />
            <b>{run.model.replace("-maxctx", "")}</b>
            <span>{run.classification ? `${run.purpose} / ${run.classification}` : run.purpose}</span>
            <span>
              {formatDuration(run.durationMs)}
              {run.memoryMb ? ` / ${formatMemory(run.memoryMb)}` : ""}
            </span>
            <time>{formatRelative(run.createdAt)}</time>
          </div>
        ))}
      </div>
    </section>
  );
}

function SettingsView({
  state,
  busy,
  onPoll,
  onSyncAccounts,
  onDemo,
  onCheckUpdates,
}: {
  state: DashboardState;
  busy: string | null;
  onPoll: () => void;
  onSyncAccounts: () => void;
  onDemo: () => void;
  onCheckUpdates: () => void;
}) {
  return (
    <section className="settings-layout">
      <div className="settings-band">
        <div className="section-heading large">
          <div><h2>Connections</h2><span>Credentials stay outside the repository.</span></div>
        </div>
        <div className="connection-list">
          <Connection
            icon={Mail}
            name="Gmail"
            detail={
              state.accounts.length
                ? `${state.accounts.length} authorized account${
                    state.accounts.length === 1 ? "" : "s"
                  } / ${
                    state.health.gmailModifyAuthorized ? "maintenance enabled" : "read-only"
                  }`
                : "Authorization needed"
            }
            good={state.accounts.some((account) => account.status === "connected")}
          />
          <Connection
            icon={Send}
            name="Telegram"
            detail={state.health.telegramConfigured ? "Owner chat configured" : "Bot token and chat ID needed"}
            good={state.health.telegramConfigured}
          />
          <Connection icon={Sparkles} name="Ollama" detail="Local inference service" good={state.health.ollama} />
          <Connection icon={Wifi} name="gog" detail="Restricted Gmail command bridge" good={state.health.gogInstalled} />
        </div>
        <div className="account-lanes">
          {state.accounts.length === 0 ? (
            <div className="account-empty">
              <Mail size={18} />
              <span>
                Authorize a Gmail account with the local Gmail bridge, then refresh accounts here.
              </span>
            </div>
          ) : (
            state.accounts.map((account) => <AccountCard account={account} key={account.id} />)
          )}
        </div>
        <div className="settings-actions">
          <button className="primary-button" disabled={busy === "poll"} onClick={onPoll}>
            <RefreshCcw className={busy === "poll" ? "spin" : ""} size={17} />
            Poll now
          </button>
          <button
            className="secondary-button"
            disabled={busy === "sync-accounts"}
            onClick={onSyncAccounts}
          >
            <RefreshCcw className={busy === "sync-accounts" ? "spin" : ""} size={17} />
            Refresh accounts
          </button>
          <button className="secondary-button" disabled={busy === "demo"} onClick={onDemo}>
            <Sparkles size={17} />
            Load safe demo
          </button>
        </div>
      </div>

      <div className="settings-band">
        <div className="section-heading large">
          <div>
            <h2>Updates</h2>
            <span>
              Checked {formatRelative(state.updates.checkedAt) === "now"
                ? "just now"
                : `${formatRelative(state.updates.checkedAt)} ago`}
            </span>
          </div>
          <button
            className="secondary-button"
            disabled={busy === "check-updates"}
            onClick={onCheckUpdates}
          >
            <RefreshCcw className={busy === "check-updates" ? "spin" : ""} size={16} />
            Check now
          </button>
        </div>
        <div className="update-list">
          <UpdateRow
            name="Ezra Mail"
            version={`v${state.updates.app.currentVersion}${
              state.updates.app.commit ? ` (${state.updates.app.commit})` : ""
            }`}
            detail={
              state.updates.app.remoteConfigured
                ? "Private release source connected"
                : "Private release source not configured"
            }
            state={state.updates.app.remoteConfigured ? "Current" : "Setup needed"}
            good={state.updates.app.remoteConfigured}
          />
          <UpdateRow
            name="Ollama"
            version={
              state.updates.ollama.installedVersion
                ? `v${state.updates.ollama.installedVersion}`
                : "Not detected"
            }
            detail={
              state.updates.ollama.latestVersion
                ? `Latest v${state.updates.ollama.latestVersion}`
                : "Latest release unavailable"
            }
            state={state.updates.ollama.updateAvailable ? "Update available" : "Current"}
            good={!state.updates.ollama.updateAvailable}
          />
        </div>
      </div>

      <div className="settings-band">
        <div className="section-heading large">
          <div><h2>Automation</h2><span>{state.schedule.timezone}</span></div>
        </div>
        <div className="schedule-grid">
          <Schedule label="Inbox poll" value={`Every ${state.schedule.pollMinutes} minutes`} />
          <Schedule label="Morning digest" value={state.schedule.digestTimes[0]} />
          <Schedule label="Afternoon digest" value={state.schedule.digestTimes[1]} />
          <Schedule label="Quiet hours" value={`${state.schedule.quietStart} - ${state.schedule.quietEnd}`} />
        </div>
      </div>

      <div className="settings-band security-band">
        <ShieldCheck size={22} />
        <div>
          <h2>Local safety boundary</h2>
          <p>
            Models can classify and draft. They cannot browse, execute commands, access credentials,
            call Gmail, contact Telegram, or send mail.
          </p>
        </div>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number;
  tone: string;
  icon: typeof Inbox;
}) {
  return (
    <div className="metric">
      <span className={`metric-icon ${tone}`}><Icon size={18} /></span>
      <span><b>{value}</b><small>{label}</small></span>
    </div>
  );
}

function StatusDot({ good, label }: { good: boolean; label: string }) {
  return <span><i className={good ? "good" : ""} />{label}</span>;
}

function EmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Inbox;
  title: string;
  body: string;
}) {
  return (
    <div className="empty-state">
      <Icon size={23} />
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function Connection({
  icon: Icon,
  name,
  detail,
  good,
}: {
  icon: typeof Inbox;
  name: string;
  detail: string;
  good: boolean;
}) {
  return (
    <div className="connection-row">
      <span className="connection-icon"><Icon size={19} /></span>
      <span><b>{name}</b><small>{detail}</small></span>
      <span className={good ? "connection-state good" : "connection-state"}>
        {good ? "Ready" : "Setup needed"}
      </span>
    </div>
  );
}

function AccountCard({ account }: { account: AccountStatus }) {
  return (
    <article className={`account-card ${accountTone(account.id)}`}>
      <div className="account-card-head">
        <AccountChip accountId={account.id} label={account.label || account.email} />
        <span className={account.status === "connected" ? "connection-state good" : "connection-state"}>
          {humanize(account.status)}
        </span>
      </div>
      <strong>{account.email}</strong>
      <span>
        {humanize(account.provider)} /{" "}
        {account.lastSyncAt ? `Last checked ${formatRelative(account.lastSyncAt)} ago` : "Not checked yet"}
      </span>
      <div className="account-card-stats">
        <small><b>{account.counts.interrupt}</b> priority</small>
        <small><b>{account.counts.digest}</b> digest</small>
        <small><b>{account.counts.unread}</b> unread</small>
        <small><b>{account.counts.maintenance}</b> cleanup</small>
      </div>
    </article>
  );
}

function AccountChip({
  accountId,
  label,
}: {
  accountId: string;
  label: string;
}) {
  return (
    <small className={`account-chip ${accountTone(accountId)}`}>
      <i>{accountInitials(label)}</i>
      {label}
    </small>
  );
}

function Schedule({ label, value }: { label: string; value: string }) {
  return <div className="schedule-item"><span>{label}</span><b>{value}</b></div>;
}

function UpdateRow({
  name,
  version,
  detail,
  state,
  good,
}: {
  name: string;
  version: string;
  detail: string;
  state: string;
  good: boolean;
}) {
  return (
    <div className="update-row">
      <span className="connection-icon"><ArrowDownToLine size={18} /></span>
      <span><b>{name}</b><small>{version} / {detail}</small></span>
      <span className={good ? "connection-state good" : "connection-state"}>{state}</span>
    </div>
  );
}

function compareInboxItems(left: InboxItem, right: InboxItem) {
  const attentionRank = { interrupt: 0, pending: 1, digest: 2, suppress: 3 };
  const leftRank = attentionRank[left.attention || "pending"];
  const rightRank = attentionRank[right.attention || "pending"];
  if (leftRank !== rightRank) return leftRank - rightRank;

  const urgencyDifference = (right.urgency || 0) - (left.urgency || 0);
  if (urgencyDifference !== 0) return urgencyDifference;

  const leftDeadline = left.deadline ? new Date(left.deadline).getTime() : Number.MAX_SAFE_INTEGER;
  const rightDeadline = right.deadline ? new Date(right.deadline).getTime() : Number.MAX_SAFE_INTEGER;
  if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;

  return new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime();
}

function inboxModeLabel(mode: InboxMode) {
  if (mode === "priority") return "Priority";
  if (mode === "digest") return "Digest";
  return "All";
}

function inboxModeTitle(mode: InboxMode) {
  if (mode === "priority") return "Needs attention";
  if (mode === "digest") return "Next digest";
  return "All decisions";
}

function inboxModeCount(state: DashboardState, mode: InboxMode) {
  if (mode === "priority") return state.counts.interrupt;
  if (mode === "digest") return state.counts.digest;
  return state.inbox.length;
}

function mailboxModeLabel(mode: MailboxMode) {
  if (mode === "all") return "All";
  if (mode === "unread") return "Unread";
  if (mode === "spam") return "Spam";
  if (mode === "sent") return "Sent";
  return "Inbox";
}

function mailboxModeIncludes(item: InboxItem, mode: MailboxMode) {
  const labels = item.mailboxLabels.map((label) => label.toUpperCase());
  if (mode === "all") return true;
  if (mode === "unread") return item.isUnread;
  if (mode === "inbox") return labels.includes("INBOX");
  if (mode === "spam") return labels.includes("SPAM") || item.status === "spammed";
  return labels.includes("SENT");
}

function displayMailboxLabels(item: InboxItem) {
  const labels = item.mailboxLabels
    .filter((label) => !["UNREAD", "IMPORTANT"].includes(label.toUpperCase()))
    .map(mailboxLabelName);
  return Array.from(new Set(labels)).slice(0, 3);
}

function primaryMailboxLabel(item: InboxItem) {
  if (item.isUnread) return "Unread";
  return displayMailboxLabels(item)[0] || humanize(item.status);
}

function mailboxLabelName(label: string) {
  return label
    .replace(/^CATEGORY_/i, "")
    .replace(/^Label_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function maintenanceKey(group: MaintenanceGroup) {
  return `${group.accountId}:${group.senderEmail.toLowerCase()}`;
}

function formatModelLabel(model: string) {
  const withoutProvider = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return withoutProvider.replace("-maxctx", "");
}

function sumMaintenanceMessages(groups: MaintenanceGroup[]) {
  return groups.reduce((sum, group) => sum + group.messageCount, 0);
}

function formatRelative(value: string) {
  const distance = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(distance / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatDeadline(value: string) {
  const distance = new Date(value).getTime() - Date.now();
  if (distance <= 0) return "Past due";
  const hours = Math.ceil(distance / 3_600_000);
  if (hours < 24) return `Due ${hours}h`;
  const days = Math.ceil(hours / 24);
  if (days < 7) return `Due ${days}d`;
  return `Due ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(value))}`;
}

function formatDuration(value: number) {
  if (!value) return "-";
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

function formatMemory(value: number) {
  if (!value) return "-";
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${Math.round(value)} MB`;
}

function formatConfidence(value: number) {
  const percentage = value <= 1 ? value * 100 : value;
  return `${Math.round(percentage)}%`;
}

function formatDigestTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function accountTone(value: string) {
  const tones = ["teal", "blue", "amber", "green", "red", "slate"];
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) % 997;
  return `account-${tones[Math.abs(hash) % tones.length]}`;
}

function accountInitials(value: string) {
  const [name] = value.split("@");
  const parts = name.split(/[._\-\s]+/).filter(Boolean);
  return (parts[0]?.[0] || value[0] || "M").toUpperCase();
}

function backlogStatusLine(state: DashboardState) {
  if (state.backlog.status === "completed") {
    return `Complete across ${state.backlog.pagesScanned} Gmail pages`;
  }
  if (state.backlog.status === "running") {
    return `${state.backlog.pagesScanned} pages scanned; continuing in bounded background batches`;
  }
  if (state.backlog.status === "paused") {
    return `Paused after ${state.backlog.pagesScanned} Gmail pages`;
  }
  if (state.backlog.status === "error") {
    return state.backlog.error || "Review needs attention";
  }
  return "Not started";
}

function maintenanceActionTitle(action: MaintenanceAction) {
  if (action === "spam") return "Send this sender to spam?";
  if (action === "unsubscribe") return "Unsubscribe and clear unread mail?";
  return "Mark this sender's mail as read?";
}

function maintenanceActionExplanation(action: MaintenanceAction) {
  if (action === "spam") {
    return "Current unread messages move to Gmail Spam and future low-priority messages from this sender will follow the approved spam rule.";
  }
  if (action === "unsubscribe") {
    return "Ezra will use only a standards-based HTTPS one-click unsubscribe endpoint, then mark the current messages read. If the sender does not provide one, nothing changes.";
  }
  return "Current unread messages become read and future low-priority messages from this sender will be marked read after Ezra reviews them.";
}

function maintenanceActionPastTense(action: MaintenanceAction) {
  if (action === "spam") return "Moved";
  if (action === "unsubscribe") return "Unsubscribed and cleared";
  return "Marked read";
}
