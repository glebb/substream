import type { LiveCategory, LiveCountryEvidence } from "./types.ts";

/** Country key for provider categories that cannot be confidently classified. */
export const UNKNOWN_LIVE_COUNTRY = "unknown";
export const DEFAULT_LIVE_COUNTRIES: readonly string[] = ["finland"];

type CountryDefinition = {
  key: string;
  label: string;
  /** Names that may also start a category without a separator, e.g. "Finland Movies". */
  names: readonly string[];
  /** Short codes, trusted only as a separated prefix ("FI | Sports") or as the whole name. */
  codes?: readonly string[];
};

// Includes provider language/region groups (Arabic, Latino, Ex-Yu) because IPTV
// providers group channels that way alongside countries.
const COUNTRIES: readonly CountryDefinition[] = [
  { key: "finland", label: "Finland", names: ["finland", "finnish", "suomi", "suomalaiset", "finlande", "finlandia", "fi finland", "fi suomi", "finland channels", "suomi kanavat"], codes: ["fi", "fin"] },
  { key: "sweden", label: "Sweden", names: ["sweden", "swedish", "sverige", "svenska"], codes: ["se", "swe"] },
  { key: "norway", label: "Norway", names: ["norway", "norwegian", "norge", "norsk"], codes: ["no", "nor"] },
  { key: "denmark", label: "Denmark", names: ["denmark", "danish", "danmark", "dansk"], codes: ["dk", "den", "dan"] },
  { key: "iceland", label: "Iceland", names: ["iceland", "icelandic"], codes: ["is", "isl"] },
  { key: "nordic", label: "Nordic", names: ["nordic", "scandinavia", "scandinavian"] },
  { key: "baltic", label: "Baltic", names: ["baltic", "baltics"] },
  { key: "estonia", label: "Estonia", names: ["estonia", "eesti"], codes: ["ee", "est"] },
  { key: "latvia", label: "Latvia", names: ["latvia", "latvija"], codes: ["lv", "lat"] },
  { key: "lithuania", label: "Lithuania", names: ["lithuania", "lietuva"], codes: ["lt", "ltu"] },
  { key: "united-kingdom", label: "United Kingdom", names: ["united kingdom", "great britain", "britain", "england", "scotland", "wales"], codes: ["uk", "gb", "gbr"] },
  { key: "ireland", label: "Ireland", names: ["ireland", "eire"], codes: ["ie", "irl"] },
  { key: "usa", label: "USA", names: ["usa", "united states", "united states of america"], codes: ["us"] },
  { key: "canada", label: "Canada", names: ["canada"], codes: ["ca", "can"] },
  { key: "australia", label: "Australia", names: ["australia"], codes: ["au", "aus"] },
  { key: "new-zealand", label: "New Zealand", names: ["new zealand"], codes: ["nz"] },
  { key: "germany", label: "Germany", names: ["germany", "german", "deutschland", "deutsch"], codes: ["de", "ger", "deu"] },
  { key: "austria", label: "Austria", names: ["austria", "osterreich"], codes: ["at", "aut"] },
  { key: "switzerland", label: "Switzerland", names: ["switzerland", "swiss", "schweiz", "suisse", "svizzera"], codes: ["ch", "che"] },
  { key: "netherlands", label: "Netherlands", names: ["netherlands", "netherland", "holland", "dutch", "nederland"], codes: ["nl", "nld"] },
  { key: "belgium", label: "Belgium", names: ["belgium", "belgie", "belgique"], codes: ["be", "bel"] },
  { key: "luxembourg", label: "Luxembourg", names: ["luxembourg"], codes: ["lu", "lux"] },
  { key: "france", label: "France", names: ["france", "french", "francais"], codes: ["fr", "fra"] },
  { key: "spain", label: "Spain", names: ["spain", "spanish", "espana"], codes: ["es", "esp"] },
  { key: "portugal", label: "Portugal", names: ["portugal", "portuguese"], codes: ["pt", "por"] },
  { key: "italy", label: "Italy", names: ["italy", "italian", "italia"], codes: ["it", "ita"] },
  { key: "malta", label: "Malta", names: ["malta"], codes: ["mt"] },
  { key: "greece", label: "Greece", names: ["greece", "greek", "hellas", "ellada"], codes: ["gr", "gre"] },
  { key: "cyprus", label: "Cyprus", names: ["cyprus"], codes: ["cy"] },
  { key: "poland", label: "Poland", names: ["poland", "polish", "polska"], codes: ["pl", "pol"] },
  { key: "czechia", label: "Czechia", names: ["czech", "czechia", "czech republic", "cesko"], codes: ["cz", "cze"] },
  { key: "slovakia", label: "Slovakia", names: ["slovakia", "slovensko"], codes: ["sk", "svk"] },
  { key: "hungary", label: "Hungary", names: ["hungary", "hungarian", "magyar", "magyarorszag"], codes: ["hu", "hun"] },
  { key: "romania", label: "Romania", names: ["romania", "romanian"], codes: ["ro", "rou"] },
  { key: "moldova", label: "Moldova", names: ["moldova"], codes: ["md"] },
  { key: "bulgaria", label: "Bulgaria", names: ["bulgaria", "bulgarian"], codes: ["bg", "bgr"] },
  { key: "ex-yu", label: "Ex-Yu", names: ["ex yu", "exyu", "ex yugoslavia", "balkan", "balkans"] },
  { key: "croatia", label: "Croatia", names: ["croatia", "hrvatska"], codes: ["hr", "hrv"] },
  { key: "serbia", label: "Serbia", names: ["serbia", "srbija"], codes: ["rs", "srb"] },
  { key: "bosnia", label: "Bosnia and Herzegovina", names: ["bosnia", "bosna", "bosnia and herzegovina", "bosna i hercegovina"], codes: ["ba", "bih"] },
  { key: "montenegro", label: "Montenegro", names: ["montenegro", "crna gora"], codes: ["me", "mne"] },
  { key: "slovenia", label: "Slovenia", names: ["slovenia", "slovenija"], codes: ["si", "svn"] },
  { key: "north-macedonia", label: "North Macedonia", names: ["macedonia", "north macedonia", "makedonija"], codes: ["mk", "mkd"] },
  { key: "albania", label: "Albania", names: ["albania", "albanian", "shqiperia", "shqip"], codes: ["al", "alb"] },
  { key: "turkiye", label: "Türkiye", names: ["turkiye", "turkey", "turkish", "turk"], codes: ["tr", "tur"] },
  { key: "ukraine", label: "Ukraine", names: ["ukraine", "ukrainian", "ukraina"], codes: ["ua", "ukr"] },
  { key: "russia", label: "Russia", names: ["russia", "russian", "rossiya"], codes: ["ru", "rus"] },
  { key: "armenia", label: "Armenia", names: ["armenia", "armenian"], codes: ["am", "arm"] },
  { key: "georgia", label: "Georgia", names: ["georgia", "georgian", "sakartvelo"], codes: ["ge", "geo"] },
  { key: "azerbaijan", label: "Azerbaijan", names: ["azerbaijan"], codes: ["az", "aze"] },
  { key: "kazakhstan", label: "Kazakhstan", names: ["kazakhstan"], codes: ["kz"] },
  { key: "kyrgyzstan", label: "Kyrgyzstan", names: ["kyrgyzstan"], codes: ["kg"] },
  { key: "tajikistan", label: "Tajikistan", names: ["tajikistan"], codes: ["tj"] },
  { key: "turkmenistan", label: "Turkmenistan", names: ["turkmenistan"], codes: ["tm"] },
  { key: "uzbekistan", label: "Uzbekistan", names: ["uzbekistan"], codes: ["uz"] },
  { key: "arabic", label: "Arabic", names: ["arabic", "arab", "arabia", "middle east"] },
  { key: "hebrew", label: "Hebrew", names: ["hebrew", "israel"], codes: ["il", "isr"] },
  { key: "kurdistan", label: "Kurdistan", names: ["kurdistan", "kurdish"] },
  { key: "iran", label: "Iran", names: ["iran", "persian", "farsi"], codes: ["ir", "irn"] },
  { key: "afghanistan", label: "Afghanistan", names: ["afghanistan", "afghan"], codes: ["af", "afg"] },
  { key: "pakistan", label: "Pakistan", names: ["pakistan", "urdu"], codes: ["pk", "pak"] },
  { key: "india", label: "India", names: ["india", "indian", "hindi"], codes: ["in", "ind"] },
  { key: "bangladesh", label: "Bangladesh", names: ["bangladesh", "bangla", "bengali"], codes: ["bd", "bgd"] },
  { key: "sri-lanka", label: "Sri Lanka", names: ["sri lanka", "tamil"], codes: ["lk"] },
  { key: "nepal", label: "Nepal", names: ["nepal"], codes: ["np"] },
  { key: "maldives", label: "Maldives", names: ["maldives"], codes: ["mv"] },
  { key: "myanmar", label: "Myanmar", names: ["myanmar", "burma"], codes: ["mm"] },
  { key: "thailand", label: "Thailand", names: ["thailand", "thai"], codes: ["th", "tha"] },
  { key: "vietnam", label: "Vietnam", names: ["vietnam", "viet nam", "vietnamese"], codes: ["vn", "vnm"] },
  { key: "malaysia", label: "Malaysia", names: ["malaysia"], codes: ["my", "mys"] },
  { key: "singapore", label: "Singapore", names: ["singapore"], codes: ["sg"] },
  { key: "indonesia", label: "Indonesia", names: ["indonesia"], codes: ["id", "idn"] },
  { key: "philippines", label: "Philippines", names: ["philippines", "filipino", "pinoy"], codes: ["ph", "phl"] },
  { key: "china", label: "China", names: ["china", "chinese"], codes: ["cn", "chn"] },
  { key: "hong-kong", label: "Hong Kong", names: ["hong kong"], codes: ["hk"] },
  { key: "taiwan", label: "Taiwan", names: ["taiwan"], codes: ["tw"] },
  { key: "japan", label: "Japan", names: ["japan", "japanese"], codes: ["jp", "jpn"] },
  { key: "korea", label: "Korea", names: ["korea", "korean", "south korea"], codes: ["kr", "kor"] },
  { key: "pacific", label: "Pacific Islands", names: ["pacific", "pacific islands"] },
  { key: "africa", label: "Africa", names: ["africa", "african"] },
  { key: "latino", label: "Latino", names: ["latino", "latin", "latin america", "latam"] },
  { key: "mexico", label: "Mexico", names: ["mexico"], codes: ["mx", "mex"] },
  { key: "brazil", label: "Brazil", names: ["brazil", "brasil", "brazilian"], codes: ["br", "bra"] },
  { key: "argentina", label: "Argentina", names: ["argentina"] },
  { key: "caribbean", label: "Caribbean", names: ["caribbean"] },
  { key: "suriname", label: "Suriname", names: ["suriname"], codes: ["sr"] },
];

const BY_NAME = new Map<string, CountryDefinition>();
const BY_CODE = new Map<string, CountryDefinition>();
for (const country of COUNTRIES) {
  country.names.forEach((name) => BY_NAME.set(name, country));
  country.codes?.forEach((code) => BY_CODE.set(code, country));
}
const MAX_NAME_WORDS = Math.max(...COUNTRIES.flatMap((country) => country.names.map((name) => name.split(" ").length)));
const LABELS = new Map(COUNTRIES.map((country) => [country.key, country.label]));
const CATEGORY_SEPARATOR = /\s*(?:[|:▸»›•]|\s[-–]|[-–]\s)\s*/;

export interface LiveCountryMatch {
  country: string;
  /** The category name without its recognized country prefix. */
  displayName: string;
  evidence: LiveCountryEvidence;
}

export interface LiveCountryGroup {
  country: string;
  label: string;
  categories: LiveCategory[];
}

export function normalizeLiveMetadata(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

export function liveCountryLabel(country: string): string {
  return LABELS.get(country) ?? (country === UNKNOWN_LIVE_COUNTRY ? "Other" : country);
}

/** Every country key the detector can return, in display order. */
export function knownLiveCountries(): string[] {
  return COUNTRIES.map((country) => country.key);
}

/**
 * Classifies a provider live category by its leading country/region label.
 * Unrecognized categories stay `unknown` so they remain reachable under Other.
 */
export function detectLiveCountry(categoryName: string): LiveCountryMatch {
  const separator = CATEGORY_SEPARATOR.exec(categoryName);
  if (separator && separator.index > 0) {
    const head = normalizeLiveMetadata(categoryName.slice(0, separator.index));
    const country = BY_NAME.get(head) ?? BY_CODE.get(head);
    if (country) {
      const rest = categoryName.slice(separator.index + separator[0].length).trim();
      return {
        country: country.key,
        displayName: rest || categoryName.trim(),
        evidence: { kind: "category-prefix", value: categoryName, detail: `Category prefix matched ${country.label}` },
      };
    }
  }
  const normalized = normalizeLiveMetadata(categoryName);
  const exact = BY_NAME.get(normalized) ?? BY_CODE.get(normalized);
  if (exact) return { country: exact.key, displayName: categoryName.trim(), evidence: { kind: "category-name", value: categoryName, detail: `Category name matched ${exact.label}` } };
  // Codes are too ambiguous as leading words ("IT Crowd", "NO Limits"), so only full names qualify here.
  const words = normalized.split(" ");
  for (let count = Math.min(MAX_NAME_WORDS, words.length - 1); count >= 1; count -= 1) {
    const country = BY_NAME.get(words.slice(0, count).join(" "));
    if (country) return { country: country.key, displayName: categoryName.trim(), evidence: { kind: "category-name", value: categoryName, detail: `Category name starts with ${country.label}` } };
  }
  return { country: UNKNOWN_LIVE_COUNTRY, displayName: categoryName.trim(), evidence: { kind: "unmatched", value: categoryName, detail: "Category name did not match a known country or region" } };
}

/** Groups categories by detected country, keeping provider order inside each group and Other last. */
export function groupLiveCategoriesByCountry(categories: readonly LiveCategory[]): LiveCountryGroup[] {
  const groups = new Map<string, LiveCountryGroup>();
  for (const category of categories) {
    const country = detectLiveCountry(category.name).country;
    const group = groups.get(country) ?? { country, label: liveCountryLabel(country), categories: [] };
    group.categories.push(category);
    groups.set(country, group);
  }
  return [...groups.values()].sort((left, right) =>
    Number(left.country === UNKNOWN_LIVE_COUNTRY) - Number(right.country === UNKNOWN_LIVE_COUNTRY)
    || left.label.localeCompare(right.label));
}
