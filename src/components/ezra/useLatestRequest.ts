"use client";

import { useCallback, useEffect, useRef } from "react";

type RequestTicket = {
  signal: AbortSignal;
  isLatest: () => boolean;
};

/**
 * Gives a data surface last-request-wins semantics. Starting a replacement
 * request aborts its predecessor and stale completions cannot commit state.
 */
export function useLatestRequest() {
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  return useCallback((): RequestTicket => {
    controller.current?.abort();
    const nextController = new AbortController();
    const requestGeneration = ++generation.current;
    controller.current = nextController;
    return {
      signal: nextController.signal,
      isLatest: () => generation.current === requestGeneration && !nextController.signal.aborted,
    };
  }, []);
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
