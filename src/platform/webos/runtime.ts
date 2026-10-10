/** Small boundary for LG webOS globals. Shared screens only use the runtime port. */
interface WebOsGlobal {
  platform?: { tv?: boolean };
  platformBack?: () => void;
}

interface PalmSystemGlobal {
  platformBack?: () => void;
  isKeyboardVisible?: boolean | (() => boolean);
}

const keyboardVisibility = new WeakMap<Document, boolean>();
const watchedDocuments = new WeakSet<Document>();

function webOsGlobal(): WebOsGlobal | undefined {
  return (globalThis as typeof globalThis & { webOS?: WebOsGlobal }).webOS;
}

function palmSystem(): PalmSystemGlobal | undefined {
  return (globalThis as typeof globalThis & { PalmSystem?: PalmSystemGlobal }).PalmSystem;
}

/** Detect the TV host without treating a webOS SDK bundle in a desktop browser as a TV. */
export function isWebOsRuntime(): boolean {
  if (webOsGlobal()?.platform?.tv === true) return true;
  if (palmSystem() !== undefined) return true;
  const userAgent = typeof globalThis.navigator === "undefined" ? "" : globalThis.navigator.userAgent;
  return /Web[0O]S;\s*Linux\/SmartTV/i.test(userAgent) && /WebAppManager/i.test(userAgent);
}

/** Invoke platform Back at the app root, after shared screens handle Back. */
export function invokeWebOsPlatformBack(): void {
  if (isWebOsKeyboardVisible()) return;
  const api = webOsGlobal();
  const palm = palmSystem();
  try {
    if (api?.platformBack) {
      api.platformBack();
      return;
    }
    if (palm?.platformBack) {
      palm.platformBack();
      return;
    }
  } catch {
    // Fall through to the packaged-app close behavior if an optional API fails.
  }
  // `window.close()` is documented for exiting a packaged app without webOSTV.js.
  try { globalThis.close(); } catch { /* Browser contexts may forbid closing their own window. */ }
}

/** Direction, OK, and Back arrive as keyboard events; observe native keyboard visibility. */
export function registerWebOsPlaybackKeys(): void {
  if (typeof document === "undefined" || watchedDocuments.has(document)) return;
  watchedDocuments.add(document);
  document.addEventListener("keyboardStateChange", (event) => {
    const detail = (event as CustomEvent<{ visibility?: unknown }>).detail;
    if (typeof detail?.visibility === "boolean") keyboardVisibility.set(document, detail.visibility);
  });
}

/** Query the platform's current keyboard state, then use its visibility event as fallback. */
export function isWebOsKeyboardVisible(): boolean {
  const palm = palmSystem();
  try {
    const nativeState = palm?.isKeyboardVisible;
    const visible = typeof nativeState === "function" ? nativeState.call(palm) : nativeState;
    if (typeof visible === "boolean") return visible;
  } catch { /* Continue to the visibility event state. */ }
  if (typeof document === "undefined") return false;
  return keyboardVisibility.get(document) ?? false;
}
