import { describe, expect, it } from "vitest";
import { isInitialPanelLoad, isInPlaceRefresh } from "@/components/ezra/refreshState";

describe("refresh state helpers", () => {
  it("only shows full-panel loading when there is no existing data", () => {
    expect(isInitialPanelLoad(true, false)).toBe(true);
    expect(isInitialPanelLoad(true, true)).toBe(false);
    expect(isInitialPanelLoad(false, false)).toBe(false);
  });

  it("treats quiet refreshes and data-preserving loads as in-place refreshes", () => {
    expect(isInPlaceRefresh(false, true, true)).toBe(true);
    expect(isInPlaceRefresh(true, false, true)).toBe(true);
    expect(isInPlaceRefresh(true, false, false)).toBe(false);
  });

  it("never requests a full-panel replacement while existing data is mounted", () => {
    expect(isInitialPanelLoad(true, true)).toBe(false);
    expect(isInPlaceRefresh(true, false, true)).toBe(true);
    expect(isInPlaceRefresh(false, true, true)).toBe(true);
  });
});
