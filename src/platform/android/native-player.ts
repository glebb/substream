import type { AudioTrack, EmbeddedSubtitleTrack, MediaPlayer, MediaPlayerEventHandlers, PlaybackState, SubtitleAttachment, SubtitleRenderingCapabilities, VideoDisplayMode } from "../media-player.ts";
import { androidBridge, postAndroidCommand, subscribeAndroidEvents, type AndroidNativeEvent } from "./bridge.ts";

type NativeCommand = "create" | "load" | "play" | "pause" | "seek" | "skip" | "restart" | "displayMode" | "resize" | "audioTrack" | "textTrack" | "textTrackEnabled" | "subtitle" | "subtitleOffset" | "destroy";
interface NativeEvent extends AndroidNativeEvent {}

let nextSession = 0;
const validStates = new Set<PlaybackState>(["loading", "buffering", "playing", "paused", "ended", "error"]);

function safeTrack(value: unknown): AudioTrack | EmbeddedSubtitleTrack | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.label !== "string") return undefined;
  const common = { id: row.id, label: row.label, ...(typeof row.language === "string" ? { language: row.language } : {}), ...(typeof row.codec === "string" ? { codec: row.codec } : {}), selected: row.selected === true };
  if ("forced" in row || "playable" in row || "hearingImpaired" in row) return {
    ...common,
    ...(typeof row.forced === "boolean" ? { forced: row.forced } : {}),
    ...(typeof row.hearingImpaired === "boolean" ? { hearingImpaired: row.hearingImpaired } : {}),
    ...(typeof row.playable === "boolean" ? { playable: row.playable } : {}),
  };
  return common;
}

/** Media3 playback adapter. Provider URLs are used only by the native player and are never logged. */
export class AndroidNativePlayer implements MediaPlayer {
  private readonly session = `android-${++nextSession}`;
  private unsubscribe: (() => void) | undefined;
  private eventHandlers: MediaPlayerEventHandlers | null = null;
  private audioTracks: AudioTrack[] = [];
  private textTracks: EmbeddedSubtitleTrack[] = [];
  private disposed = false;
  private readonly containerId: string;
  private readonly onEvent = (event: NativeEvent) => {
    if (this.disposed) return;
    if (!event || event.v !== 1 || event.session !== this.session) return;
    const payload = event.payload ?? {};
    if (event.type === "state" && typeof payload.state === "string" && validStates.has(payload.state as PlaybackState)) {
      this.eventHandlers?.onStateChange(payload.state as PlaybackState);
    } else if (event.type === "progress") {
      const currentTimeSeconds = Number(payload.currentTimeSeconds), durationSeconds = Number(payload.durationSeconds);
      if (Number.isFinite(currentTimeSeconds) && Number.isFinite(durationSeconds)) this.eventHandlers?.onProgress?.({ currentTimeSeconds, durationSeconds });
    } else if (event.type === "audioTracks") {
      this.audioTracks = (Array.isArray(payload.tracks) ? payload.tracks : []).map(safeTrack).filter((x): x is AudioTrack => !!x && !("playable" in x));
      this.eventHandlers?.onAudioTracksChange?.(this.getAudioTracks()!);
    } else if (event.type === "textTracks") {
      this.textTracks = (Array.isArray(payload.tracks) ? payload.tracks : []).map(safeTrack).filter((x): x is EmbeddedSubtitleTrack => !!x && ("playable" in x || "forced" in x || "hearingImpaired" in x));
      this.eventHandlers?.onEmbeddedSubtitleTracksChange?.(this.getEmbeddedSubtitleTracks()!);
    } else if (event.type === "error") {
      // Native events intentionally contain no exception text, URL, or provider response.
      this.eventHandlers?.onStateChange("error");
    }
  };

  constructor(private readonly container: HTMLElement, private readonly kind: "live" | "vod" = "vod", private readonly resumeSeconds = 0) {
    if (!androidBridge()) throw new Error("Android native playback bridge unavailable");
    if (typeof document !== "undefined") {
      document.documentElement.classList.add("android-native-playback");
      document.body?.classList.add("android-native-playback");
    }
    this.containerId = container.id || `substream-native-video-${this.session}`;
    container.id = this.containerId;
    this.unsubscribe = subscribeAndroidEvents(this.session, this.onEvent);
    this.send("create", { containerId: this.containerId });
    this.resize();
  }

  private send(command: NativeCommand, payload: Record<string, unknown> = {}): void {
    if (this.disposed && command !== "destroy") return;
    try { postAndroidCommand(command, this.session, payload); }
    catch { if (command !== "destroy") this.eventHandlers?.onStateChange("error"); }
  }

  setEventHandlers(handlers: MediaPlayerEventHandlers | null): void { this.eventHandlers = handlers; }
  load(streamUrl: string): void {
    // This URL stays on the device and goes only to Media3 for direct provider playback.
    this.send("load", { url: streamUrl, kind: this.kind, resumeSeconds: this.resumeSeconds });
  }
  loadRequest(streamUrl: string, kind: "live" | "vod", resumeSeconds = 0): void { this.send("load", { url: streamUrl, kind, resumeSeconds }); }
  play(): void { this.send("play"); }
  pause(): void { this.send("pause"); }
  seekTo(seconds: number): void { if (Number.isFinite(seconds)) this.send("seek", { seconds: Math.max(0, seconds) }); }
  skip(seconds: number): void { if (Number.isFinite(seconds)) this.send("skip", { seconds }); }
  restart(): void { this.send("restart"); }
  setDisplayMode(mode: VideoDisplayMode): void { this.send("displayMode", { mode }); }
  resize(): void {
    const bounds = this.container.getBoundingClientRect();
    this.send("resize", { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height });
  }
  getAudioTracks(): AudioTrack[] { return this.audioTracks.map((track) => ({ ...track })); }
  selectAudioTrack(id: string): boolean { if (!this.audioTracks.some((track) => track.id === id)) return false; this.send("audioTrack", { id }); return true; }
  getEmbeddedSubtitleTracks(): EmbeddedSubtitleTrack[] { return this.textTracks.map((track) => ({ ...track })); }
  selectEmbeddedSubtitleTrack(id: string): boolean { if (!this.textTracks.some((track) => track.id === id)) return false; this.send("textTrack", { id }); return true; }
  setLiveSubtitleMode(enabled: boolean): void { this.send("textTrackEnabled", { enabled }); }
  setVodSubtitleMode(enabled: boolean): void { this.send("textTrackEnabled", { enabled }); }
  setSubtitle(subtitleText: string, _label: string, language: string): Promise<SubtitleAttachment> {
    if (JSON.stringify({ text: subtitleText, language }).length > 1_000_000) {
      return Promise.resolve({ enabled: false, reason: "Subtitle file is too large for this device." });
    }
    this.send("subtitle", { text: subtitleText, language });
    return Promise.resolve({ enabled: true });
  }
  setSubtitleEnabled(enabled: boolean): void { this.send("textTrackEnabled", { enabled }); }
  getSubtitleRenderingCapabilities(): SubtitleRenderingCapabilities {
    return { timingAdjustment: false, styling: false, sharedOverlay: false };
  }
  destroy(): void {
    if (this.disposed) return;
    this.send("destroy"); this.disposed = true; this.unsubscribe?.(); this.eventHandlers = null;
    if (typeof document !== "undefined") {
      document.documentElement.classList.remove("android-native-playback");
      document.body?.classList.remove("android-native-playback");
    }
  }
  async dispose(): Promise<void> { this.destroy(); }
}
