import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveDvbOverlay } from "./live-dvb-overlay.ts";

afterEach(() => vi.unstubAllGlobals());

describe("LiveDvbOverlay", () => {
  it("draws validated worker pixels and removes canvas/listeners on disposal", () => {
    const videoListeners = new Map<string, EventListener>();
    const windowListeners = new Map<string, EventListener>();
    const context = { clearRect: vi.fn(), putImageData: vi.fn() };
    const canvas = { style: {}, width: 0, height: 0, setAttribute: vi.fn(), getContext: vi.fn(() => context), remove: vi.fn() };
    const video = {
      addEventListener: vi.fn((type: string, listener: EventListener) => videoListeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => videoListeners.delete(type)),
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 225 }),
    } as unknown as HTMLVideoElement;
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas), body: { appendChild: vi.fn() } });
    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, listener: EventListener) => windowListeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => windowListeners.delete(type)),
    });
    vi.stubGlobal("ImageData", class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });

    const overlay = new LiveDvbOverlay(video);
    overlay.present({ type: "frame", width: 2, height: 1, screenWidth: 4, screenHeight: 2, x: 1, y: 1, rgba: new ArrayBuffer(8) });
    expect(context.putImageData).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(4);
    expect(canvas.height).toBe(2);
    expect(canvas.style).toMatchObject({ display: "block", left: "10px", top: "20px", width: "400px", height: "225px" });

    overlay.present({ type: "frame", width: 2, height: 1, screenWidth: 4, screenHeight: 2, x: 1, y: 1, rgba: new ArrayBuffer(8) });
    // Reusing dimensions avoids reallocating a full video-sized canvas for
    // every DVB frame; only the prior subtitle rectangle is cleared.
    expect(canvas.width).toBe(4);
    expect(canvas.height).toBe(2);
    expect(context.clearRect).toHaveBeenLastCalledWith(1, 1, 2, 1);
    expect(context.putImageData).toHaveBeenCalledTimes(2);

    overlay.present({ type: "frame", width: 2, height: 1, screenWidth: 4, screenHeight: 2, x: 1, y: 1, rgba: new ArrayBuffer(3) });
    expect(context.putImageData).toHaveBeenCalledTimes(2);
    overlay.clear();
    expect(canvas.style).toMatchObject({ display: "none" });
    overlay.dispose();
    expect(canvas.remove).toHaveBeenCalledOnce();
    expect(videoListeners.size).toBe(0);
    expect(windowListeners.size).toBe(0);
  });

  it("isolates canvas failures behind the subtitle error callback", () => {
    const onError = vi.fn();
    vi.stubGlobal("document", { createElement: () => ({ style: {}, setAttribute: () => {}, getContext: () => null }), body: { appendChild: vi.fn() } });
    const video = { addEventListener: vi.fn(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) } as unknown as HTMLVideoElement;
    expect(() => new LiveDvbOverlay(video, onError)).toThrow("Subtitle overlay unavailable");
    expect(onError).toHaveBeenCalledOnce();
  });
});
