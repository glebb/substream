import type { MatroskaSubtitleTrack } from "./matroska.ts";

interface NativeSubtitleTrack {
  id: string;
  label: string;
  language?: string;
  codec?: string;
  forced?: boolean;
  hearingImpaired?: boolean;
}

function languageKey(value?: string): string {
  const code = value?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (["", "und", "unknown", "unknown language", "null"].includes(code)) return "";
  return ({
    fin: "fi", finnish: "fi", eng: "en", english: "en", swe: "sv", swedish: "sv",
    dan: "da", nor: "no", nob: "no", ger: "de", deu: "de", fre: "fr", fra: "fr",
    spa: "es", ita: "it", por: "pt", ara: "ar", chi: "zh", zho: "zh", cze: "cs", ces: "cs",
    dut: "nl", nld: "nl", gre: "el", ell: "el", hin: "hi", jpn: "ja", kor: "ko", per: "fa", fas: "fa",
    pol: "pl", rum: "ro", ron: "ro", tur: "tr", urd: "ur", rus: "ru", ukr: "uk", ind: "id",
    may: "ms", msa: "ms", hun: "hu", hrv: "hr", tha: "th", vie: "vi", heb: "he",
  } as Record<string, string>)[code] ?? code;
}

/**
 * AVPlay subtitle indices are selection handles, not Matroska TrackNumbers.
 * Match subtitle order only for complete equal-sized lists whose native
 * language/Matroska codec anchors agree. Never add file-only tracks as playable.
 */
export function enrichEmbeddedSubtitleTracks<T extends NativeSubtitleTrack>(native: readonly T[], metadata: readonly MatroskaSubtitleTrack[]): Array<T & NativeSubtitleTrack> {
  if (!native.length || native.length !== metadata.length
    || new Set(native.map((track) => track.id)).size !== native.length
    || new Set(metadata.map((track) => track.trackNumber)).size !== metadata.length) return [...native];
  const compatible = native.every((track, index) => {
    const file = metadata[index]!;
    const knownLanguage = languageKey(track.language);
    const fileLanguage = languageKey(file.language);
    return (!knownLanguage || !fileLanguage || knownLanguage === fileLanguage)
      && (!track.codec?.startsWith("S_") || track.codec === file.codecId);
  });
  if (!compatible) return [...native];
  return native.map((track, index) => {
    const file = metadata[index]!;
    const language = languageKey(track.language) ? track.language : languageKey(file.language) ? file.language : undefined;
    const codec = track.codec || file.codecId;
    const genericLabel = /^(?:Subtitle\s+\d+|(?:und|unknown(?: language)?)(?:\s*·.*)?)$/i.test(track.label.trim());
    const label = genericLabel || !track.label ? file.label || [language, codec].filter(Boolean).join(" · ") || track.label : track.label;
    return { ...track, label, ...(language ? { language } : {}), ...(codec ? { codec } : {}),
      forced: track.forced ?? file.forced, hearingImpaired: track.hearingImpaired ?? file.hearingImpaired };
  });
}
