import { afterEach, describe, expect, it, vi } from "vitest";
import { TizenAvPlayPlayer, isTizenAvPlayAvailable } from "./avplay-player.ts";

const originalWebapis = (globalThis as typeof globalThis & { webapis?: unknown }).webapis;
const originalTizen = (globalThis as typeof globalThis & { tizen?: unknown }).tizen;

afterEach(() => {
  if (originalWebapis === undefined) delete (globalThis as typeof globalThis & { webapis?: unknown }).webapis;
  else (globalThis as typeof globalThis & { webapis?: unknown }).webapis = originalWebapis;
  if (originalTizen === undefined) delete (globalThis as typeof globalThis & { tizen?: unknown }).tizen;
  else (globalThis as typeof globalThis & { tizen?: unknown }).tizen = originalTizen;
});

describe("TizenAvPlayPlayer", () => {
  it("opens, positions, starts, and attaches a temporary SAMI subtitle", async () => {
    const open = vi.fn();
    const prepareAsync = vi.fn((success: () => void) => success());
    const play = vi.fn();
    const pause = vi.fn();
    const jumpForward = vi.fn();
    const jumpBackward = vi.fn();
    const stop = vi.fn();
    const close = vi.fn();
    const setDisplayRect = vi.fn();
    const setDisplayMethod = vi.fn();
    let listener: { oncurrentplaytime?(milliseconds: number): void } | undefined;
    const setListener = vi.fn((nextListener: { oncurrentplaytime?(milliseconds: number): void }) => { listener = nextListener; });
    (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: { open, prepareAsync, play, pause, jumpForward, jumpBackward, stop, close, setDisplayRect, setDisplayMethod, setListener } };
    const container = { getBoundingClientRect: () => ({ left: 10.2, top: 20.7, width: 1280, height: 720 }) } as unknown as HTMLElement;

    const onSubtitleCue = vi.fn();
    const player = new TizenAvPlayPlayer(container, vi.fn(), onSubtitleCue);
    expect(isTizenAvPlayAvailable()).toBe(true);
    player.load("https://example.invalid/stream.mkv");
    player.pause();
    player.play();
    player.restart();
    player.resize();
    player.setDisplayMode("fit");
    player.skip(60);
    player.skip(-60);
    expect(open).toHaveBeenCalledWith("https://example.invalid/stream.mkv");
    expect(setDisplayRect).toHaveBeenCalledWith(10, 21, 1280, 720);
    expect(setDisplayMethod).toHaveBeenNthCalledWith(1, "PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO");
    expect(setDisplayMethod).toHaveBeenLastCalledWith("PLAYER_DISPLAY_MODE_LETTER_BOX");
    expect(play).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledOnce();
    expect(jumpForward).toHaveBeenCalledWith(60_000);
    expect(jumpBackward).toHaveBeenCalledWith(60_000);
    await expect(player.setSubtitle("1\n00:00:01,000 --> 00:00:02,000\nHello", "English", "en")).resolves.toEqual({ enabled: true });
    listener?.oncurrentplaytime?.(1_500);
    listener?.oncurrentplaytime?.(2_500);
    expect(onSubtitleCue).toHaveBeenCalledWith("Hello");
    expect(onSubtitleCue).toHaveBeenLastCalledWith("");
    expect(play).toHaveBeenCalledTimes(3);
    player.destroy();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });
});
