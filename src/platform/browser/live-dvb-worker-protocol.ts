/** Message contract for the optional browser DVB worker. Payloads are capped. */
export const LIVE_DVB_MAX_FRAGMENT_BYTES = 512 * 1024;
export const LIVE_DVB_DISCOVERY_FRAGMENT_BYTES = 64 * 1024;
export const LIVE_DVB_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const LIVE_DVB_MAX_QUEUED_FRAGMENTS = 2;

export type LiveDvbWorkerRequest =
  | { type: "fragment"; buffer: ArrayBuffer; startSeconds: number }
  | { type: "select"; trackId: string }
  | { type: "time"; seconds: number }
  | { type: "dispose" };

export type LiveDvbWorkerTrack = { id: string; language: string; label: string };
export type LiveDvbWorkerResponse =
  | { type: "ack" }
  | { type: "tracks"; tracks: LiveDvbWorkerTrack[] }
  | { type: "frame"; width: number; height: number; screenWidth: number; screenHeight: number; x: number; y: number; rgba: ArrayBuffer }
  | { type: "clear" }
  | { type: "error" };

export interface WorkerPort {
  postMessage(message: LiveDvbWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message" | "error", listener: EventListener): void;
  removeEventListener(type: "message" | "error", listener: EventListener): void;
  terminate(): void;
}

/** Explicit construction keeps the worker completely dormant by default. */
export function createLiveDvbWorkerClient(
  onMessage: (message: LiveDvbWorkerResponse) => void,
  workerFactory: () => WorkerPort = () => new Worker(new URL("./live-dvb-subtitle.worker.ts", import.meta.url), { type: "module" }),
): LiveDvbWorkerClient {
  return new LiveDvbWorkerClient(workerFactory(), { onMessage });
}

/**
 * Small main-thread boundary. It only transfers capped fragments and receives
 * capped pixel frames; transport parsing and WASM decoding stay in the worker.
 */
export class LiveDvbWorkerClient {
  private queuedFragments = 0;
  private disposed = false;
  private readonly onMessage = (event: Event) => {
    const response = (event as MessageEvent<LiveDvbWorkerResponse>).data;
    if (!response || typeof response !== "object") return;
    if (response.type === "ack") { this.queuedFragments = Math.max(0, this.queuedFragments - 1); return; }
    if (response.type === "frame") {
      if (!(response.rgba instanceof ArrayBuffer) || response.rgba.byteLength > LIVE_DVB_MAX_FRAME_BYTES
        || !Number.isInteger(response.width) || !Number.isInteger(response.height)
        || !Number.isInteger(response.screenWidth) || !Number.isInteger(response.screenHeight)
        || response.width < 1 || response.height < 1 || response.width > 1920 || response.height > 1080
        || response.screenWidth < 1 || response.screenHeight < 1 || response.screenWidth > 1920 || response.screenHeight > 1080
        || !Number.isFinite(response.x) || !Number.isFinite(response.y)
        || response.width * response.height * 4 !== response.rgba.byteLength
        || response.x < 0 || response.y < 0 || response.x + response.width > response.screenWidth || response.y + response.height > response.screenHeight) return;
    }
    if (response.type === "tracks" && (!Array.isArray(response.tracks) || response.tracks.length > 32)) return;
    this.handlers.onMessage(response);
  };
  private readonly onError = () => this.handlers.onMessage({ type: "error" });

  constructor(private readonly worker: WorkerPort, private readonly handlers: { onMessage: (message: LiveDvbWorkerResponse) => void }) {
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onError);
  }

  pushFragment(payload: ArrayBuffer, startSeconds: number, captureBytes = LIVE_DVB_MAX_FRAGMENT_BYTES): boolean {
    if (this.disposed || this.queuedFragments >= LIVE_DVB_MAX_QUEUED_FRAGMENTS || payload.byteLength === 0) return false;
    const length = Math.min(payload.byteLength, LIVE_DVB_MAX_FRAGMENT_BYTES, Math.max(0, captureBytes));
    const copy = payload.slice(0, length);
    this.queuedFragments++;
    this.worker.postMessage({ type: "fragment", buffer: copy, startSeconds: Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0 }, [copy]);
    // Worker messages are processed in order. A bounded count provides
    // backpressure without retaining raw TS buffers in this client.
    return true;
  }

  select(trackId: string): void { if (!this.disposed) this.worker.postMessage({ type: "select", trackId: trackId.slice(0, 32) }); }
  setTime(seconds: number): void { if (!this.disposed && Number.isFinite(seconds)) this.worker.postMessage({ type: "time", seconds: Math.max(0, seconds) }); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.postMessage({ type: "dispose" });
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.terminate();
  }
}
