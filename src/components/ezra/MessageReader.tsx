"use client";

import { useMemo, useState } from "react";
import { ImageOff } from "lucide-react";
import type { MessageDetail } from "@/lib/email/types";
import styles from "./EzraMail.module.css";

type ReadingMode = "clean" | "original" | "plain";

export function MessageReader(props: {
  content?: MessageDetail["content"];
  fallbackText: string;
  isExcerpt?: boolean;
  senderEmail?: string;
  remoteImagesAllowed?: boolean;
  onAlwaysShowImages?: (senderEmail: string) => void;
}) {
  const [mode, setMode] = useState<ReadingMode>("clean");
  const [showImagesOnce, setShowImagesOnce] = useState(false);
  const content = props.content;
  const plainText = content?.plainText || props.fallbackText;
  const hasHtml = Boolean(content?.sanitizedHtml);
  const showImages = Boolean(props.remoteImagesAllowed || showImagesOnce);
  const renderedHtml = useMemo(() => {
    if (!content?.sanitizedHtml) return "";
    const html = mode === "clean"
      ? collapseDocumentSections(content.sanitizedHtml)
      : expandDetectedSections(content.sanitizedHtml);
    return showImages ? revealRemoteImages(html) : html;
  }, [content?.sanitizedHtml, mode, showImages]);

  return (
    <section className={styles.readerSurface} aria-label="Original message">
      <div className={styles.readerToolbar} aria-label="Reading mode">
        <div className={styles.readerModes}>
          <button type="button" aria-pressed={mode === "clean"} onClick={() => setMode("clean")}>Clean reading</button>
          <button type="button" aria-pressed={mode === "plain"} onClick={() => setMode("plain")}>Plain text</button>
          {hasHtml ? <button type="button" aria-pressed={mode === "original"} onClick={() => setMode("original")}>Original formatting</button> : null}
        </div>
        {content?.remoteImageCount ? (
          <div className={styles.readerImageControls}>
            {!showImages ? <span><ImageOff aria-hidden="true" /> Remote images blocked</span> : null}
            {!showImages ? <button type="button" onClick={() => setShowImagesOnce(true)}>Show {content.remoteImageCount} {content.remoteImageCount === 1 ? "image" : "images"} once</button> : null}
            {!props.remoteImagesAllowed && props.senderEmail && props.onAlwaysShowImages ? (
              <button type="button" onClick={() => props.onAlwaysShowImages?.(props.senderEmail!)}>Always show for {props.senderEmail}</button>
            ) : null}
          </div>
        ) : null}
      </div>

      {mode === "plain" || !hasHtml ? (
        <div className={styles.readerPlainText}>{plainText}</div>
      ) : (
        <div
          className={mode === "clean" ? styles.readerCleanHtml : styles.readerOriginalHtml}
          data-ezra-sanitized-content="true"
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      )}

      {props.isExcerpt || content?.source === "excerpt" ? <p className={styles.excerptNotice}>Showing the locally available excerpt.</p> : null}
      {content?.truncated ? <p className={styles.excerptNotice}>This unusually long message was shortened for safe reading.</p> : null}
    </section>
  );
}

export function collapseDocumentSections(html: string) {
  return html.replace(
    /<blockquote(\s[^>]*)?>([\s\S]*?)<\/blockquote>/gi,
    (_match, attributes = "", contents) =>
      `<details class="ezra-quoted-history"><summary>Quoted conversation</summary><blockquote${attributes}>${contents}</blockquote></details>`,
  )
    .replace(
      /<details\s+data-ezra-section="signature"\s*>/gi,
      '<details class="ezra-collapsed-section"><summary>Signature</summary>',
    )
    .replace(
      /<details\s+data-ezra-section="disclaimer"\s*>/gi,
      '<details class="ezra-collapsed-section"><summary>Notice and disclaimer</summary>',
    );
}

function expandDetectedSections(html: string) {
  return html.replace(
    /<details\s+data-ezra-section="(?:signature|disclaimer)"\s*>([\s\S]*?)<\/details>/gi,
    "$1",
  );
}

function revealRemoteImages(html: string) {
  return html.replace(/\sdata-ezra-remote-src="([^"]+)"/gi, (match, encodedUrl: string) => {
    const url = decodeHtmlAttribute(encodedUrl);
    try {
      const parsed = new URL(url);
      return ["http:", "https:"].includes(parsed.protocol) ? ` src="${encodedUrl}"` : match;
    } catch {
      return match;
    }
  });
}

function decodeHtmlAttribute(value: string) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
