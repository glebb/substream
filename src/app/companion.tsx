import { createContext, useCallback, useContext, useEffect, useRef, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createCompanionController } from "../platform/companion/controller.ts";
import { createDeviceSettings } from "../bootstrap/settings.ts";
import type { PreferencesRepository } from "../contracts/repository.ts";
import { XtreamClient } from "../platform/xtream/client.ts";
import { useRuntime } from "./runtime.tsx";
import type { CompanionCommand, CompanionController } from "../application/companion-controller.ts";

const ENABLED_KEY = "substream.companion-enabled";
function loadEnabled(preferences: PreferencesRepository): boolean {
  try { return preferences.get(ENABLED_KEY) !== "false"; } catch { return true; }
}

interface CompanionContextValue {
  controller: CompanionController;
  enabled: boolean;
  setEnabled(enabled: boolean): void;
  connect(server: string): void;
  refreshConfiguration(): void;
  commands: Array<{ id: number; command: CompanionCommand }>;
  consumeCommands(throughId: number): void;
}
const CompanionContext = createContext<CompanionContextValue | null>(null);

/** Mounted once alongside App, independently of the current route/settings screen. */
export function CompanionProvider({ children }: { children: ReactNode }) {
  const runtime = useRuntime();
  const { loadPlaylistUrl, companionServerUrl, saveCompanionServerUrl } = useMemo(() => createDeviceSettings(runtime.preferences), [runtime.preferences]);
  const [controller] = useState(() => createCompanionController(loadPlaylistUrl, runtime));
  const [enabled, setEnabledState] = useState(() => loadEnabled(runtime.preferences));
  const enabledRef = useRef(enabled);
  const [commands, setCommands] = useState<Array<{ id: number; command: CompanionCommand }>>([]);
  const nextId = useRef(0);
  const refreshConfiguration = useCallback(() => {
    controller.configure({
      enabled: enabledRef.current && runtime.interactionProfile === "tv" && runtime.capabilities.supportsCompanion,
      server: companionServerUrl(),
      sourceFingerprint: XtreamClient.fromPlaylistUrl(loadPlaylistUrl())?.pairingFingerprint() ?? "",
    });
  }, [controller, runtime, companionServerUrl, loadPlaylistUrl]);
  const setEnabled = (next: boolean) => {
    enabledRef.current = next;
    setEnabledState(next);
    try { runtime.preferences.set(ENABLED_KEY, String(next)); } catch { /* In-session preference still applies. */ }
    refreshConfiguration();
    if (!next) setCommands([]);
  };
  const connect = (server: string) => {
    const saved = saveCompanionServerUrl(server);
    setEnabled(true);
    if (saved) controller.reconnect(saved);
    else refreshConfiguration();
  };
  const consumeCommands = useCallback((throughId: number) => {
    setCommands((pending) => pending.filter((item) => item.id > throughId));
  }, []);
  useEffect(() => {
    const unsubscribe = controller.onCommand((command) => {
      const item = { id: ++nextId.current, command };
      setCommands((pending) => [...pending, item]);
    });
    refreshConfiguration();
    window.addEventListener("storage", refreshConfiguration);
    return () => {
      window.removeEventListener("storage", refreshConfiguration);
      unsubscribe();
      controller.dispose();
    };
  }, [controller, refreshConfiguration]);
  return <CompanionContext.Provider value={{ controller, enabled, setEnabled, connect, refreshConfiguration, commands, consumeCommands }}>{children}</CompanionContext.Provider>;
}

export function useCompanion() {
  const value = useContext(CompanionContext);
  if (!value) throw new Error("CompanionProvider is required.");
  return value;
}

export function useCompanionSnapshot() {
  const { controller } = useCompanion();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
