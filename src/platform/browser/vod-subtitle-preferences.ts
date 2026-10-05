import { normalizeSubtitleOffsetSeconds } from "../../core/subtitles/timing.ts";
import type { VodSubtitleLanguage } from "../../core/subtitles/vod-selection.ts";
import type { PreferencesRepository } from "../../contracts/repository.ts";

export type VodSubtitleChoice =
  | { mode: "automatic" }
  | { mode: "off" }
  | { mode: "embedded"; language: string; label: string; forced?: boolean; hearingImpaired?: boolean; codec?: string; occurrence?: number }
  | { mode: "external"; language: string; id: string; fileId?: string };

export type VodSubtitleTimingSource = "embedded" | "external" | `embedded:${string}` | `external:${string}`;

const CHOICES_KEY = "substream.vod-subtitle-choices";
const OFFSETS_KEY = "substream.vod-subtitle-offsets";
const EMPTY_OFFSET = 0;

function safeKey(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /(?:https?|file|blob|data):\/\//i.test(normalized)) return undefined;
  return normalized;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/(?:https?|file|blob|data):\/\//i.test(value);
}

function parseChoice(value: unknown): VodSubtitleChoice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const choice = value as Record<string, unknown>;
  if (choice.mode === "automatic" || choice.mode === "off") return { mode: choice.mode };
  if (choice.mode === "embedded") {
    const language = typeof choice.language === "string" ? choice.language.trim().toLowerCase() : "";
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language) || typeof choice.label !== "string" || choice.label.length > 160) return null;
    const result: Extract<VodSubtitleChoice, { mode: "embedded" }> = { mode: "embedded", language, label: choice.label };
    if (typeof choice.forced === "boolean") result.forced = choice.forced;
    if (typeof choice.hearingImpaired === "boolean") result.hearingImpaired = choice.hearingImpaired;
    if (typeof choice.codec === "string" && choice.codec.length <= 64 && !/(?:https?|file|blob|data):\/\//i.test(choice.codec)) result.codec = choice.codec;
    if (typeof choice.occurrence === "number" && Number.isInteger(choice.occurrence) && choice.occurrence >= 0 && choice.occurrence <= 127) result.occurrence = choice.occurrence;
    return result;
  }
  if (choice.mode === "external" && typeof choice.language === "string" && validId(choice.id)) {
    const result: VodSubtitleChoice = { mode: "external", language: choice.language.slice(0, 32), id: choice.id };
    return validId(choice.fileId) ? { ...result, fileId: choice.fileId } : result;
  }
  return null;
}

/** Device-local VOD subtitle choices and per-source timing offsets. */
export class VodSubtitlePreferences {
  constructor(private readonly store: PreferencesRepository) {}

  getChoice(titleKey: string): VodSubtitleChoice | null {
    const key = safeKey(titleKey);
    if (!key) return null;
    const choices = this.readMap(CHOICES_KEY);
    return parseChoice(choices[key]);
  }

  setChoice(titleKey: string, choice: VodSubtitleChoice): void {
    const key = safeKey(titleKey);
    if (!key) return;
    const normalized = parseChoice(choice);
    if (!normalized) return;
    const choices = this.readMap(CHOICES_KEY);
    choices[key] = normalized;
    this.writeMap(CHOICES_KEY, choices);
  }

  getOffset(titleKey: string, sourceKey: VodSubtitleTimingSource): number {
    const key = this.timingKey(titleKey, sourceKey);
    if (!key) return EMPTY_OFFSET;
    const value = this.readMap(OFFSETS_KEY)[key];
    return typeof value === "number" ? normalizeSubtitleOffsetSeconds(value) : EMPTY_OFFSET;
  }

  setOffset(titleKey: string, sourceKey: VodSubtitleTimingSource, offsetSeconds: number): number {
    const normalized = normalizeSubtitleOffsetSeconds(offsetSeconds);
    const key = this.timingKey(titleKey, sourceKey);
    if (key) {
      const offsets = this.readMap(OFFSETS_KEY);
      offsets[key] = normalized;
      this.writeMap(OFFSETS_KEY, offsets);
    }
    return normalized;
  }

  clear(): void {
    try {
      this.store.remove(CHOICES_KEY);
      this.store.remove(OFFSETS_KEY);
    } catch { /* playback remains available if persistence cleanup fails */ }
  }

  private timingKey(titleKey: string, sourceKey: VodSubtitleTimingSource): string | undefined {
    const title = safeKey(titleKey);
    const source = safeKey(sourceKey);
    return title && source ? `${title}::${source}` : undefined;
  }

  private readMap(key: string): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(this.store.get(key) ?? "null");
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch { return {}; }
  }

  private writeMap(key: string, value: Record<string, unknown>): void {
    try { this.store.set(key, JSON.stringify(value)); } catch { /* playback remains available if persistence fails */ }
  }
}
