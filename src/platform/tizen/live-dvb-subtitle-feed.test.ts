import { afterEach, describe, expect, it, vi } from "vitest";
import { TizenLiveDvbSubtitleFeed } from "./live-dvb-subtitle-feed.ts";

class FakeXhr {
  responseText = "";
  onprogress: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  opened: { method: string; url: string } | undefined;
  mime = "";
  sent = false;
  aborted = false;
  open(method: string, url: string): void { this.opened = { method, url }; }
  overrideMimeType(value: string): void { this.mime = value; }
  send(): void { this.sent = true; }
  abort(): void { this.aborted = true; this.onabort?.(); }
  progress(bytes: Uint8Array): void {
    this.responseText += String.fromCharCode(...Array.from(bytes));
    this.onprogress?.();
  }
}

const originalXhr = globalThis.XMLHttpRequest;

afterEach(() => {
  globalThis.XMLHttpRequest = originalXhr;
  vi.unstubAllGlobals();
});

describe("Tizen standalone DVB subtitle feed", () => {
  it("discovers and selects Finnish DVB tracks from a split plain GET response", () => {
    const xhrs: FakeXhr[] = [];
    class CapturingXhr extends FakeXhr { constructor() { super(); xhrs.push(this); } }
    globalThis.XMLHttpRequest = CapturingXhr as unknown as typeof XMLHttpRequest;
    const context = { clearRect: vi.fn(), putImageData: vi.fn() };
    const canvas = { style: {}, setAttribute: vi.fn(), getContext: vi.fn(() => context), remove: vi.fn() };
    const windowStub = {
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(), setInterval: vi.fn(() => 1), clearInterval: vi.fn(),
    };
    vi.stubGlobal("window", windowStub);
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas), body: { appendChild: vi.fn() } });
    vi.stubGlobal("ImageData", class { constructor(_data: Uint8ClampedArray, _width: number, _height: number) {} });
    const anchor = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }) } as unknown as HTMLElement;
    const changed = vi.fn();
    const feed = new TizenLiveDvbSubtitleFeed("https://example.invalid/live.ts", anchor, () => 3, changed);
    feed.start();

    expect(xhrs).toHaveLength(1);
    expect(xhrs[0]!.opened).toEqual({ method: "GET", url: "https://example.invalid/live.ts" });
    expect(xhrs[0]!.mime).toBe("text/plain; charset=x-user-defined");
    expect(xhrs[0]!.sent).toBe(true);
    expect(feed.getDiagnostics()).toMatch(/^dvb p=3\.0 vp=na sp=na map=na d=na r=0 \+0 -0$/);
    expect(windowStub.setTimeout).toHaveBeenCalledWith(expect.any(Function), 600_000);

    const pat = [0, 0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0, 0, 0, 0, 0];
    const pmt = [0, 2, 0xb0, 28, 0, 1, 0xc1, 0, 0, 0xe1, 0x20, 0xf0, 0,
      6, 0xe1, 0x20, 0xf0, 10, 0x59, 8, 0x66, 0x69, 0x6e, 0x10, 0, 1, 0, 1, 0, 0, 0, 0];
    const tablePackets = new Uint8Array(188 * 2);
    tablePackets.set(packet(0, pat));
    tablePackets.set(packet(0x100, pmt), 188);
    xhrs[0]!.progress(tablePackets.subarray(0, 97));
    xhrs[0]!.progress(tablePackets.subarray(97));

    expect(feed.getTracks()).toEqual([{ id: "dvb:288:1", label: "Finnish · DVB", language: "fin", selected: false }]);
    expect(feed.getStatus()).toBe("available");
    expect(feed.select("dvb:288:1")).toBe(true);
    expect(feed.select("dvb:288:1")).toBe(true);
    expect(feed.getTracks()[0]?.selected).toBe(true);
    expect(changed).toHaveBeenCalled();
    feed.dispose();
    expect(xhrs[0]!.aborted).toBe(true);
  });

  it("notifies the player when pending track discovery times out", () => {
    const xhrs: FakeXhr[] = [];
    class CapturingXhr extends FakeXhr { constructor() { super(); xhrs.push(this); } }
    globalThis.XMLHttpRequest = CapturingXhr as unknown as typeof XMLHttpRequest;
    const context = { clearRect: vi.fn(), putImageData: vi.fn() };
    const canvas = { style: {}, setAttribute: vi.fn(), getContext: vi.fn(() => context), remove: vi.fn() };
    const callbacks: Array<() => void> = [];
    const windowStub = {
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      setTimeout: vi.fn((callback: () => void) => { callbacks.push(callback); return callbacks.length; }),
      clearTimeout: vi.fn(),
    };
    vi.stubGlobal("window", windowStub);
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas), body: { appendChild: vi.fn() } });
    vi.stubGlobal("ImageData", class { constructor(_data: Uint8ClampedArray, _width: number, _height: number) {} });
    const anchor = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }) } as unknown as HTMLElement;
    const changed = vi.fn();
    const feed = new TizenLiveDvbSubtitleFeed("https://example.invalid/live.ts", anchor, () => 0, changed);
    feed.start();
    expect(feed.getStatus()).toBe("pending");
    callbacks[0]!();
    expect(feed.getStatus()).toBe("unavailable");
    expect(changed).toHaveBeenCalledWith([]);
    feed.dispose();
  });

  it("reports numeric-only diagnostics without stream or caption data", () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const canvas = { style: {}, setAttribute: vi.fn(), getContext: vi.fn(() => ({ clearRect: vi.fn(), putImageData: vi.fn() })), remove: vi.fn() };
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas), body: { appendChild: vi.fn() } });
    const anchor = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }) } as unknown as HTMLElement;
    const feed = new TizenLiveDvbSubtitleFeed("https://private.invalid/secret.ts", anchor, () => 12.345, vi.fn());
    const diagnostics = feed.getDiagnostics();
    expect(diagnostics).toBe("dvb p=12.3 vp=na sp=na map=na d=na r=0 +0 -0");
    expect(diagnostics).not.toContain("private");
    expect(diagnostics).not.toContain("secret");
    feed.dispose();
  });
});

function packet(pid: number, payload: number[]): Uint8Array {
  const bytes = new Uint8Array(188).fill(0xff);
  bytes[0] = 0x47;
  bytes[1] = 0x40 | (pid >> 8);
  bytes[2] = pid & 255;
  bytes[3] = 0x10;
  bytes.set(payload, 4);
  return bytes;
}
