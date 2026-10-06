/** Worker boundary for packet-copy remuxing of browser VOD sources. */
export const VOD_REMUX_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const VOD_REMUX_MAX_AUDIO_TRACKS = 12;

export const VOD_REMUX_AUDIO_MIME_CODECS = {
  aac: "mp4a.40.2", opus: "opus", flac: "flac", mp3: "mp3",
  ac3: "ac-3", eac3: "ec-3", dts: "dtsc",
} as const;
export type VodRemuxAudioCodec = keyof typeof VOD_REMUX_AUDIO_MIME_CODECS;
export const VOD_REMUX_AUDIO_LABELS = ["AAC", "OPUS", "FLAC", "MP3", "AC3", "EAC3", "DTS", "VORBIS", "PCM", "unknown"] as const;
export type VodRemuxAudioLabel = typeof VOD_REMUX_AUDIO_LABELS[number];

export type VodRemuxWorkerRequest =
  | { type: "start"; url: string; startSeconds: number; audioTrackId?: number; supportedAudioCodecs?: VodRemuxAudioCodec[]; forceDolbyAac?: boolean }
  | { type: "ack" }
  | { type: "dispose" };

export interface VodRemuxAudioTrack {
  id: number;
  label: string;
  language: string;
}

export type VodRemuxFailureReason =
  | "cors-range"
  | "provider-redirect"
  | "provider-timeout"
  | "range-unsupported"
  | "range-metadata"
  | "range-invalid"
  | "unsupported-video"
  | "unsupported-audio"
  | "invalid-media"
  | "processing-failed";

export type VodRemuxWorkerResponse =
  | { type: "metadata"; durationSeconds: number | null; mimeType: string; audioTracks: VodRemuxAudioTrack[]; selectedAudioTrackId: number; audioProcessing?: "copy" | "dolby-to-aac" }
  | { type: "chunk"; buffer: ArrayBuffer }
  | { type: "progress"; phase: "downloading" | "remuxing" | "waiting" }
  | { type: "end" }
  | { type: "error"; reason: VodRemuxFailureReason; audioCodec?: VodRemuxAudioLabel };

export interface VodRemuxWorkerPort {
  postMessage(message: VodRemuxWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message" | "error", listener: EventListener): void;
  removeEventListener(type: "message" | "error", listener: EventListener): void;
  terminate(): void;
}
