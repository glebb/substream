import { LIVE_DVB_MAX_FRAME_BYTES, type LiveDvbWorkerResponse } from "./live-dvb-worker-protocol.ts";

type OverlayCanvas = HTMLCanvasElement & { getContext(contextId: "2d"): CanvasRenderingContext2D | null };

/** Presents only validated RGBA frames received from the DVB worker. */
export class LiveDvbOverlay {
  private readonly canvas: OverlayCanvas;
  private readonly context: CanvasRenderingContext2D;
  private disposed = false;
  private lastPaint: { x: number; y: number; width: number; height: number } | undefined;
  private readonly reposition = () => this.position();

  constructor(private readonly video: HTMLVideoElement, private readonly onError: () => void = () => undefined) {
    try {
      this.canvas = document.createElement("canvas") as OverlayCanvas;
      this.canvas.setAttribute("aria-hidden", "true");
      Object.assign(this.canvas.style, {
        position: "fixed", pointerEvents: "none", zIndex: "2147483000", margin: "0", padding: "0",
        border: "0", display: "none", objectFit: "fill",
      });
      this.context = this.canvas.getContext("2d", { alpha: true })!;
      if (!this.context) throw new Error("Canvas 2D context unavailable");
      document.body.appendChild(this.canvas);
      window.addEventListener("resize", this.reposition);
      window.addEventListener("scroll", this.reposition, true);
      video.addEventListener("timeupdate", this.reposition);
      video.addEventListener("loadedmetadata", this.reposition);
      video.addEventListener("playing", this.reposition);
      this.position();
    } catch {
      this.onError();
      throw new Error("Subtitle overlay unavailable");
    }
  }

  present(message: Extract<LiveDvbWorkerResponse, { type: "frame" }>): void {
    if (this.disposed) return;
    try {
      const { rgba, width, height, screenWidth, screenHeight, x, y } = message;
      if (!(rgba instanceof ArrayBuffer) || rgba.byteLength > LIVE_DVB_MAX_FRAME_BYTES
        || ![width, height, screenWidth, screenHeight, x, y].every(Number.isFinite)
        || ![width, height, screenWidth, screenHeight].every(Number.isInteger)
        || width < 1 || height < 1 || screenWidth < 1 || screenHeight < 1
        || width > 1920 || height > 1080 || screenWidth > 1920 || screenHeight > 1080
        || x < 0 || y < 0 || x + width > screenWidth || y + height > screenHeight
        || width * height * 4 !== rgba.byteLength) return;
      // Assigning either canvas dimension clears and reallocates its entire
      // backing store. DVB frames commonly arrive several times a second, so
      // doing that for a 1080p video on every cue can starve playback.
      if (this.canvas.width !== screenWidth || this.canvas.height !== screenHeight) {
        this.canvas.width = screenWidth;
        this.canvas.height = screenHeight;
        this.lastPaint = undefined;
      }
      const pixels = new Uint8ClampedArray(rgba);
      const image = new ImageData(pixels, width, height);
      if (this.lastPaint) this.context.clearRect(this.lastPaint.x, this.lastPaint.y, this.lastPaint.width, this.lastPaint.height);
      this.context.putImageData(image, x, y);
      this.lastPaint = { x, y, width, height };
      this.canvas.style.display = "block";
      this.position();
    } catch {
      this.onError();
    }
  }

  clear(): void {
    if (this.disposed) return;
    try {
      if (this.lastPaint) this.context.clearRect(this.lastPaint.x, this.lastPaint.y, this.lastPaint.width, this.lastPaint.height);
      this.lastPaint = undefined;
      this.canvas.style.display = "none";
    }
    catch { this.onError(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
    this.video.removeEventListener("timeupdate", this.reposition);
    this.video.removeEventListener("loadedmetadata", this.reposition);
    this.video.removeEventListener("playing", this.reposition);
    this.canvas.remove();
  }

  private position(): void {
    if (this.disposed) return;
    try {
      const rect = this.video.getBoundingClientRect();
      Object.assign(this.canvas.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    } catch { this.onError(); }
  }
}
