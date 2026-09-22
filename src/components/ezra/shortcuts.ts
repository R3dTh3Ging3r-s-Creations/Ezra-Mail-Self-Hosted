export type EzraShortcutCommand =
  | "help"
  | "search"
  | "next"
  | "previous"
  | "open"
  | "acknowledge"
  | "care_more"
  | "care_less"
  | "trash"
  | "escape";

export function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"),
  );
}

export function directShortcutCommand(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">): EzraShortcutCommand | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === "Escape") return "escape";
  if (event.key === "?" || (event.key === "/" && event.shiftKey)) return "help";
  if (event.key === "/") return "search";
  if (event.key === "j") return "next";
  if (event.key === "k") return "previous";
  if (event.key === "Enter") return "open";
  if (event.key === "e") return "acknowledge";
  if (event.key === "+" || event.key === "=") return "care_more";
  if (event.key === "-") return "care_less";
  if (event.key === "#" || (event.key === "3" && event.shiftKey)) return "trash";
  return null;
}

export function navigationShortcut(key: string) {
  const routes = {
    t: "today",
    m: "mail",
    c: "calendar",
    d: "drafts",
    o: "outbox",
    a: "actions",
    l: "activity",
    s: "settings",
  } as const;
  return routes[key.toLowerCase() as keyof typeof routes] || null;
}
