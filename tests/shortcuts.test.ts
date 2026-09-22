import { describe, expect, it } from "vitest";
import { directShortcutCommand, isEditableShortcutTarget, navigationShortcut } from "@/components/ezra/shortcuts";

describe("keyboard shortcuts", () => {
  it("maps safe direct and go commands", () => {
    const key = (value: string, overrides: Partial<KeyboardEvent> = {}) => directShortcutCommand({ key: value, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...overrides });
    expect(key("?")).toBe("help");
    expect(key("/")).toBe("search");
    expect(key("j")).toBe("next");
    expect(key("#")).toBe("trash");
    expect(key("e", { ctrlKey: true })).toBeNull();
    expect(navigationShortcut("t")).toBe("today");
    expect(navigationShortcut("L")).toBe("activity");
  });

  it("recognizes editable targets so mail actions stay suppressed", () => {
    const input = document.createElement("input");
    const button = document.createElement("button");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    expect(isEditableShortcutTarget(input)).toBe(true);
    expect(isEditableShortcutTarget(editor)).toBe(true);
    expect(isEditableShortcutTarget(button)).toBe(false);
  });
});
