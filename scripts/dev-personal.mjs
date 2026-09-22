import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

/** Start the personal Vite app and LAN relay as one foreground command. */
export function startDevStack({ spawnChild = spawn, root = projectRoot, onExit = (code) => process.exit(code), installSignalHandlers = true, viteArgs = process.argv.slice(2) } = {}) {
  const vite = spawnChild(process.execPath, ["node_modules/vite/bin/vite.js", ...viteArgs], {
    cwd: root,
    env: { ...process.env, PERSONAL_BUILD: "1" },
    stdio: "inherit",
  });
  const relay = spawnChild(process.execPath, ["scripts/companion-server.mjs"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  const children = [vite, relay];
  let stopping = false;
  let finalExitCode = 0;
  let closedChildren = 0;
  let exited = false;
  const finish = () => {
    if (stopping && closedChildren === children.length && !exited) {
      exited = true;
      onExit(finalExitCode);
    }
  };
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    finalExitCode = code;
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    finish();
  };

  for (const child of children) {
    child.once("error", () => stop(1));
    child.once("close", (code, signal) => {
      closedChildren += 1;
      if (!stopping) {
        // Terminals can signal all foreground processes before our own handler runs.
        // Treat the child's SIGINT as the user's Ctrl+C; other exits are failures.
        finalExitCode = signal === "SIGINT" ? 0 : (code === 0 && !signal ? 1 : (code ?? 1));
        stopping = true;
        for (const sibling of children) if (sibling !== child && sibling.exitCode === null && sibling.signalCode === null) sibling.kill("SIGTERM");
      }
      finish();
    });
  }

  if (installSignalHandlers) {
    const onSignal = () => stop(0);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  return { children, stop };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startDevStack();
