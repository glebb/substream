export const COMPANION_PROTOCOL_VERSION: 4;

export type CompanionSelectionWire = {
  kind: "movie" | "series" | "episode";
  id: string;
  seriesId?: string;
  title: string;
  year: number | null;
  season?: number | null;
  episode?: number | null;
  extension: string;
  sourceFingerprint: string;
};

export type CompanionLocalMediaWire = {
  sessionId: string;
  ticket: string;
  title: string;
  searchTitle: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  contentType: "movie" | "series" | "unknown";
  /** Requested playback start in whole seconds; 0 starts from the beginning. */
  startSeconds: number;
  mediaType: string;
  size: number;
};

export type CompanionEventWire = {
  sequence: number;
  action?: "play" | "select";
  selection: CompanionSelectionWire;
} | {
  sequence: number;
  action: "play-local";
  localMedia: CompanionLocalMediaWire;
} | {
  sequence: number;
  action: "stop-local";
  sessionId: string;
};

export type CompanionEventsPayload = {
  protocolVersion: 4;
  events: CompanionEventWire[];
  paired: boolean;
  retentionGap: { throughSequence: number; firstAvailableSequence: number } | null;
};

export const MAX_LOCAL_START_SECONDS: number;
export function parseLocalStartSeconds(value: unknown): number;
export function supportsCompanionProtocolVersion(value: unknown): boolean;
export function parseCompanionSelection(value: unknown): CompanionSelectionWire | null;
export function parseCompanionEvent(value: unknown): CompanionEventWire | null;
export function parseCompanionEventsPayload(value: unknown): CompanionEventsPayload | null;
