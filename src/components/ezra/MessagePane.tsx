"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ExternalLink,
  FilePenLine,
  Forward,
  LoaderCircle,
  MailCheck,
  Paperclip,
  ShieldAlert,
  Sparkles,
  Trash2,
  VolumeX,
  X,
} from "lucide-react";
import type { MailActionResult, MailCareLevel, MailCareScope, MailThreadItem, MessageDetail, OutgoingDraft, ReplyMode } from "@/lib/email/types";
import type { ProviderOrganizationCapabilities } from "@/lib/email/provider-adapter";
import { attentionLabel, mailActionCopy, notificationStatusLabel, whyThisMattersRows } from "@/lib/email/vocabulary";
import { accountWorkspaceId } from "@/lib/email/workspace-identity";
import { api, post } from "./api";
import { RecipientField, parseRecipientText } from "./RecipientField";
import { isAbortError, useLatestRequest } from "./useLatestRequest";
import { MessageReader } from "./MessageReader";
import { ReplyStudio } from "./ReplyStudio";
import styles from "./EzraMail.module.css";

type DetailPayload = {
  detail: MessageDetail;
  thread: MailThreadItem[];
  capabilities: {
    unsubscribeSupported: boolean;
    protectedMessage: boolean;
    organization?: ProviderOrganizationCapabilities;
  };
};

type AttachmentPreviewState = {
  attachmentId: string;
  name: string;
  kind: "pdf" | "image" | "text";
  objectUrl?: string;
  text?: string;
} | {
  attachmentId: string;
  name: string;
  status: "unsupported" | "too_large" | "failed";
  message: string;
};

export function MessagePane(props: {
  messageId: string | null;
  refreshToken?: number;
  workspaceId?: string | null;
  onClose: () => void;
  onOpenOutbox?: (draftId: string) => void;
  onRequestAction: (action: string, ids: string[], payload?: Record<string, unknown>) => Promise<MailActionResult>;
}) {
  const [payload, setPayload] = useState<DetailPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [replyMode, setReplyMode] = useState<ReplyMode | null>(null);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [careOpen, setCareOpen] = useState(false);
  const [careLevel, setCareLevel] = useState<MailCareLevel>("more");
  const [careScopes, setCareScopes] = useState<MailCareScope[]>(["sender", "topic"]);
  const [topicLabel, setTopicLabel] = useState("");
  const [remoteImagesAllowed, setRemoteImagesAllowed] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreviewState | null>(null);
  const beginDetailRequest = useLatestRequest();
  const mounted = useRef(false);
  const liveReader = useRef({ messageId: props.messageId, workspaceId: props.workspaceId });
  if (liveReader.current.messageId !== props.messageId || liveReader.current.workspaceId !== props.workspaceId) {
    liveReader.current = { messageId: props.messageId, workspaceId: props.workspaceId };
  }
  const readerIdentity = liveReader.current;
  const isCurrentReader = () => mounted.current && liveReader.current === readerIdentity;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!props.messageId) {
      setPayload(null);
      return;
    }
    const request = beginDetailRequest();
    setLoading(true);
    setPayload(null);
    setError("");
    void api<DetailPayload>(`/api/mail/${encodeURIComponent(props.messageId)}`, { signal: request.signal })
      .then((result) => {
        if (!request.isLatest()) return;
        if (!matchesMessageIdentity(result, props.messageId, props.workspaceId)) throw new Error("This message is unavailable in the selected account.");
        setPayload(result);
      })
      .catch((nextError) => request.isLatest() && !isAbortError(nextError) && setError(nextError instanceof Error ? nextError.message : String(nextError)))
      .finally(() => request.isLatest() && setLoading(false));
  }, [beginDetailRequest, props.messageId, props.refreshToken, props.workspaceId]);

  useEffect(() => {
    setReplyMode(null);
    setActionBusy(null);
    setActionError("");
    setMenuOpen(false);
    setForwardOpen(false);
    setAttachmentPreview(null);
  }, [props.messageId, props.workspaceId]);

  useEffect(() => () => {
    if (attachmentPreview && "objectUrl" in attachmentPreview && attachmentPreview.objectUrl) {
      URL.revokeObjectURL(attachmentPreview.objectUrl);
    }
  }, [attachmentPreview]);

  useEffect(() => {
    const detail = payload?.detail;
    if (!detail || !matchesMessageIdentity(payload, props.messageId, props.workspaceId)) return;
    let active = true;
    setRemoteImagesAllowed(false);
    void api<{ remoteImagesAllowed: boolean }>(
      `/api/settings/writing?accountId=${encodeURIComponent(detail.message.accountId)}&senderEmail=${encodeURIComponent(detail.message.senderEmail)}`,
    ).then((result) => active && setRemoteImagesAllowed(result.remoteImagesAllowed)).catch(() => undefined);
    return () => { active = false; };
  }, [payload?.detail, props.messageId, props.workspaceId]);

  async function refreshDetail() {
    // An awaited action may belong to a reader that has since changed or unmounted.
    if (!props.messageId || !isCurrentReader()) return;
    const request = beginDetailRequest();
    const result = await api<DetailPayload>(`/api/mail/${encodeURIComponent(props.messageId)}`, { signal: request.signal });
    if (isCurrentReader() && request.isLatest()) {
      if (!matchesMessageIdentity(result, props.messageId, props.workspaceId)) { setPayload(null); setError("This message is unavailable in the selected account."); return; }
      setPayload(result);
    }
  }

  function downloadAttachment(attachment: MessageDetail["attachments"][number]) {
    if (!props.messageId) return;
    const risky = /\.(exe|dll|msi|bat|cmd|ps1|js|vbs|scr|com|jar|zip|rar|7z|xlsm|docm|pptm)$/i.test(attachment.name);
    if (risky && !window.confirm(`"${attachment.name}" can contain active content. Ezra will download it without opening it. Continue?`)) return;
    const params = risky ? "?confirmRisk=true" : "";
    window.location.assign(`/api/mail/${encodeURIComponent(props.messageId)}/attachments/${encodeURIComponent(attachment.id)}${params}`);
  }

  async function previewAttachment(attachment: MessageDetail["attachments"][number]) {
    if (!props.messageId) return;
    setAttachmentPreview(null);
    try {
      const response = await fetch(`/api/mail/${encodeURIComponent(props.messageId)}/attachments/${encodeURIComponent(attachment.id)}/preview`);
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok) throw new Error("Ezra could not prepare this attachment preview.");
      if (contentType.includes("application/json")) {
        const payload = await response.json() as { preview?: { status?: "unsupported" | "too_large"; reason?: string } };
        setAttachmentPreview({
          attachmentId: attachment.id,
          name: attachment.name,
          status: payload.preview?.status === "too_large" ? "too_large" : "unsupported",
          message: payload.preview?.reason || "Ezra cannot preview this attachment safely.",
        });
        return;
      }
      const blob = await response.blob();
      if (contentType.includes("application/pdf")) {
        setAttachmentPreview({ attachmentId: attachment.id, name: attachment.name, kind: "pdf", objectUrl: URL.createObjectURL(blob) });
      } else if (contentType.startsWith("image/")) {
        setAttachmentPreview({ attachmentId: attachment.id, name: attachment.name, kind: "image", objectUrl: URL.createObjectURL(blob) });
      } else if (contentType.startsWith("text/plain")) {
        setAttachmentPreview({ attachmentId: attachment.id, name: attachment.name, kind: "text", text: await blob.text() });
      } else {
        setAttachmentPreview({ attachmentId: attachment.id, name: attachment.name, status: "failed", message: "Ezra received an unsafe attachment preview response." });
      }
    } catch (nextError) {
      setAttachmentPreview({ attachmentId: attachment.id, name: attachment.name, status: "failed", message: nextError instanceof Error ? nextError.message : "Ezra could not prepare this attachment preview." });
    }
  }

  function previewAttachmentFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, attachment: MessageDetail["attachments"][number]) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void previewAttachment(attachment);
  }

  if (!props.messageId) {
    return (
      <aside className={styles.messagePaneEmpty}>
        <MailCheck aria-hidden="true" />
        <h2>Select a conversation</h2>
        <p>Read the message, Ezra's analysis, and contact history here.</p>
      </aside>
    );
  }
  if (loading && !payload) return <aside className={styles.messagePaneLoading}><LoaderCircle aria-hidden="true" /> Loading conversation...</aside>;
  if (error) return <aside className={styles.messagePaneError}><strong>Conversation unavailable</strong><p>{error}</p><button onClick={props.onClose}>Back to mail</button></aside>;
  if (!payload || !matchesMessageIdentity(payload, props.messageId, props.workspaceId)) return null;

  const { detail } = payload;
  const message = detail.message;
  const microsoftMessage = message.accountProvider === "microsoft";
  const organization = payload.capabilities.organization || {
    pin: { state: "unavailable" as const, reason: "Ezra cannot safely map Pin for this account yet." },
    flag: { state: "unavailable" as const, reason: "Ezra cannot safely map Flag for this account yet." },
  };
  const pinCapability = organization.pin;
  const flagCapability = organization.flag;
  const providerName = message.accountProvider === "microsoft" ? "Microsoft" : "Gmail";
  const whyRows = whyThisMattersRows({
    summary: message.summary || message.snippet,
    reason: message.reason,
    recommendation: message.recommendation,
  });

  async function action(name: string, payload?: Record<string, unknown>) {
    setActionBusy(name);
    setActionError("");
    try {
      await props.onRequestAction(name, [message.id], payload);
      if (!isCurrentReader()) return false;
      setMenuOpen(false);
      if (name === "teach_care" || (props.refreshToken === undefined && ["pin", "unpin", "flag", "unflag"].includes(name))) {
        await refreshDetail();
      }
      return true;
    } catch (nextError) {
      if (isCurrentReader()) setActionError(nextError instanceof Error ? nextError.message : String(nextError));
      return false;
    } finally {
      if (isCurrentReader()) setActionBusy(null);
    }
  }

  function openCareModal() {
    setCareLevel("more");
    setCareScopes(["sender", "topic"]);
    setTopicLabel(suggestTopicLabel(message));
    setActionError("");
    setCareOpen(true);
  }

  async function alwaysShowSenderImages(senderEmail: string) {
    try {
      const result = await api<{ remoteImagesAllowed: boolean }>("/api/settings/writing", {
        method: "PATCH",
        body: JSON.stringify({ action: "sender_images", accountId: message.accountId, senderEmail, allowed: true }),
      });
      setRemoteImagesAllowed(result.remoteImagesAllowed);
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function saveCare() {
    if (!careScopes.length) {
      setActionError("Choose whether Ezra should learn from this message, sender, subject matter, or both.");
      return;
    }
    if (careScopes.includes("topic") && !topicLabel.trim()) {
      setActionError("Add a subject matter label before saving topic learning.");
      return;
    }
    const saved = await action("teach_care", { care: careLevel, scopes: careScopes, topicLabel: topicLabel.trim() });
    if (saved) setCareOpen(false);
  }

  function toggleScope(scope: MailCareScope) {
    setCareScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope); else next.add(scope);
      return Array.from(next) as MailCareScope[];
    });
  }

  return (
    <aside className={styles.messagePane} aria-label={`Conversation: ${message.subject}`}>
      <div className={styles.messagePaneTop}>
        <button className={styles.mobileBack} onClick={props.onClose}><ArrowLeft aria-hidden="true" /> Mail</button>
        <div className={styles.detailActions}>
          <button disabled={Boolean(actionBusy)} onClick={openCareModal}><Sparkles aria-hidden="true" /> {mailActionCopy("teach_care").label}</button>
          <button disabled={Boolean(actionBusy)} onClick={() => action("done")}>{actionBusy === "done" ? <LoaderCircle className={styles.buttonSpinner} aria-hidden="true" /> : <Check aria-hidden="true" />} {actionBusy === "done" ? mailActionCopy("done").progressLabel : mailActionCopy("done").label}</button>
          {pinCapability.state === "supported" ? (
            <button disabled={Boolean(actionBusy)} onClick={() => action(message.isPinned ? "unpin" : "pin")}>
              {message.isPinned ? mailActionCopy("unpin").label : mailActionCopy("pin").label}
            </button>
          ) : null}
          {flagCapability.state === "supported" ? (
            <button disabled={Boolean(actionBusy)} onClick={() => action(message.isFlagged ? "unflag" : "flag")}>
              {message.isFlagged ? mailActionCopy("unflag").label : mailActionCopy("flag").label}
            </button>
          ) : null}
          <button disabled={Boolean(actionBusy)} onClick={() => setReplyMode("sender")}><FilePenLine aria-hidden="true" /> Reply</button>
          <button disabled={Boolean(actionBusy)} onClick={() => setReplyMode("all")}><FilePenLine aria-hidden="true" /> Reply all</button>
          <button disabled={Boolean(actionBusy)} title="Save a local forward draft to Outbox." onClick={() => setForwardOpen(true)}><Forward aria-hidden="true" /> Forward</button>
          <button disabled={Boolean(actionBusy)} className={styles.dangerButtonText} onClick={() => action("delete")}>{actionBusy === "delete" ? <LoaderCircle className={styles.buttonSpinner} aria-hidden="true" /> : <Trash2 aria-hidden="true" />} {actionBusy === "delete" ? mailActionCopy("delete").progressLabel : mailActionCopy("delete").label}</button>
          <div className={styles.menuWrap}>
            <button disabled={Boolean(actionBusy)} className={styles.iconButtonSmall} onClick={() => setMenuOpen((value) => !value)} aria-expanded={menuOpen} aria-label="More message actions"><ChevronDown aria-hidden="true" /></button>
            {menuOpen ? (
              <div className={styles.actionMenu}>
                <button disabled={Boolean(actionBusy)} onClick={() => action("lower_priority")}>{mailActionCopy("lower_priority").label}</button>
                {!payload.capabilities.protectedMessage ? <button disabled={Boolean(actionBusy)} onClick={() => action("quiet")}><VolumeX aria-hidden="true" /> {mailActionCopy("quiet").label}</button> : null}
                {!microsoftMessage && payload.capabilities.unsubscribeSupported ? <button disabled={Boolean(actionBusy)} onClick={() => action("unsubscribe")}>{mailActionCopy("unsubscribe").label}</button> : null}
                <button disabled={Boolean(actionBusy)} className={styles.destructiveMenuItem} onClick={() => action("delete_and_teach")}><Sparkles aria-hidden="true" /> {mailActionCopy("delete_and_teach").label}</button>
                {!payload.capabilities.protectedMessage ? <button disabled={Boolean(actionBusy)} className={styles.destructiveMenuItem} onClick={() => action("spam")}><ShieldAlert aria-hidden="true" /> {mailActionCopy("spam").label}</button> : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {actionError ? <div className={styles.inlineError} role="alert">{actionError}</div> : null}

      <article className={styles.messageArticle}>
        <header className={styles.messageHeader}>
          <div className={styles.senderLine}>
            <span className={styles.avatarLarge}>{initials(message.senderName)}</span>
            <div><strong>{message.senderName}</strong><span>{message.senderEmail} · {message.accountLabel}</span></div>
            <time>{formatDate(message.receivedAt)}</time>
          </div>
          <h2>{message.subject}</h2>
          <div className={styles.messageBadges}>
            {message.isUnread ? <span>Unread</span> : null}
            {message.category ? <span>{humanize(message.category)}</span> : null}
            {payload.thread.length > 1 ? <span>{payload.thread.length} messages</span> : null}
            {message.hasAttachments ? <span><Paperclip aria-hidden="true" /> Attachment</span> : null}
            {message.isPinned ? <span>Pinned</span> : null}
            {message.isFlagged ? <span>Flagged</span> : null}
            {microsoftMessage ? <span>Hotmail actions enabled</span> : null}
          </div>
        </header>

        {pinCapability.state === "reconnect_required" ? <p className={styles.inlineError}>{`Reconnect ${providerName} to use Pin. ${pinCapability.reason}`}</p> : null}
        {pinCapability.state === "unavailable" ? <p className={styles.inlineError}>{`Pin is unavailable for this ${providerName} account. ${pinCapability.reason}`}</p> : null}
        {flagCapability.state === "reconnect_required" ? <p className={styles.inlineError}>{`Reconnect ${providerName} to use Flag. ${flagCapability.reason}`}</p> : null}
        {flagCapability.state === "unavailable" ? <p className={styles.inlineError}>{`Flag is unavailable for this ${providerName} account. ${flagCapability.reason}`}</p> : null}

        <section className={styles.aiBrief} aria-labelledby="ezra-analysis">
          <div className={styles.aiBriefTitle}><Sparkles aria-hidden="true" /><h3 id="ezra-analysis">Ezra's read</h3></div>
          <dl>
            {whyRows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
            {message.deadline ? <div><dt>Deadline</dt><dd>{formatDate(message.deadline)}</dd></div> : null}
          </dl>
        </section>

        {detail.careTrace ? (
          <section className={styles.careTrace} aria-labelledby="care-trace-heading">
            <div className={styles.careTraceTitle}>
              <Sparkles aria-hidden="true" />
              <h3 id="care-trace-heading">Why Ezra treated it this way</h3>
            </div>
            <dl>
              <div><dt>Original read</dt><dd>{attentionLabel(detail.careTrace.originalAttention)}</dd></div>
              <div><dt>Current care</dt><dd>{attentionLabel(detail.careTrace.currentAttention)}</dd></div>
              <div><dt>User correction</dt><dd>{attentionLabel(detail.careTrace.correctedAttention)}</dd></div>
              <div><dt>Notification</dt><dd>{notificationStatusLabel(detail.careTrace.notificationStatus, detail.careTrace.notificationSentAt ? formatDate(detail.careTrace.notificationSentAt) : null)}</dd></div>
            </dl>
            {detail.careTrace.matchingPreferences.length ? (
              <div className={styles.preferenceChips}>
                {detail.careTrace.matchingPreferences.map((preference) => (
                  <span key={`${preference.kind}-${preference.pattern}-${preference.action}`}>
                    {preference.kind}: {preference.pattern} → {attentionLabel(preference.action)}
                  </span>
                ))}
              </div>
            ) : <p>No matching sender or topic preference was applied.</p>}
            <p>Use <b>{mailActionCopy("teach_care").label}</b> to correct the sender, subject matter, or this thread.</p>
          </section>
        ) : null}

        <section className={styles.bodySection}>
          <MessageReader
            content={detail.content}
            fallbackText={detail.bodyText || message.snippet}
            isExcerpt={detail.bodyIsExcerpt}
            senderEmail={message.senderEmail}
            remoteImagesAllowed={remoteImagesAllowed}
            onAlwaysShowImages={alwaysShowSenderImages}
          />
          {message.gmailUrl && message.gmailUrl !== "#" ? <a className={styles.originalLink} href={message.gmailUrl} target="_blank" rel="noreferrer">Open original <ExternalLink aria-hidden="true" /></a> : null}
        </section>

        {detail.attachments.length ? (
          <section className={styles.attachmentSection} aria-labelledby="attachments-heading">
            <h3 id="attachments-heading">Attachments</h3>
            {detail.attachments.map((attachment) => (
              <div key={attachment.id}>
                <button type="button" onClick={() => downloadAttachment(attachment)}><Paperclip aria-hidden="true" /><span>{attachment.name}</span><small>{formatBytes(attachment.size)} · Download</small></button>
                <dl className={styles.attachmentMetadata} aria-label={`Attachment details for ${attachment.name}`}>
                  <div><dt>Provider-reported type</dt><dd>{attachment.mimeType || "application/octet-stream"}</dd></div>
                  <div><dt>Verified type</dt><dd>Ezra checks the file only after you choose Preview.</dd></div>
                  <div><dt>Source</dt><dd>{providerName} account {message.accountLabel} · {message.subject}</dd></div>
                  <div><dt>Availability</dt><dd>Download remains available; preview never opens the file automatically.</dd></div>
                </dl>
                <button type="button" onClick={() => void previewAttachment(attachment)} onKeyDown={(event) => previewAttachmentFromKeyboard(event, attachment)} aria-label={`Preview ${attachment.name}`}>Preview</button>
                {attachmentPreview?.attachmentId === attachment.id ? (
                  "status" in attachmentPreview ? <p className={styles.inlineError}>{attachmentPreview.message}</p>
                    : attachmentPreview.kind === "pdf" ? <iframe title="Attachment preview" sandbox="" src={attachmentPreview.objectUrl} />
                      : attachmentPreview.kind === "image" ? <img src={attachmentPreview.objectUrl} alt={`Preview of ${attachmentPreview.name}`} />
                        : <pre>{attachmentPreview.text}</pre>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}

        <section className={styles.contactMemory} aria-labelledby="contact-memory-heading">
          <h3 id="contact-memory-heading">Contact memory</h3>
          <p>{detail.contactMemory.summary}</p>
          <div className={styles.memoryGrid}>
            {detail.contactMemory.categories.map((category) => <div key={category.label}><strong>{category.label}</strong><span>{category.summary}</span></div>)}
          </div>
        </section>
      </article>

      {replyMode ? <ReplyStudio key={`${message.id}:${replyMode}`} detail={detail} replyMode={replyMode} onClose={() => setReplyMode(null)} onOpenOutbox={props.onOpenOutbox} /> : null}
      {forwardOpen ? <ForwardComposer detail={detail} workspaceId={props.workspaceId} onClose={() => setForwardOpen(false)} onOpenOutbox={props.onOpenOutbox} /> : null}
      {careOpen ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => !actionBusy && setCareOpen(false)}>
          <section className={styles.careDialog} role="dialog" aria-modal="true" aria-labelledby="care-heading" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><span>Teach Ezra</span><h2 id="care-heading">{message.subject}</h2></div>
              <button className={styles.iconButtonSmall} disabled={Boolean(actionBusy)} onClick={() => setCareOpen(false)} aria-label="Close care tuning"><X aria-hidden="true" /></button>
            </header>
            <fieldset>
              <legend>How much should Ezra care?</legend>
              <label><input type="radio" name="care-level" checked={careLevel === "more"} onChange={() => setCareLevel("more")} /> Care more <span>Priority / needs attention</span></label>
              <label><input type="radio" name="care-level" checked={careLevel === "useful"} onChange={() => setCareLevel("useful")} /> Keep useful <span>Brief-worthy, not urgent</span></label>
              <label><input type="radio" name="care-level" checked={careLevel === "less"} onChange={() => setCareLevel("less")} /> Care less <span>Quiet / cleanup</span></label>
            </fieldset>
            <fieldset>
              <legend>What should Ezra learn from?</legend>
              <label><input type="checkbox" checked={careScopes.includes("message")} onChange={() => toggleScope("message")} /> This message chain <span>Correct this conversation now</span></label>
              <label><input type="checkbox" checked={careScopes.includes("sender")} onChange={() => toggleScope("sender")} /> Sender <span>{message.senderEmail}</span></label>
              <label><input type="checkbox" checked={careScopes.includes("topic")} onChange={() => toggleScope("topic")} /> Subject matter <span>Apply to similar future mail in this account</span></label>
            </fieldset>
            {careScopes.includes("topic") ? (
              <label className={styles.topicLabelField} htmlFor="care-topic">Subject matter label
                <input id="care-topic" value={topicLabel} onChange={(event) => setTopicLabel(event.target.value)} placeholder="job application / interview request" />
              </label>
            ) : null}
            {actionError ? <p className={styles.formError} role="alert">{actionError}</p> : null}
            <footer>
              <span>Sender and topic lessons stay scoped to this account/workspace.</span>
              <div>
                <button className={styles.secondaryButton} disabled={Boolean(actionBusy)} onClick={() => setCareOpen(false)}>Cancel</button>
                <button className={styles.primaryButton} disabled={Boolean(actionBusy)} onClick={saveCare}>{actionBusy === "teach_care" ? "Teaching..." : "Save lesson"}</button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}
    </aside>
  );
}

function suggestTopicLabel(message: MessageDetail["message"]) {
  const category = message.category ? humanize(message.category).toLowerCase() : "";
  if (category && category !== "general" && category !== "uncategorized") return category;
  return message.subject
    .replace(/^\s*(re|fw|fwd):\s*/i, "")
    .replace(/[^\w\s/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 80) || "important subject matter";
}

function ForwardComposer(props: { detail: MessageDetail; workspaceId?: string | null; onClose: () => void; onOpenOutbox?: (draftId: string) => void }) {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(() => forwardSubject(props.detail.message.subject));
  const [body, setBody] = useState(() => defaultForwardBody(props.detail));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedDraftId, setSavedDraftId] = useState<string | null>(null);

  async function saveForward() {
    setSaving(true);
    setError("");
    try {
      const draft = await post<OutgoingDraft>("/api/drafts", {
        action: "forward_create",
        messageId: props.detail.message.id,
        to: parseRecipientText(to),
        cc: parseRecipientText(cc),
        bcc: parseRecipientText(bcc),
        subject,
        body,
      });
      setSavedDraftId(draft.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.modalBackdrop} role="presentation">
      <section className={styles.draftDialog} role="dialog" aria-modal="true" aria-labelledby="forward-heading">
        <header>
          <div>
            <span>Forward from {props.detail.message.accountLabel}</span>
            <h2 id="forward-heading">{props.detail.message.subject}</h2>
          </div>
          <button className={styles.iconButtonSmall} onClick={props.onClose} aria-label="Close forward draft"><X aria-hidden="true" /></button>
        </header>

        {savedDraftId ? (
          <div className={styles.savedState}>
            <Check aria-hidden="true" />
            <strong>Saved to Outbox</strong>
            <p>Ezra created a local forward draft. Nothing has been sent.</p>
            <div className={styles.dialogActions}>
              <button className={styles.secondaryButton} onClick={props.onClose}>Done</button>
              {props.onOpenOutbox ? <button className={styles.primaryButton} onClick={() => props.onOpenOutbox?.(savedDraftId)}>Open Outbox</button> : null}
            </div>
          </div>
        ) : (
          <>
            <p className={styles.formHelper}>
              This creates a local forward draft in Outbox using the original message's sending account. Provider sending stays locked until exact-review send is enabled.
            </p>
            <div className={styles.newEmailGrid}>
              <RecipientField
                label="To"
                value={to}
                onChange={setTo}
                workspaceId={props.workspaceId}
                accountId={props.detail.message.accountId}
                placeholder="person@example.com, Name <name@example.com>"
              />
              <RecipientField
                label="Cc"
                value={cc}
                onChange={setCc}
                workspaceId={props.workspaceId}
                accountId={props.detail.message.accountId}
                placeholder="Optional"
              />
              <RecipientField
                label="Bcc"
                value={bcc}
                onChange={setBcc}
                workspaceId={props.workspaceId}
                accountId={props.detail.message.accountId}
                placeholder="Optional"
              />
              <label className={styles.newEmailFull}>
                Subject
                <input value={subject} onChange={(event) => setSubject(event.target.value)} />
              </label>
            </div>
            <label htmlFor="forward-body">Forward body</label>
            <textarea id="forward-body" value={body} onChange={(event) => setBody(event.target.value)} rows={12} />
            {props.detail.bodyIsExcerpt ? <p className={styles.excerptNotice}>This forward starts from the locally available excerpt. Open the original if you need the full provider body.</p> : null}
            {error ? <p className={styles.formError} role="alert">{error}</p> : null}
            <footer>
              <span>{props.detail.message.accountLabel} identity is preserved.</span>
              <div>
                <button className={styles.secondaryButton} onClick={props.onClose}>Cancel</button>
                <button className={styles.primaryButton} disabled={saving || !body.trim()} onClick={saveForward}>
                  <Forward aria-hidden="true" /> {saving ? "Saving..." : "Save to Outbox"}
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

function forwardSubject(subject: string) {
  return /^\s*(fwd?|fw):/i.test(subject) ? subject.trim() : `Fwd: ${subject.trim() || "(no subject)"}`;
}

function defaultForwardBody(detail: MessageDetail) {
  const message = detail.message;
  return [
    "",
    "",
    "---------- Forwarded message ----------",
    `From: ${message.senderName} <${message.senderEmail}>`,
    `Date: ${formatDate(message.receivedAt)}`,
    `Subject: ${message.subject}`,
    "",
    detail.bodyText || message.snippet,
  ].join("\n");
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  return `${Math.round(value / 1_024)} KB`;
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(value: string) {
  return value.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

function matchesMessageIdentity(payload: DetailPayload | null, messageId: string | null, workspaceId?: string | null) {
  const message = payload?.detail?.message;
  if (!message || message.id !== messageId) return false;
  if (!workspaceId?.startsWith("workspace:account:")) return true;
  return (message.accountProvider === "gmail" || message.accountProvider === "microsoft")
    && accountWorkspaceId(message.accountProvider, message.accountId) === workspaceId;
}
