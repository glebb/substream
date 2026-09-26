import { afterEach, expect, it, vi } from "vitest";

const synthetic = vi.hoisted(() => ({
  scan: vi.fn((): Uint8Array[] => { throw new Error("synthetic scanner failure"); }),
  render: vi.fn((): never => { throw new Error("synthetic renderer failure"); }),
}));

vi.mock("./live-dvb-ts-scanner.ts", () => ({
  LiveDvbTsScanner: class {
    scan = synthetic.scan;
    getSelected() { return undefined; }
    getActiveTracks() { return []; }
  },
}));

vi.mock("libbitsub", () => ({
  initWasm: vi.fn(async () => undefined),
  DvbParser: class {
    count = 1;
    feed = vi.fn();
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
  await Promise.resolve();
  await Promise.resolve();

  expect(synthetic.render).toHaveBeenCalledOnce();
  expect(postMessage.mock.calls.map(([message]) => message)).toContainEqual({ type: "error" });
  expect(postMessage.mock.calls.map(([message]) => message)).toContainEqual({ type: "ack" });
  onMessage?.({ data: { type: "time", seconds: 2 } } as MessageEvent);
  expect(synthetic.render).toHaveBeenCalledOnce();
  expect(postMessage.mock.calls.filter(([message]) => message.type === "error")).toHaveLength(1);
});
