import type { EmbeddedSubtitleDiscoveryResult } from "../platform/browser/embedded-subtitle-discovery.ts";
import { Localized, translate, type UiLanguage } from "./language.tsx";
import { subtitleLanguageLabel } from "./subtitle-labels.ts";

/** File presence and device playability are deliberately separate facts. */
export function SubtitleAvailability({ embedded, externalLanguages, episodeRequired = false, local = false, language = "en" }: {
  embedded: EmbeddedSubtitleDiscoveryResult | null;
  externalLanguages: string[];
  episodeRequired?: boolean;
  local?: boolean;
  language?: UiLanguage;
}) {
  const includedLanguages = [...new Set(embedded?.tracks.map((track) => translate(subtitleLanguageLabel(track.language), language)) ?? [])];
  return <Localized language={language}>
    {episodeRequired ? <p className="hint">Choose an episode to check included subtitles.</p> : !local && <p className="hint">
      <span>Included in video: </span>
      {embedded?.status === "ready" ? includedLanguages.length ? <span translate="no">{includedLanguages.join(", ")}</span> : <span>No embedded subtitles found</span>
        : embedded ? <span>Availability could not be checked</span> : <span>Checking included subtitles…</span>}
    </p>}
    {includedLanguages.length > 0 && <p className="hint">Included tracks are available when supported by this device's player.</p>}
    {externalLanguages.length > 0 ? <p className="hint"><span>OpenSubtitles: </span><span translate="no">{[...new Set(externalLanguages.map((code) => translate(subtitleLanguageLabel(code), language)))].join(", ")}</span></p>
      : <p className="hint">Subtitle languages will appear after searching OpenSubtitles.</p>}
  </Localized>;
}
