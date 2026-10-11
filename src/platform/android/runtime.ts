interface AndroidHost { postMessage(json: string): void }
interface AndroidWindow extends Window { SubstreamNative?: AndroidHost }

export function isAndroidRuntime(): boolean {
  return typeof window !== "undefined" && typeof (window as AndroidWindow).SubstreamNative?.postMessage === "function";
}
