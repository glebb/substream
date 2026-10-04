import { describe, expect, it } from "vitest";
import { createAppRuntime } from "./runtime.ts";

describe("application runtime composition", () => {
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

  it.each(["tv", "desktop"] as const)("keeps direct guide transport independent of %s interaction", (interactionProfile) => {
    const runtime = createAppRuntime({
      platform: "browser",
      interactionProfile,
      capabilities: { directGuideRequests: true },
    });
    expect(runtime.interactionProfile).toBe(interactionProfile);
    expect(runtime.capabilities.directGuideRequests).toBe(true);
  });
});
