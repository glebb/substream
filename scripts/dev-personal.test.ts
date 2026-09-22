import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startDevStack } from "./dev-personal.mjs";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

describe("personal development launcher", () => {
  it("starts the personal Vite app and relay as supervised children", () => {
    const vite = fakeChild();
    const relay = fakeChild();
    const spawnChild = vi.fn().mockReturnValueOnce(vite).mockReturnValueOnce(relay);
    const onExit = vi.fn();

    startDevStack({ spawnChild, root: "/project", onExit, installSignalHandlers: false });

    expect(spawnChild).toHaveBeenNthCalledWith(1, process.execPath, ["node_modules/vite/bin/vite.js"], expect.objectContaining({
      cwd: "/project",
      env: expect.objectContaining({ PERSONAL_BUILD: "1" }),
      stdio: "inherit",
    }));
    expect(spawnChild).toHaveBeenNthCalledWith(2, process.execPath, ["scripts/companion-server.mjs"], expect.objectContaining({
      cwd: "/project",
      stdio: "inherit",
    }));
    expect(onExit).not.toHaveBeenCalled();
  });

  it("stops the other service and exits unsuccessfully when a child stops", () => {
    const vite = fakeChild();
    const relay = fakeChild();
    const onExit = vi.fn();
    startDevStack({ spawnChild: vi.fn().mockReturnValueOnce(vite).mockReturnValueOnce(relay), onExit, installSignalHandlers: false });

    vite.emit("close", 0, null);

    expect(relay.kill).toHaveBeenCalledWith("SIGTERM");
    expect(onExit).not.toHaveBeenCalled();
    relay.emit("close", null, "SIGTERM");
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it("treats a child receiving the terminal SIGINT as a clean Ctrl+C shutdown", () => {
    const vite = fakeChild();
    const relay = fakeChild();
    const onExit = vi.fn();
    startDevStack({ spawnChild: vi.fn().mockReturnValueOnce(vite).mockReturnValueOnce(relay), onExit, installSignalHandlers: false });

    vite.emit("close", null, "SIGINT");

    expect(relay.kill).toHaveBeenCalledWith("SIGTERM");
    relay.emit("close", null, "SIGTERM");
    expect(onExit).toHaveBeenCalledWith(0);
  });
});
