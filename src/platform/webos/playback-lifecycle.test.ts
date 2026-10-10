import { describe, expect, it, vi } from "vitest";
import { bindWebOsPlaybackLifecycle } from "./playback-lifecycle.ts";

class FakeTarget {
  listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type: string) { this.listeners.get(type)?.forEach((listener) => listener(new Event(type))); }
}

describe("bindWebOsPlaybackLifecycle", () => {
  it("coalesces hidden and pagehide, then allows one fresh suspension after resume", () => {
    const document = Object.assign(new FakeTarget(), { visibilityState: "visible" });
    const window = new FakeTarget();
    const onSuspend = vi.fn();
    const onResume = vi.fn();
    const dispose = bindWebOsPlaybackLifecycle({ document, window, onSuspend, onResume });

    document.visibilityState = "hidden";
    document.dispatch("visibilitychange");
    window.dispatch("pagehide");
    expect(onSuspend).toHaveBeenCalledOnce();
    expect(onSuspend).toHaveBeenCalledWith("hidden");

    document.visibilityState = "visible";
    document.dispatch("visibilitychange");
    expect(onResume).toHaveBeenCalledOnce();
    document.visibilityState = "hidden";
    document.dispatch("visibilitychange");
    expect(onSuspend).toHaveBeenCalledTimes(2);

    dispose();
    document.visibilityState = "visible";
    document.dispatch("visibilitychange");
    expect(onResume).toHaveBeenCalledOnce();
  });

  it("uses pagehide when the document did not first become hidden", () => {
    const document = Object.assign(new FakeTarget(), { visibilityState: "visible" });
    const window = new FakeTarget();
    const onSuspend = vi.fn();
    const dispose = bindWebOsPlaybackLifecycle({ document, window, onSuspend });
    window.dispatch("pagehide");
    window.dispatch("pagehide");
    expect(onSuspend).toHaveBeenCalledOnce();
    expect(onSuspend).toHaveBeenCalledWith("pagehide");
    dispose();
  });
});
