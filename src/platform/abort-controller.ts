/**
 * AbortController was added after the Chromium 47 engine used by Tizen 3.
 * Requests can still enforce Promise-based deadlines there; they just cannot
 * physically cancel the underlying fetch.
 */
export function createAbortController(): AbortController | undefined {
  return typeof AbortController === "function" ? new AbortController() : undefined;
}
