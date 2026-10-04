import { createContext, useContext, useState, type ReactNode } from "react";
import type { AppRuntime } from "../contracts/runtime.ts";
import { createAppRuntime } from "../bootstrap/runtime.ts";

const RuntimeContext = createContext<AppRuntime | null>(null);

export function RuntimeProvider({ runtime, children }: { runtime?: AppRuntime; children: ReactNode }) {
  const [resolvedRuntime] = useState(() => runtime ?? createAppRuntime());
  return <RuntimeContext.Provider value={resolvedRuntime}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): AppRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("RuntimeProvider is missing.");
  return runtime;
}
