export type LiveCountryEvidence = {
  /** `category-alias` appears in channel caches saved before multi-country detection. */
  kind: "category-prefix" | "category-name" | "category-alias" | "unmatched";
  value: string;
  detail: string;
};

export interface LiveCategory {
  id: string;
  name: string;
}

export interface LiveChannel {
  id: string;
  providerStreamId: string;
  providerCategoryId: string;
  name: string;
  logo: string | null;
  dnaChannelId?: string;
  dnaLogo?: string;
  dnaMatchEvidence?: { kind: "normalized-exact-name" | "curated-alias"; providerName: string; dnaName: string };
  providerOrder: number;
  epgId?: string;
  variant?: string;
  /** Detected country/region key such as `finland`, or `unknown`. */
  country: string;
  evidence: LiveCountryEvidence[];
}

export interface ProviderLiveStream {
  streamId: string;
  categoryId: string;
  name: string;
  logo?: string;
  epgId?: string;
  order: number;
}

/** A single provider EPG entry. Times are Unix timestamps in milliseconds. */
export interface EpgProgramme {
  channelId: string;
  title: string;
  startTime: number;
  endTime: number;
  description?: string;
}

export interface CurrentAndNextProgramme {
  current: EpgProgramme | null;
  next: EpgProgramme | null;
}
