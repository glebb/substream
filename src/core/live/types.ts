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
