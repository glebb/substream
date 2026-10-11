export interface AndroidNativeEvent { v: 1; id?: number; session?: string; type: string; payload?: Record<string, unknown> }
interface BridgeWindow extends Window {
  SubstreamNative?: { postMessage(json: string): void };
  __substreamAndroid?: { onEvent(event: AndroidNativeEvent | string): void };
}

const listeners = new Map<string, Set<(event: AndroidNativeEvent) => void>>();
let installedTarget: BridgeWindow | undefined;

export function androidBridge(): NonNullable<BridgeWindow["SubstreamNative"]> | undefined {
  return typeof window === "undefined" ? undefined : (window as BridgeWindow).SubstreamNative;
}

function installDispatcher(): boolean {
  if (typeof window === "undefined") return false;
  const target = window as BridgeWindow;
  if (!target.SubstreamNative) return false;
  if (installedTarget === target) return true;
  const callbackHost = target.__substreamAndroid ?? (target.__substreamAndroid = { onEvent: () => {} });
  callbackHost.onEvent = (value) => {
    let event: AndroidNativeEvent;
    try { event = typeof value === "string" ? JSON.parse(value) as AndroidNativeEvent : value; } catch { return; }
    if (!event || event.v !== 1) return;
    if (!event.session) return;
    for (const listener of listeners.get(event.session) ?? []) listener(event);
  };
  installedTarget = target;
  return true;
}

export function subscribeAndroidEvents(key: string, listener: (event: AndroidNativeEvent) => void): () => void {
  if (!installDispatcher()) return () => {};
  let group = listeners.get(key);
  if (!group) { group = new Set(); listeners.set(key, group); }
  group.add(listener);
  return () => {
    group?.delete(listener);
    if (group?.size === 0) listeners.delete(key);
  };
}

export function postAndroidCommand(command: string, session: string, payload: Record<string, unknown> = {}): void {
  const bridge = androidBridge();
  if (!bridge) throw new Error("Android bridge unavailable");
  bridge.postMessage(JSON.stringify({ v: 1, id: Date.now(), session, command, payload }));
}
