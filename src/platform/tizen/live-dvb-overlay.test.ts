import { afterEach, describe, expect, it, vi } from "vitest";
import { TizenLiveDvbOverlay } from "./live-dvb-overlay.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Tizen DVB overlay", () => {
  it("keeps identical frames painted without clearing and redrawing them", () => {
    const context = { clearRect: vi.fn(), putImageData: vi.fn() };
    const canvas = { style: {}, width: 0, height: 0, setAttribute: vi.fn(), getContext: vi.fn(() => context), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas), body: { appendChild: vi.fn() } });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("ImageData", class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
    const anchor = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }) } as unknown as HTMLElement;
    const overlay = new TizenLiveDvbOverlay(anchor);
    const frame = {
      imageData: { data: new Uint8ClampedArray([1, 2, 3, 4]), width: 1, height: 1 },
      screenWidth: 1, screenHeight: 1, offsetX: 0, offsetY: 0,
    };

    overlay.present(frame);
    overlay.present({ ...frame, imageData: { ...frame.imageData, data: frame.imageData.data.slice() } });
    expect(context.putImageData).toHaveBeenCalledOnce();
    expect(context.clearRect).not.toHaveBeenCalled();

    overlay.present({ ...frame, imageData: { ...frame.imageData, data: new Uint8ClampedArray([4, 3, 2, 1]) } });
    expect(context.clearRect).toHaveBeenCalledOnce();
    expect(context.putImageData).toHaveBeenCalledTimes(2);
    overlay.clear();
    overlay.clear();
    expect(context.clearRect).toHaveBeenCalledTimes(2);
    overlay.dispose();
  });
});
