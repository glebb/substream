export type CompanionConnection = { apiUrl: URL; username: string; password: string; sourceFingerprint: string };
export type CompanionRecord = { id: string; kind: "movie" | "series"; title: string; searchTitle: string; year: number | null; extension: string; category: string; sourceFingerprint: string };
export type CompanionResult = Pick<CompanionRecord, "id" | "kind" | "title" | "year" | "extension" | "category" | "sourceFingerprint">;
export type CompanionEpisode = { id: string; kind: "episode"; title: string; year: null; extension: string; sourceFingerprint: string };
export function xtreamConnectionFromPlaylist(value: string): CompanionConnection | null;
export function resolveXtreamEpisode(connection: CompanionConnection, seriesId: string, episodeId: string, request?: (url: URL) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>): Promise<CompanionEpisode | null>;
export function loadXtreamCatalogue(connection: CompanionConnection, request?: (url: URL) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>): Promise<CompanionRecord[]>;
export function searchCatalogue(records: CompanionRecord[], query: string, limit?: number): CompanionResult[];
