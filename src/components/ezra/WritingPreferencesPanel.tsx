"use client";

import { useEffect, useState } from "react";
import { Check, PenLine } from "lucide-react";
import type { AccountWritingSettings, WritingLength, WritingTone } from "@/lib/email/writing-settings";
import { api } from "./api";
import styles from "./EzraMail.module.css";

type AccountSummary = { id: string; label: string; email: string };
type Draft = Pick<AccountWritingSettings, "signature" | "signatureEnabled" | "defaultTone" | "preferredLength">;

export function WritingPreferencesPanel(props: { accounts: AccountSummary[] }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all(props.accounts.map(async (account) => [
      account.id,
      await api<AccountWritingSettings>(`/api/settings/writing?accountId=${encodeURIComponent(account.id)}`),
    ] as const)).then((rows) => {
      if (!active) return;
      setDrafts(Object.fromEntries(rows.map(([accountId, value]) => [accountId, draftFromSettings(value)])));
    }).catch((nextError) => active && setError(nextError instanceof Error ? nextError.message : String(nextError)));
    return () => { active = false; };
  }, [props.accounts]);

  function update(accountId: string, patch: Partial<Draft>) {
    setSaved(null);
    setDrafts((current) => ({ ...current, [accountId]: { ...defaultDraft(), ...current[accountId], ...patch } }));
  }

  async function save(accountId: string) {
    const draft = drafts[accountId];
    if (!draft) return;
    setBusy(accountId);
    setError("");
    try {
      const result = await api<AccountWritingSettings>("/api/settings/writing", {
        method: "PATCH",
        body: JSON.stringify({ action: "update_writing", accountId, ...draft }),
      });
      setDrafts((current) => ({ ...current, [accountId]: draftFromSettings(result) }));
      setSaved(accountId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={styles.writingPreferences} aria-labelledby="writing-preferences-heading">
      <header><div className={styles.settingsIcon}><PenLine aria-hidden="true" /></div><div><h2 id="writing-preferences-heading">Reply voice and signature</h2><p>Set a calm default for each sending account. Ezra shows every proposed change before it is used.</p></div></header>
      <div className={styles.writingPreferenceList}>
        {props.accounts.map((account) => {
          const draft = drafts[account.id] || defaultDraft();
          return (
            <article key={account.id}>
              <header><div><strong>{account.label}</strong><span>{account.email}</span></div>{saved === account.id ? <span className={styles.writingSaved}><Check aria-hidden="true" /> Saved</span> : null}</header>
              <div className={styles.writingPreferenceGrid}>
                <label>Default polish tone<select value={draft.defaultTone} onChange={(event) => update(account.id, { defaultTone: event.target.value as WritingTone })}><option value="professional">Professional</option><option value="warmer">Warmer</option><option value="clearer">Clearer</option><option value="concise">Concise</option><option value="grammar">Grammar only</option><option value="firmer">Firmer</option></select></label>
                <label>Preferred length<select value={draft.preferredLength} onChange={(event) => update(account.id, { preferredLength: event.target.value as WritingLength })}><option value="brief">Brief</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select></label>
              </div>
              <label className={styles.signatureToggle}><input type="checkbox" checked={draft.signatureEnabled} onChange={(event) => update(account.id, { signatureEnabled: event.target.checked })} /> Add this signature when saving a reply to Outbox</label>
              <label>Signature<textarea rows={4} value={draft.signature} disabled={!draft.signatureEnabled} onChange={(event) => update(account.id, { signature: event.target.value })} placeholder="Your name and preferred sign-off" /></label>
              <footer><span>Signatures remain editable in Outbox and are included in exact review.</span><button type="button" className={styles.secondaryButton} disabled={busy === account.id} onClick={() => save(account.id)}>{busy === account.id ? "Saving..." : "Save writing settings"}</button></footer>
            </article>
          );
        })}
      </div>
      {error ? <p className={styles.formError} role="alert">{error}</p> : null}
    </section>
  );
}

function defaultDraft(): Draft {
  return { signature: "", signatureEnabled: false, defaultTone: "professional", preferredLength: "balanced" };
}

function draftFromSettings(settings: AccountWritingSettings): Draft {
  return {
    signature: settings.signature,
    signatureEnabled: settings.signatureEnabled,
    defaultTone: settings.defaultTone,
    preferredLength: settings.preferredLength,
  };
}
