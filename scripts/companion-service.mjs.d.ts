export type CompanionConnection = { apiUrl: URL; username: string; password: string; sourceFingerprint: string };
export type CompanionEpisode = { id: string; kind: "episode"; title: string; year: null; extension: string; sourceFingerprint: string };
export type CompanionRequestOptions = { timeoutMs?: number; signal?: AbortSignal };
export type CompanionResponse = { ok: boolean; status: number; json(): Promise<unknown> };
export function xtreamConnectionFromPlaylist(value: string): CompanionConnection | null;
export function fetchXtreamAction(connection: CompanionConnection, action: string, parameters?: Record<string, string>, request?: (url: URL, init?: { signal: AbortSignal }) => Promise<CompanionResponse>, options?: CompanionRequestOptions): Promise<unknown[] | Record<string, unknown>>;
export function resolveXtreamEpisode(connection: CompanionConnection, seriesId: string, episodeId: string, request?: (url: URL, init?: { signal: AbortSignal }) => Promise<CompanionResponse>, options?: CompanionRequestOptions): Promise<CompanionEpisode | null>;
