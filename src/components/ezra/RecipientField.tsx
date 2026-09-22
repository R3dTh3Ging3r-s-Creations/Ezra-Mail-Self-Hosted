"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { ContactSuggestion, ContactSuggestionPage, EmailRecipient } from "@/lib/email/types";
import { api } from "./api";
import styles from "./EzraMail.module.css";

export function RecipientField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  workspaceId?: string | null;
  accountId?: string | null;
  placeholder?: string;
}) {
  const id = useId();
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const query = useMemo(() => activeRecipientQuery(props.value), [props.value]);

  useEffect(() => {
    if (!open || query.length < 2) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ q: query, limit: "8" });
        if (props.workspaceId) params.set("workspaceId", props.workspaceId);
        if (props.accountId) params.set("accountId", props.accountId);
        const page = await api<ContactSuggestionPage>(`/api/contacts?${params.toString()}`);
        if (!cancelled) setSuggestions(page.items);
      } catch {
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [props.accountId, props.workspaceId, open, query]);

  function chooseSuggestion(suggestion: ContactSuggestion) {
    props.onChange(insertRecipient(props.value, suggestion));
    setOpen(false);
    setSuggestions([]);
  }

  return (
    <div className={styles.recipientField}>
      <label htmlFor={id}>{props.label}</label>
      <div className={styles.recipientInputWrap}>
        <input
          id={id}
          value={props.value}
          onChange={(event) => {
            props.onChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          placeholder={props.placeholder}
          autoComplete="off"
        />
        {loading ? <span className={styles.recipientLoading}>Searching...</span> : null}
        {open && suggestions.length ? (
          <div className={styles.recipientSuggestions} role="listbox" aria-label={`${props.label} contact suggestions`}>
            {suggestions.map((suggestion) => (
              <button
                key={`${suggestion.accountId}:${suggestion.email}`}
                type="button"
                role="option"
                aria-selected="false"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseSuggestion(suggestion)}
              >
                <strong>{suggestion.name || suggestion.email}</strong>
                <span>{suggestion.name ? suggestion.email : suggestion.relationship}</span>
                <small>{suggestion.accountLabel} · {providerLabel(suggestion.accountProvider)} · {sourceLabel(suggestion.source)}</small>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function parseRecipientText(value: string): EmailRecipient[] {
  return String(value || "")
    .split(/[,\n;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(.*?)<([^<>]+)>$/);
      if (!match) return { email: part };
      const name = match[1].trim().replace(/^"|"$/g, "") || null;
      return { name, email: match[2].trim() };
    });
}

function activeRecipientQuery(value: string) {
  const token = String(value || "").split(/[,\n;]/).pop()?.trim() || "";
  const openAddress = token.match(/<([^<>]*)$/);
  return (openAddress ? openAddress[1] : token).trim().toLowerCase();
}

function insertRecipient(value: string, suggestion: ContactSuggestion) {
  const formatted = suggestion.name ? `${suggestion.name} <${suggestion.email}>` : suggestion.email;
  const current = String(value || "");
  const lastSeparator = Math.max(current.lastIndexOf(","), current.lastIndexOf(";"), current.lastIndexOf("\n"));
  const prefix = lastSeparator >= 0 ? `${current.slice(0, lastSeparator + 1)} ` : "";
  return `${prefix}${formatted}, `;
}

function providerLabel(provider: ContactSuggestion["accountProvider"]) {
  return provider === "microsoft" ? "Hotmail" : "Gmail";
}

function sourceLabel(source: ContactSuggestion["source"]) {
  if (source === "manual") return "Saved";
  if (source === "recipient") return "Prior draft";
  if (source === "mixed") return "Known contact";
  return "Sender";
}
