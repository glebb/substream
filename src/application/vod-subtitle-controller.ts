import {
  chooseEmbeddedSubtitleTrack,
  type VodEmbeddedSubtitleCandidate,
  type VodSubtitleLanguage,
} from "../core/subtitles/vod-selection.ts";

export interface VodExternalSubtitleCandidate {
  language: string;
  /** Activates only while current; discovery itself must not attach it. */
  activate(isCurrent: () => boolean): Promise<boolean> | boolean;
}

export type VodSubtitleSelection =
  | { source: "embedded"; language: VodSubtitleLanguage; track: VodEmbeddedSubtitleCandidate }
  | { source: "external"; language: string }
  | { source: "off" };

export interface VodSubtitleControllerOptions<T extends VodEmbeddedSubtitleCandidate> {
  preferredLanguage: VodSubtitleLanguage;
  discoverEmbedded(): Promise<readonly T[]>;
  selectEmbedded(track: T): Promise<boolean> | boolean;
  searchExternal(language: VodSubtitleLanguage): Promise<VodExternalSubtitleCandidate | null>;
  discoveryTimeoutMs?: number;
  externalTimeoutMs?: number;
  includeHearingImpaired?: boolean;
}

/**
 * Resolves the VOD automatic subtitle choice once at startup. Explicit user
 * choices invalidate pending automatic work, including pending downloads.
 */
export class VodSubtitleController<T extends VodEmbeddedSubtitleCandidate> {
  private generation = 0;
  private userLocked = false;

  constructor(private readonly options: VodSubtitleControllerOptions<T>) {}

  async start(): Promise<VodSubtitleSelection> {
    const generation = ++this.generation;
    this.userLocked = false;
    const timeout = Math.max(0, this.options.discoveryTimeoutMs ?? 1200);
    const preferredExternal = await this.tryExternal(this.options.preferredLanguage, generation);
    if (preferredExternal) return preferredExternal;
    if (!this.isCurrent(generation)) return { source: "off" };

    const tracks = await this.discoverWithin(timeout);
    if (!this.isCurrent(generation)) return { source: "off" };
    const preferred = await this.tryEmbedded(tracks, this.options.preferredLanguage, generation);
    if (preferred) return { source: "embedded", language: this.options.preferredLanguage, track: preferred };
    if (!this.isCurrent(generation)) return { source: "off" };

    const fallbackLanguage = this.options.preferredLanguage === "fi" ? "en" : "fi";
    const fallbackExternal = await this.tryExternal(fallbackLanguage, generation);
    if (fallbackExternal) return fallbackExternal;
    if (!this.isCurrent(generation)) return { source: "off" };
    const fallback = await this.tryEmbedded(tracks, fallbackLanguage, generation);
    if (fallback) return { source: "embedded", language: fallbackLanguage, track: fallback };
    if (!this.isCurrent(generation)) return { source: "off" };

    return { source: "off" };
  }

  /** Lock Automatic out after a manual track selection. */
  chooseManual(): void {
    this.userLocked = true;
    this.generation++;
  }

  /** Explicit Off is also a manual choice and cannot be undone by late work. */
  chooseOff(): VodSubtitleSelection {
    this.chooseManual();
    return { source: "off" };
  }

  /** Invalidates async work when playback is replaced or closed. */
  cancel(): void {
    this.generation++;
  }

  private async tryExternal(language: VodSubtitleLanguage, generation: number): Promise<VodSubtitleSelection | null> {
    const timeout = Math.max(0, this.options.externalTimeoutMs ?? 8000);
    const candidate = await this.withTimeout(Promise.resolve().then(() => this.options.searchExternal(language)), timeout);
    if (!candidate || !this.isCurrent(generation)) return null;
    let attemptActive = true;
    const isCurrentAttempt = () => attemptActive && this.isCurrent(generation);
    const activation = Promise.resolve().then(() => candidate.activate(isCurrentAttempt));
    let activated: boolean | undefined;
    try {
      activated = await this.withTimeout(activation, timeout);
    } finally {
      // Invalidate late async commits even if the overall player session remains current.
      attemptActive = false;
    }
    if (!activated || !this.isCurrent(generation)) return null;
    return { source: "external", language: candidate.language };
  }

  private async activateEmbedded(track: T, generation: number): Promise<boolean> {
    if (!this.isCurrent(generation)) return false;
    try {
      const activated = await this.options.selectEmbedded(track);
      return activated && this.isCurrent(generation);
    } catch { return false; }
  }

  private async tryEmbedded(tracks: readonly T[], language: VodSubtitleLanguage, generation: number): Promise<T | undefined> {
    let candidates = tracks;
    while (this.isCurrent(generation)) {
      const candidate = chooseEmbeddedSubtitleTrack(candidates, language, {
        includeHearingImpaired: this.options.includeHearingImpaired,
      });
      if (!candidate) return undefined;
      if (await this.activateEmbedded(candidate, generation)) return candidate;
      candidates = candidates.filter((track) => track.id !== candidate.id);
    }
    return undefined;
  }

  private isCurrent(generation: number): boolean {
    return this.generation === generation && !this.userLocked;
  }

  private async discoverWithin(timeoutMs: number): Promise<readonly T[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.options.discoverEmbedded(),
        new Promise<readonly T[]>((resolve) => { timer = setTimeout(() => resolve([]), timeoutMs); }),
      ]);
    } catch {
      return [];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async withTimeout<TValue>(operation: Promise<TValue>, timeoutMs: number): Promise<TValue | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
      ]);
    } catch { return undefined; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
