/** Shared, platform-independent wire types for the hosted live subtitle relay. */

export const LIVE_RELAY_PROTOCOL_VERSION = 1 as const;

export type RelaySubtitleLanguage = "fi" | "en";
export type RelaySessionState = "preparing" | "ready" | "failed";

export interface RelaySessionCreateRequest {
  channelId: string;
  preferredLanguage?: RelaySubtitleLanguage;
}

export interface RelaySessionCreateResponse {
  protocolVersion: typeof LIVE_RELAY_PROTOCOL_VERSION;
  sessionId: string;
  capability: string;
  state: "preparing" | "ready";
  mediaUrl: string;
  cueUrl: string;
  statusUrl: string;
  trackUrl: string;
  heartbeatUrl: string;
  playbackStartedUrl: string;
  deleteUrl: string;
  leaseExpiresAt: number;
}

export interface RelaySubtitleTrack {
  id: string;
  language: string;
  label: string;
}

export interface RelaySessionStatus {
  sessionId: string;
  state: RelaySessionState;
  tracks: RelaySubtitleTrack[];
  selectedTrackId: string | null;
  /** Output-media timeline origin in seconds. This does not claim AVPlay mapping. */
  timingOrigin?: number;
  /** First output video PTS in 90 kHz units, for measured AVPlay clock mapping. */
  videoPtsOrigin90k?: number;
  /** First retained output segment pinned for AVPlay startup, until playbackStarted or deadline. */
  startupSequence?: number | null;
  startupDeadlineAt?: number;
  playbackStarted?: boolean;
  /** Timeline and PTS origin captured from startupSequence, held stable through startup. */
  startupTimingOrigin?: number;
  startupVideoPtsOrigin90k?: number;
  errorCode?: string;
}

export interface RelayCue {
  seq: number;
  epoch: number;
  trackId: string;
  startMs: number;
  endMs?: number;
  clear: boolean;
  imageId?: string;
  screenWidth: number;
  screenHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RelayCueBatch {
  cues: RelayCue[];
  nextCursor: number;
  /** Cursor fell behind the retained window; client should replace local state. */
  reset: boolean;
  /** Current display state, when reset is true. */
  active?: RelayCue | null;
}

export interface RelaySubtitleImage {
  id: string;
  bytes: Uint8Array;
  contentType: "image/png";
}

export interface RelaySubtitleTrackSelection {
  trackId: string | null;
}

export interface RelayHeartbeatResponse {
  leaseExpiresAt: number;
}
