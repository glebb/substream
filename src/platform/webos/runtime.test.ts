import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeWebOsPlatformBack, isWebOsKeyboardVisible, isWebOsRuntime, registerWebOsPlaybackKeys } from "./runtime.ts";

afterEach(() => vi.unstubAllGlobals());

describe("webOS runtime adapter", () => {
  it("detects webOS through its platform global", () => {
    expect(isWebOsRuntime()).toBe(false);
    vi.stubGlobal("webOS", { platform: { tv: true }, platformBack: vi.fn() });
    expect(isWebOsRuntime()).toBe(true);
  });

  it("detects the packaged webOS host without requiring webOSTV.js", () => {
    vi.stubGlobal("PalmSystem", {});
    expect(isWebOsRuntime()).toBe(true);
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/120.0 WebAppManager" });
    expect(isWebOsRuntime()).toBe(true);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Chrome/120.0 Safari/537.36" });
    expect(isWebOsRuntime()).toBe(false);
  });

  it("invokes platform Back and tolerates missing or failing APIs", () => {
    const platformBack = vi.fn();
    vi.stubGlobal("webOS", { platformBack });
    invokeWebOsPlatformBack();
    expect(platformBack).toHaveBeenCalledOnce();

    const close = vi.fn();
    vi.stubGlobal("close", close);
    vi.stubGlobal("webOS", { platformBack: () => { throw new Error("synthetic firmware failure"); } });
    expect(() => invokeWebOsPlatformBack()).not.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses PalmSystem platform Back and reads native keyboard visibility", () => {
    const platformBack = vi.fn();
    vi.stubGlobal("PalmSystem", { platformBack, isKeyboardVisible: false });
    invokeWebOsPlatformBack();
    expect(platformBack).toHaveBeenCalledOnce();
    expect(isWebOsKeyboardVisible()).toBe(false);

    vi.stubGlobal("PalmSystem", { platformBack, isKeyboardVisible: true });
    invokeWebOsPlatformBack();
    expect(platformBack).toHaveBeenCalledOnce();
    expect(isWebOsKeyboardVisible()).toBe(true);
  });

  it("does not require a special registration API for standard remote keys", () => {
    expect(() => registerWebOsPlaybackKeys()).not.toThrow();
  });
});
