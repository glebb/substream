/** Owns a selected local video and its object URL for one browser session. */
export class LocalMediaSource {
  private fileValue: File | null;
  private urlValue: string | null;
  private disposed = false;
  private retains = 0;
  private disposeTimer: number | ReturnType<typeof setTimeout> | null = null;

  constructor(file: File, private readonly urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL) {
    this.fileValue = file;
    this.urlValue = urls.createObjectURL(file);
  }

  get file(): File | null { return this.fileValue; }
  get url(): string | null { return this.urlValue; }
  get name(): string { return this.fileValue?.name ?? "Local video"; }
  get size(): number { return this.fileValue?.size ?? 0; }
  get type(): string { return this.fileValue?.type ?? ""; }

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
