import { afterEach, describe, expect, it, vi } from "vitest";
import { TizenLiveRelayPlayer } from "./live-relay-player.ts";
import type { LiveRelayConfig } from "../live-relay/config.ts";

const serviceUrl = "https://relay.example.test";
const sessionId = "a".repeat(32);
const capability = "c".repeat(64);
const config: LiveRelayConfig = { serviceUrl, deviceCredential: "d".repeat(64) };
const originalWebapis = (globalThis as typeof globalThis & { webapis?: unknown }).webapis;

class FakeElement {
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  attributes: Record<string, string> = {};
  private text = "";
  get textContent() { return this.text; }
  set textContent(value: string) { this.text = value; if (value === "") { for (const child of this.children) child.parentNode = null; this.children = []; } }
  appendChild<T extends FakeElement>(child: T): T { child.parentNode?.removeChild(child); child.parentNode = this; this.children.push(child); return child; }
  removeChild(child: FakeElement): FakeElement { this.children = this.children.filter((item) => item !== child); child.parentNode = null; return child; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1920, height: 1080 }; }
}

class FakeImage extends FakeElement {
  static autoLoad = true;
  static instances: FakeImage[] = [];
  naturalWidth = 200;
  naturalHeight = 40;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private source = "";
  constructor() { super(); FakeImage.instances.push(this); }
  set src(value: string) { this.source = value; if (value && FakeImage.autoLoad) Promise.resolve().then(() => this.onload?.()); }
  get src() { return this.source; }
}

function wire() {
  return {
    protocolVersion: 1, sessionId, capability, state: "ready", leaseExpiresAt: Date.now() + 60_000,
    mediaUrl: `${serviceUrl}/v1/sessions/${sessionId}/hls/index.m3u8?cap=${capability}`,
    cueUrl: `${serviceUrl}/v1/sessions/${sessionId}/cues`, statusUrl: `${serviceUrl}/v1/sessions/${sessionId}/status`,
    trackUrl: `${serviceUrl}/v1/sessions/${sessionId}/subtitle-track`, heartbeatUrl: `${serviceUrl}/v1/sessions/${sessionId}/heartbeat`,
    playbackStartedUrl: `${serviceUrl}/v1/sessions/${sessionId}/playback-started`, deleteUrl: `${serviceUrl}/v1/sessions/${sessionId}`,
  };
}

function relayStatus(tracks = [{ id: "dvb-fi", language: "fi", label: "Finnish" }], selectedTrackId: string | null = "dvb-fi") {
  return { sessionId, state: "ready", tracks, selectedTrackId,
    startupSequence: 0, startupDeadlineAt: Date.now() + 30_000, playbackStarted: false, startupTimingOrigin: 0, startupVideoPtsOrigin90k: 90_000 };
}

function json(value: unknown, status = 200): Response {
  return new Response(value === undefined ? null : JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function setup(options: { status?: () => unknown; cues?: (request: number) => unknown; deleteStatus?: number; create?: () => Promise<Response>; selectTrack?: () => Promise<Response>; duration?: number; playbackStartedFailures?: number } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const body = new FakeElement();
  FakeImage.autoLoad = true;
  FakeImage.instances = [];
  let cueRequests = 0;
  let avplayListener: { oncurrentplaytime?(milliseconds: number): void; onbufferingstart?(): void } | undefined;
  const play = vi.fn();
  const prepareAsync = vi.fn((success: () => void) => success());
  const open = vi.fn();
  const setBufferingParam = vi.fn();
  let playbackStartedFailures = options.playbackStartedFailures ?? 0;
  (globalThis as typeof globalThis & { webapis?: unknown }).webapis = { avplay: {
    open, prepareAsync, play, pause: vi.fn(), stop: vi.fn(), close: vi.fn(), jumpForward: vi.fn(), jumpBackward: vi.fn(),
    setDisplayRect: vi.fn(), setDisplayMethod: vi.fn(), setBufferingParam, setListener: (listener: typeof avplayListener) => { avplayListener = listener; },
    setSilentSubtitle: vi.fn(), getTotalTrackInfo: vi.fn(() => []), getDuration: vi.fn(() => options.duration ?? 20_000),
  } };
  vi.stubGlobal("document", { documentElement: { clientWidth: 1920, clientHeight: 1080 }, body, createElement: () => new FakeElement() });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith("/v1/sessions")) return options.create?.() ?? json(wire());
    if (url.endsWith("/status")) return json(options.status?.() ?? relayStatus());
    if (url.includes("/cues?")) return json(options.cues?.(++cueRequests) ?? { cues: [{ seq: 1, epoch: 1, trackId: "dvb-fi", startMs: 500, endMs: 2_000, clear: false, imageId: "caption-1", screenWidth: 1920, screenHeight: 1080, x: 100, y: 900, width: 200, height: 40 }], nextCursor: cueRequests || 1, reset: false });
    if (url.endsWith("/subtitle-track")) return options.selectTrack?.() ?? json({ selected: true });
    if (url.endsWith("/playback-started")) {
      if (playbackStartedFailures > 0) { playbackStartedFailures--; return json({ error: "synthetic failure" }, 503); }
      return json({ playbackStarted: true });
    }
    if (url.endsWith("/heartbeat")) return json({ leaseExpiresAt: Date.now() + 60_000 });
    if (url.endsWith(`/${sessionId}`)) return json({ closed: true }, options.deleteStatus ?? 200);
    throw new Error("unexpected synthetic request");
  });
  return { calls, body, open, play, prepareAsync, setBufferingParam, emitProgress: (ms: number) => avplayListener?.oncurrentplaytime?.(ms), emitBuffering: () => avplayListener?.onbufferingstart?.() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeImage.autoLoad = true;
  FakeImage.instances = [];
  if (originalWebapis === undefined) delete (globalThis as typeof globalThis & { webapis?: unknown }).webapis;
  else (globalThis as typeof globalThis & { webapis?: unknown }).webapis = originalWebapis;
});

describe("TizenLiveRelayPlayer", () => {
  it("uses an eight second AVPlay buffer and reports stalls without advancing the playhead clock", async () => {
    vi.useFakeTimers();
    const harness = setup({ duration: 0 });
    const player = new TizenLiveRelayPlayer(new FakeElement() as unknown as HTMLElement, config, "synthetic-channel");
    await player.start();
    expect(harness.setBufferingParam).toHaveBeenNthCalledWith(1, "PLAYER_BUFFER_FOR_PLAY", "PLAYER_BUFFER_SIZE_IN_SECOND", 8);
    expect(harness.setBufferingParam).toHaveBeenNthCalledWith(2, "PLAYER_BUFFER_FOR_RESUME", "PLAYER_BUFFER_SIZE_IN_SECOND", 8);
    harness.emitProgress(1_000);
    harness.emitBuffering();
    expect(player.getRelayDiagnostics()).toContain("playheadMs=1000 bufferEvents=1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(player.getRelayDiagnostics()).toContain("playheadMs=1000 bufferEvents=1");
    harness.emitProgress(1_250);
    expect(player.getRelayDiagnostics()).toContain("playheadMs=1250 bufferEvents=1");
    await player.close();
  });

  it("waits for AVPlay playhead before anchoring captions and draws prepared PNGs", async () => {
    const harness = setup({ duration: 0 });
    const container = new FakeElement();
    const player = new TizenLiveRelayPlayer(container as unknown as HTMLElement, config, "synthetic-channel");
    const states: string[] = [];
    const tracks: string[][] = [];
    player.setEventHandlers({ onStateChange: (state) => states.push(state), onEmbeddedSubtitleTracksChange: (value) => {
      tracks.push(value.map((track) => track.id));
      if (value.some((track) => track.id === "relay:dvb-fi" && track.selected)) player.selectEmbeddedSubtitleTrack("relay:dvb-fi");
    } });

    await player.start();
    expect(harness.body.children[0]?.style.position).toBe("fixed");
    expect(harness.body.children[0]?.parentNode).toBe(harness.body);
    expect(harness.prepareAsync).toHaveBeenCalledOnce();
    expect(player.getEmbeddedSubtitleTracks()).toEqual([{ id: "relay:dvb-fi", label: "Finnish · Relay", language: "fi", selected: true }]);
    expect(player.getRelayDiagnostics()).toContain("timing=experimental-provisional clock=unverified");
    expect(player.getRelayDiagnostics()).toContain("pts90k=90000");

    await vi.waitFor(() => expect(harness.calls.some((call) => call.url.includes("/cues?"))).toBe(true));
    harness.emitProgress(1_000);
    await vi.waitFor(() => expect(harness.body.children.some((child) => child.style.display === "block"), `${player.getRelayDiagnostics()} ${player.getRelaySubtitleStatus()}`).toBe(true));
    const overlay = harness.body.children.find((child) => child.style.display === "block")!;
    expect(overlay.children).toHaveLength(1);
    expect(overlay.children[0]?.style.left).toBe("5.208333333333334%");
    expect(harness.calls.some((call) => call.url.endsWith("/playback-started"))).toBe(true);
    expect(player.getRelayDiagnostics()).toContain("progress=local ack=confirmed");
    expect(harness.calls.filter((call) => call.url.endsWith("/subtitle-track"))).toHaveLength(0);
    expect(states).toContain("playing");
    expect(tracks.at(-1)).toContain("relay:dvb-fi");

    await player.close();
    expect(harness.calls.some((call) => call.url.endsWith(`/${sessionId}`) && call.init?.method === "DELETE")).toBe(true);
    expect(harness.body.children).toHaveLength(0);
  });

  it("retries playback-start acknowledgement a bounded number of times after a rejected response", async () => {
    vi.useFakeTimers();
    const harness = setup({ duration: 0, playbackStartedFailures: 2 });
    const player = new TizenLiveRelayPlayer(new FakeElement() as unknown as HTMLElement, config, "synthetic-channel");
    await player.start();
    harness.emitProgress(1_000);
    await vi.waitFor(() => expect(harness.calls.filter((call) => call.url.endsWith("/playback-started"))).toHaveLength(1));
    expect(player.getRelayDiagnostics()).toContain("progress=local ack=pending");
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(harness.calls.filter((call) => call.url.endsWith("/playback-started"))).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(harness.calls.filter((call) => call.url.endsWith("/playback-started"))).toHaveLength(3));
    await vi.waitFor(() => expect(player.getRelayDiagnostics()).toContain("ack=confirmed"));
    await player.close();
  });

  it("keeps captions hidden when disabled and serializes teardown behind a pending start", async () => {
    const harness = setup();
    const container = new FakeElement();
    const player = new TizenLiveRelayPlayer(container as unknown as HTMLElement, config, "synthetic-channel", { mediaToPlayheadOffsetMs: 250 });
    const starting = player.start();
    const closing = player.close();
    await Promise.all([starting, closing]);
    expect(harness.calls.some((call) => call.init?.method === "DELETE")).toBe(true);
    expect(player.getRelayDiagnostics()).toContain("offsetMs=250");
    expect(player.getRelaySubtitleStatus()).toBe("relay closed");
  });

  it("coalesces parent track reconciliation and stops a manual off selection from status polling", async () => {
    vi.useFakeTimers();
    const harness = setup({ status: () => relayStatus([
      { id: "dvb-fi", language: "fi", label: "Finnish" },
      { id: "dvb-en", language: "en", label: "English" },
    ]) });
    const player = new TizenLiveRelayPlayer(new FakeElement() as unknown as HTMLElement, config, "synthetic-channel");
    player.setEventHandlers({ onStateChange: () => undefined, onEmbeddedSubtitleTracksChange: (tracks) => {
      const selected = tracks.find((track) => track.selected && track.id.startsWith("relay:"));
      if (selected) player.selectEmbeddedSubtitleTrack(selected.id);
      else if (tracks.some((track) => track.id.startsWith("relay:"))) player.selectEmbeddedSubtitleTrack("off");
    } });
    await player.start();
    expect(player.selectEmbeddedSubtitleTrack("relay:dvb-en")).toBe(true);
    await vi.waitFor(() => expect(harness.calls.filter((call) => call.url.endsWith("/subtitle-track"))).toHaveLength(1));
    expect(JSON.parse(String(harness.calls.find((call) => call.url.endsWith("/subtitle-track"))?.init?.body))).toEqual({ trackId: "dvb-en" });
    expect(player.selectEmbeddedSubtitleTrack("relay:dvb-en")).toBe(true);
    expect(harness.calls.filter((call) => call.url.endsWith("/subtitle-track"))).toHaveLength(1);

    expect(player.selectEmbeddedSubtitleTrack("off")).toBe(true);
    await vi.waitFor(() => expect(harness.calls.filter((call) => call.url.endsWith("/subtitle-track"))).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.calls.filter((call) => call.url.endsWith("/status")).length).toBeGreaterThan(1);
    expect(harness.calls.filter((call) => call.url.endsWith("/subtitle-track"))).toHaveLength(2);
    expect(player.getEmbeddedSubtitleTracks().filter((track) => track.id.startsWith("relay:")).every((track) => !track.selected)).toBe(true);
    await player.close();
  });

  it("limits image caching to 32 entries while evicting older PNGs for new captions", async () => {
    const makeCue = (seq: number) => ({ seq, epoch: 1, trackId: "dvb-fi", startMs: seq * 100, endMs: seq * 100 + 90_000,
      clear: false, imageId: `caption-${seq}`, screenWidth: 1920, screenHeight: 1080, x: 100, y: 900, width: 200, height: 40 });
    const harness = setup({ cues: (request) => request === 1
      ? { cues: Array.from({ length: 32 }, (_, i) => makeCue(i + 1)), nextCursor: 32, reset: false }
      : request === 2 ? { cues: Array.from({ length: 16 }, (_, i) => makeCue(i + 33)), nextCursor: 48, reset: false }
        : { cues: [], nextCursor: 48, reset: false } });
    const player = new TizenLiveRelayPlayer(new FakeElement() as unknown as HTMLElement, config, "synthetic-channel");
    await player.start();
    await vi.waitFor(() => expect(FakeImage.instances.length).toBeGreaterThanOrEqual(48), { timeout: 2_500 });
    expect(player.getRelayDiagnostics()).toContain("images=32");
    expect(player.getRelayDiagnostics()).toContain("decodedBytes=1024000");
    expect(FakeImage.instances.filter((image) => image.src === "")).toHaveLength(16);
    await player.close();
  });

  it("times out a slow replacement image without leaving the expired subtitle visible", async () => {
    const harness = setup({ cues: (request) => {
      const seq = request === 1 ? 1 : 2;
      return { cues: [{ seq, epoch: 1, trackId: "dvb-fi", startMs: seq === 1 ? 500 : 1_200, endMs: 5_000, clear: false,
        imageId: `caption-${seq}`, screenWidth: 1920, screenHeight: 1080, x: 100, y: 900, width: 200, height: 40 }], nextCursor: seq, reset: false };
    } });
    const player = new TizenLiveRelayPlayer(new FakeElement() as unknown as HTMLElement, config, "synthetic-channel", { imageLoadTimeoutMs: 250 });
    await player.start();
    await vi.waitFor(() => expect(harness.calls.filter((call) => call.url.includes("/cues?")).length).toBeGreaterThan(0));
    harness.emitProgress(1_000);
    await vi.waitFor(() => expect(harness.body.children.some((child) => child.style.display === "block")).toBe(true));
    FakeImage.autoLoad = false;
    await vi.waitFor(() => expect(harness.calls.filter((call) => call.url.includes("/cues?")).length).toBeGreaterThan(1), { timeout: 1_000 });
    harness.emitProgress(1_300);
    await vi.waitFor(() => expect(FakeImage.instances).toHaveLength(2));
    expect(harness.body.children.some((child) => child.style.display === "block")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(FakeImage.instances[1]?.src).toBe("");
    expect(player.getRelayDiagnostics()).toContain("images=1 decodedBytes=32000");
    expect(harness.play).toHaveBeenCalledOnce();
    await player.close();
  });

  it("awaits deletion after close-during-create and shares close failures across callers", async () => {
    let resolveCreate!: (response: Response) => void;
    const create = () => new Promise<Response>((resolve) => { resolveCreate = resolve; });
    const harness = setup({ create });
    const player = new TizenLiveRelayPlayer(new FakeElement() as unknown as HTMLElement, config, "synthetic-channel");
    const starting = player.start();
    await vi.waitFor(() => expect(harness.calls.some((call) => call.url.endsWith("/v1/sessions"))).toBe(true));
    const closing = player.close();
    resolveCreate(json(wire()));
    await Promise.all([starting, closing]);
    expect(harness.calls.some((call) => call.init?.method === "DELETE")).toBe(true);

    const failedHarness = setup({ deleteStatus: 503 });
    const failedPlayer = new TizenLiveRelayPlayer(new FakeElement() as unknown as HTMLElement, config, "synthetic-channel");
    await failedPlayer.start();
    const failedClose = failedPlayer.close();
    expect(failedPlayer.close()).toBe(failedClose);
    await expect(failedClose).rejects.toThrow("Could not close live subtitle relay session.");
    expect(failedHarness.calls.filter((call) => call.init?.method === "DELETE")).toHaveLength(1);
  });

  it("does not load AVPlay after close races with asynchronous initial track selection", async () => {
    let resolveSelection!: (response: Response) => void;
    const selectionResponse = new Promise<Response>((resolve) => { resolveSelection = resolve; });
    const harness = setup({ status: () => relayStatus([{ id: "dvb-fi", language: "fi", label: "Finnish" }], null), selectTrack: () => selectionResponse });
    const player = new TizenLiveRelayPlayer(new FakeElement() as unknown as HTMLElement, config, "synthetic-channel");
    const starting = player.start();
    await vi.waitFor(() => expect(harness.calls.some((call) => call.url.endsWith("/subtitle-track"))).toBe(true));
    const closing = player.close();
    resolveSelection(json({ selected: true }));
    await Promise.all([starting, closing]);
    expect(harness.open).not.toHaveBeenCalled();
  });

  it("hides captions instead of reanchoring when the relay reports a new epoch", async () => {
    const harness = setup({ cues: (request) => {
      const epoch = request === 1 ? 1 : 2;
      const seq = request === 1 ? 1 : 2;
      return { cues: [{ seq, epoch, trackId: "dvb-fi", startMs: 500, endMs: 5_000, clear: false,
        imageId: `epoch-${epoch}`, screenWidth: 1920, screenHeight: 1080, x: 100, y: 900, width: 200, height: 40 }], nextCursor: seq, reset: false };
    } });
    const player = new TizenLiveRelayPlayer(new FakeElement() as unknown as HTMLElement, config, "synthetic-channel");
    await player.start();
    await vi.waitFor(() => expect(harness.calls.filter((call) => call.url.includes("/cues?")).length).toBeGreaterThan(0));
    harness.emitProgress(1_000);
    await vi.waitFor(() => expect(harness.body.children[0]?.style.display).toBe("block"));
    await vi.waitFor(() => expect(harness.calls.filter((call) => call.url.includes("/cues?")).length).toBeGreaterThan(1), { timeout: 1_000 });
    await vi.waitFor(() => expect(player.getRelayDiagnostics()).toContain("clock=invalidated"));
    expect(harness.body.children[0]?.style.display).toBe("none");
    await player.close();
  });
});
