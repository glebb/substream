import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRuntime } from "./runtime.ts";

afterEach(() => vi.unstubAllGlobals());

describe("application runtime composition", () => {
  it("selects touch interaction from pointer capabilities without changing browser playback", () => {
    const matchMedia = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("matchMedia", matchMedia);
    const runtime = createAppRuntime();
    expect(runtime.interactionProfile).toBe("touch");
    expect(runtime.platform).toBe("browser");
    expect(runtime.capabilities.nativeVideoSurface).toBe(false);
    expect(matchMedia).toHaveBeenCalledWith("(pointer: coarse) and (hover: none)");
    expect(createAppRuntime({ interactionProfile: "tv" }).interactionProfile).toBe("tv");
  });

  it("retains desktop interaction for a mouse or unavailable pointer detection", () => {
    expect(createAppRuntime().interactionProfile).toBe("desktop");
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(createAppRuntime().interactionProfile).toBe("desktop");
  });

  it("selects the conservative webOS TV runtime and routes platform Back", () => {
    const platformBack = vi.fn();
    vi.stubGlobal("webOS", { platform: { tv: true }, platformBack });

    const runtime = createAppRuntime();
    expect(runtime.platform).toBe("webos");
    expect(runtime.interactionProfile).toBe("tv");
    expect(runtime.capabilities).toEqual({
      nativeVideoSurface: false,
      tvInput: true,
      supportsLocalMediaPicker: false,
      directGuideRequests: true,
      supportsCompanion: true,
      supportsLiveRelay: false,
    });
    expect(runtime.playbackFactory.constructor.name).toBe("WebOsPlaybackPlayerFactory");
    runtime.input.platformBack?.();
    expect(platformBack).toHaveBeenCalledOnce();
  });
  it("keeps TV interaction profile independent from platform capabilities", () => {
    const runtime = createAppRuntime({
      platform: "browser",
      interactionProfile: "tv",
      capabilities: { nativeVideoSurface: false, tvInput: false },
    });

    expect(runtime.platform).toBe("browser");
    expect(runtime.interactionProfile).toBe("tv");
    expect(runtime.capabilities.nativeVideoSurface).toBe(false);
    expect(runtime.capabilities.tvInput).toBe(false);
    expect(runtime.capabilities.supportsLocalMediaPicker).toBe(true);
  });

  it("allows services to be replaced at the composition boundary", async () => {
    const fetch = async () => new Response("fixture");
    const runtime = createAppRuntime({ transport: { fetch } });

    expect(await (await runtime.transport.fetch("https://fixture.invalid")).text()).toBe("fixture");
    expect(typeof runtime.preferences.get).toBe("function");
    expect(typeof runtime.playbackFactory.createDirect).toBe("function");
    expect(typeof runtime.catalogue.open).toBe("function");
    expect("app" in runtime).toBe(false);
  });

  it.each(["tv", "desktop", "touch"] as const)("keeps direct guide transport independent of %s interaction", (interactionProfile) => {
    const runtime = createAppRuntime({
      platform: "browser",
      interactionProfile,
      capabilities: { directGuideRequests: true },
    });
    expect(runtime.interactionProfile).toBe(interactionProfile);
    expect(runtime.capabilities.directGuideRequests).toBe(true);
  });
});
