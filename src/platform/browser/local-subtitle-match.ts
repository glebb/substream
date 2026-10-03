import { rankSubtitleResults, type RankedSubtitleResult, type SubtitleCandidate } from "../../core/subtitles/rank.ts";
import type { SubtitleLanguage } from "./subtitle-preferences.ts";

export type LocalSubtitleTarget = {
  title: string;
  year: number | null;
  contentType: "movie" | "series";
  season?: number;
  episode?: number;
};

export type LocalSubtitleSnapshot = {
  text: string;
  label: string;
  language: string;
  enabled: true;
  offsetSeconds: number;
  result: RankedSubtitleResult;
};

type LocalSubtitleSearch = { languages: string[]; query?: string; type: "movie" | "episode"; year?: number; season?: number; episode?: number; parentFeatureId?: number };
export type LocalSubtitleClient = {
  search(input: LocalSubtitleSearch): Promise<SubtitleCandidate[]>;
  findSeriesFeature(query: string, year: number | null): Promise<{ id: number; title: string; year: number | null } | null>;
  download(fileId: number): Promise<{ fileName: string; link: string }>;
  fetchSubtitleText(url: string): Promise<string>;
};

export type LocalSubtitleLoadOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  abortRequest?: () => void;
};

/** Find and download only a high-confidence preferred local-file subtitle. */
export async function loadPreferredLocalSubtitle(
  client: LocalSubtitleClient,
  target: LocalSubtitleTarget,
  languagePreference: SubtitleLanguage,
  options: LocalSubtitleLoadOptions = {},
): Promise<LocalSubtitleSnapshot | null> {
  const title = target.title.trim();
  if (!title) return null;
  const languages = languagePreference === "fi" ? ["fi", "en"] : ["en", "fi"];
  const timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: () => void = () => {};
  let finish: (value: LocalSubtitleSnapshot | null) => void = () => undefined;
  const abortedOrTimedOut = new Promise<LocalSubtitleSnapshot | null>((resolve) => {
    finish = resolve;
    const onAbort = () => {
      options.abortRequest?.();
      resolve(null);
    };
    if (options.signal?.aborted) onAbort();
    else if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
    }
    timer = setTimeout(() => {
      options.abortRequest?.();
      resolve(null);
    }, timeoutMs);
  });
  const operation = (async (): Promise<LocalSubtitleSnapshot | null> => {
  let results: SubtitleCandidate[];
  let parentFeatureId: number | undefined;
  if (target.contentType === "series" && target.season !== undefined && target.episode !== undefined) {
    const feature = await client.findSeriesFeature(title, target.year);
    if (feature) {
      parentFeatureId = feature.id;
      results = await client.search({ languages, parentFeatureId, season: target.season, episode: target.episode, type: "episode" });
    } else {
      results = await client.search({ languages, query: title, season: target.season, episode: target.episode, type: "episode" });
    }
  } else {
    results = await client.search({ languages, query: title, type: target.contentType === "series" ? "episode" : "movie", ...(target.year !== null ? { year: target.year } : {}) });
  }
  const ranked = rankSubtitleResults({
    title,
    year: target.year,
    contentType: target.contentType,
    ...(target.season !== undefined ? { season: target.season } : {}),
    ...(target.episode !== undefined ? { episode: target.episode } : {}),
    ...(parentFeatureId !== undefined ? { parentFeatureId } : {}),
    languagePreference,
  }, results);
  const result = ranked.find((item) => item.highConfidence);
  if (!result) return null;
  const download = await client.download(result.fileId);
  const text = await client.fetchSubtitleText(download.link);
  if (!text.trim()) return null;
  return { text, label: download.fileName || result.fileName, language: result.language, enabled: true, offsetSeconds: 0, result };
  })();
  try {
    return await Promise.race([operation, abortedOrTimedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbort();
    // Settle the timeout promise if the operation won, allowing its abort
    // listener to be removed without leaving a pending lifecycle handle.
    finish(null);
  }
}
