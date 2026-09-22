"use client";

import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Sparkles, X } from "lucide-react";
import type { MessageDetail, OutgoingDraft, ReplyDraftPreparation, ReplyMode } from "@/lib/email/types";
import type { PolishReplyResult } from "@/lib/email/reply-polish";
import type { AccountWritingSettings, WritingTone } from "@/lib/email/writing-settings";
import { api, post } from "./api";
import { appendSignature, polishAcceptanceReady, replyStudioStorageKey, shouldApplyGeneratedText } from "./replyStudioState";
import styles from "./EzraMail.module.css";

type ComposeChoice = "draft" | "mine" | null;
const polishModes: Array<{ value: WritingTone; label: string }> = [
  { value: "grammar", label: "Grammar only" },
  { value: "clearer", label: "Clearer" },
  { value: "concise", label: "Concise" },
  { value: "warmer", label: "Warmer" },
  { value: "professional", label: "Professional" },
  { value: "firmer", label: "Firmer" },
];

export function ReplyStudio(props: {
  detail: MessageDetail;
  replyMode: ReplyMode;
  onClose: () => void;
  onOpenOutbox?: (draftId: string) => void;
}) {
  const storageKey = replyStudioStorageKey(props.detail.message.id, props.replyMode);
  const [choice, setChoice] = useState<ComposeChoice>(null);
  const [body, setBody] = useState("");
  const [context, setContext] = useState("");
  const [prepared, setPrepared] = useState<ReplyDraftPreparation | null>(null);
  const [settings, setSettings] = useState<AccountWritingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [polishMode, setPolishMode] = useState<WritingTone>("professional");
  const [comparison, setComparison] = useState<PolishReplyResult | null>(null);
  const [factualWarningsReviewed, setFactualWarningsReviewed] = useState(false);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "recovered">("idle");
  const [savedDraftId, setSavedDraftId] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const draftChoiceRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const generationRef = useRef(0);
  const bodyRef = useRef(body);
  const choiceRef = useRef(choice);
  bodyRef.current = body;
  choiceRef.current = choice;

  useEffect(() => {
    let recoveredDraft = false;
    if (typeof rootRef.current?.scrollIntoView === "function") {
      rootRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        const recovered = JSON.parse(stored) as { body?: string; context?: string; choice?: ComposeChoice };
        if (recovered.body) {
          recoveredDraft = true;
          setBody(recovered.body);
          setContext(recovered.context || "");
          setChoice(recovered.choice || "mine");
          setSaveState("recovered");
        }
      }
    } catch {
      // A corrupt session draft is ignored; provider and Outbox state remain untouched.
    }
    const focusTimer = window.setTimeout(() => {
      if (recoveredDraft) editorRef.current?.focus();
      else draftChoiceRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [storageKey]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const requestBody = bodyRef.current;
    setLoading(true);
    setError("");
    void Promise.all([
      post<ReplyDraftPreparation>("/api/drafts", {
        action: "prepare_reply",
        messageId: props.detail.message.id,
        replyMode: props.replyMode,
      }),
      api<AccountWritingSettings>(
        `/api/settings/writing?accountId=${encodeURIComponent(props.detail.message.accountId)}&senderEmail=${encodeURIComponent(props.detail.message.senderEmail)}`,
      ).catch(() => null),
    ])
      .then(([nextPrepared, nextSettings]) => {
        setPrepared(nextPrepared);
        if (nextSettings) {
          setSettings(nextSettings);
          setPolishMode(nextSettings.defaultTone);
        }
        if (choiceRef.current === "draft" && shouldApplyGeneratedText({
          requestGeneration: generation,
          currentGeneration: generationRef.current,
          requestBody,
          currentBody: bodyRef.current,
          requestMessageId: props.detail.message.id,
          currentMessageId: props.detail.message.id,
          requestMode: props.replyMode,
          currentMode: props.replyMode,
        })) setBody(nextPrepared.content);
      })
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : String(nextError)))
      .finally(() => setLoading(false));
  }, [props.detail.message.accountId, props.detail.message.id, props.detail.message.senderEmail, props.replyMode]);

  useEffect(() => {
    if (!body && !context && !choice) return;
    setSaveState((current) => current === "recovered" ? current : "saving");
    const timer = window.setTimeout(() => {
      sessionStorage.setItem(storageKey, JSON.stringify({ body, context, choice }));
      setSaveState("saved");
    }, 450);
    return () => window.clearTimeout(timer);
  }, [body, choice, context, storageKey]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!body.trim() || savedDraftId) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [body, savedDraftId]);

  function chooseDraft() {
    setChoice("draft");
    if (prepared && !body.trim()) setBody(prepared.content);
    window.setTimeout(() => editorRef.current?.focus(), 0);
  }

  function chooseMine() {
    setChoice("mine");
    window.setTimeout(() => editorRef.current?.focus(), 0);
  }

  async function polish() {
    const requestGeneration = ++generationRef.current;
    const requestBody = body;
    setPolishing(true);
    setComparison(null);
    setFactualWarningsReviewed(false);
    setError("");
    try {
      const result = await post<PolishReplyResult>("/api/drafts", {
        action: "polish_reply",
        messageId: props.detail.message.id,
        body: requestBody,
        mode: polishMode,
        direction: context,
      });
      if (shouldApplyGeneratedText({
        requestGeneration,
        currentGeneration: generationRef.current,
        requestBody,
        currentBody: bodyRef.current,
        requestMessageId: props.detail.message.id,
        currentMessageId: props.detail.message.id,
        requestMode: props.replyMode,
        currentMode: props.replyMode,
      })) setComparison(result);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPolishing(false);
    }
  }

  function persistAndClose() {
    if (body || context || choice) {
      sessionStorage.setItem(storageKey, JSON.stringify({ body, context, choice }));
    }
    props.onClose();
  }

  async function saveToOutbox() {
    setSaving(true);
    setError("");
    try {
      const exactBody = appendSignature(body, settings?.signature || "", Boolean(settings?.signatureEnabled));
      const outgoing = await post<OutgoingDraft>("/api/drafts", {
        action: "create_reply_outgoing",
        messageId: props.detail.message.id,
        replyMode: props.replyMode,
        body: exactBody,
        context,
      });
      sessionStorage.removeItem(storageKey);
      setSavedDraftId(outgoing.id);
      props.onOpenOutbox?.(outgoing.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section ref={rootRef} className={styles.replyStudio} aria-labelledby="reply-studio-heading">
      <header className={styles.replyStudioHeader}>
        <div><span>{props.replyMode === "all" ? "Reply all" : "Reply"} from {prepared?.accountLabel || props.detail.message.accountLabel}</span><h2 id="reply-studio-heading">Reply Studio</h2></div>
        <button type="button" className={styles.iconButtonSmall} onClick={persistAndClose} aria-label="Close Reply Studio"><X aria-hidden="true" /></button>
      </header>

      {prepared ? <div className={styles.outboxMetaGrid}><div><span>From</span><strong>{prepared.accountEmail}</strong></div><div><span>To</span><strong>{prepared.to.map((item) => item.email).join(", ")}</strong></div><div><span>Cc</span><strong>{prepared.cc.length ? prepared.cc.map((item) => item.email).join(", ") : "None"}</strong></div></div> : null}

      {savedDraftId ? (
        <div className={styles.savedState}><Check aria-hidden="true" /><strong>Saved to Outbox</strong><p>Review the exact account, recipients, text, signature, and attachments there before approval.</p><button className={styles.primaryButton} onClick={() => props.onOpenOutbox?.(savedDraftId)}>Open Outbox</button></div>
      ) : (
        <>
          <div className={styles.replyChoice} aria-label="How would you like to reply?">
            <button ref={draftChoiceRef} type="button" aria-label="Draft for me" aria-pressed={choice === "draft"} onClick={chooseDraft}><Sparkles aria-hidden="true" /><strong>Draft for me</strong><span>Ezra proposes a starting point.</span></button>
            <button type="button" aria-label="I'll write" aria-pressed={choice === "mine"} onClick={chooseMine}><strong>I'll write</strong><span>Start with a quiet blank page.</span></button>
          </div>

          {choice ? (
            <div className={styles.replyEditorArea}>
              {loading && choice === "draft" && !body ? <div className={styles.draftLoading}><LoaderCircle aria-hidden="true" /> Ezra is preparing a draft...</div> : null}
              <label htmlFor="reply-context">Optional direction</label>
              <input id="reply-context" value={context} onChange={(event) => { generationRef.current += 1; setContext(event.target.value); setComparison(null); setFactualWarningsReviewed(false); }} placeholder="Keep it brief, mention Tuesday, or adjust the tone" />
              <label htmlFor="reply-editor">Reply draft</label>
              <textarea ref={editorRef} id="reply-editor" value={body} onChange={(event) => { generationRef.current += 1; setBody(event.target.value); setComparison(null); }} rows={12} />
              <div className={styles.replyPolishBar}>
                <label htmlFor="polish-mode">Polish with Ezra</label>
                <select id="polish-mode" value={polishMode} onChange={(event) => { generationRef.current += 1; setPolishMode(event.target.value as WritingTone); setComparison(null); setFactualWarningsReviewed(false); }}>{polishModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select>
                <button type="button" className={styles.secondaryButton} disabled={polishing || !body.trim()} onClick={polish}>{polishing ? "Polishing..." : "Compare polish"}</button>
                <span aria-live="polite">{saveState === "saving" ? "Saving locally..." : saveState === "recovered" ? "Recovered local draft" : saveState === "saved" ? "Saved locally" : ""}</span>
              </div>

              {comparison ? <section className={styles.polishComparison} aria-label="Polish comparison"><div><span>Mine</span><p>{comparison.original}</p></div><div><span>Ezra's polish</span><p>{comparison.proposed}</p></div>{comparison.warnings.length ? <><ul>{comparison.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><label className={styles.polishReview}><input type="checkbox" checked={factualWarningsReviewed} onChange={(event) => setFactualWarningsReviewed(event.target.checked)} /> I reviewed the factual differences above.</label></> : null}<footer><button type="button" className={styles.secondaryButton} onClick={() => setComparison(null)}>Keep mine</button><button type="button" className={styles.primaryButton} disabled={!polishAcceptanceReady(comparison.warnings, factualWarningsReviewed)} onClick={() => { setBody(comparison.proposed); setComparison(null); setFactualWarningsReviewed(false); }}>Use polished version</button></footer></section> : null}
              {error ? <p className={styles.formError} role="alert">{error}</p> : null}
              <footer className={styles.replyStudioFooter}><span>Exact review and approval happen in Outbox. Nothing sends from here.</span><div><button type="button" className={styles.secondaryButton} onClick={persistAndClose}>Close</button><button type="button" className={styles.primaryButton} disabled={saving || !prepared || !body.trim()} onClick={saveToOutbox}>{saving ? "Saving..." : "Save to Outbox"}</button></div></footer>
            </div>
          ) : <p className={styles.replyStudioHint}>Choose a starting point. Ezra will keep this workspace out of the way until you need it.</p>}
        </>
      )}
    </section>
  );
}
