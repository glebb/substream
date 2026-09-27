import type { EpgProgramme, LiveChannel } from "./types.ts";
import { selectCurrentAndNextProgramme } from "./epg.ts";

export interface DnaChannel {
  id: string;
  name: string;
  logo: string | null;
}

export interface DnaChannelMatch {
  channel: DnaChannel;
  evidence: { kind: "normalized-exact-name" | "curated-alias"; providerName: string; dnaName: string };
}

/** Conservative cross-provider matching: exact normalized names after removing only a terminal quality label. */
export function matchDnaChannel(channel: LiveChannel, catalog: readonly DnaChannel[]): DnaChannelMatch | null {
  const key = channelMatchKey(channel.name);
  if (!key) return null;
  const aliasTarget = DNA_NAME_ALIASES[key];
  const matches = catalog.filter((item) => channelMatchKey(item.name) === (aliasTarget ?? key));
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  return { channel: match, evidence: { kind: aliasTarget ? "curated-alias" : "normalized-exact-name", providerName: channel.name, dnaName: match.name } };
}

export function attachDnaFallback(channel: LiveChannel, match: DnaChannelMatch | null): LiveChannel {
  if (!match) return channel;
  return {
    ...channel,
    dnaChannelId: match.channel.id,
    dnaMatchEvidence: match.evidence,
    ...(match.channel.logo ? { dnaLogo: match.channel.logo } : {}),
  };
}

/** Adds only the missing current/next slots, preserving the provider's entries when present. */
export function fillMissingGuideSlots(
  providerProgrammes: readonly EpgProgramme[],
  dnaProgrammes: readonly EpgProgramme[],
  now: number,
): EpgProgramme[] {
  const provider = selectCurrentAndNextProgramme(providerProgrammes, now);
  const dna = selectCurrentAndNextProgramme(dnaProgrammes, now);
  const current = provider.current ?? dna.current;
  if (!current) {
    if (provider.next || !dna.next) return [...providerProgrammes];
    return [...providerProgrammes, dna.next];
  }

  const firstCompatible = (programmes: readonly EpgProgramme[]): EpgProgramme | null =>
    [...programmes]
      .filter((programme) => programme !== current && programme.startTime > now && programme.startTime >= current.endTime)
      .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime)[0] ?? null;
  const providerNext = firstCompatible(providerProgrammes);
  const dnaNext = firstCompatible(dnaProgrammes);

  const reconciled = providerProgrammes.filter((programme) => {
    if (programme === provider.next && provider.next && !providerNext) return false;
    return !(programme.startTime > now && programme.startTime < current.endTime);
  });
  if (!provider.current && dna.current) reconciled.push(dna.current);
  if (!providerNext && dnaNext) reconciled.push(dnaNext);
  return reconciled;
}

function channelMatchKey(value: string): string {
  return value.replace(/^\s*fi\s*[:|\-]\s*/i, "")
    .replace(/\s*(?:\[(?:multi[ -]?(?:sub|audio)|subtitles?|live during events only|(?:4k|uhd|fhd|hd|sd))\]\s*)+$/i, "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase()
    .replace(/\b(?:4k|uhd|fhd|hd|sd)\b/gi, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

const DNA_NAME_ALIASES: Record<string, string> = {
  "star": "star channel",
  "national geographic wild": "nat geo wild",
  "v winter": "v sport vinter",
  "v vinter": "v sport vinter",
  "nelonen 4": "nelonen",
  "v ultra": "v sport ultra",
  "v fotboll": "v sport football",
  "v golf": "v sport golf",
  "liiga 1": "mtv liiga 1",
  "liiga 2": "mtv liiga 2",
  "liiga 3": "mtv liiga 3",
  "liiga 4": "mtv liiga 4",
  "liiga 5": "mtv liiga 5",
  "liiga 6": "mtv liiga 6",
  "liiga 7": "mtv liiga 7",
};
