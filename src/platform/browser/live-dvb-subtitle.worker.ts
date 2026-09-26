import { DvbParser, initWasm } from "libbitsub";
import { LIVE_DVB_MAX_FRAME_BYTES, type LiveDvbWorkerRequest, type LiveDvbWorkerResponse } from "./live-dvb-worker-protocol.ts";
import { LiveDvbTsScanner } from "./live-dvb-ts-scanner.ts";

const scope = self as unknown as { postMessage(message: LiveDvbWorkerResponse, transfer?: Transferable[]): void; addEventListener(type: "message", listener: (event: MessageEvent<LiveDvbWorkerRequest>) => void): void };
const scanner = new LiveDvbTsScanner();
const MAX_DECODER_CUES = 256;
// Bitmap cues are static between subtitle changes. Rendering/transferring them
// at every media timeupdate makes the main-thread canvas a bottleneck even
// though parsing is in a worker.
const MIN_FRAME_INTERVAL_MS = 500;
let parser: DvbParser | undefined;
let firstPts: number | undefined;
let firstPtsFragmentStart: number | undefined;
let currentTime = 0;
let disposed = false;
let lastFrameRenderAt = -Infinity;

scope.addEventListener("message", (event) => {
  const request = event.data;
  if (!request || disposed) return;
  if (request.type === "dispose") {
    disposed = true;
    parser?.dispose();
    parser = undefined;
    return;
  }
  if (request.type === "select") {
    if (scanner.getSelected()?.id === request.trackId || (!request.trackId && !scanner.getSelected() && !parser)) return;
    scanner.select(request.trackId);
    parser?.reset();
    firstPts = undefined;
    firstPtsFragmentStart = undefined;
    lastFrameRenderAt = -Infinity;
    scope.postMessage({ type: "clear" });
    return;
  }
  if (request.type === "time") {
    currentTime = request.seconds;
    renderAtCurrentTime();
    return;
  }
  if (request.type === "fragment") {
    void processFragment(request);
  }
});

async function processFragment(request: Extract<LiveDvbWorkerRequest, { type: "fragment" }>): Promise<void> {
  try {
    if (request.buffer.byteLength > 512 * 1024) return;
    const selectedBeforeScan = scanner.getSelected()?.id;
    const pesPackets = scanner.scan(new Uint8Array(request.buffer));
    const playableTracks = scanner.getActiveTracks().map(({ id, language }) => ({ id, language, label: `${language} · DVB` }));
    scope.postMessage({ type: "tracks", tracks: playableTracks });
    if (selectedBeforeScan && scanner.getSelected()?.id !== selectedBeforeScan) {
      parser?.reset();
      firstPts = undefined;
      firstPtsFragmentStart = undefined;
      lastFrameRenderAt = -Infinity;
      scope.postMessage({ type: "clear" });
    }
    if (pesPackets.length) {
      if (!parser) {
        await initWasm();
        parser = new DvbParser();
      }
      for (const pes of pesPackets) {
        const rebased = rebasePesPts(pes, request.startSeconds);
        parser.feed(rebased);
        if (parser.count > MAX_DECODER_CUES) {
          parser.reset();
          firstPts = undefined;
          firstPtsFragmentStart = undefined;
          lastFrameRenderAt = -Infinity;
          scope.postMessage({ type: "clear" });
          break;
        }
      }
      renderAtCurrentTime();
    }
  } catch {
    // Decoder/parser errors are local to subtitles and never escape the worker.
    failWorker();
  } finally {
    scope.postMessage({ type: "ack" });
  }
}

function renderAtCurrentTime(): void {
  if (!parser || parser.count === 0) return;
  try {
    const now = performance.now();
    if (now - lastFrameRenderAt < MIN_FRAME_INTERVAL_MS) return;
    lastFrameRenderAt = now;
    const frame = parser.renderFrameDataAtTimestamp(currentTime, { crop: "bounds" });
    if (!frame) { scope.postMessage({ type: "clear" }); return; }
    const image = frame.imageData;
    const bytes = image.data;
    if (image.width < 1 || image.height < 1 || bytes.byteLength > LIVE_DVB_MAX_FRAME_BYTES) { scope.postMessage({ type: "clear" }); return; }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    scope.postMessage({ type: "frame", width: image.width, height: image.height, screenWidth: frame.screenWidth, screenHeight: frame.screenHeight, x: frame.offsetX, y: frame.offsetY, rgba: buffer }, [buffer]);
  } catch { failWorker(); }
}

function failWorker(): void {
  disposed = true;
  try { parser?.dispose(); } catch { /* Failure cleanup must stay inside the subtitle worker. */ }
  parser = undefined;
  scope.postMessage({ type: "error" });
}

function rebasePesPts(pes: Uint8Array, fragmentStart: number): Uint8Array {
  if (pes.length < 14 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return pes;
  const flags = pes[7]! >> 6;
  if (flags !== 2 && flags !== 3) return pes;
  const pts = ((pes[9]! & 14) * 0x20000000) + (pes[10]! << 22) + ((pes[11]! & 254) << 14) + (pes[12]! << 7) + ((pes[13]! & 254) >> 1);
  if (firstPts === undefined) {
    firstPts = pts;
    firstPtsFragmentStart = fragmentStart;
  }
  let delta = pts - firstPts;
  const wrap = 0x200000000;
  if (delta > wrap / 2) delta -= wrap;
  if (delta < -wrap / 2) delta += wrap;
  const value = Math.max(0, Math.round((firstPtsFragmentStart ?? fragmentStart) * 90_000 + delta));
  const copy = pes.slice();
  copy[9] = (copy[9]! & 0xf0) | ((value >>> 29) & 14) | 1;
  copy[10] = (value >>> 22) & 255;
  copy[11] = ((value >>> 14) & 254) | 1;
  copy[12] = (value >>> 7) & 255;
  copy[13] = ((value << 1) & 254) | 1;
  return copy;
}
