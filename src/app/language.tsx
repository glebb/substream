import { Children, cloneElement, createContext, isValidElement, type ReactNode } from "react";
import { en } from "./locales/en.ts";
import { fi } from "./locales/fi.ts";

import type { UiLanguage } from "../platform/web/ui-language-config.ts";
export { loadUiLanguage, saveUiLanguage, type UiLanguage } from "../platform/web/ui-language-config.ts";

const dictionaries: Record<UiLanguage, Record<string, string>> = { en, fi };
export function translate(value: string, language: UiLanguage): string {
  const dictionary = dictionaries[language];
  if (dictionary[value] !== undefined) return dictionary[value]!;
  const trimmed = value.trim();
  if (trimmed && dictionary[trimmed] !== undefined) {
    return value.slice(0, value.indexOf(trimmed)) + dictionary[trimmed]! + value.slice(value.indexOf(trimmed) + trimmed.length);
  }
  const subtitleCount = value.match(/^(.+) subtitle matches found$/);
  if (subtitleCount) return dictionary["{{count}} subtitle matches found"]!.replace("{{count}}", subtitleCount[1]!);
  const episodeSubtitleCount = value.match(/^(.+) possible episode subtitles found$/);
  if (episodeSubtitleCount) return dictionary["{{count}} possible episode subtitles found"]!.replace("{{count}}", episodeSubtitleCount[1]!);
  const latestFailureCount = value.match(/^Latest loaded with (\d+) unavailable categories?\.$/);
  if (latestFailureCount) {
    const count = latestFailureCount[1]!;
    return language === "fi"
      ? `Uusimpien latauksessa ${count} ${count === "1" ? "kategoria" : "kategoriaa"} ei ollut saatavilla.`
      : `Latest loaded with ${count} unavailable ${count === "1" ? "category" : "categories"}.`;
  }
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

  // Only known UI messages are translated. Unknown text may be provider content.
  const seasonEpisode = value.match(/^(Season|Episode) (\d+)(, )?$/);
  if (seasonEpisode) return `${seasonEpisode[1] === "Season" ? "Kausi" : "Jakso"} ${seasonEpisode[2]}${seasonEpisode[3] ?? ""}`;
  const audio = value.match(/^Audio: (.+)$/);
  if (audio) return `Ääni: ${audio[1]}`;
  const subtitles = value.match(/^Subtitles: (On|Off|Finnish|English)( · Timing test)?$/);
  if (subtitles) return `Tekstitykset: ${translate(subtitles[1]!, language)}${subtitles[2] ? " · Ajoitustesti" : ""}`;
  const aspect = value.match(/^Aspect: (Auto|Fit|Fill)$/);
  if (aspect) return `Kuvasuhde: ${translate(aspect[1]!, language)}`;
  const removeHistory = value.match(/^Remove (.+) from Continue watching$/);
  if (removeHistory) return `Poista ${removeHistory[1]} Jatka katselua -listalta`;
  const favouriteAction = value.match(/^(Add|Remove) (.+) (to|from) favourites$/);
  if (favouriteAction) return `${favouriteAction[1] === "Add" ? "Lisää" : "Poista"} ${favouriteAction[2]} ${favouriteAction[1] === "Add" ? "suosikkeihin" : "suosikeista"}`;
  const watched = value.match(/^Watched (.+) of (.+)$/);
  if (watched) return `Katsottu ${watched[1]} / ${watched[2]}`;
  const nextProgramme = value.match(/^Next: (.+)$/);
  if (nextProgramme) return `Seuraavaksi: ${nextProgramme[1]}`;
  const remainingTime = value.match(/^(\d{2}:\d{2}–\d{2}:\d{2}) · (\d+) min left$/);
  if (remainingTime) return `${remainingTime[1]} · ${remainingTime[2]} min jäljellä`;
  const programmeProgress = value.match(/^(\d+)% of (.+)$/);
  if (programmeProgress) return `${programmeProgress[1]} % ohjelmasta ${programmeProgress[2]}`;
  const loadingGroup = value.match(/^Loading (.+) from the provider…$/);
  if (loadingGroup) return `Ladataan ${loadingGroup[1]} palveluntarjoajalta…`;
  const subtitleEnabled = value.match(/^Subtitle enabled: (.+)$/);
  if (subtitleEnabled) return `Tekstitys käytössä: ${subtitleEnabled[1]}`;
  const bestSubtitle = value.match(/^Best match found. Loading (.+) subtitles…$/);
  if (bestSubtitle) return `Paras vastaavuus löytyi. Ladataan ${bestSubtitle[1]}-tekstitystä…`;
  const providerCategories = value.match(/^(.+) provider categories ready$/);
  if (providerCategories) return `${providerCategories[1]} palveluntarjoajan kategoriaa valmiina`;
  const importProgress = value.match(/^(.+) entries scanned · (.+) VOD items saved$/);
  if (importProgress) return `${importProgress[1]} merkintää luettu · ${importProgress[2]} videonimikettä tallennettu`;
  const importComplete = value.match(/^(.+) VOD items imported$/);
  if (importComplete) return `${importComplete[1]} videonimikettä tuotu`;
  const updatingCatalogue = value.match(/^Updating saved catalogue… (.+) titles processed\. Large libraries can take a few minutes; keep this page open\.$/);
  if (updatingCatalogue) return `Päivitetään tallennettua luetteloa… ${updatingCatalogue[1]} nimikettä käsitelty. Suuren kirjaston käsittely voi kestää muutaman minuutin. Pidä sivu avoinna.`;
  const pairedBrowser = value.match(/^Browser paired with (.+)\. You can choose it as the playback target\.$/);
  if (pairedBrowser) return `Selain pariliitetty TV:hen ${pairedBrowser[1]}. Voit valita sen toistokohteeksi.`;
  return value;
}

function localizeNode(node: ReactNode, language: UiLanguage): ReactNode {
  return Children.map(node, (child) => {
    if (typeof child === "string") return translate(child, language);
    if (!isValidElement<Record<string, unknown>>(child)) return child;
    const props = { ...child.props };
    if (props.translate === "no") return child;
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
