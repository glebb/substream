import { translate, type UiLanguage } from "./language.tsx";

const LANGUAGE_NAMES: Record<string, string> = {
  fi: "Finnish", fin: "Finnish", en: "English", eng: "English", sv: "Swedish", swe: "Swedish",
  da: "Danish", dan: "Danish", no: "Norwegian", nor: "Norwegian", nob: "Norwegian",
  de: "German", ger: "German", deu: "German", fr: "French", fre: "French", fra: "French",
  es: "Spanish", spa: "Spanish", it: "Italian", ita: "Italian", pt: "Portuguese", por: "Portuguese",
  ar: "Arabic", ara: "Arabic", zh: "Chinese", chi: "Chinese", zho: "Chinese", cs: "Czech", cze: "Czech", ces: "Czech",
  nl: "Dutch", dut: "Dutch", nld: "Dutch", el: "Greek", gre: "Greek", ell: "Greek", hi: "Hindi", hin: "Hindi",
  ja: "Japanese", jpn: "Japanese", ko: "Korean", kor: "Korean", fa: "Persian", per: "Persian", fas: "Persian",
  pl: "Polish", pol: "Polish", ro: "Romanian", rum: "Romanian", ron: "Romanian", tr: "Turkish", tur: "Turkish",
  ur: "Urdu", urd: "Urdu", ru: "Russian", rus: "Russian", uk: "Ukrainian", ukr: "Ukrainian",
  id: "Indonesian", ind: "Indonesian", ms: "Malay", may: "Malay", hu: "Hungarian", hun: "Hungarian",
  hr: "Croatian", hrv: "Croatian", th: "Thai", tha: "Thai", vi: "Vietnamese", vie: "Vietnamese",
  he: "Hebrew", heb: "Hebrew", fil: "Filipino", und: "Unknown language",
};

export function subtitleLanguageLabel(language?: string): string {
  if (!language?.trim()) return "Unknown language";
  const code = language.toLowerCase().replace(/_/g, "-").split("-")[0]!;
  return LANGUAGE_NAMES[code] ?? language;
}

export function embeddedSubtitleLabel(track: { language?: string; label: string; forced?: boolean; hearingImpaired?: boolean }, uiLanguage: UiLanguage = "en"): string {
  const language = subtitleLanguageLabel(track.language);
  let extra = track.label;
  for (const prefix of [track.language, language]) {
    if (!prefix) continue;
    if (extra.toLowerCase() === prefix.toLowerCase()) extra = "";
    else if (extra.toLowerCase().startsWith(prefix.toLowerCase() + " · ")) extra = extra.slice(prefix.length + 3).trim();
  }
  const translatedLanguage = translate(language, uiLanguage);
  const label = extra ? `${translatedLanguage} · ${extra}` : translatedLanguage;
  return label + (track.forced ? " · " + translate("Forced only", uiLanguage) : "") + (track.hearingImpaired ? " · " + translate("Hearing impaired", uiLanguage) : "");
}
