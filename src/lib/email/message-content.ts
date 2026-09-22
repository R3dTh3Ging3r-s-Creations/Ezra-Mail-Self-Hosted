import crypto from "node:crypto";
import sanitizeHtml from "sanitize-html";

const MAX_SOURCE_LENGTH = 200_000;
const MAX_PLAIN_TEXT_LENGTH = 100_000;
const MAX_SANITIZED_HTML_LENGTH = 160_000;

export type SanitizedMessageContent = {
  plainText: string;
  sanitizedHtml: string | null;
  contentHash: string;
  remoteImageCount: number;
  trackingPixelCount: number;
  truncated: boolean;
};

export function messageContentFromPlainText(input: string): SanitizedMessageContent {
  const normalized = input.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const plainText = normalized.slice(0, MAX_PLAIN_TEXT_LENGTH);
  return {
    plainText,
    sanitizedHtml: null,
    contentHash: crypto.createHash("sha256").update(`${plainText}\n--ezra-html--\n`).digest("hex"),
    remoteImageCount: 0,
    trackingPixelCount: 0,
    truncated: normalized.length > MAX_PLAIN_TEXT_LENGTH,
  };
}

export function sanitizeMessageHtml(input: string): SanitizedMessageContent {
  const sourceWasTruncated = input.length > MAX_SOURCE_LENGTH;
  const bounded = input.slice(0, MAX_SOURCE_LENGTH);
  let trackingPixelCount = 0;
  let remoteImageCount = 0;
  const withoutTrackers = bounded.replace(/<img\b[^>]*>/gi, (tag) => {
    if (isTrackingPixel(tag)) {
      trackingPixelCount += 1;
      return "";
    }
    return tag;
  });
  const sanitized = sanitizeHtml(withoutTrackers, {
    allowedTags: [
      "p", "div", "span", "br", "hr", "strong", "b", "em", "i", "u", "s",
      "blockquote", "pre", "code", "ul", "ol", "li", "dl", "dt", "dd",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td", "h1", "h2",
      "h3", "h4", "h5", "h6", "a", "img", "details",
    ],
    allowedAttributes: {
      a: ["href", "title", "rel"],
      img: ["alt", "title", "width", "height", "data-ezra-remote-src"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan", "scope"],
      details: ["data-ezra-section"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      div: (_tagName, attribs) => {
        const section = detectedSection(attribs);
        const safeAttributes: Record<string, string> = section
          ? { "data-ezra-section": section }
          : {};
        return { tagName: section ? "details" : "div", attribs: safeAttributes };
      },
      a: (_tagName, attribs) => {
        const href = safeLink(attribs.href);
        return {
          tagName: "a",
          attribs: href
            ? { href, ...(attribs.title ? { title: attribs.title } : {}), rel: "noopener noreferrer nofollow" }
            : {},
        };
      },
      img: (_tagName, attribs) => {
        const remoteSource = safeRemoteImage(attribs.src);
        if (remoteSource) remoteImageCount += 1;
        return {
          tagName: "img",
          attribs: {
            ...(attribs.alt ? { alt: attribs.alt } : {}),
            ...(attribs.title ? { title: attribs.title } : {}),
            ...(safeDimension(attribs.width) ? { width: safeDimension(attribs.width)! } : {}),
            ...(safeDimension(attribs.height) ? { height: safeDimension(attribs.height)! } : {}),
            ...(remoteSource ? { "data-ezra-remote-src": remoteSource } : {}),
          },
        };
      },
    },
    exclusiveFilter(frame) {
      return frame.tag === "img" && !frame.attribs["data-ezra-remote-src"];
    },
  });
  const plain = normalizePlainText(withoutTrackers);
  const htmlWasTruncated = sanitized.length > MAX_SANITIZED_HTML_LENGTH;
  const sanitizedHtml = sanitized.trim()
    ? sanitized.slice(0, MAX_SANITIZED_HTML_LENGTH)
    : null;
  const truncated = sourceWasTruncated || htmlWasTruncated || plain.length > MAX_PLAIN_TEXT_LENGTH;
  const plainText = plain.slice(0, MAX_PLAIN_TEXT_LENGTH);
  const contentHash = crypto
    .createHash("sha256")
    .update(`${plainText}\n--ezra-html--\n${sanitizedHtml || ""}`)
    .digest("hex");
  return {
    plainText,
    sanitizedHtml,
    contentHash,
    remoteImageCount,
    trackingPixelCount,
    truncated,
  };
}

export function normalizePlainText(input: string) {
  const withLineBreaks = input
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|blockquote|pre|li|tr)>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "- ");
  return decodeHtmlEntities(sanitizeHtml(withLineBreaks, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
  }))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, token: string) => {
    if (token[0] !== "#") return named[token.toLowerCase()] ?? entity;
    const hexadecimal = token[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(token.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

function safeLink(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? value : null;
  } catch {
    return null;
  }
}

function safeRemoteImage(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? value : null;
  } catch {
    return null;
  }
}

function safeDimension(value: string | undefined) {
  if (!value || !/^\d{1,4}$/.test(value)) return null;
  return value;
}

function detectedSection(attributes: Record<string, string>) {
  const marker = [attributes.class, attributes.id, attributes["data-smartmail"]]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/gmail_signature|(?:^|[-_\s])signature(?:$|[-_\s])|email[-_\s]?footer/.test(marker)) return "signature";
  if (/disclaimer|confidential|legal[-_\s]?(?:notice|footer)/.test(marker)) return "disclaimer";
  return null;
}

function isTrackingPixel(tag: string) {
  const width = attributeValue(tag, "width");
  const height = attributeValue(tag, "height");
  if ((width === "0" || width === "1") && (height === "0" || height === "1")) return true;
  const style = attributeValue(tag, "style").toLowerCase().replace(/\s+/g, "");
  return /display:none|visibility:hidden|opacity:0|width:(0|1)px|height:(0|1)px/.test(style);
}

function attributeValue(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] || match[2] || match[3] || "") : "";
}
