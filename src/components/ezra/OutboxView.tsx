"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  FilePenLine,
  LoaderCircle,
  Paperclip,
  RotateCcw,
  Send,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { OutboxActionResult, OutboxItem, OutboxPage, OutgoingApprovalSnapshot, OutgoingDraftStatus } from "@/lib/email/types";
import { api, post } from "./api";
import { isInitialPanelLoad } from "./refreshState";
import { isAbortError, useLatestRequest } from "./useLatestRequest";
import styles from "./EzraMail.module.css";

type OutboxFilter = "active" | "blocked" | "failed" | "sent" | "cancelled" | "all";

type OutboxViewProps = {
  workspaceId: string;
  initialDraftId?: string | null;
};

const FILTERS: Array<{ id: OutboxFilter; label: string }> = [
  { id: "active", label: "Active" },
  { id: "blocked", label: "Blocked" },
  { id: "failed", label: "Failed" },
  { id: "sent", label: "Sent" },
  { id: "cancelled", label: "Cancelled" },
  { id: "all", label: "All" },
];

export function OutboxView({ workspaceId, initialDraftId }: OutboxViewProps) {
  const [page, setPage] = useState<OutboxPage | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(initialDraftId || null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(Boolean(initialDraftId));
  const [filter, setFilter] = useState<OutboxFilter>("active");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyDraftId, setBusyDraftId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewItem, setReviewItem] = useState<OutboxItem | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const beginRequest = useLatestRequest();

  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    const request = beginRequest();
    if (options.quiet) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setError("");
    }
    try {
      const params = new URLSearchParams({ workspaceId });
      const result = await api<OutboxPage>(`/api/outbox?${params.toString()}`, { signal: request.signal });
      if (!request.isLatest()) return;
      setPage(result);
      setSelectedDraftId((current) => {
        if (current && result.items.some((item) => item.draftId === current)) return current;
        if (initialDraftId && result.items.some((item) => item.draftId === initialDraftId)) return initialDraftId;
        return result.items[0]?.draftId || null;
      });
    } catch (nextError) {
      if (!options.quiet && request.isLatest() && !isAbortError(nextError)) setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (request.isLatest()) {
        if (options.quiet) setRefreshing(false);
        else setLoading(false);
      }
    }
  }, [beginRequest, initialDraftId, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refresh = () => void load({ quiet: true });
    window.addEventListener("ezra:refresh", refresh);
    return () => window.removeEventListener("ezra:refresh", refresh);
  }, [load]);

  const items = page?.items || [];
  const filtered = useMemo(() => items.filter((item) => matchesFilter(item, filter)), [filter, items]);
  const selected = items.find((item) => item.draftId === selectedDraftId) || null;

  useEffect(() => {
    if (initialDraftId && items.some((item) => item.draftId === initialDraftId)) {
      setSelectedDraftId(initialDraftId);
      setMobileDetailOpen(true);
    }
  }, [initialDraftId, items]);

  useEffect(() => {
    setSelectedDraftId((current) => {
      if (current && filtered.some((item) => item.draftId === current)) return current;
      return current ? filtered[0]?.draftId || null : null;
    });
  }, [filtered]);

  async function runOutboxAction(action: "cancel" | "send" | "retry" | "reconcile", item: OutboxItem) {
    setBusyDraftId(item.draftId);
    setError("");
    setNotice("");
    try {
      const result = await post<OutboxActionResult>("/api/outbox/actions", { action, draftId: item.draftId });
      if (result.ok) setNotice(result.message);
      else setError(result.message);
      await load({ quiet: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyDraftId(null);
    }
  }

  async function startApprovalReview(item: OutboxItem) {
    setBusyDraftId(item.draftId);
    setError("");
    setNotice("");
    setReviewConfirmed(false);
    try {
      const result = await post<OutboxActionResult>("/api/outbox/actions", {
        action: "request_approval",
        draftId: item.draftId,
      });
      if (result.ok && result.item) {
        setReviewItem(result.item);
        await load({ quiet: true });
      } else {
        setError(result.message || "Could not prepare exact review.");
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyDraftId(null);
    }
  }

  async function approveReview() {
    if (!reviewItem) return;
    const snapshot = approvalSnapshotForItem(reviewItem);
    setBusyDraftId(reviewItem.draftId);
    setError("");
    setNotice("");
    try {
      const result = await post<OutboxActionResult>("/api/outbox/actions", {
        action: "approve",
        draftId: reviewItem.draftId,
        contentHash: snapshot.contentHash,
      });
      if (result.ok) {
        setNotice(result.message);
        setReviewItem(null);
        setReviewConfirmed(false);
        await load({ quiet: true });
      } else {
        setError(result.message);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyDraftId(null);
    }
  }

  async function uploadAttachments(files: FileList | null, item: OutboxItem) {
    if (!files?.length) return;
    setAttachmentBusy(true);
    setError("");
    setNotice("");
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set("file", file);
        const response = await fetch(`/api/outbox/${encodeURIComponent(item.draftId)}/attachments`, { method: "POST", body: form });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error || "Attachment upload failed.");
      }
      setNotice(`${files.length} attachment${files.length === 1 ? "" : "s"} added. Exact approval was reset.`);
      await load({ quiet: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function removeAttachment(item: OutboxItem, attachmentId: string) {
    setAttachmentBusy(true);
    setError("");
    try {
      await api(`/api/outbox/${encodeURIComponent(item.draftId)}/attachments`, { method: "DELETE", body: JSON.stringify({ attachmentId }) });
      setNotice("Attachment removed. Exact approval was reset.");
      await load({ quiet: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setAttachmentBusy(false);
    }
  }

  const counts = page?.counts;

  return (
    <div className={styles.outboxView} aria-busy={refreshing || loading}>
      <section className={styles.actionCenterHero}>
        <div>
          <span className={styles.dialogEyebrow}>Send Safety Queue</span>
          <h2>Outbox</h2>
          <p>
            Review outgoing mail before any provider write happens. Ezra can hold,
            block, cancel, and send through connected providers only after exact approval.
          </p>
        </div>
        <div className={styles.actionCenterCounts} aria-label="Outbox counts">
          <div className={styles.actionCenterCount}>
            <strong>{counts?.total ?? 0}</strong>
            <span>Total</span>
          </div>
          <div className={styles.actionCenterCount}>
            <strong>{counts?.awaitingApproval ?? 0}</strong>
            <span>Awaiting</span>
          </div>
          <div className={`${styles.actionCenterCount} ${counts?.blocked ? styles.actionCenterCountRepair : ""}`}>
            <strong>{counts?.blocked ?? 0}</strong>
            <span>Blocked</span>
          </div>
        </div>
      </section>

      <div className={styles.draftFilters} role="tablist" aria-label="Outbox filters">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            className={filter === item.id ? styles.segmentActive : ""}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {notice ? <div className={styles.successNotice} role="status"><Check aria-hidden="true" /> {notice}</div> : null}
      {error ? <div className={styles.inlineError} role="alert">{error}</div> : null}

      <div className={`${styles.draftWorkspace} ${styles.outboxWorkspace} ${selected && mobileDetailOpen ? styles.draftWorkspaceSelected : ""}`}>
        <section className={styles.draftList} aria-label="Outbox queue">
          <header>
            <div>
              <h2>Send queue</h2>
              <span>{filtered.length} item{filtered.length === 1 ? "" : "s"} in this view</span>
            </div>
          </header>

          {isInitialPanelLoad(loading, Boolean(items.length)) ? (
            <div className={styles.listLoading}><LoaderCircle aria-hidden="true" /> Loading outbox...</div>
          ) : null}

          {!loading && !filtered.length ? (
            <div className={styles.draftEmpty}>
              <ShieldCheck aria-hidden="true" />
              <h3>No outbox items here</h3>
              <p>Create a new email or forward draft, then it will appear here for exact review.</p>
            </div>
          ) : null}

          {filtered.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${styles.draftRow} ${item.draftId === selectedDraftId ? styles.draftRowActive : ""}`}
              onClick={() => { setSelectedDraftId(item.draftId); setMobileDetailOpen(true); }}
            >
              <span>
                <strong>{item.subject || "(No subject)"}</strong>
                <small>{item.accountLabel} · {sourceLabel(item.sourceType)} · v{item.version}</small>
                <small>{item.to.length ? `To ${formatRecipients(item.to)}` : "No recipients yet"}</small>
              </span>
              <span className={`${styles.statusBadge} ${styles[`status_${item.status}`] || ""}`}>
                {statusLabel(item.status)}
              </span>
            </button>
          ))}
        </section>

        {selected ? (
          <section className={styles.draftEditor} aria-labelledby="outbox-detail-heading">
            <button className={styles.mobileBack} onClick={() => setMobileDetailOpen(false)}><ArrowLeft aria-hidden="true" /> Outbox</button>
            <header>
              <div>
                <span>{selected.accountLabel} · {selected.accountProvider === "microsoft" ? "Hotmail / Outlook" : "Gmail"} · {sourceLabel(selected.sourceType)}</span>
                <h2 id="outbox-detail-heading">{selected.subject || "(No subject)"}</h2>
              </div>
              <span className={`${styles.statusBadge} ${styles[`status_${selected.status}`] || ""}`}>
                {statusLabel(selected.status)}
              </span>
            </header>

            <div className={styles.outboxMetaGrid}>
              <div><span>From</span><strong>{selected.fromEmail}</strong></div>
              <div><span>To</span><strong>{selected.to.length ? formatRecipients(selected.to) : "No recipients"}</strong></div>
              <div><span>Cc</span><strong>{selected.cc.length ? formatRecipients(selected.cc) : "None"}</strong></div>
              <div><span>Bcc</span><strong>{selected.bcc.length ? `${selected.bcc.length} hidden recipient${selected.bcc.length === 1 ? "" : "s"}` : "None"}</strong></div>
              <div><span>Updated</span><strong>{formatDate(selected.updatedAt)}</strong></div>
              <div><span>Content hash</span><strong>{selected.contentHash.slice(0, 12)}</strong></div>
              {selected.replyMode ? <div><span>Reply mode</span><strong>{selected.replyMode === "all" ? "Reply all" : "Reply"}</strong></div> : null}
            </div>

            {selected.blockedReason ? (
              <div className={styles.outboxSafetyNotice}>
                <Ban aria-hidden="true" />
                <div>
                  <strong>Provider send is locked</strong>
                  <p>{selected.blockedReason}</p>
                </div>
              </div>
            ) : null}

            {selected.status === "approved" ? (
              <div className={styles.outboxApprovalNotice}>
                <ShieldCheck aria-hidden="true" />
                <div>
                  <strong>Exact draft approved</strong>
                  <p>{selected.canSend
                    ? `Ezra has an approval snapshot for this exact content. The ${selected.accountProvider === "microsoft" ? "Hotmail" : "Gmail"} send button is now unlocked for this draft only.`
                    : "Ezra has an approval snapshot for this exact content, but this provider is still locked for sending."}</p>
                </div>
              </div>
            ) : null}

            {selected.lastError ? (
              <div className={styles.outboxErrorNotice}>
                <AlertTriangle aria-hidden="true" />
                <div>
                  <strong>Last send error</strong>
                  <p>{selected.lastError}</p>
                </div>
              </div>
            ) : null}

            <label htmlFor="outbox-exact-body">Exact message body</label>
            <textarea id="outbox-exact-body" value={selected.body} readOnly />

            <section className={styles.outgoingAttachments} aria-labelledby="outgoing-attachments-heading">
              <header><div><h3 id="outgoing-attachments-heading">Attachments</h3><span>{selected.attachments.length} file{selected.attachments.length === 1 ? "" : "s"} · 20 MB total limit</span></div>
                {!['sent', 'cancelled', 'sending'].includes(selected.status) ? <label className={styles.secondaryButton}><Paperclip aria-hidden="true" /> {attachmentBusy ? "Working..." : "Add files"}<input type="file" multiple accept=".pdf,.docx,.xlsx,.csv,.txt,.png,.jpg,.jpeg" disabled={attachmentBusy} onChange={(event) => { void uploadAttachments(event.target.files, selected); event.currentTarget.value = ""; }} /></label> : null}
              </header>
              {selected.attachments.map((attachment) => <div key={attachment.id}><Paperclip aria-hidden="true" /><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size)} · SHA-256 {attachment.sha256.slice(0, 10)}</small></span>{!['sent', 'cancelled', 'sending'].includes(selected.status) ? <button className={styles.iconButtonSmall} disabled={attachmentBusy} onClick={() => void removeAttachment(selected, attachment.id)} aria-label={`Remove ${attachment.name}`}>x</button> : null}</div>)}
              {!selected.attachments.length ? <p>No files attached. Original received attachments are never forwarded automatically.</p> : null}
            </section>

            <footer>
              <div>
                <span>Created {formatDate(selected.createdAt)}</span>
                <span>{selected.recipientCount} recipient{selected.recipientCount === 1 ? "" : "s"} · {selected.sourceMessageId ? "Linked to source mail" : "Manual outgoing draft"}</span>
              </div>
              <div className={styles.draftActionButtons}>
                {selected.status === "draft" || selected.status === "awaiting_approval" ? (
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={busyDraftId === selected.draftId}
                    onClick={() => startApprovalReview(selected)}
                  >
                    {busyDraftId === selected.draftId ? <LoaderCircle aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                    {selected.status === "awaiting_approval" ? "Continue review" : "Review exact draft"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={busyDraftId === selected.draftId || !selected.canRetry}
                  title={selected.canRetry ? "Retry send" : selected.blockedReason || "Retry is not available yet."}
                  onClick={() => runOutboxAction("retry", selected)}
                >
                  <RotateCcw aria-hidden="true" /> Retry
                </button>
                {selected.canReconcile ? (
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={busyDraftId === selected.draftId}
                    onClick={() => runOutboxAction("reconcile", selected)}
                  >
                    <RotateCcw aria-hidden="true" /> Check provider status
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={busyDraftId === selected.draftId || !selected.canSend}
                  title={selected.canSend ? "Send after approval" : selected.blockedReason || "Send is not enabled yet."}
                  onClick={() => runOutboxAction("send", selected)}
                >
                  {busyDraftId === selected.draftId ? <LoaderCircle aria-hidden="true" /> : <Send aria-hidden="true" />}
                  Send
                </button>
                {selected.canCancel ? (
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={busyDraftId === selected.draftId}
                    title="Cancel draft"
                    onClick={() => runOutboxAction("cancel", selected)}
                  >
                    {busyDraftId === selected.draftId ? <LoaderCircle aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                    Cancel draft
                  </button>
                ) : null}
              </div>
            </footer>
          </section>
        ) : (
          <section className={styles.draftEditorEmpty}>
            <FilePenLine aria-hidden="true" />
            <h2>Select an outbox item</h2>
          </section>
        )}
      </div>

      {reviewItem ? (
        <ApprovalReviewDialog
          item={reviewItem}
          confirmed={reviewConfirmed}
          busy={busyDraftId === reviewItem.draftId}
          onConfirmChange={setReviewConfirmed}
          onApprove={approveReview}
          onClose={() => {
            if (busyDraftId !== reviewItem.draftId) {
              setReviewItem(null);
              setReviewConfirmed(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function ApprovalReviewDialog(props: {
  item: OutboxItem;
  confirmed: boolean;
  busy: boolean;
  onConfirmChange: (confirmed: boolean) => void;
  onApprove: () => void;
  onClose: () => void;
}) {
  const snapshot = approvalSnapshotForItem(props.item);
  return (
    <div className={styles.modalBackdrop} role="presentation">
      <section className={styles.sendDialog} role="dialog" aria-modal="true" aria-labelledby="outbox-approval-heading">
        <span className={styles.dialogEyebrow}>Exact outgoing approval</span>
        <h2 id="outbox-approval-heading">Approve this exact draft?</h2>
        <p>Ezra will only mark this local draft approved. No Gmail or Hotmail provider write happens in this step.</p>

        <div className={styles.outboxMetaGrid}>
          <div><span>From</span><strong>{snapshot.fromEmail}</strong></div>
          <div><span>To</span><strong>{snapshot.to.length ? formatRecipients(snapshot.to) : "No recipients"}</strong></div>
          <div><span>Cc</span><strong>{snapshot.cc.length ? formatRecipients(snapshot.cc) : "None"}</strong></div>
          <div><span>Bcc</span><strong>{snapshot.bcc.length ? `${snapshot.bcc.length} hidden recipient${snapshot.bcc.length === 1 ? "" : "s"}` : "None"}</strong></div>
          <div><span>Subject</span><strong>{snapshot.subject || "(No subject)"}</strong></div>
          <div><span>Hash</span><strong>{snapshot.contentHash.slice(0, 12)}</strong></div>
        </div>

        <div className={styles.sendPreview}>{snapshot.body}</div>
        {snapshot.attachments.length ? <div className={styles.approvalAttachments}><strong>Exact attachments</strong>{snapshot.attachments.map((attachment) => <span key={attachment.id}><Paperclip aria-hidden="true" /> {attachment.name} · {formatBytes(attachment.size)} · SHA-256 {attachment.sha256.slice(0, 10)}</span>)}</div> : null}
        <label className={styles.confirmCheck}>
          <input
            type="checkbox"
            checked={props.confirmed}
            onChange={(event) => props.onConfirmChange(event.target.checked)}
          />
          I reviewed the exact sender, recipients, subject, body, attachments, and content hash.
        </label>
        <div className={styles.dialogActions}>
          <button className={styles.secondaryButton} disabled={props.busy} onClick={props.onClose}>Cancel</button>
          <button className={styles.primaryButton} disabled={!props.confirmed || props.busy} onClick={props.onApprove}>
            {props.busy ? <LoaderCircle aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
            Approve exact draft
          </button>
        </div>
      </section>
    </div>
  );
}

function matchesFilter(item: OutboxItem, filter: OutboxFilter) {
  if (filter === "all") return true;
  if (filter === "blocked") return Boolean(item.blockedReason) && item.status !== "sent" && item.status !== "cancelled";
  if (filter === "active") return ["draft", "awaiting_approval", "approved", "sending", "failed", "send_unknown"].includes(item.status);
  return item.status === filter;
}

function sourceLabel(sourceType: OutboxItem["sourceType"]) {
  if (sourceType === "forward") return "Forward";
  if (sourceType === "new") return "New email";
  return "Reply";
}

function statusLabel(status: OutgoingDraftStatus) {
  if (status === "awaiting_approval") return "Needs approval";
  if (status === "send_unknown") return "Send unconfirmed";
  return status[0].toUpperCase() + status.slice(1).replace("_", " ");
}

function formatRecipients(recipients: OutboxItem["to"]) {
  return recipients
    .map((recipient) => recipient.name ? `${recipient.name} <${recipient.email}>` : recipient.email)
    .join(", ");
}

function approvalSnapshotForItem(item: OutboxItem): OutgoingApprovalSnapshot {
  if (item.approvalSnapshot) {
    try {
      const parsed = JSON.parse(item.approvalSnapshot) as OutgoingApprovalSnapshot;
      if (parsed?.contentHash && parsed?.draftId) return { ...parsed, attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [] };
    } catch {
      // Fall back to the visible item below.
    }
  }
  return {
    draftId: item.draftId,
    sourceType: item.sourceType,
    sourceMessageId: item.sourceMessageId,
    replyMode: item.replyMode,
    accountId: item.accountId,
    accountLabel: item.accountLabel,
    accountEmail: item.accountEmail,
    accountProvider: item.accountProvider,
    fromEmail: item.fromEmail,
    to: item.to,
    cc: item.cc,
    bcc: item.bcc,
    subject: item.subject,
    body: item.body,
    attachments: item.attachments,
    contentHash: item.contentHash,
    version: item.version,
    requestedAt: item.updatedAt,
  };
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / 1024 / 102.4) / 10} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
