import type { LocalMediaContainer } from "../media-player.ts";

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;
const EBML_HEADER_PROBE_BYTES = 64;

/** Filename/MIME fallback used until (or if) the header probe cannot read the file. */
export function guessLocalContainer(file: { name?: string; type?: string }): LocalMediaContainer {
  if (/\.webm$/i.test(file.name ?? "") || /^video\/webm\b/i.test(file.type ?? "")) return "webm";
  if (/\.mk[av]$/i.test(file.name ?? "") || /matroska/i.test(file.type ?? "")) return "matroska";
  return "other";
}

/**
 * Reads only the EBML header on the device. The DocType separates WebM, which
 * browsers usually decode natively, from Matroska, which needs the remux path.
 */
export async function probeLocalContainer(file: Blob & { name?: string }): Promise<LocalMediaContainer> {
  try {
    const head = new Uint8Array(await file.slice(0, EBML_HEADER_PROBE_BYTES).arrayBuffer());
    if (head.length < EBML_MAGIC.length || EBML_MAGIC.some((byte, index) => head[index] !== byte)) return "other";
    // DocType element (0x4282) followed by a one-byte size and an ASCII value.
    for (let index = EBML_MAGIC.length; index + 3 < head.length; index++) {
      if (head[index] !== 0x42 || head[index + 1] !== 0x82) continue;
      const size = head[index + 2]! & 0x7f;
      const docType = String.fromCharCode(...head.slice(index + 3, index + 3 + size));
      return docType === "webm" ? "webm" : "matroska";
    }
    return "matroska";
  } catch {
    return guessLocalContainer(file);
  }
}

/** Owns a selected local video and its object URL for one browser session. */
export class LocalMediaSource {
  private fileValue: File | null;
  private urlValue: string | null;
  private containerValue: LocalMediaContainer;
  private disposed = false;
  private retains = 0;
  private disposeTimer: number | ReturnType<typeof setTimeout> | null = null;

  constructor(file: File, private readonly urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL) {
    this.fileValue = file;
    this.urlValue = urls.createObjectURL(file);
    this.containerValue = guessLocalContainer(file);
    // The header is normally probed long before the viewer presses Play on the
    // details screen. Until then, the filename/MIME guess is used.
    void probeLocalContainer(file).then((container) => {
      if (!this.disposed) this.containerValue = container;
    });
  }

  get file(): File | null { return this.fileValue; }
  get url(): string | null { return this.urlValue; }
  get name(): string { return this.fileValue?.name ?? "Local video"; }
  get size(): number { return this.fileValue?.size ?? 0; }
  get type(): string { return this.fileValue?.type ?? ""; }
  /** Container detected from the file header; never derived from or sent to a server. */
  get container(): LocalMediaContainer { return this.containerValue; }

  retain(): () => void {
    if (this.disposed) throw new Error("Local media source has already been released.");
    if (this.disposeTimer !== null) {
      clearTimeout(this.disposeTimer as number);
      this.disposeTimer = null;
    }
    this.retains += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retains = Math.max(0, this.retains - 1);
      if (this.retains === 0) {
        this.disposeTimer = setTimeout(() => {
          this.disposeTimer = null;
          if (this.retains === 0) this.dispose();
        }, 0);
      }
    };
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.disposeTimer !== null) clearTimeout(this.disposeTimer as number);
    this.disposeTimer = null;
    this.disposed = true;
    if (this.urlValue) this.urls.revokeObjectURL(this.urlValue);
    this.urlValue = null;
    this.fileValue = null;
  }
}

export function localDisplayTitle(filename: string): string {
  const withoutExtension = filename.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") ?? filename;
  return withoutExtension.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim() || "Local video";
}

function rawLocalBasename(filename: string): string {
  return filename.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") ?? filename;
}

function cleanSearchTitle(value: string): string {
  return value
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?=[^)]*(?:eztv|rarbg|yify|ettv|torrent|web[- ]?dl|bluray))[^)]*\)/gi, " ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/(?:^|[\s._-])(?:480p|720p|1080p|2160p|4k|8k|web[ ._-]?dl|webrip|bluray|brrip|hdtv|hevc|h\.?265|x265|h\.?264|x264|aac|eac3|ac3|dts|atmos|proper|repack|remux|hdr10?)(?:$|[\s._-].*)/i, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s.-]+$/g, "")
    .trim();
}

export function localSubtitleQuery(filename: string): string {
  const raw = rawLocalBasename(filename);
  const episode = raw.match(/\bS\d{1,2}\s*E\d{1,3}\b|\b\d{1,2}\s*[xX]\s*\d{1,3}\b/i);
  const seriesTitle = episode?.index !== undefined ? raw.slice(0, episode.index) : raw;
  return cleanSearchTitle(seriesTitle) || cleanSearchTitle(raw) || localDisplayTitle(filename);
}

export function classifyLocalFilename(filename: string): { contentType: "series" | "other"; season?: number; episode?: number; evidence: string[] } {
  const title = rawLocalBasename(filename);
  const explicitEpisode = title.match(/\bS(\d{1,2})\s*E(\d{1,3})\b|\b(\d{1,2})\s*[xX]\s*(\d{1,3})\b/i);
  if (explicitEpisode) {
    return {
      contentType: "series",
      season: Number(explicitEpisode[1] ?? explicitEpisode[3]),
      episode: Number(explicitEpisode[2] ?? explicitEpisode[4]),
      evidence: ["Filename contains an explicit season-and-episode pattern."],
    };
  }
  return { contentType: "other", evidence: ["Filename alone does not establish whether this video is a movie or series episode."] };
}

/** Read the duration from local media metadata; null when this browser cannot open the container. */
export function probeLocalDuration(url: string, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = (duration: number | null) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      resolve(duration);
    };
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => finish(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null);
    video.onerror = () => finish(null);
    timer = setTimeout(() => finish(null), timeoutMs);
    video.src = url;
  });
}
