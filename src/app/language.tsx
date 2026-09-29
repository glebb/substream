import { Children, cloneElement, createContext, isValidElement, type ReactNode } from "react";
import { en } from "./locales/en.ts";
import { fi } from "./locales/fi.ts";

export type UiLanguage = "fi" | "en";

const storageKey = "substream.ui-language";
const dictionaries: Record<UiLanguage, Record<string, string>> = { en, fi };
const dynamicWords = Object.keys(fi).filter((key) => /^[A-Za-z]+$/.test(key)).sort((left, right) => right.length - left.length);
const dynamicWordPattern = new RegExp(`\\b(?:${dynamicWords.map(escapeRegExp).join("|")})\\b`, "gi");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function loadUiLanguage(): UiLanguage {
  try { return localStorage.getItem(storageKey) === "en" ? "en" : "fi"; } catch { return "fi"; }
}

export function saveUiLanguage(language: UiLanguage): void {
  try { localStorage.setItem(storageKey, language); } catch { /* optional preference */ }
}

export function translate(value: string, language: UiLanguage): string {
  const dictionary = dictionaries[language];
  if (dictionary[value] !== undefined) return dictionary[value]!;
  const subtitleCount = value.match(/^(.+) subtitle matches found$/);
  if (subtitleCount) return dictionary["{{count}} subtitle matches found"]!.replace("{{count}}", subtitleCount[1]!);
  const episodeSubtitleCount = value.match(/^(.+) possible episode subtitles found$/);
  if (episodeSubtitleCount) return dictionary["{{count}} possible episode subtitles found"]!.replace("{{count}}", episodeSubtitleCount[1]!);
  if (language === "en") return value;

  const loadingCategories = value.match(/^Loading (.+) of (.+) categories…$/);
  if (loadingCategories) return `Ladataan ${loadingCategories[1]} / ${loadingCategories[2]} kategoriaa…`;
  const favouriteNotice = value.match(/^(.+) (added to|removed from) favourites\.$/);
  if (favouriteNotice) return `${favouriteNotice[1]} ${favouriteNotice[2] === "added to" ? "lisätty suosikkeihin" : "poistettu suosikeista"}.`;
  const providerLoaded = value.match(/^(.+) titles loaded from your provider\.$/);
  if (providerLoaded) return `${providerLoaded[1]} nimikettä ladattu palveluntarjoajalta.`;
  const channelCount = value.match(/^(.+) channels ready$/);
  if (channelCount) return `${channelCount[1]} kanavaa valmiina`;
  const titleCount = value.match(/^(.+) titles ready$/);
  if (titleCount) return `${titleCount[1]} nimikettä valmiina`;
  const behindLive = value.match(/^(.+)s behind live$/);
  if (behindLive) return `${behindLive[1]} s jäljessä suorasta lähetyksestä`;
  const sentTitle = value.match(/^Sent “(.+)” to TV\.$/);
  if (sentTitle) return `Lähetettiin ”${sentTitle[1]}” TV:hen.`;
  const removedTitle = value.match(/^(.+) removed from Continue watching\.$/);
  if (removedTitle) return `${removedTitle[1]} poistettu Jatka katselua -listalta.`;
  const companionReceived = value.match(/^(.+) received from companion\.$/);
  if (companionReceived) return `${companionReceived[1]} vastaanotettu oheislaitteelta.`;
  const companionSent = value.match(/^(.+) sent to TV playback\.$/);
  if (companionSent) return `${companionSent[1]} lähetetty TV:n toistoon.`;
  const finnishCategories = value.match(/^(.+) Finnish categories ready$/);
  if (finnishCategories) return `${finnishCategories[1]} suomalaista kategoriaa valmiina`;
  const finnishAudio = value.match(/^Finnish audio unavailable · (.+)$/);
  if (finnishAudio) return `Suomenkielistä ääntä ei ole saatavilla · ${finnishAudio[1]}`;
  const subtitleOffset = value.match(/^([+-]?\d+(?:\.\d+)?) s \((in sync|later|earlier)\)$/);
  if (subtitleOffset) return `${subtitleOffset[1]} s (${subtitleOffset[2] === "in sync" ? "synkronissa" : subtitleOffset[2] === "later" ? "myöhemmin" : "aiemmin"})`;
  const relayGap = value.match(/^Relay queue gap: commands through sequence (\d+) expired; replay resumed at (\d+)\.$/);
  if (relayGap) return `Välitysjono katkesi: komennot järjestysnumeroon ${relayGap[1]} asti vanhenivat; toisto jatkuu numerosta ${relayGap[2]}.`;

  return value.replace(dynamicWordPattern, (word) => dictionary[word] ?? dictionary[word.toLocaleLowerCase()] ?? dictionary[word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase()] ?? word);
}

function localizeNode(node: ReactNode, language: UiLanguage): ReactNode {
  return Children.map(node, (child) => {
    if (typeof child === "string") return translate(child, language);
    if (!isValidElement<Record<string, unknown>>(child)) return child;
    const props = { ...child.props };
    for (const key of ["aria-label", "aria-description", "title", "placeholder", "label"]) {
      if (typeof props[key] === "string") props[key] = translate(props[key] as string, language);
    }
    if (props.children !== undefined) props.children = localizeNode(props.children as ReactNode, language);
    return cloneElement(child, props);
  });
}

export function Localized({ language, children }: { language: UiLanguage; children: ReactNode }) {
  return <>{localizeNode(children, language)}</>;
}

export const LanguageContext = createContext<{ language: UiLanguage; setLanguage(language: UiLanguage): void }>({ language: "fi", setLanguage: () => undefined });
