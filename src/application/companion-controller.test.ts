import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionController, type CompanionDependencies } from "./companion-controller.ts";
import type { CompanionConnection, CompanionEventsResult } from "../contracts/companion.ts";
import type { VodCatalogItem } from "../core/catalog/index.ts";

const title: VodCatalogItem = {
  id: "synthetic-title", title: "Synthetic Movie", searchTitle: "Synthetic Movie", searchTerms: [],
  year: null, group: "Synthetic", contentType: "movie", addedAt: 0, sourceLine: 0, streamUrl: "https://example.invalid/movie.mp4",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const connection: CompanionConnection = {
  deviceId: "synthetic-device", deviceName: "Synthetic TV", tvCredential: "a".repeat(64),
  pairingCode: "12345678", pairingExpiresAt: 600_000, expiresAt: 900_000,
  sourceFingerprint: "vod_test", capabilities: { localMedia: true }, paired: true,
};
const empty: CompanionEventsResult = { protocolVersion: 4, paired: true, events: [], retentionGap: null };
const playback: CompanionEventsResult = { ...empty, events: [{ sequence: 1, action: "play", selection: {
  id: "1", kind: "movie", title: "Synthetic Movie", year: null, extension: "mp4", sourceFingerprint: "vod_test",
} }] };
function setup(overrides: Partial<CompanionDependencies> = {}) {
  vi.useFakeTimers();
  const pendingEvents = deferred<CompanionEventsResult>();
  const dependencies: CompanionDependencies = {
    identity: () => ({ deviceId: "synthetic-device", deviceName: "Synthetic TV" }),
    connect: vi.fn(async () => connection), events: vi.fn(() => pendingEvents.promise),
    acknowledge: vi.fn(async () => {}), reset: vi.fn(async () => ({ pairingCode: "87654321", pairingExpiresAt: 700_000 })),
    loadCredential: () => "", saveCredential: vi.fn(), resolveSelection: () => title,
    createAbortController: () => undefined, now: () => 0, ...overrides,
  };
  const controller = new CompanionController(dependencies);
  const commands = vi.fn();
  controller.onCommand(commands);
  const start = () => controller.configure({ enabled: true, server: "https://example.invalid", sourceFingerprint: "vod_test" });
  return { controller, dependencies, commands, start, pendingEvents };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); });

describe("application companion lifecycle", () => {
  it("does no work without an enabled endpoint", async () => {
    const { controller, dependencies } = setup();
    controller.configure({ enabled: false, server: "https://example.invalid", sourceFingerprint: "vod_test" });
    controller.configure({ enabled: true, server: "", sourceFingerprint: "vod_test" });
    await flush();
    expect(dependencies.connect).not.toHaveBeenCalled();
    expect(dependencies.events).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.getSnapshot().state).toBe("disabled");
  });

  it("ignores registration that completes after disable, even without AbortController", async () => {
    const pending = deferred<CompanionConnection>();
    const { controller, dependencies, start } = setup({ connect: () => pending.promise });
    start();
    controller.configure({ enabled: false, server: "https://example.invalid", sourceFingerprint: "vod_test" });
    pending.resolve(connection);
    await flush();
    expect(dependencies.saveCredential).not.toHaveBeenCalled();
    expect(dependencies.events).not.toHaveBeenCalled();
    expect(controller.getSnapshot().state).toBe("disabled");
  });

  it("dispatches commands without a settings screen and acknowledges after accepting them", async () => {
    const { controller, commands, dependencies, start, pendingEvents } = setup();
    start(); await flush();
    pendingEvents.resolve(playback); await flush();
    expect(commands).toHaveBeenCalledWith({ kind: "play", title });
    expect(dependencies.acknowledge).toHaveBeenCalledWith("https://example.invalid", connection.tvCredential, 1);
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not deliver commands from an obsolete poll", async () => {
    const { controller, commands, start, pendingEvents } = setup();
    start(); await flush();
    controller.dispose();
    pendingEvents.resolve(playback); await flush();
    expect(commands).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a connection that resolves after reconfiguration", async () => {
    const pendingOld = deferred<CompanionConnection>();
    const { controller, dependencies } = setup({
      connect: vi.fn((server) => server.includes("old") ? pendingOld.promise : Promise.resolve(connection)),
    });
    controller.configure({ enabled: true, server: "https://old.example.invalid", sourceFingerprint: "old" });
    await flush();
    controller.configure({ enabled: true, server: "https://new.example.invalid", sourceFingerprint: "new" });
    await flush();
    pendingOld.resolve(connection);
    await flush();
    expect(dependencies.saveCredential).toHaveBeenCalledTimes(1);
    expect(dependencies.saveCredential).toHaveBeenCalledWith("https://new.example.invalid", connection.tvCredential);
    expect(controller.getSnapshot().server).toBe("https://new.example.invalid");
    controller.dispose();
  });

  it("isolates command subscriber failures and remains configurable after disposal", async () => {
    const { controller, commands, dependencies, start } = setup({ events: vi.fn(async () => playback) });
    controller.onCommand(() => { throw new Error("synthetic subscriber failure"); });
    start(); await flush();
    expect(commands).toHaveBeenCalledTimes(1);
    expect(dependencies.acknowledge).toHaveBeenCalledWith("https://example.invalid", connection.tvCredential, 1);
    controller.dispose();

    const nextPoll = deferred<CompanionEventsResult>();
    vi.mocked(dependencies.events).mockImplementation(() => nextPoll.promise);
    start(); await flush();
    expect(controller.getSnapshot().state).toBe("available");
    nextPoll.resolve(empty); await flush();
    expect(vi.getTimerCount()).toBe(1);
    controller.dispose();
  });

  it("does not replay accepted commands when acknowledgment fails", async () => {
    const { controller, commands, dependencies, start } = setup({
      events: vi.fn(async () => playback), acknowledge: vi.fn().mockRejectedValueOnce(new Error("synthetic failure")).mockResolvedValue(undefined),
    });
    start(); await flush();
    expect(controller.getSnapshot().state).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(2_000); await flush();
    expect(commands).toHaveBeenCalledTimes(1);
    expect(dependencies.connect).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("rejects a different provider selection without interfering with later polling", async () => {
    const { controller, commands, dependencies, start, pendingEvents } = setup({ resolveSelection: () => null });
    start(); await flush(); pendingEvents.resolve(playback); await flush();
    expect(commands).not.toHaveBeenCalled();
    expect(dependencies.acknowledge).toHaveBeenCalled();
    expect(controller.getSnapshot().error).toContain("different provider");
    controller.dispose();
  });

  it("sanitizes failures and cancels retry on disable", async () => {
    const { controller, start } = setup({ connect: async () => { throw new Error("https://secret.invalid/?token=private"); } });
    start(); await flush();
    expect(controller.getSnapshot().error).not.toContain("private");
    expect(vi.getTimerCount()).toBe(1);
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "TV app and LAN service versions do not match. Restart the LAN service and install the latest TV app.",
    "The LAN service rejected this TV's saved pairing. Restart the LAN service, then connect and pair this TV again.",
    "The LAN service rejected this app's origin. Check the relay's allowed origins.",
    "The LAN service has reached its TV connection limit. Disconnect unused TVs or restart the LAN service.",
    "Companion service did not respond within 10 seconds. Check the LAN address and service, then try again.",
  ])("preserves a safe connection diagnostic while retrying: %s", async (message) => {
    const { controller, dependencies, start } = setup({ connect: vi.fn().mockRejectedValueOnce(new Error(message)).mockResolvedValue(connection) });
    start(); await flush();
    expect(controller.getSnapshot()).toMatchObject({ state: "unavailable", error: message });
    await vi.advanceTimersByTimeAsync(2_000); await flush();
    expect(dependencies.connect).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({ state: "available", error: "" });
    controller.dispose();
  });
});
