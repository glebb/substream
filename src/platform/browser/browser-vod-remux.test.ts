import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserVodRemuxSession } from "./browser-vod-remux.ts";
import { VOD_REMUX_AUDIO_MIME_CODECS, type VodRemuxWorkerRequest, VodRemuxWorkerResponse } from "./vod-remux-protocol.ts";

class FakeTimeRanges {
  constructor(private ranges: Array<[number, number]> = []) {}
  get length(): number { return this.ranges.length; }
  start(index: number): number { return this.ranges[index]?.[0] ?? 0; }
  end(index: number): number { return this.ranges[index]?.[1] ?? 0; }
  set(ranges: Array<[number, number]>): void { this.ranges = ranges; }
}

class FakeSourceBuffer extends EventTarget {
  readonly appendBuffer = vi.fn((_buffer: BufferSource) => { this.updating = true; });
  readonly remove = vi.fn((_start: number, _end: number) => { this.updating = true; });
  updating = false;
  readonly buffered = new FakeTimeRanges();
}

class FakeMediaSource extends EventTarget {
  static supported = true;
  static isTypeSupported = vi.fn((_mimeType: string) => FakeMediaSource.supported);
  readyState: "closed" | "open" | "ended" = "closed";
  duration = NaN;
  readonly buffer = new FakeSourceBuffer();
  readonly addSourceBuffer = vi.fn((_mimeType: string) => this.buffer as unknown as SourceBuffer);
  readonly endOfStream = vi.fn();
  open(): void { this.readyState = "open"; this.dispatchEvent(new Event("sourceopen")); }
}

class FakeWorker extends EventTarget {
  readonly messages: VodRemuxWorkerRequest[] = [];
  readonly terminate = vi.fn();
  postMessage(message: VodRemuxWorkerRequest): void { this.messages.push(message); }
  emit(data: VodRemuxWorkerResponse): void { this.dispatchEvent(new MessageEvent("message", { data })); }
}

class FakeVideo extends EventTarget {
  error: { code: number } | null = null;
  disableRemotePlayback = false;
  readyState = 1;
  currentTime = 0;
  src = "";
  readonly load = vi.fn();
  readonly pause = vi.fn();
  readonly removeAttribute = vi.fn((name: string) => { if (name === "src") this.src = ""; });
}

const mimeType = 'video/mp4; codecs="avc1.64001f,mp4a.40.2"';
const url = "https://provider.example.invalid/movie.mkv?token=synthetic";

function fixture(initialRemotePlayback = false) {
  FakeMediaSource.supported = true;
  FakeMediaSource.isTypeSupported.mockClear();
  const video = new FakeVideo();
  video.disableRemotePlayback = initialRemotePlayback;
  const sources: FakeMediaSource[] = [];
  const workers: FakeWorker[] = [];
  const errors: string[] = [];
  const onReady = vi.fn();
  const onAudioTracksChange = vi.fn();
  let objectUrlCount = 0;
  const create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:vod-test-${++objectUrlCount}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const session = new BrowserVodRemuxSession(video as unknown as HTMLVideoElement, {
    onReady,
    onError: (reason) => errors.push(reason),
    onAudioTracksChange,
    mediaSourceConstructor: FakeMediaSource as unknown as typeof MediaSource,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return {
    session, video, workers, errors, onReady, onAudioTracksChange, create, revoke,
    sources,
    start(seconds = 0) {
      const before = create.mock.calls.length;
      session.start(url, seconds);
      expect(create.mock.calls.length).toBe(before + 1);
      const source = (session as unknown as { source: FakeMediaSource }).source;
      sources.push(source);
      source.open();
      return source;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeMediaSource.supported = true;
});

describe("BrowserVodRemuxSession", () => {
  it("retains the async buffer failure stage and codecs after releasing the media source", () => {
    const f = fixture();
    const source = f.start();
    const worker = f.workers[0]!;
    worker.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0, audioProcessing: "copy" });
    worker.emit({ type: "chunk", buffer: new Uint8Array([1]).buffer });
    f.video.error = { code: 3 };
    source.buffer.dispatchEvent(new Event("error"));
    expect(f.errors).toEqual(["buffer-failed"]);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(f.video.src).toBe("");
    f.video.error = null;
    expect(f.session.getBufferDiagnostics()).toContain("Failed: initial append (asynchronous parser error; media decode) · Appends: 1");
    expect(f.session.getBufferDiagnostics()).toContain("Refill: stopped");
    expect(f.session.getPlaybackCodecs()).toEqual({ videoCodec: "avc1.64001f", audioCodec: "mp4a.40.2" });
    source.buffer.dispatchEvent(new Event("error"));
    expect(f.errors).toHaveLength(1);
    f.start();
    expect(f.session.getBufferDiagnostics()).not.toContain("Failed:");
    expect(f.session.getPlaybackCodecs()).toEqual({});
    f.session.dispose();
  });

  it("distinguishes buffer creation failures and excludes arbitrary exception names and messages", () => {
    const f = fixture();
    const source = f.start();
    source.addSourceBuffer.mockImplementationOnce(() => {
      throw Object.assign(new Error(url), { name: url });
    });
    f.workers[0]!.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    expect(f.session.getBufferDiagnostics()).toContain("Failed: buffer setup (operation rejected; media none) · Appends: 0");
    expect(f.session.getBufferDiagnostics()).not.toContain("synthetic");
    expect(f.errors).toEqual(["buffer-failed"]);
  });

  it("reports a safe quota failure on a later append with the pre-cleanup buffer size", () => {
    const f = fixture();
    const source = f.start();
    const worker = f.workers[0]!;
    worker.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    worker.emit({ type: "chunk", buffer: new Uint8Array([1]).buffer });
    source.buffer.updating = false;
    source.buffer.buffered.set([[0, 5]]);
    source.buffer.dispatchEvent(new Event("updateend"));
    source.buffer.appendBuffer.mockImplementationOnce(() => { throw new DOMException(url, "QuotaExceededError"); });
    worker.emit({ type: "chunk", buffer: new Uint8Array([2]).buffer });
    expect(f.session.getBufferDiagnostics()).toContain("Buffer: 5.0s");
    expect(f.session.getBufferDiagnostics()).toContain("Failed: media append (operation rejected; QuotaExceededError; media none) · Appends: 2");
    expect(f.session.getBufferDiagnostics()).not.toContain("synthetic");
    expect(f.errors).toEqual(["buffer-failed"]);
  });

  it("preserves native Dolby playback on iPhone without forcing conversion", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" });
    const f = fixture();
    f.start();
    expect(f.workers[0]!.messages[0]).not.toHaveProperty("forceDolbyAac");
    f.workers[0]!.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 1, audioProcessing: "copy" });
    expect(f.session.getBufferDiagnostics()).toContain("Audio: copy");
    expect(f.session.getPlaybackCodecs()).toEqual({ videoCodec: "avc1.64001f", audioCodec: "mp4a.40.2" });
    f.session.dispose();
    expect(f.session.getPlaybackCodecs()).toEqual({});
  });

  it("sends only browser-supported MP4 audio codecs to the worker", () => {
    const f = fixture();
    FakeMediaSource.isTypeSupported.mockImplementation((mime) => mime.includes('"opus"') || mime.includes('"mp4a.40.2"'));
    f.start();
    expect(f.workers[0]!.messages[0]).toEqual({ type: "start", url, startSeconds: 0, supportedAudioCodecs: ["aac", "opus"] });
    f.session.dispose();
    FakeMediaSource.isTypeSupported.mockImplementation(() => FakeMediaSource.supported);
  });

  it("sends the provider URL to the local worker only after sourceopen", () => {
    const f = fixture();
    f.session.start(url, 12);
    expect(f.workers).toHaveLength(0);
    const source = (f.session as unknown as { source: FakeMediaSource }).source;
    source.open();
    expect(f.workers).toHaveLength(1);
    expect(f.workers[0]?.messages).toEqual([{ type: "start", url, startSeconds: 12, supportedAudioCodecs: Object.keys(VOD_REMUX_AUDIO_MIME_CODECS) }]);
    expect(f.create).toHaveBeenCalledWith(source);
    expect(f.errors).toEqual([]);
  });

  it("gates metadata MIME with MediaSource.isTypeSupported before adding a buffer", () => {
    const f = fixture();
    FakeMediaSource.supported = false;
    const source = f.start();
    f.workers[0]?.emit({ type: "metadata", durationSeconds: 10, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    expect(FakeMediaSource.isTypeSupported).toHaveBeenCalledWith(mimeType);
    expect(source.addSourceBuffer).not.toHaveBeenCalled();
    expect(f.errors).toEqual(["browser-unsupported"]);
  });

  it("appends one chunk and acknowledges it only after updateend", () => {
    const f = fixture();
    const source = f.start();
    const worker = f.workers[0]!;
    worker.emit({ type: "metadata", durationSeconds: 8, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    worker.emit({ type: "chunk", buffer: new Uint8Array([1, 2, 3]).buffer });
    expect(source.buffer.appendBuffer).toHaveBeenCalledOnce();
    expect(worker.messages.filter((message) => message.type === "ack")).toEqual([]);
    source.buffer.updating = false;
    source.buffer.dispatchEvent(new Event("updateend"));
    expect(worker.messages.filter((message) => message.type === "ack")).toHaveLength(1);
  });

  it("recovers from a small startup quota without dropping bytes or granting premature worker credit", () => {
    const f = fixture();
    const source = f.start();
    const worker = f.workers[0]!;
    worker.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    // Simulate WebKit's smaller allowance before it parses the video track.
    const accepted: Uint8Array[] = [];
    source.buffer.appendBuffer.mockImplementation((bytes) => {
      const data = new Uint8Array(bytes as ArrayBuffer);
      if (data.byteLength > 128 * 1024) throw new DOMException(url, "QuotaExceededError");
      accepted.push(data);
      source.buffer.updating = true;
    });
    const chunk = Uint8Array.from({ length: 1024 * 1024 + 17 }, (_, i) => i % 251);
    worker.emit({ type: "chunk", buffer: chunk.buffer });
    expect(source.buffer.appendBuffer.mock.calls.slice(0, 3).map(([data]) => data.byteLength))
      .toEqual([512 * 1024, 256 * 1024, 128 * 1024]);
    for (let i = 0; i < 9; i++) {
      expect(worker.messages.filter(m => m.type === "ack")).toHaveLength(0);
      source.buffer.updating = false;
      source.buffer.dispatchEvent(new Event("updateend"));
    }
    expect(worker.messages.filter(m => m.type === "ack")).toHaveLength(1);
    expect(new Uint8Array(Buffer.concat(accepted))).toEqual(chunk);
    expect(f.errors).toEqual([]);
    expect(worker.terminate).not.toHaveBeenCalled();
    f.session.dispose();
  });

  it("holds the rest of a partially appended worker chunk across a managed pause", () => {
    const f = fixture();
    const source = f.start();
    const worker = f.workers[0]!;
    worker.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    const chunk = new Uint8Array(512 * 1024 + 10);
    chunk.fill(7); chunk.set([8, 9], 512 * 1024);
    worker.emit({ type: "chunk", buffer: chunk.buffer });
    source.buffer.buffered.set([[0, 5]]);
    source.dispatchEvent(new Event("endstreaming"));
    source.buffer.updating = false;
    source.buffer.dispatchEvent(new Event("updateend"));
    f.video.dispatchEvent(new Event("timeupdate"));
    expect(source.buffer.appendBuffer).toHaveBeenCalledOnce();
    expect(worker.messages.filter(m => m.type === "ack")).toHaveLength(0);
    source.dispatchEvent(new Event("startstreaming"));
    expect(source.buffer.appendBuffer).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(source.buffer.appendBuffer.mock.calls[1]![0] as ArrayBuffer))
      .toEqual(chunk.slice(512 * 1024));
    expect(worker.messages.filter(m => m.type === "ack")).toHaveLength(0);
    source.buffer.updating = false;
    source.buffer.dispatchEvent(new Event("updateend"));
    expect(worker.messages.filter(m => m.type === "ack")).toHaveLength(1);
    f.session.dispose();
  });

  it("stops after bounded quota reductions when even a minimum piece is rejected", () => {
    const f = fixture();
    const source = f.start();
    const worker = f.workers[0]!;
    worker.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    source.buffer.appendBuffer.mockImplementation(() => { throw new DOMException(url, "QuotaExceededError"); });
    worker.emit({ type: "chunk", buffer: new Uint8Array(512 * 1024).buffer });
    expect(source.buffer.appendBuffer.mock.calls.map(([data]) => data.byteLength))
      .toEqual([512, 256, 128, 64, 32, 16].map(kib => kib * 1024));
    expect(f.errors).toEqual(["buffer-failed"]);
    expect(worker.messages.filter(m => m.type === "ack")).toHaveLength(0);
    expect(f.session.getBufferDiagnostics()).not.toContain("synthetic");
    f.session.dispose();
  });

  it("resets a partial chunk on seek and never appends its remainder to the replacement source", () => {
    const f = fixture();
    const source = f.start();
    const worker = f.workers[0]!;
    worker.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    worker.emit({ type: "chunk", buffer: new Uint8Array(1024 * 1024).fill(9).buffer });
    f.session.seek(12);
    source.buffer.updating = false;
    source.buffer.dispatchEvent(new Event("updateend"));
    expect(source.buffer.appendBuffer).toHaveBeenCalledOnce();
    const next = (f.session as unknown as { source: FakeMediaSource }).source;
    next.open();
    f.workers[1]!.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    f.workers[1]!.emit({ type: "chunk", buffer: new Uint8Array([1, 2, 3]).buffer });
    expect(new Uint8Array(next.buffer.appendBuffer.mock.calls[0]![0] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    f.session.dispose();
  });

  it("throttles acknowledgements above the forward buffer and resumes on timeupdate", () => {
    const f = fixture();
    const source = f.start();
    const worker = f.workers[0]!;
    worker.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    worker.emit({ type: "chunk", buffer: new Uint8Array([1]).buffer });
    source.buffer.updating = false;
    source.buffer.buffered.set([[0, 40]]);
    source.buffer.dispatchEvent(new Event("updateend"));
    expect(worker.messages.filter((message) => message.type === "ack")).toEqual([]);
    f.video.currentTime = 12;
    f.video.dispatchEvent(new Event("timeupdate"));
    expect(worker.messages.filter((message) => message.type === "ack")).toHaveLength(1);
  });

  it("prepares two bounded refills during managed pause, preserves order, and ends only after both append", () => {
    const f = fixture();
    const source = f.start();
    const worker = f.workers[0]!;
    worker.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    worker.emit({ type: "chunk", buffer: new Uint8Array([1]).buffer });
    source.dispatchEvent(new Event("endstreaming"));
    source.buffer.updating = false;
    source.buffer.buffered.set([[0, 5]]);
    source.buffer.dispatchEvent(new Event("updateend"));
    expect(worker.messages.filter(m => m.type === "ack")).toHaveLength(1);
    worker.emit({ type: "chunk", buffer: new Uint8Array(8 * 1024 * 1024).fill(2).buffer });
    expect(worker.messages.filter(m => m.type === "ack")).toHaveLength(2);
    worker.emit({ type: "chunk", buffer: new Uint8Array(8 * 1024 * 1024).fill(3).buffer });
    f.video.dispatchEvent(new Event("timeupdate"));
    expect(source.buffer.appendBuffer).toHaveBeenCalledOnce();
    expect(worker.messages.filter(m => m.type === "ack")).toHaveLength(2);
    expect(f.session.getBufferDiagnostics()).toContain("Pending: 16384 KiB");
    source.dispatchEvent(new Event("startstreaming"));
    for (let i = 0; i < 32; i++) {
      source.buffer.updating = false;
      source.buffer.dispatchEvent(new Event("updateend"));
    }
    const pieces = source.buffer.appendBuffer.mock.calls.slice(1).map(([bytes]) => new Uint8Array(bytes as ArrayBuffer));
    expect(pieces).toHaveLength(32);
    expect(pieces.every((bytes, i) => bytes.length === 512 * 1024 && bytes.every(value => value === (i < 16 ? 2 : 3)))).toBe(true);
    expect(worker.messages.filter(m => m.type === "ack")).toHaveLength(3);
    worker.emit({ type: "end" });
    expect(source.endOfStream).toHaveBeenCalledOnce();
    expect(f.errors).toEqual([]);
    f.session.dispose();
  });

  it("rejects a third held refill without credit and discards held refills on seek", () => {
    const f = fixture();
    const source = f.start();
    const worker = f.workers[0]!;
    worker.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    source.buffer.buffered.set([[0, 5]]);
    source.dispatchEvent(new Event("endstreaming"));
    worker.emit({ type: "chunk", buffer: new Uint8Array([2]).buffer });
    worker.emit({ type: "chunk", buffer: new Uint8Array([3]).buffer });
    expect(f.session.getBufferDiagnostics()).toContain("Pending: 1 KiB");
    f.session.seek(40);
    worker.emit({ type: "chunk", buffer: new Uint8Array([4]).buffer });
    expect(f.errors).toEqual([]);
    const next = (f.session as unknown as { source: FakeMediaSource }).source;
    next.open();
    const nextWorker = f.workers[1]!;
    nextWorker.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    next.buffer.buffered.set([[40, 45]]);
    next.dispatchEvent(new Event("endstreaming"));
    nextWorker.emit({ type: "chunk", buffer: new Uint8Array([5]).buffer });
    nextWorker.emit({ type: "chunk", buffer: new Uint8Array([6]).buffer });
    nextWorker.emit({ type: "chunk", buffer: new Uint8Array([7]).buffer });
    expect(f.errors).toEqual(["buffer-failed"]);
    expect(source.buffer.appendBuffer).not.toHaveBeenCalled();
    f.session.dispose();
  });

  it("accepts only fixed worker phase labels in local diagnostics", () => {
    const f = fixture();
    f.start();
    const worker = f.workers[0]!;
    worker.emit({ type: "progress", phase: "downloading" });
    expect(f.session.getBufferDiagnostics()).toContain("Worker: downloading");
    worker.emit({ type: "progress", phase: url } as unknown as VodRemuxWorkerResponse);
    expect(f.session.getBufferDiagnostics()).toContain("Worker: downloading");
    expect(f.session.getBufferDiagnostics()).not.toContain("synthetic");
    f.session.dispose();
  });

  it("bootstraps playable data when managed streaming pauses before the first append", () => {
    const f = fixture();
    const source = f.start();
    f.workers[0]!.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    source.dispatchEvent(new Event("endstreaming"));
    f.workers[0]!.emit({ type: "chunk", buffer: new Uint8Array([1]).buffer });
    expect(source.buffer.appendBuffer).toHaveBeenCalledOnce();
    source.buffer.updating = false;
    source.buffer.buffered.set([[0, 1]]);
    source.buffer.dispatchEvent(new Event("updateend"));
    expect(f.onReady).toHaveBeenCalledOnce();
  });

  it("waits for three playable seconds before starting, and starts once", () => {
    const f = fixture();
    const source = f.start();
    f.workers[0]!.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    expect(f.onReady).not.toHaveBeenCalled();
    source.buffer.buffered.set([[0, 1]]);
    source.buffer.dispatchEvent(new Event("updateend"));
    expect(f.onReady).not.toHaveBeenCalled();
    source.buffer.buffered.set([[0, 3]]);
    source.buffer.dispatchEvent(new Event("updateend"));
    source.buffer.dispatchEvent(new Event("updateend"));
    expect(f.onReady).toHaveBeenCalledOnce();
  });

  it.each(["endstreaming", "end"])("starts with a shorter cushion when %s limits startup", (event) => {
    const f = fixture();
    const source = f.start();
    f.workers[0]!.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    if (event === "endstreaming") source.dispatchEvent(new Event(event));
    else f.workers[0]!.emit({ type: "end" });
    expect(f.onReady).not.toHaveBeenCalled();
    source.buffer.buffered.set([[0, 1]]);
    source.buffer.dispatchEvent(new Event("updateend"));
    expect(f.onReady).toHaveBeenCalledOnce();
  });

  it("counts only contiguous media at the playhead and wakes on managed buffer changes", () => {
    const f = fixture();
    const source = f.start();
    f.workers[0]!.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    f.workers[0]!.emit({ type: "chunk", buffer: new Uint8Array([1]).buffer });
    source.buffer.updating = false;
    source.buffer.buffered.set([[0, 40]]);
    source.buffer.dispatchEvent(new Event("updateend"));
    expect(f.workers[0]!.messages.filter(m => m.type === "ack")).toHaveLength(0);
    source.buffer.buffered.set([[0, 2], [10, 80]]);
    source.buffer.dispatchEvent(new Event("bufferedchange"));
    expect(f.session.getBufferDiagnostics()).toBe("Buffer: 2.0s · Refill: active · Audio: copy · Pending: none · Appends: 1 · Worker: remuxing");
    expect(f.workers[0]!.messages.filter(m => m.type === "ack")).toHaveLength(1);
    expect(f.onReady).toHaveBeenCalledOnce();
  });

  it("evicts old back buffer before appending the next chunk", () => {
    const f = fixture();
    const source = f.start();
    const worker = f.workers[0]!;
    worker.emit({ type: "metadata", durationSeconds: 100, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    f.video.currentTime = 60;
    source.buffer.buffered.set([[0, 60]]);
    worker.emit({ type: "chunk", buffer: new Uint8Array([1]).buffer });
    expect(source.buffer.remove).toHaveBeenCalledWith(0, 30);
    expect(source.buffer.appendBuffer).not.toHaveBeenCalled();
    source.buffer.buffered.set([[30, 60]]);
    source.buffer.updating = false;
    source.buffer.dispatchEvent(new Event("updateend"));
    expect(source.buffer.appendBuffer).toHaveBeenCalledOnce();
  });

  it("terminates the old worker and revokes its URL on seek, ignoring late old events", () => {
    const f = fixture();
    const firstSource = f.start();
    const oldWorker = f.workers[0]!;
    const firstObjectUrl = "blob:vod-test-1";
    f.session.seek(25);
    const secondSource = (f.session as unknown as { source: FakeMediaSource }).source;
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    expect(f.revoke).toHaveBeenCalledWith(firstObjectUrl);
    expect(f.video.src).toBe("blob:vod-test-2");
    oldWorker.emit({ type: "metadata", durationSeconds: 90, mimeType, audioTracks: [], selectedAudioTrackId: 0 });
    oldWorker.emit({ type: "chunk", buffer: new Uint8Array([9]).buffer });
    expect(firstSource.addSourceBuffer).not.toHaveBeenCalled();
    secondSource.open();
    expect(f.workers).toHaveLength(2);
    expect(f.workers[1]?.messages).toEqual([{ type: "start", url, startSeconds: 25, supportedAudioCodecs: Object.keys(VOD_REMUX_AUDIO_MIME_CODECS) }]);
  });

  it("disposes the worker, object URL and video source, then restores remote playback", () => {
    const f = fixture(false);
    const source = f.start();
    const worker = f.workers[0]!;
    expect(f.video.disableRemotePlayback).toBe(true);
    f.session.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(f.revoke).toHaveBeenCalledWith("blob:vod-test-1");
    expect(f.video.src).toBe("");
    expect(f.video.removeAttribute).toHaveBeenCalledWith("src");
    expect(f.video.pause).toHaveBeenCalledOnce();
    expect(f.video.load).toHaveBeenCalledTimes(2);
    expect(f.video.disableRemotePlayback).toBe(false);
    source.open();
    expect(f.workers).toHaveLength(1);
  });

  it("fails safely on invalid metadata before accepting chunks", () => {
    const f = fixture();
    const source = f.start();
    const worker = f.workers[0]!;
    worker.emit({ type: "metadata", durationSeconds: 10, mimeType: "application/octet-stream", audioTracks: [], selectedAudioTrackId: 0 });
    worker.emit({ type: "chunk", buffer: new Uint8Array([1]).buffer });
    expect(source.addSourceBuffer).not.toHaveBeenCalled();
    expect(f.errors).toEqual(["browser-unsupported"]);
    expect(source.buffer.appendBuffer).not.toHaveBeenCalled();
  });

  it("publishes remux audio tracks and restarts the local worker for a selection", () => {
    const f = fixture();
    f.start();
    const firstWorker = f.workers[0]!;
    firstWorker.emit({
      type: "metadata", durationSeconds: 90, mimeType,
      audioTracks: [
        { id: 1, label: "ignored provider label", language: "eng" },
        { id: 2, label: "also ignored", language: "fi" },
      ],
      selectedAudioTrackId: 2,
    });
    expect(f.session.getAudioTracks()).toEqual([
      { id: "remux:1", label: "Audio 1", language: "eng", selected: false },
      { id: "remux:2", label: "Audio 2", language: "fi", selected: true },
    ]);
    expect(f.onAudioTracksChange).toHaveBeenCalledOnce();
    expect(f.session.selectAudioTrack("remux:2")).toBe(true);
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    const secondSource = (f.session as unknown as { source: FakeMediaSource }).source;
    secondSource.open();
    expect(f.workers[1]?.messages).toEqual([{ type: "start", url, startSeconds: 0, audioTrackId: 2, supportedAudioCodecs: Object.keys(VOD_REMUX_AUDIO_MIME_CODECS) }]);
    expect(f.session.selectAudioTrack("remux:999")).toBe(false);
  });
});
