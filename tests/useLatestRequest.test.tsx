import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLatestRequest } from "@/components/ezra/useLatestRequest";

describe("latest request controller", () => {
  it("aborts predecessors and only allows the newest request to commit", () => {
    const { result, unmount } = renderHook(() => useLatestRequest());
    let first!: ReturnType<typeof result.current>;
    let second!: ReturnType<typeof result.current>;

    act(() => {
      first = result.current();
      second = result.current();
    });

    expect(first.signal.aborted).toBe(true);
    expect(first.isLatest()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isLatest()).toBe(true);

    unmount();
    expect(second.signal.aborted).toBe(true);
  });

  it("prevents an older asynchronous completion from committing after the latest result", async () => {
    const { result } = renderHook(() => useLatestRequest());
    let older!: ReturnType<typeof result.current>;
    let latest!: ReturnType<typeof result.current>;
    const committed: string[] = [];

    act(() => {
      older = result.current();
      latest = result.current();
    });

    await Promise.resolve().then(() => {
      if (latest.isLatest()) committed.push("latest");
    });
    await Promise.resolve().then(() => {
      if (older.isLatest()) committed.push("older");
    });

    expect(committed).toEqual(["latest"]);
  });
});
