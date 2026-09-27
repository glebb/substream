import { LIVE_DVB_MAX_FRAME_BYTES } from "../browser/live-dvb-worker-protocol.ts";

type Canvas2D = HTMLCanvasElement & { getContext(id: "2d", options?: { alpha?: boolean }): CanvasRenderingContext2D | null };

/** Canvas layer positioned over the AVPlay display rectangle. */
export class TizenLiveDvbOverlay {
  private readonly canvas: Canvas2D;
  private readonly context: CanvasRenderingContext2D;
  private lastPaint: { x: number; y: number; width: number; height: number } | undefined;
  private lastImage: ImageData | undefined;
  private disposed = false;
  private readonly reposition = () => this.position();

  constructor(private readonly anchor: HTMLElement, private readonly onError: () => void = () => undefined) {
    try {
      this.canvas = document.createElement("canvas") as Canvas2D;
      this.canvas.setAttribute("aria-hidden", "true");
      Object.assign(this.canvas.style, { position: "fixed", pointerEvents: "none", zIndex: "2147483000", margin: "0", padding: "0", border: "0", display: "none" });
      const context = this.canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("Canvas unavailable");
      this.context = context;
      document.body.appendChild(this.canvas);
      window.addEventListener("resize", this.reposition);
      window.addEventListener("scroll", this.reposition, true);
      this.position();
    } catch {
      this.onError();
      throw new Error("DVB subtitle overlay unavailable");
    }
  }

  present(frame: { imageData: { data: Uint8ClampedArray; width: number; height: number }; screenWidth: number; screenHeight: number; offsetX: number; offsetY: number }): void {
    if (this.disposed) return;
    try {
      const { imageData, screenWidth, screenHeight, offsetX, offsetY } = frame;
      const { width, height, data } = imageData;
      if (!(data instanceof Uint8ClampedArray) || data.byteLength > LIVE_DVB_MAX_FRAME_BYTES
        || ![width, height, screenWidth, screenHeight, offsetX, offsetY].every(Number.isFinite)
        || ![width, height, screenWidth, screenHeight].every(Number.isInteger)
        || width < 1 || height < 1 || width > 1920 || height > 1080
        || screenWidth < 1 || screenHeight < 1 || screenWidth > 1920 || screenHeight > 1080
        || offsetX < 0 || offsetY < 0 || offsetX + width > screenWidth || offsetY + height > screenHeight
        || width * height * 4 !== data.byteLength) return;
      if (this.canvas.width !== screenWidth || this.canvas.height !== screenHeight) {
        this.canvas.width = screenWidth;
        this.canvas.height = screenHeight;
        this.lastPaint = undefined;
        this.lastImage = undefined;
      }
      if (this.lastPaint && this.lastImage && this.lastPaint.x === offsetX && this.lastPaint.y === offsetY
        && this.lastPaint.width === width && this.lastPaint.height === height
        && equalPixels(this.lastImage.data, data)) {
        this.position();
        return;
      }
      if (this.lastPaint) this.context.clearRect(this.lastPaint.x, this.lastPaint.y, this.lastPaint.width, this.lastPaint.height);
      const pixels = new ImageData(new Uint8ClampedArray(data), width, height);
      this.context.putImageData(pixels, offsetX, offsetY);
      this.lastPaint = { x: offsetX, y: offsetY, width, height };
      this.lastImage = pixels;
      this.canvas.style.display = "block";
      this.position();
    } catch { this.onError(); }
  }

  clear(): void {
    if (this.disposed) return;
    try {
      if (this.lastPaint) this.context.clearRect(this.lastPaint.x, this.lastPaint.y, this.lastPaint.width, this.lastPaint.height);
      this.lastPaint = undefined;
      this.lastImage = undefined;
      this.canvas.style.display = "none";
    } catch { this.onError(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
    this.canvas.remove();
  }

  private position(): void {
    if (this.disposed) return;
    try {
      const rect = this.anchor.getBoundingClientRect();
      Object.assign(this.canvas.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    } catch { this.onError(); }
  }
}

function equalPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
