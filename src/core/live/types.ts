export type LiveCountryEvidence = {
  kind: "category-alias" | "unmatched";
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
  providerOrder: number;
  epgId?: string;
  variant?: string;
  country: "finland" | "unknown";
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
