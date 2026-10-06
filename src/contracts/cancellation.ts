/** Minimal cancellation port for finite requests, including Chromium 47 XHR. */
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** Local cancellation needs neither native AbortController nor a fetch polyfill. */
export function createCancellationController(): { signal: CancellationSignal; abort(): void } {
  let aborted = false;
  const listeners = new Set<() => void>();
  return {
    signal: {
      get aborted() { return aborted; },
      addEventListener(_type, listener) { listeners.add(listener); },
      removeEventListener(_type, listener) { listeners.delete(listener); },
    },
    abort() {
      if (aborted) return;
      aborted = true;
      const pending = [...listeners];
      listeners.clear();
      pending.forEach((listener) => listener());
    },
  };
}
