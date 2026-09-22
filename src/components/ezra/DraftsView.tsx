"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, FilePenLine, LoaderCircle, MailCheck, Paperclip, Plus, Send, Trash2, X } from "lucide-react";
import type { DraftItem, MailWorkspace, OutgoingDraft } from "@/lib/email/types";
import { api, post } from "./api";
import { isInitialPanelLoad } from "./refreshState";
import { isAbortError, useLatestRequest } from "./useLatestRequest";
import { RecipientField, parseRecipientText } from "./RecipientField";
import styles from "./EzraMail.module.css";

type DraftFilter = "active" | "approval" | "sent" | "all";
type MailMeta = {
  accounts: Array<{ id: string; provider: "gmail" | "microsoft"; label: string; email: string; purpose?: string }>;
  workspaces: MailWorkspace[];
  categories: string[];
};

type NewEmailForm = {
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
};

const EMPTY_NEW_EMAIL: NewEmailForm = {
  accountId: "",
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  body: "",
};

export function DraftsView(props: {
  workspaceId: string;
  workspace: MailWorkspace | null;
  onOpenMessage: (messageId: string) => void;
  onOpenOutbox?: (draftId: string) => void;
}) {
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [meta, setMeta] = useState<MailMeta>({ accounts: [], workspaces: [], categories: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [filter, setFilter] = useState<DraftFilter>("active");
  const [content, setContent] = useState("");
  const [contentDirty, setContentDirty] = useState(false);
  const [serverConflict, setServerConflict] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createdOutboxDraftId, setCreatedOutboxDraftId] = useState<string | null>(null);
  const [sendReview, setSendReview] = useState<DraftItem | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [newEmailOpen, setNewEmailOpen] = useState(false);
  const [newEmail, setNewEmail] = useState<NewEmailForm>(EMPTY_NEW_EMAIL);
  const [newEmailError, setNewEmailError] = useState("");
  const beginRequest = useLatestRequest();
  const beginMetaRequest = useLatestRequest();
  const contentDirtyRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const selectedVersionRef = useRef<number | null>(null);

  useEffect(() => { contentDirtyRef.current = contentDirty; }, [contentDirty]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    const request = beginRequest();
    if (options.quiet) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setError("");
    }
    try {
      const result = await api<DraftItem[]>("/api/drafts", { signal: request.signal });
      if (!request.isLatest()) return;
      const currentServerDraft = result.find((draft) => draft.id === selectedIdRef.current);
      if (contentDirtyRef.current && currentServerDraft && selectedVersionRef.current !== null && currentServerDraft.version !== selectedVersionRef.current) {
        setServerConflict(true);
      } else if (!contentDirtyRef.current && currentServerDraft) {
        selectedVersionRef.current = currentServerDraft.version;
        setContent(currentServerDraft.content);
      }
      setDrafts(result);
      setSelectedId((current) => current && result.some((draft) => draft.id === current) ? current : result[0]?.id || null);
    } catch (nextError) {
      if (!options.quiet && request.isLatest() && !isAbortError(nextError)) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      if (request.isLatest()) {
        if (options.quiet) setRefreshing(false);
        else setLoading(false);
      }
    }
  }, [beginRequest]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const refresh = () => void load({ quiet: true });
    window.addEventListener("ezra:refresh", refresh);
    return () => window.removeEventListener("ezra:refresh", refresh);
  }, [load]);
  useEffect(() => {
    const request = beginMetaRequest();
    void api<MailMeta>("/api/mail/meta", { signal: request.signal })
      .then((next) => request.isLatest() && setMeta(next))
      .catch(() => undefined);
  }, [beginMetaRequest]);

  const filtered = useMemo(() => drafts.filter((draft) => {
    if (filter === "active") return draft.status === "draft" || draft.status === "awaiting_approval";
    if (filter === "approval") return draft.status === "awaiting_approval";
    if (filter === "sent") return draft.status === "sent";
    return true;
  }), [drafts, filter]);
  const selected = drafts.find((draft) => draft.id === selectedId) || null;
  const visibleAccounts = useMemo(() => {
    if (!props.workspace || props.workspace.isAllAccounts) return meta.accounts;
    return meta.accounts.filter((account) => props.workspace?.accountIds.includes(account.id));
  }, [meta.accounts, props.workspace]);

  useEffect(() => {
    if (!selected) return;
    setContent(selected.content);
    setContentDirty(false);
    setServerConflict(false);
    selectedVersionRef.current = selected.version;
  }, [selected?.id]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!contentDirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeNavigate = (event: Event) => {
      if (!contentDirtyRef.current) return;
      if (!window.confirm("Discard the unsaved draft changes?")) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("ezra:before-navigate", beforeNavigate);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("ezra:before-navigate", beforeNavigate);
    };
  }, []);
  useEffect(() => {
    if (!newEmailOpen) return;
    setNewEmail((current) => {
      if (current.accountId && visibleAccounts.some((account) => account.id === current.accountId)) return current;
      return { ...current, accountId: visibleAccounts[0]?.id || "" };
    });
  }, [newEmailOpen, visibleAccounts]);

  async function action(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    setCreatedOutboxDraftId(null);
    try {
      await post("/api/drafts", body);
      if (body.action === "update") {
        setContentDirty(false);
        contentDirtyRef.current = false;
        setServerConflict(false);
      }
      setNotice(success);
      await load({ quiet: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  function openNewEmail() {
    setNewEmail({
      ...EMPTY_NEW_EMAIL,
      accountId: visibleAccounts[0]?.id || "",
    });
    setNewEmailError("");
    setNotice("");
    setError("");
    setCreatedOutboxDraftId(null);
    setNewEmailOpen(true);
  }

  async function saveNewEmail() {
    setBusy(true);
    setNewEmailError("");
    setNotice("");
    setCreatedOutboxDraftId(null);
    try {
      if (!newEmail.accountId) throw new Error("Choose a sending account first.");
      const draft = await post<OutgoingDraft>("/api/drafts", {
        action: "new_email_create",
        accountId: newEmail.accountId,
        to: parseRecipientText(newEmail.to),
        cc: parseRecipientText(newEmail.cc),
        bcc: parseRecipientText(newEmail.bcc),
        subject: newEmail.subject,
        body: newEmail.body,
      });
      setNewEmailOpen(false);
      setNewEmail(EMPTY_NEW_EMAIL);
      setNotice("New email draft saved to Outbox for exact review.");
      setCreatedOutboxDraftId(draft.id);
      await load({ quiet: true });
    } catch (nextError) {
      setNewEmailError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!sendReview) return;
    await action({ action: "approve_send", draftId: sendReview.id }, "Email sent.");
    setSendReview(null);
    setConfirmed(false);
  }

  async function prepareReplyInOutbox(draft: DraftItem) {
    setBusy(true);
    setError("");
    try {
      const outgoing = await post<OutgoingDraft>("/api/drafts", { action: "reply_outgoing_create", draftId: draft.id });
      setNotice("Reply copied to Outbox. Add attachments before exact review.");
      setCreatedOutboxDraftId(outgoing.id);
      props.onOpenOutbox?.(outgoing.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  function selectDraft(draftId: string) {
    if (draftId !== selectedId && contentDirty && !window.confirm("Discard the unsaved draft changes?")) return;
    setContentDirty(false);
    contentDirtyRef.current = false;
    setServerConflict(false);
    setSelectedId(draftId);
    setMobileDetailOpen(true);
  }

  return (
    <div className={styles.draftsView} aria-busy={refreshing || loading}>
      <div className={styles.draftToolbar}>
        <div className={styles.draftFilters} role="tablist" aria-label="Draft filters">
          {(["active", "approval", "sent", "all"] as DraftFilter[]).map((item) => <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? styles.segmentActive : ""} onClick={() => setFilter(item)}>{item === "approval" ? "Needs approval" : item[0].toUpperCase() + item.slice(1)}</button>)}
        </div>
        <button className={styles.primaryButton} onClick={openNewEmail}>
          <Plus aria-hidden="true" /> New email draft
        </button>
      </div>
      {notice ? (
        <div className={styles.successNotice} role="status">
          <Check aria-hidden="true" />
          <span>{notice}</span>
          {createdOutboxDraftId && props.onOpenOutbox ? (
            <button type="button" onClick={() => props.onOpenOutbox?.(createdOutboxDraftId)}>Open Outbox</button>
          ) : null}
        </div>
      ) : null}
      {error ? <div className={styles.inlineError} role="alert">{error}</div> : null}
      <div className={`${styles.draftWorkspace} ${selected && mobileDetailOpen ? styles.draftWorkspaceSelected : ""}`}>
        <section className={styles.draftList} aria-label="Reply drafts">
          <header><div><h2>Reply queue</h2><span>{filtered.length} draft{filtered.length === 1 ? "" : "s"}</span></div></header>
          {isInitialPanelLoad(loading, Boolean(drafts.length)) ? <div className={styles.listLoading}><LoaderCircle aria-hidden="true" /> Loading drafts...</div> : null}
          {!loading && !filtered.length ? <div className={styles.draftEmpty}><FilePenLine aria-hidden="true" /><h3>No drafts here</h3><p>Draft a reply from any conversation in Mail.</p></div> : null}
          {filtered.map((draft) => (
            <button key={draft.id} className={`${styles.draftRow} ${draft.id === selectedId ? styles.draftRowActive : ""}`} onClick={() => selectDraft(draft.id)}>
              <span><strong>{draft.subject}</strong><small>{draft.senderName} · v{draft.version}</small></span>
              <span className={`${styles.statusBadge} ${styles[`status_${draft.status}`]}`}>{statusLabel(draft.status)}</span>
            </button>
          ))}
        </section>

        {selected ? (
          <section className={styles.draftEditor} aria-labelledby="draft-editor-heading">
            <button className={styles.mobileBack} onClick={() => setMobileDetailOpen(false)}><ArrowLeft aria-hidden="true" /> Drafts</button>
            <header>
              <div><span>Reply to {selected.senderName} · {selected.senderEmail}</span><h2 id="draft-editor-heading">{selected.subject}</h2></div>
              <button className={styles.textButton} onClick={() => props.onOpenMessage(selected.messageId)}>Open original</button>
            </header>
            <label htmlFor="queue-draft-editor">Exact reply text</label>
            {serverConflict ? <div className={styles.inlineError} role="alert"><span>The server copy changed while you were editing.</span><button type="button" onClick={() => { setContent(selected.content); setContentDirty(false); contentDirtyRef.current = false; setServerConflict(false); selectedVersionRef.current = selected.version; }}>Reload server copy</button><button type="button" onClick={() => { setServerConflict(false); selectedVersionRef.current = selected.version; }}>Keep my text</button></div> : null}
            <textarea id="queue-draft-editor" value={content} onChange={(event) => { setContent(event.target.value); setContentDirty(event.target.value !== selected.content); }} disabled={selected.status === "sent" || selected.status === "cancelled"} />
            <footer>
              <div><span>Version {selected.version}</span><span>Updated {formatDate(selected.updatedAt)}</span></div>
              <div className={styles.draftActionButtons}>
                {selected.status === "draft" ? <button className={styles.secondaryButton} disabled={busy || content === selected.content} onClick={() => action({ action: "update", draftId: selected.id, content }, "New draft version saved.")}>Save version</button> : null}
                {selected.status === "draft" && props.onOpenOutbox ? <button className={styles.secondaryButton} disabled={busy || content !== selected.content} onClick={() => void prepareReplyInOutbox(selected)}><Paperclip aria-hidden="true" /> Attach in Outbox</button> : null}
                {selected.status === "draft" ? <button className={styles.primaryButton} disabled={busy || content !== selected.content} onClick={() => action({ action: "request_send", draftId: selected.id }, "Draft locked for exact send review.")}><MailCheck aria-hidden="true" /> Request send</button> : null}
                {selected.status === "awaiting_approval" ? <button className={styles.primaryButton} disabled={busy} onClick={() => setSendReview(selected)}><Send aria-hidden="true" /> Review and send</button> : null}
                {selected.status !== "sent" && selected.status !== "cancelled" ? <button className={styles.iconButtonSmall} disabled={busy} title="Cancel draft" onClick={() => action({ action: "cancel", draftId: selected.id }, "Draft cancelled.")}><Trash2 aria-hidden="true" /><span className={styles.srOnly}>Cancel draft</span></button> : null}
              </div>
            </footer>
          </section>
        ) : <section className={styles.draftEditorEmpty}><FilePenLine aria-hidden="true" /><h2>Select a draft</h2></section>}
      </div>

      {sendReview ? (
        <div className={styles.modalBackdrop} role="presentation">
          <section className={styles.sendDialog} role="alertdialog" aria-modal="true" aria-labelledby="send-review-heading">
            <span className={styles.dialogEyebrow}>Final send review</span>
            <h2 id="send-review-heading">Send this exact reply?</h2>
            <p>To: {sendReview.senderName} &lt;{sendReview.senderEmail}&gt;</p>
            <div className={styles.sendPreview}>{sendReview.content}</div>
            <label className={styles.confirmCheck}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the exact recipients and message.</label>
            <div className={styles.dialogActions}><button className={styles.secondaryButton} disabled={busy} onClick={() => { setSendReview(null); setConfirmed(false); }}>Cancel</button><button className={styles.primaryButton} disabled={!confirmed || busy} onClick={send}><Send aria-hidden="true" /> {busy ? "Sending..." : "Send email"}</button></div>
          </section>
        </div>
      ) : null}

      {newEmailOpen ? (
        <div className={styles.modalBackdrop} role="presentation">
          <section className={styles.draftDialog} role="dialog" aria-modal="true" aria-labelledby="new-email-heading">
            <header>
              <div>
                <span>Local draft only</span>
                <h2 id="new-email-heading">Draft a new email</h2>
              </div>
              <button className={styles.iconButtonSmall} type="button" onClick={() => setNewEmailOpen(false)} aria-label="Close new email draft">
                <X aria-hidden="true" />
              </button>
            </header>

            <p className={styles.formHelper}>
              This saves a local draft into Outbox. Gmail sends only after exact review and explicit approval; Hotmail sending stays locked for now.
            </p>
            {newEmailError ? <div className={styles.inlineError} role="alert">{newEmailError}</div> : null}

            <div className={styles.newEmailGrid}>
              <label>
                Sending account
                <select
                  value={newEmail.accountId}
                  onChange={(event) => setNewEmail((current) => ({ ...current, accountId: event.target.value }))}
                  disabled={!visibleAccounts.length}
                >
                  {visibleAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label} · {account.email} · {account.provider === "microsoft" ? "Hotmail" : "Gmail"}
                    </option>
                  ))}
                </select>
              </label>
              <RecipientField
                label="To"
                value={newEmail.to}
                onChange={(to) => setNewEmail((current) => ({ ...current, to }))}
                workspaceId={props.workspaceId}
                accountId={newEmail.accountId}
                placeholder="person@example.com, Name <name@example.com>"
              />
              <RecipientField
                label="Cc"
                value={newEmail.cc}
                onChange={(cc) => setNewEmail((current) => ({ ...current, cc }))}
                workspaceId={props.workspaceId}
                accountId={newEmail.accountId}
                placeholder="Optional"
              />
              <RecipientField
                label="Bcc"
                value={newEmail.bcc}
                onChange={(bcc) => setNewEmail((current) => ({ ...current, bcc }))}
                workspaceId={props.workspaceId}
                accountId={newEmail.accountId}
                placeholder="Optional"
              />
              <label className={styles.newEmailFull}>
                Subject
                <input value={newEmail.subject} onChange={(event) => setNewEmail((current) => ({ ...current, subject: event.target.value }))} />
              </label>
            </div>
            <label htmlFor="new-email-body">Message body</label>
            <textarea
              id="new-email-body"
              value={newEmail.body}
              onChange={(event) => setNewEmail((current) => ({ ...current, body: event.target.value }))}
              rows={10}
              placeholder="Write the exact message you want held for review."
            />

            <footer>
              <span>{props.workspace?.isAllAccounts ? "All accounts view: choose the sending identity deliberately." : `${props.workspace?.label || "Workspace"} identity is preserved.`}</span>
              <div>
                <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => setNewEmailOpen(false)}>Cancel</button>
                <button className={styles.primaryButton} type="button" disabled={busy || !visibleAccounts.length} onClick={saveNewEmail}>
                  <FilePenLine aria-hidden="true" /> {busy ? "Saving..." : "Save to Outbox"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function statusLabel(status: DraftItem["status"]) {
  if (status === "awaiting_approval") return "Needs approval";
  return status[0].toUpperCase() + status.slice(1);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
