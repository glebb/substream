import type { ChildProcess } from "node:child_process";

export function startDevStack(options?: {
  spawnChild?: (...args: any[]) => ChildProcess;
  root?: string;
  onExit?: (code: number) => void;
  installSignalHandlers?: boolean;
  viteArgs?: string[];
}): { children: ChildProcess[]; stop: (code?: number) => void };
