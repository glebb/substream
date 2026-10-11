import { afterEach, describe, expect, it, vi } from "vitest";
import { AndroidNativePlayer } from "./native-player.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Android native player bridge", () => {
  it("sends direct provider playback commands and ignores callbacks from other sessions", () => {
    const commands: Array<Record<string, unknown>> = [];
    const host = { postMessage: (json: string) => commands.push(JSON.parse(json) as Record<string, unknown>) };
    const windowLike: Record<string, unknown> = { SubstreamNative: host };
    vi.stubGlobal("window", windowLike);
    const container = { id: "video", getBoundingClientRect: () => ({ left: 1, top: 2, width: 320, height: 180 }) } as unknown as HTMLElement;
    const player = new AndroidNativePlayer(container, "live");
    const onStateChange = vi.fn();
    player.setEventHandlers({ onStateChange });
    player.load("https://provider.example/live/channel.m3u8");
    const load = commands.find((command) => command.command === "load")!;
    expect(load.payload).toEqual({ url: "https://provider.example/live/channel.m3u8", kind: "live", resumeSeconds: 0 });

    const callback = (windowLike.__substreamAndroid as { onEvent(event: unknown): void }).onEvent;
    callback({ v: 1, session: "stale", type: "state", payload: { state: "playing" } });
    callback({ v: 1, session: load.session, type: "state", payload: { state: "playing" } });
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("playing");
    player.destroy();
  });
});
