import { afterEach, expect, it, vi } from "vitest";

const synthetic = vi.hoisted(() => ({
  scan: vi.fn((): Uint8Array[] => { throw new Error("synthetic scanner failure"); }),
  render: vi.fn((): never => { throw new Error("synthetic renderer failure"); }),
  videoPts: undefined as number | undefined,
  feed: vi.fn(),
}));

vi.mock("./live-dvb-ts-scanner.ts", () => ({
  LiveDvbTsScanner: class {
    scan = synthetic.scan;
    getSelected() { return undefined; }
    getActiveTracks() { return []; }
    getFragmentVideoPts() { return synthetic.videoPts; }
  },
}));

vi.mock("libbitsub", () => ({
  initWasm: vi.fn(async () => undefined),
  DvbParser: class {
    count = 1;
    feed = synthetic.feed;
    reset = vi.fn();
    dispose = vi.fn();
    renderFrameDataAtTimestamp = synthetic.render;
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  synthetic.scan.mockReset().mockImplementation((): never => { throw new Error("synthetic scanner failure"); });
  synthetic.render.mockReset().mockImplementation((): never => { throw new Error("synthetic renderer failure"); });
  synthetic.feed.mockReset();
  synthetic.videoPts = undefined;
});

it("reports a fatal scanner failure so the subtitle path can be disposed", async () => {
  let onMessage: ((event: MessageEvent) => void) | undefined;
  const postMessage = vi.fn();
  vi.stubGlobal("self", {
    postMessage,
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => { onMessage = listener; },
  });

  await import("./live-dvb-subtitle.worker.ts");
  onMessage?.({ data: { type: "fragment", buffer: new ArrayBuffer(188), startSeconds: 0 } } as MessageEvent);
  await vi.waitFor(() => expect(synthetic.scan).toHaveBeenCalledOnce());

  expect(synthetic.scan).toHaveBeenCalledOnce();
  expect(postMessage.mock.calls.map(([message]) => message)).toEqual([{ type: "error" }, { type: "ack" }]);
  onMessage?.({ data: { type: "fragment", buffer: new ArrayBuffer(188), startSeconds: 0 } } as MessageEvent);
  expect(synthetic.scan).toHaveBeenCalledOnce();
});

it("reports a fatal render failure and does not retry on later time updates", async () => {
  let onMessage: ((event: MessageEvent) => void) | undefined;
  const postMessage = vi.fn();
  vi.stubGlobal("self", {
    postMessage,
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => { onMessage = listener; },
  });
  synthetic.scan.mockImplementation(() => [new Uint8Array([1])]);

  await import("./live-dvb-subtitle.worker.ts");
  onMessage?.({ data: { type: "fragment", buffer: new ArrayBuffer(188), startSeconds: 0 } } as MessageEvent);
  await vi.waitFor(() => expect(synthetic.render).toHaveBeenCalledOnce());

  expect(synthetic.render).toHaveBeenCalledOnce();
  expect(postMessage.mock.calls.map(([message]) => message)).toContainEqual({ type: "error" });
  expect(postMessage.mock.calls.map(([message]) => message)).toContainEqual({ type: "ack" });
  onMessage?.({ data: { type: "time", seconds: 2 } } as MessageEvent);
  expect(synthetic.render).toHaveBeenCalledOnce();
  expect(postMessage.mock.calls.filter(([message]) => message.type === "error")).toHaveLength(1);
});

it("anchors a subtitle PES after segment start to the video timestamp", async () => {
  let onMessage: ((event: MessageEvent) => void) | undefined;
  vi.stubGlobal("self", {
    postMessage: vi.fn(),
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => { onMessage = listener; },
  });
  synthetic.videoPts = 90_000;
  // Subtitle PTS is one second after the segment's first video PTS.
  synthetic.scan.mockImplementation(() => [new Uint8Array([
    0, 0, 1, 0xbd, 0, 8, 0x80, 0x80, 5, 0x21, 0, 11, 126, 65,
  ])]);
  synthetic.render.mockReturnValue(null as never);
  await import("./live-dvb-subtitle.worker.ts");
  onMessage?.({ data: { type: "fragment", buffer: new ArrayBuffer(188), startSeconds: 12 } } as MessageEvent);
  await vi.waitFor(() => expect(synthetic.feed).toHaveBeenCalledOnce());
  const fed = synthetic.feed.mock.calls[0]?.[0] as Uint8Array;
  const pts = ((fed[9]! & 14) * 0x20000000) + (fed[10]! << 22)
    + ((fed[11]! & 254) << 14) + (fed[12]! << 7) + ((fed[13]! & 254) >> 1);
  expect(pts).toBe(13 * 90_000);
});
