import {
  LIVE_RELAY_PROTOCOL_VERSION,
  type RelayCueBatch,
  type RelayHeartbeatResponse,
  type RelaySessionCreateRequest,
  type RelaySessionCreateResponse,
  type RelaySessionStatus,
  type RelaySubtitleLanguage,
  type RelaySubtitleTrackSelection,
} from "../../core/live-relay/protocol.ts";
import { createAbortController } from "../abort-controller.ts";
import { normalizeLiveRelayConfig, type LiveRelayConfig } from "./config.ts";

export const LIVE_RELAY_REQUEST_TIMEOUT_MS = 10_000;
export const LIVE_RELAY_CUE_POLL_INTERVAL_MS = 500;
export const LIVE_RELAY_MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_CUES_PER_RESPONSE = 256;
const MAX_TRACKS = 32;
const SESSION_ID_RE = /^[a-f0-9]{32}$/;
const OPAQUE_RE = /^[a-f0-9]{64}$/;

type RequestCancelToken = { cancelled: boolean; listeners: Set<() => void> };
export type RelayRequestOptions = { signal?: AbortSignal; cancelToken?: RequestCancelToken };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function withinJsonByteLimit(text: string): boolean {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > LIVE_RELAY_MAX_JSON_RESPONSE_BYTES) return false;
  }
  return true;
}

function parseJsonResponseText(text: string): unknown {
  if (!withinJsonByteLimit(text)) throw new Error("response-too-large");
  return JSON.parse(text) as unknown;
}

function apiUrl(serviceUrl: string, path: string): string {
  return new URL(path, serviceUrl + "/").toString();
}

function safeSessionUrl(value: unknown, serviceUrl: string): string {
  if (typeof value !== "string") throw new Error("Live subtitle relay response was invalid.");
  let url: URL;
  try { url = new URL(value, serviceUrl); } catch { throw new Error("Live subtitle relay response was invalid."); }
  if (url.origin !== serviceUrl || url.username || url.password || url.hash || url.protocol !== new URL(serviceUrl).protocol) {
    throw new Error("Live subtitle relay response was invalid.");
  }
  return url.toString();
}

function parseSession(value: unknown, serviceUrl: string): RelaySessionCreateResponse {
  if (!isObject(value) || value.protocolVersion !== LIVE_RELAY_PROTOCOL_VERSION
    || typeof value.sessionId !== "string" || !SESSION_ID_RE.test(value.sessionId)
    || typeof value.capability !== "string" || !OPAQUE_RE.test(value.capability)
    || (value.state !== "preparing" && value.state !== "ready") || !Number.isFinite(value.leaseExpiresAt)) {
    throw new Error("Live subtitle relay response was invalid.");
  }
  const mediaUrl = safeSessionUrl(value.mediaUrl, serviceUrl);
  const urls = ["cueUrl", "statusUrl", "trackUrl", "heartbeatUrl", "deleteUrl", "playbackStartedUrl"] as const;
  const mediaQuery = new URL(mediaUrl).searchParams;
  if (mediaQuery.getAll("cap").length !== 1 || mediaQuery.get("cap") !== value.capability
    || Array.from(mediaQuery.keys()).some((key) => key !== "cap")) throw new Error("Live subtitle relay response was invalid.");
  const parsedUrls = Object.fromEntries(urls.map((key) => [key, safeSessionUrl(value[key], serviceUrl)])) as Pick<RelaySessionCreateResponse, typeof urls[number]>;
  const sessionRoot = `/v1/sessions/${value.sessionId}`;
  const expectedPaths: Record<typeof urls[number] | "mediaUrl", string> = {
    mediaUrl: `${sessionRoot}/hls/index.m3u8`, cueUrl: `${sessionRoot}/cues`, statusUrl: `${sessionRoot}/status`,
    trackUrl: `${sessionRoot}/subtitle-track`, heartbeatUrl: `${sessionRoot}/heartbeat`, deleteUrl: sessionRoot,
    playbackStartedUrl: `${sessionRoot}/playback-started`,
  };
  if (new URL(mediaUrl).pathname !== expectedPaths.mediaUrl || mediaQuery.get("cap") !== value.capability
    || urls.some((key) => new URL(parsedUrls[key]).pathname !== expectedPaths[key] || new URL(parsedUrls[key]).search)) throw new Error("Live subtitle relay response was invalid.");
  return {
    protocolVersion: LIVE_RELAY_PROTOCOL_VERSION, sessionId: value.sessionId, capability: value.capability,
    state: value.state, mediaUrl, ...parsedUrls, leaseExpiresAt: Number(value.leaseExpiresAt),
  };
}

function parseStatus(value: unknown, sessionId: string): RelaySessionStatus {
  if (!isObject(value) || value.sessionId !== sessionId || !["preparing", "ready", "failed"].includes(String(value.state))
    || !Array.isArray(value.tracks) || value.tracks.length > MAX_TRACKS
    || !(value.selectedTrackId === null || typeof value.selectedTrackId === "string")
    || (value.timingOrigin !== undefined && (!Number.isFinite(value.timingOrigin) || Math.abs(Number(value.timingOrigin)) > 1e12))
    || (value.videoPtsOrigin90k !== undefined && (!Number.isSafeInteger(value.videoPtsOrigin90k) || Number(value.videoPtsOrigin90k) < 0))
    || (value.startupSequence !== undefined && !(value.startupSequence === null || (Number.isSafeInteger(value.startupSequence) && Number(value.startupSequence) >= 0)))
    || (value.startupDeadlineAt !== undefined && !Number.isFinite(value.startupDeadlineAt))
    || (value.playbackStarted !== undefined && typeof value.playbackStarted !== "boolean")
    || (value.startupTimingOrigin !== undefined && (!Number.isFinite(value.startupTimingOrigin) || Math.abs(Number(value.startupTimingOrigin)) > 1e12))
    || (value.startupVideoPtsOrigin90k !== undefined && (!Number.isSafeInteger(value.startupVideoPtsOrigin90k) || Number(value.startupVideoPtsOrigin90k) < 0))
    || (value.errorCode !== undefined && (typeof value.errorCode !== "string" || !/^[a-z0-9_-]{1,64}$/.test(value.errorCode)))) {
    throw new Error("Live subtitle relay status was invalid.");
  }
  const tracks = value.tracks.map((track) => {
    if (!isObject(track) || typeof track.id !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(track.id)
      || typeof track.language !== "string" || track.language.length > 32 || typeof track.label !== "string" || track.label.length > 100) {
      throw new Error("Live subtitle relay status was invalid.");
    }
    return { id: track.id, language: track.language, label: track.label };
  });
  if (typeof value.selectedTrackId === "string" && !tracks.some((track) => track.id === value.selectedTrackId)) throw new Error("Live subtitle relay status was invalid.");
  return {
    sessionId, state: value.state as RelaySessionStatus["state"], tracks,
    selectedTrackId: value.selectedTrackId as string | null,
    ...(typeof value.timingOrigin === "number" ? { timingOrigin: value.timingOrigin } : {}),
    ...(typeof value.videoPtsOrigin90k === "number" ? { videoPtsOrigin90k: value.videoPtsOrigin90k } : {}),
    ...(value.startupSequence === null || typeof value.startupSequence === "number" ? { startupSequence: value.startupSequence as number | null } : {}),
    ...(typeof value.startupDeadlineAt === "number" ? { startupDeadlineAt: value.startupDeadlineAt } : {}),
    ...(typeof value.playbackStarted === "boolean" ? { playbackStarted: value.playbackStarted } : {}),
    ...(typeof value.startupTimingOrigin === "number" ? { startupTimingOrigin: value.startupTimingOrigin } : {}),
    ...(typeof value.startupVideoPtsOrigin90k === "number" ? { startupVideoPtsOrigin90k: value.startupVideoPtsOrigin90k } : {}),
    ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
  };
}

function parseCue(value: unknown): RelayCueBatch["cues"][number] {
  if (!isObject(value) || !Number.isSafeInteger(value.seq) || Number(value.seq) < 0
    || !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 0
    || typeof value.trackId !== "string" || value.trackId.length > 128
    || !Number.isFinite(value.startMs) || Number(value.startMs) < 0
    || (value.endMs !== undefined && (!Number.isFinite(value.endMs) || Number(value.endMs) < Number(value.startMs)))
    || typeof value.clear !== "boolean"
    || (value.imageId !== undefined && (typeof value.imageId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.imageId)))
    || !["screenWidth", "screenHeight", "x", "y", "width", "height"].every((key) => Number.isFinite(value[key]) && Number(value[key]) >= 0)) {
    throw new Error("Live subtitle cue response was invalid.");
  }
  const emptyClear = value.clear === true && Number(value.screenWidth) === 0 && Number(value.screenHeight) === 0
    && Number(value.x) === 0 && Number(value.y) === 0 && Number(value.width) === 0 && Number(value.height) === 0;
  if ((!emptyClear && (Number(value.screenWidth) < 1 || Number(value.screenHeight) < 1))
    || (!value.clear && (Number(value.width) < 1 || Number(value.height) < 1 || Number(value.width) > 1920 || Number(value.height) > 1080 || Number(value.width) * Number(value.height) * 4 > 4 * 1024 * 1024))
    || Number(value.screenWidth) > 8192 || Number(value.screenHeight) > 8192
    || Number(value.x) + Number(value.width) > Number(value.screenWidth) || Number(value.y) + Number(value.height) > Number(value.screenHeight)
    || (!value.clear && typeof value.imageId !== "string")) throw new Error("Live subtitle cue response was invalid.");
  return {
    seq: Number(value.seq), epoch: Number(value.epoch), trackId: value.trackId, startMs: Number(value.startMs), clear: value.clear,
    ...(typeof value.endMs === "number" ? { endMs: value.endMs } : {}), ...(typeof value.imageId === "string" ? { imageId: value.imageId } : {}),
    screenWidth: Number(value.screenWidth), screenHeight: Number(value.screenHeight), x: Number(value.x), y: Number(value.y), width: Number(value.width), height: Number(value.height),
  };
}

function parseCueBatch(value: unknown): RelayCueBatch {
  if (!isObject(value) || !Array.isArray(value.cues) || value.cues.length > MAX_CUES_PER_RESPONSE
    || !Number.isSafeInteger(value.nextCursor) || Number(value.nextCursor) < 0 || typeof value.reset !== "boolean") {
    throw new Error("Live subtitle cue response was invalid.");
  }
  const cues = value.cues.map(parseCue);
  if (cues.some((cue, index) => index > 0 && cue.seq <= cues[index - 1]!.seq)) throw new Error("Live subtitle cue response was invalid.");
  let active: RelayCueBatch["active"];
  if (value.active === null) active = null;
  else if (value.active !== undefined) active = parseCue(value.active);
  return { cues, nextCursor: Number(value.nextCursor), reset: value.reset, ...(active !== undefined ? { active } : {}) };
}

async function jsonRequest<T>(url: string, credential: string, init: RequestInit, parse: (value: unknown) => T, message: string, externalSignal?: AbortSignal, cancelToken?: RequestCancelToken): Promise<T> {
  if (externalSignal?.aborted || cancelToken?.cancelled) throw new Error("Live subtitle relay request was cancelled.");
  const controller = createAbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let abortRequest = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { timedOut = true; controller?.abort(); abortRequest(); reject(new Error("timeout")); }, LIVE_RELAY_REQUEST_TIMEOUT_MS);
  });
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => { controller?.abort(); abortRequest(); rejectAbort?.(new Error("cancelled")); };
  externalSignal?.addEventListener("abort", onAbort);
  cancelToken?.listeners.add(onAbort);
  const requestHeaders = { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${credential}` };
  try {
    return await Promise.race([
      (async () => {
        // Chromium 47 lacks AbortController, but XHR supports timeout and abort.
        // Use it there so timed-out polls cannot keep running beside retries.
        if (!controller && typeof XMLHttpRequest === "function") {
          return await new Promise<T>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            let responseTooLarge = false;
            abortRequest = () => xhr.abort();
            xhr.open(init.method ?? "GET", url, true);
            xhr.timeout = LIVE_RELAY_REQUEST_TIMEOUT_MS;
            for (const [key, value] of Object.entries(requestHeaders)) xhr.setRequestHeader(key, value);
            xhr.onprogress = (event) => {
              if (event.loaded > LIVE_RELAY_MAX_JSON_RESPONSE_BYTES) {
                responseTooLarge = true;
                xhr.abort();
              }
            };
            xhr.onload = () => {
              if (xhr.status < 200 || xhr.status >= 300) { reject(new Error("http")); return; }
              if (xhr.status === 204) { try { resolve(parse(undefined)); } catch { reject(new Error("invalid-response")); } return; }
              const contentLength = Number(xhr.getResponseHeader("content-length"));
              if ((Number.isFinite(contentLength) && contentLength > LIVE_RELAY_MAX_JSON_RESPONSE_BYTES) || !withinJsonByteLimit(xhr.responseText)) {
                reject(new Error("response-too-large")); return;
              }
              try { resolve(parse(parseJsonResponseText(xhr.responseText))); } catch { reject(new Error("invalid-response")); }
            };
            xhr.onerror = () => reject(new Error("network"));
            xhr.ontimeout = () => reject(new Error("timeout"));
            xhr.onabort = () => reject(new Error(responseTooLarge ? "response-too-large" : "cancelled"));
            const body = typeof init.body === "string" || init.body === null ? init.body : null;
            xhr.send(body);
          });
        }
        const response = await fetch(url, {
          ...init,
          headers: requestHeaders,
          cache: "no-store",
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (!response.ok) throw new Error("http");
        if (response.status === 204) return parse(undefined);
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > LIVE_RELAY_MAX_JSON_RESPONSE_BYTES) throw new Error("response-too-large");
        let value: unknown;
        try { value = parseJsonResponseText(await response.text()); } catch { throw new Error("invalid-json"); }
        return parse(value);
      })(), timeout, cancellation,
    ]);
  } catch {
    if (externalSignal?.aborted) throw new Error("Live subtitle relay request was cancelled.");
    throw new Error(timedOut ? "Live subtitle relay did not respond within 10 seconds." : message);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
    cancelToken?.listeners.delete(onAbort);
  }
}

function parseHeartbeat(value: unknown): RelayHeartbeatResponse {
  if (!isObject(value) || !Number.isFinite(value.leaseExpiresAt)) throw new Error("Live subtitle relay heartbeat was invalid.");
  return { leaseExpiresAt: Number(value.leaseExpiresAt) };
}

export async function createLiveRelaySession(
  configValue: LiveRelayConfig,
  channelId: string,
  preferredLanguage?: RelaySubtitleLanguage,
  options: RelayRequestOptions = {},
): Promise<LiveRelaySession> {
  const config = normalizeLiveRelayConfig(configValue);
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(channelId)) throw new Error("Live channel identity is invalid.");
  if (preferredLanguage !== undefined && preferredLanguage !== "fi" && preferredLanguage !== "en") throw new Error("Subtitle language preference is invalid.");
  const body: RelaySessionCreateRequest = { channelId, ...(preferredLanguage ? { preferredLanguage } : {}) };
  const raw = await jsonRequest(apiUrl(config.serviceUrl, "v1/sessions"), config.deviceCredential, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }, (value) => parseSession(value, config.serviceUrl), "Could not start live subtitle relay session.", options.signal, options.cancelToken);
  return new LiveRelaySession(config, raw);
}

export class LiveRelaySession {
  readonly id: string;
  readonly mediaUrl: string;
  readonly playbackStartedUrl: string;
  private readonly config: LiveRelayConfig;
  readonly wire: RelaySessionCreateResponse;
  private disposed = false;
  private cueCursor = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private activeRequest: AbortController | undefined;
  private activeCancelToken: RequestCancelToken | undefined;
  private generation = 0;

  constructor(config: LiveRelayConfig, wire: RelaySessionCreateResponse) {
    this.config = config;
    this.wire = wire;
    this.id = wire.sessionId;
    this.mediaUrl = wire.mediaUrl;
    this.playbackStartedUrl = wire.playbackStartedUrl;
  }

  private assertActive(): void { if (this.disposed) throw new Error("Live subtitle relay session is closed."); }
  private sessionPath(suffix: string): string { return `v1/sessions/${encodeURIComponent(this.id)}/${suffix}`; }

  async status(options: RelayRequestOptions = {}): Promise<RelaySessionStatus> {
    this.assertActive();
    return jsonRequest(this.wire.statusUrl, this.config.deviceCredential, { method: "GET" }, (value) => parseStatus(value, this.id), "Could not read live subtitle relay status.", options.signal, options.cancelToken);
  }

  async cues(options: RelayRequestOptions = {}): Promise<RelayCueBatch> {
    this.assertActive();
    const cueUrl = new URL(this.wire.cueUrl);
    cueUrl.searchParams.set("afterSequence", String(this.cueCursor));
    const result = await jsonRequest(cueUrl.toString(), this.config.deviceCredential, { method: "GET" }, parseCueBatch, "Could not read live subtitle cues.", options.signal, options.cancelToken);
    if (this.disposed || options.signal?.aborted || options.cancelToken?.cancelled) throw new Error("Live subtitle relay request was cancelled.");
    this.cueCursor = result.nextCursor;
    return result;
  }

  async selectTrack(trackId: string | null, options: RelayRequestOptions = {}): Promise<void> {
    this.assertActive();
    if (trackId !== null && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(trackId)) throw new Error("Subtitle track selection is invalid.");
    const selection: RelaySubtitleTrackSelection = { trackId };
    await jsonRequest(this.wire.trackUrl, this.config.deviceCredential, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(selection),
    }, () => undefined, "Could not change live subtitle track.", options.signal, options.cancelToken);
  }

  async heartbeat(options: RelayRequestOptions = {}): Promise<RelayHeartbeatResponse> {
    this.assertActive();
    return jsonRequest(this.wire.heartbeatUrl, this.config.deviceCredential, { method: "POST" }, parseHeartbeat, "Could not renew live subtitle relay session.", options.signal, options.cancelToken);
  }

  /** Release the pinned startup playlist after AVPlay reports its first playback progress. */
  async markPlaybackStarted(options: RelayRequestOptions = {}): Promise<void> {
    this.assertActive();
    await jsonRequest(this.playbackStartedUrl, this.config.deviceCredential, { method: "POST" }, (value) => {
      if (!isObject(value) || value.playbackStarted !== true) throw new Error("invalid-response");
      return undefined;
    }, "Could not confirm live relay playback start.", options.signal, options.cancelToken);
  }

  /** Image bytes use a scoped session capability in the URL because AVPlay cannot set arbitrary headers. */
  cueImageUrl(imageId: string): string {
    this.assertActive();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(imageId)) throw new Error("Subtitle image reference is invalid.");
    const url = new URL(apiUrl(this.config.serviceUrl, this.sessionPath(`images/${encodeURIComponent(imageId)}`)));
    url.searchParams.set("cap", this.wire.capability);
    return url.toString();
  }

  /** Poll serially; schedule the next request only after the previous one settles. */
  startCuePolling(onBatch: (batch: RelayCueBatch) => void, onError?: (error: Error) => void, intervalMs = LIVE_RELAY_CUE_POLL_INTERVAL_MS): () => void {
    this.assertActive();
    this.stopCuePolling();
    const generation = ++this.generation;
    const interval = Math.max(250, Math.min(5_000, Math.floor(intervalMs)));
    let nextDelay = interval;
    const loop = async () => {
      if (this.disposed || generation !== this.generation) return;
      this.activeRequest = createAbortController();
      const cancelToken: RequestCancelToken = { cancelled: false, listeners: new Set() };
      this.activeCancelToken = cancelToken;
      let delay = interval;
      try {
        const batch = await this.cues({ ...(this.activeRequest ? { signal: this.activeRequest.signal } : {}), cancelToken });
        nextDelay = interval;
        if (!this.disposed && generation === this.generation) onBatch(batch);
      } catch (error) {
        delay = nextDelay;
        nextDelay = Math.min(5_000, Math.max(interval, nextDelay * 2));
        if (!this.disposed && generation === this.generation) onError?.(error instanceof Error ? error : new Error("Could not read live subtitle cues."));
      } finally {
        this.activeRequest = undefined;
        this.activeCancelToken = undefined;
        if (!this.disposed && generation === this.generation) this.pollTimer = setTimeout(loop, delay);
      }
    };
    void loop();
    return () => this.stopCuePolling();
  }

  stopCuePolling(): void {
    this.generation += 1;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.activeRequest?.abort();
    this.activeRequest = undefined;
    if (this.activeCancelToken) {
      this.activeCancelToken.cancelled = true;
      for (const cancel of this.activeCancelToken.listeners) cancel();
    }
    this.activeCancelToken = undefined;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopCuePolling();
    await jsonRequest(this.wire.deleteUrl, this.config.deviceCredential, { method: "DELETE" }, () => undefined, "Could not close live subtitle relay session.");
  }
}
