export type M3uAttributes = Record<string, string>;

export interface M3uEntry {
  name: string;
  url: string;
  duration: number | null;
  attributes: M3uAttributes;
  options: Record<string, string>;
  line: number;
}

export interface M3uWarning {
  line: number;
  message: string;
}

export interface M3uPlaylist {
  header: M3uAttributes;
  entries: M3uEntry[];
  warnings: M3uWarning[];
}

export type MediaKind = "vod" | "live" | "unknown";
export type ClassificationConfidence = "high" | "medium" | "low";

export interface MediaClassification {
  kind: MediaKind;
  confidence: ClassificationConfidence;
  evidence: string[];
}
