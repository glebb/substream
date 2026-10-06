import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BufferSource, BufferTarget, EncodedAudioPacketSource, EncodedVideoPacketSource, EncodedPacketSink, Input, MkvOutputFormat, Output, MATROSKA, MP4 } from "mediabunny";
import { installVodRemuxWorker, type VodRemuxWorkerScope } from "./vod-remux-engine.ts";
import type { VodRemuxWorkerRequest, VodRemuxWorkerResponse } from "./vod-remux-protocol.ts";

const syntheticMkv = new Uint8Array(readFileSync(fileURLToPath(new URL("./__fixtures__/vod-remux-synthetic.mkv", import.meta.url))));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("VOD remux worker", () => {
  it.each([
    ["request", "cors-range"],
    ["status", "range-unsupported"],
    ["metadata", "range-metadata"],
    ["invalid", "range-invalid"],
  ] as const)("reports a safe distinct diagnostic for %s failures", async (failure, reason) => {
    vi.stubGlobal("fetch", async () => {
      if (failure === "request") throw new Error("https://provider.synthetic.invalid/media?token=synthetic-private");
      if (failure === "status") return new Response(new Uint8Array([1]), { status: 200 });
      return new Response(new Uint8Array([1]), {
        status: 206,
        headers: failure === "invalid" ? { "Content-Range": "invalid" } : {},
      });
    });
    const worker = new SyntheticWorkerScope();
    installVodRemuxWorker(worker);
    worker.send({ type: "start", url: "https://provider.synthetic.invalid/media.mkv?token=synthetic-private", startSeconds: 0 });
    await worker.waitFor((message) => message.type === "error");
    expect(worker.messages).toEqual([{ type: "error", reason }]);
    expect(JSON.stringify(worker.messages)).not.toContain("synthetic-private");
    worker.send({ type: "dispose" });
  });

  it("reports fixed worker phases while blocked on credit and stops reporting after disposal", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const match = new Headers(init?.headers).get("Range")!.match(/^bytes=(\d+)-(\d+)$/)!;
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]) + 1, syntheticMkv.length);
      return new Response(syntheticMkv.slice(start, end), { status: 206, headers: { "Content-Range": `bytes ${start}-${end - 1}/${syntheticMkv.length}` } });
    });
    const worker = new SyntheticWorkerScope(false);
    installVodRemuxWorker(worker);
    worker.send({ type: "start", url: "https://media.synthetic.invalid/movie.mkv?token=synthetic-secret", startSeconds: 0 });
    await worker.waitFor(message => message.type === "chunk");
    await vi.advanceTimersByTimeAsync(1000);
    expect(worker.messages.filter(message => message.type === "progress")).toEqual([{ type: "progress", phase: "waiting" }]);
    expect(JSON.stringify(worker.messages)).not.toContain("synthetic-secret");
    worker.send({ type: "dispose" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(worker.messages.filter(message => message.type === "progress")).toHaveLength(1);
  });

  it("keeps network read-ahead cached across interleaved clusters instead of downloading it again", async () => {
    const template = new Input({ formats: [MATROSKA], source: new BufferSource(syntheticMkv) });
    const videoTrack = (await template.getPrimaryVideoTrack())!;
    const audioTrack = (await template.getPrimaryAudioTrack())!;
    const videoConfig = (await videoTrack.getDecoderConfig())!;
    const audioConfig = (await audioTrack.getDecoderConfig())!;
    const videoPacket = (await new EncodedPacketSink(videoTrack).getFirstKeyPacket())!;
    const audioPacket = (await new EncodedPacketSink(audioTrack).getFirstPacket())!;
    // Expand a valid AVC sample with a length-prefixed filler NAL. The fixture
    // exercises byte-cache eviction without committing a large media file.
    const data = new Uint8Array(videoPacket.data.length + 4 + 16 * 1024);
    data.set(videoPacket.data);
    new DataView(data.buffer).setUint32(videoPacket.data.length, 16 * 1024);
    data[videoPacket.data.length + 4] = 12;
    data.fill(255, videoPacket.data.length + 5, data.length - 1);
    data[data.length - 1] = 128;
    const target = new BufferTarget();
    const output = new Output({ format: new MkvOutputFormat({ minimumClusterDuration: 2 }), target });
    const video = new EncodedVideoPacketSource("avc");
    const audio = new EncodedAudioPacketSource("aac");
    output.addVideoTrack(video, { decoderConfig: videoConfig });
    output.addAudioTrack(audio, { decoderConfig: audioConfig });
    await output.start();
    for (let i = 0; i < 1000; i++) {
      await video.add(videoPacket.clone({ data, timestamp: i / 24, duration: 1 / 24 }), { decoderConfig: videoConfig });
      await audio.add(audioPacket.clone({ timestamp: i / 24 }), { decoderConfig: audioConfig });
    }
    await output.finalize();
    template.dispose();
    const bytes = new Uint8Array(target.buffer!);
    let downloaded = 0;
    const provider = "https://provider.synthetic.invalid/cache-test.mkv?token=synthetic-private";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe(provider);
      expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
      expect(init?.body).toBeUndefined();
      const match = new Headers(init?.headers).get("Range")!.match(/^bytes=(\d+)-(\d+)$/)!;
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]) + 1, bytes.length);
      downloaded += end - start;
      return new Response(bytes.slice(start, end), { status: 206, headers: { "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}` } });
    });
    const worker = new SyntheticWorkerScope();
    installVodRemuxWorker(worker);
    worker.send({ type: "start", url: provider, startSeconds: 0 });
    await worker.waitFor(message => message.type === "end" || message.type === "error");
    expect(worker.messages.at(-1)).toEqual({ type: "end" });
    // Budget for index/header reads while preventing the old ~3x download
    // amplification. Keep the cache bounded rather than retaining the file.
    expect(downloaded).toBeLessThan(bytes.length * 1.5);
    expect(JSON.stringify(worker.messages.filter(message => message.type !== "chunk"))).not.toContain("synthetic-private");
  }, 15_000);

  it.each([0, 0.5])("packet-copies synthetic AVC/AAC Matroska into parseable fragmented MP4 with original timestamps (start: %s)", async (startSeconds) => {
    const videoDecoder = vi.fn(() => { throw new Error("decode path must not run"); });
    const videoEncoder = vi.fn(() => { throw new Error("encode path must not run"); });
    vi.stubGlobal("VideoDecoder", videoDecoder);
    vi.stubGlobal("VideoEncoder", videoEncoder);
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("Range");
      const match = range?.match(/^bytes=(\d+)-(\d+)$/);
      if (!match) return new Response(null, { status: 416 });
      const start = Number(match[1]);
      const endInclusive = Number(match[2]);
      if (start >= syntheticMkv.byteLength || endInclusive < start) return new Response(null, { status: 416 });
      const end = Math.min(endInclusive + 1, syntheticMkv.byteLength);
      return new Response(syntheticMkv.slice(start, end), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end - 1}/${syntheticMkv.byteLength}` },
      });
    });

    const worker = new SyntheticWorkerScope();
    installVodRemuxWorker(worker);
    const responses = worker.messages;
    worker.send({ type: "start", url: "https://media.synthetic.invalid/movie.mkv", startSeconds });
    await worker.waitFor((message) => message.type === "end" || message.type === "error");

    const metadata = responses.find((message) => message.type === "metadata");
    expect(metadata?.type).toBe("metadata");
    if (metadata?.type !== "metadata") throw new Error("worker did not send metadata");
    expect(metadata.mimeType).toMatch(/^video\/mp4; codecs="avc1\.[0-9a-f]{6},mp4a\.40\./i);
    expect(metadata.audioTracks).toEqual([{ id: expect.any(Number), label: "Audio 1", language: "und" }]);
    expect(responses.at(-1)).toEqual({ type: "end" });

    const chunks = responses.filter((message): message is Extract<VodRemuxWorkerResponse, { type: "chunk" }> => message.type === "chunk");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(({ buffer }) => buffer.byteLength <= 8 * 1024 * 1024)).toBe(true);
    const mp4Bytes = concat(chunks.map(({ buffer }) => new Uint8Array(buffer)));

    const sourceInput = new Input({ formats: [MATROSKA], source: new BufferSource(syntheticMkv) });
    const sourceVideo = await sourceInput.getPrimaryVideoTrack();
    expect(sourceVideo).not.toBeNull();
    const originalFirstKey = await new EncodedPacketSink(sourceVideo!).getFirstKeyPacket();
    const outputInput = new Input({ formats: [MP4], source: new BufferSource(mp4Bytes) });
    expect(await outputInput.canRead()).toBe(true);
    expect(await outputInput.getMimeType()).toContain("avc1.");
    expect(await outputInput.getMimeType()).toContain("mp4a.40.");
    expect(await outputInput.getPrimaryAudioTrack()).not.toBeNull();
    const outputVideo = await outputInput.getPrimaryVideoTrack();
    expect(outputVideo).not.toBeNull();
    const outputFirstKey = await new EncodedPacketSink(outputVideo!).getFirstKeyPacket();
    expect(outputFirstKey).not.toBeNull();
    expect(outputFirstKey!.timestamp).toBeCloseTo(originalFirstKey!.timestamp, 3);

    // The remux path must not instantiate or call a WebCodecs decoder/encoder.
    expect(videoDecoder).not.toHaveBeenCalled();
    expect(videoEncoder).not.toHaveBeenCalled();
    worker.send({ type: "dispose" });
    sourceInput.dispose();
    outputInput.dispose();
  });
  it.each([false, true])("converts synthetic EAC3 to AAC without WebCodecs while copying video bytes (forced: %s)", async (forceDolbyAac) => {
    const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL("./__fixtures__/vod-remux-eac3.mkv", import.meta.url))));
    vi.stubGlobal("AudioDecoder", undefined);
    vi.stubGlobal("AudioEncoder", undefined);
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const match = new Headers(init?.headers).get("Range")!.match(/^bytes=(\d+)-(\d+)$/)!;
      const start = Number(match[1]); const end = Math.min(Number(match[2]) + 1, bytes.length);
      return new Response(bytes.slice(start, end), { status: 206, headers: { "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}` } });
    });
    const worker = new SyntheticWorkerScope();
    installVodRemuxWorker(worker);
    worker.send({ type: "start", url: "https://media.synthetic.invalid/eac3.mkv", startSeconds: 0, supportedAudioCodecs: forceDolbyAac ? ["aac", "eac3"] : ["aac"], forceDolbyAac });
    await worker.waitFor(m => m.type === "end" || m.type === "error");
    expect(worker.messages.at(-1)).toEqual({ type: "end" });
    expect(worker.messages.find(m => m.type === "metadata")).toMatchObject({ audioProcessing: "dolby-to-aac" });
    const mp4 = concat(worker.messages.flatMap(m => m.type === "chunk" ? [new Uint8Array(m.buffer)] : []));
    const output = new Input({ formats: [MP4], source: new BufferSource(mp4) });
    expect(await (await output.getPrimaryAudioTrack())!.getCodec()).toBe("aac");
    const original = new Input({ formats: [MATROSKA], source: new BufferSource(bytes) });
    const sourceVideo = await original.getPrimaryVideoTrack();
    const resultVideo = await output.getPrimaryVideoTrack();
    expect((await new EncodedPacketSink(resultVideo!).getFirstPacket())!.data)
      .toEqual((await new EncodedPacketSink(sourceVideo!).getFirstPacket())!.data);
    original.dispose(); output.dispose(); worker.send({ type: "dispose" });
  });

  it.each([
    [undefined, "opus", undefined],
    [["ac3", "opus"], "ac3", undefined],
    [[], undefined, "AC3"],
    [["opus"], undefined, "AC3"],
  ] as const)("gates mixed audio by browser capability and preserves explicit selections (%j)", async (capabilities, expectedCodec, failureLabel) => {
    const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL("./__fixtures__/vod-remux-mixed-audio.mkv", import.meta.url))));
    const original = new Input({ formats: [MATROSKA], source: new BufferSource(bytes) });
    const primary = await original.getPrimaryAudioTrack();
    expect(await primary!.getCodec()).toBe("ac3");
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const match = new Headers(init?.headers).get("Range")!.match(/^bytes=(\d+)-(\d+)$/)!;
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]) + 1, bytes.length);
      return new Response(bytes.slice(start, end), { status: 206, headers: { "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}` } });
    });
    const worker = new SyntheticWorkerScope();
    installVodRemuxWorker(worker);
    worker.send({ type: "start", url: "https://media.synthetic.invalid/mixed.mkv", startSeconds: 0,
      supportedAudioCodecs: capabilities ? [...capabilities] : ["opus"],
      ...(failureLabel && capabilities?.length ? { audioTrackId: primary!.id } : {}),
    });
    await worker.waitFor((message) => message.type === "end" || message.type === "error");
    if (failureLabel) {
      expect(worker.messages).toEqual([{ type: "error", reason: "unsupported-audio", audioCodec: failureLabel }]);
    } else {
      expect(worker.messages.at(-1)).toEqual({ type: "end" });
      const chunks = worker.messages.flatMap((message) => message.type === "chunk" ? [new Uint8Array(message.buffer)] : []);
      const output = new Input({ formats: [MP4], source: new BufferSource(concat(chunks)) });
      const track = await output.getPrimaryAudioTrack();
      expect(await track!.getCodec()).toBe(expectedCodec);
      const sourceTrack = (await original.getAudioTracks()).find(asyncTrack => asyncTrack.id === (worker.messages.find(m => m.type === "metadata") as Extract<VodRemuxWorkerResponse, { type: "metadata" }>).selectedAudioTrackId)!;
      const sourcePacket = await new EncodedPacketSink(sourceTrack).getFirstPacket();
      const outputPacket = await new EncodedPacketSink(track!).getFirstPacket();
      expect(outputPacket!.data).toEqual(sourcePacket!.data);
      output.dispose();
    }
    original.dispose();
    worker.send({ type: "dispose" });
  });

});

class SyntheticWorkerScope implements VodRemuxWorkerScope {
  readonly messages: VodRemuxWorkerResponse[] = [];
  constructor(private readonly autoAck = true) {}

  private listener?: (event: MessageEvent<VodRemuxWorkerRequest>) => void;
  private waiters: Array<{ predicate: (message: VodRemuxWorkerResponse) => boolean; resolve: () => void }> = [];

  addEventListener(_type: "message", listener: (event: MessageEvent<VodRemuxWorkerRequest>) => void): void {
    this.listener = listener;
  }

  postMessage(message: VodRemuxWorkerResponse): void {
    this.messages.push(message);
    for (const waiter of this.waiters) {
      if (waiter.predicate(message)) waiter.resolve();
    }
    this.waiters = this.waiters.filter((waiter) => !waiter.predicate(message));
    if (message.type === "chunk" && this.autoAck) queueMicrotask(() => this.send({ type: "ack" }));
  }

  send(message: VodRemuxWorkerRequest): void {
    this.listener?.({ data: message } as MessageEvent<VodRemuxWorkerRequest>);
  }

  waitFor(predicate: (message: VodRemuxWorkerResponse) => boolean): Promise<void> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
