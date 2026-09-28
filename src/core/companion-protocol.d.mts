export const COMPANION_PROTOCOL_VERSION: 2;

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

export type CompanionEventWire = {
  sequence: number;
  action?: "play" | "select";
  selection: CompanionSelectionWire;
};

export type CompanionEventsPayload = {
  protocolVersion: 2;
  events: CompanionEventWire[];
  paired: boolean;
  retentionGap: { throughSequence: number; firstAvailableSequence: number } | null;
};

export function supportsCompanionProtocolVersion(value: unknown): boolean;
export function parseCompanionSelection(value: unknown): CompanionSelectionWire | null;
export function parseCompanionEvent(value: unknown): CompanionEventWire | null;
export function parseCompanionEventsPayload(value: unknown): CompanionEventsPayload | null;
