import { normalizeTitle, searchTerms, type VodCatalogItem } from "../../core/catalog/index.ts";
import { COMPANION_PROTOCOL_VERSION, parseCompanionEventsPayload, parseCompanionSelection, supportsCompanionProtocolVersion, type CompanionEventWire, type CompanionSelectionWire } from "../../core/companion-protocol.mjs";
import { packageDefaults } from "../package-defaults.ts";
import { createAbortController } from "../abort-controller.ts";

export const COMPANION_REQUEST_TIMEOUT_MS = 10_000;

async function companionJsonRequest<T>(url: string, init: RequestInit, unavailableMessage: string): Promise<{ response: Response; value: T }> {
  const controller = createAbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("timeout"));
      controller?.abort();
    }, COMPANION_REQUEST_TIMEOUT_MS);
  });
  try {
    // Race the complete response, including JSON, even on Tizen 3 where
    // AbortController is unavailable and fetch cannot be physically cancelled.
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
        const value = await response.json() as T;
        return { response, value };
      })(),
      deadline,
    ]);
  } catch {
    throw new Error(timedOut
      ? "Companion service did not respond within 10 seconds. Check the LAN address and service, then try again."
      : unavailableMessage);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type CompanionSelection = CompanionSelectionWire;
export type CompanionEvent = CompanionEventWire;
export type CompanionEventsResult = { protocolVersion: 4; events: CompanionEvent[]; paired: boolean; retentionGap: { throughSequence: number; firstAvailableSequence: number } | null };
export type CompanionDeviceIdentity = { deviceId: string; deviceName: string };
export type CompanionCapabilities = { localMedia: boolean };
export type CompanionConnection = CompanionDeviceIdentity & { tvCredential: string; pairingCode: string; pairingExpiresAt: number; expiresAt: number; sourceFingerprint: string; capabilities: CompanionCapabilities; paired: boolean };
export type ActiveCompanionConnection = CompanionDeviceIdentity & { expiresAt: number; sourceFingerprint: string; capabilities: CompanionCapabilities };
export type BrowserCompanionConnection = ActiveCompanionConnection & { browserCredential: string };
export type CompanionPlaybackSelection = Omit<CompanionSelection, "kind" | "seriesId"> & ({ kind: "movie" } | { kind: "episode"; seriesId: string });
export type CompanionLocalPlayback = { sessionId: string; ticket: string; title: string; searchTitle: string; year: number | null; season: number | null; episode: number | null; contentType: "movie" | "series" | "unknown"; mediaType: string; size: number };
export type CompanionLocalSubtitle = { version: number; text: string; label: string; language: string; enabled: boolean; offsetSeconds: number };

export type CompanionConnectionErrorKind = "unreachable" | "no-tv" | "invalid";
export class CompanionConnectionError extends Error {
  constructor(readonly kind: CompanionConnectionErrorKind) {
    super(kind === "unreachable" ? "TV relay is unreachable." : kind === "no-tv" ? "No TV is connected." : "TV connection response was invalid.");
  }
}

export function companionServerUrl(): string {
  let configured = "";
  let stored = "";
  try { configured = new URLSearchParams(globalThis.location?.search ?? "").get("companion") ?? ""; } catch { /* Browser location can be restricted in embedded contexts. */ }
  try { stored = globalThis.localStorage?.getItem("substream.companion-url") ?? ""; } catch { /* Storage denial should use the packaged default. */ }
  const value = configured || stored || packageDefaults.companionServerUrl || "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch { return ""; }
}

export function isLanCompanionAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && !url.username && !url.password
      && !/^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(url.hostname)
      && !/^169\.254\./.test(url.hostname);
  } catch { return false; }
}

let volatileDeviceIdentity: CompanionDeviceIdentity | null = null;

/** Stable opaque identity for this TV installation; it contains no account data. */
export function companionDeviceIdentity(): CompanionDeviceIdentity {
  try {
    const stored = globalThis.localStorage?.getItem("substream.companion-device-identity");
    if (stored) {
      const value = JSON.parse(stored) as Partial<CompanionDeviceIdentity>;
      if (/^[a-f0-9]{32}$/.test(value.deviceId || "") && typeof value.deviceName === "string" && value.deviceName.trim().length > 0 && value.deviceName.length <= 40) {
        return { deviceId: value.deviceId!, deviceName: value.deviceName };
      }
    }
  } catch { /* Storage denial falls back to an in-memory identity for this run. */ }
  if (volatileDeviceIdentity) return volatileDeviceIdentity;
  const bytes = new Uint8Array(16);
  try { globalThis.crypto?.getRandomValues(bytes); } catch { /* Use the non-secret fallback below. */ }
  if (!bytes.some(Boolean)) for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  const deviceId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  volatileDeviceIdentity = { deviceId, deviceName: `TV-${deviceId.slice(-4).toUpperCase()}` };
  try { globalThis.localStorage?.setItem("substream.companion-device-identity", JSON.stringify(volatileDeviceIdentity)); } catch { /* Identity remains usable for this run. */ }
  return volatileDeviceIdentity;
}

function tvCredentialStorageKey(server: string): string {
  return `substream.companion-tv-credential:${new URL(server).origin}`;
}

export function storedCompanionTvCredential(server: string): string {
  try {
    const value = globalThis.localStorage?.getItem(tvCredentialStorageKey(server)) || "";
    return /^[a-f0-9]{64}$/i.test(value) ? value : "";
  } catch { return ""; }
}

export function storeCompanionTvCredential(server: string, credential: string): void {
  if (!/^[a-f0-9]{64}$/i.test(credential)) return;
  try { globalThis.localStorage?.setItem(tvCredentialStorageKey(server), credential); } catch { /* Re-pairing remains available if storage is unavailable. */ }
}

export function saveCompanionDeviceLabel(deviceId: string, label: string): void {
  if (!/^[a-f0-9]{32}$/.test(deviceId)) return;
  const cleanLabel = label.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  if (!cleanLabel) return;
  try {
    const current = JSON.parse(globalThis.localStorage?.getItem("substream.companion-device-labels") || "{}") as Record<string, unknown>;
    globalThis.localStorage?.setItem("substream.companion-device-labels", JSON.stringify({ ...current, [deviceId]: cleanLabel }));
  } catch { /* Labels are a convenience; TV-provided names remain available. */ }
}

export function companionDeviceLabel(deviceId: string, fallback: string): string {
  if (!/^[a-f0-9]{32}$/.test(deviceId)) return fallback;
  try {
    const current = JSON.parse(globalThis.localStorage?.getItem("substream.companion-device-labels") || "{}") as Record<string, unknown>;
    const saved = current[deviceId];
    return typeof saved === "string" && saved.trim() ? saved.slice(0, 40) : fallback;
  } catch { return fallback; }
}

/** Stores only a validated relay origin, never credentials or request paths. */
export function saveCompanionServerUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    try { globalThis.localStorage?.removeItem("substream.companion-url"); } catch { /* Storage can be unavailable in private contexts. */ }
    return "";
  }
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error("Enter a valid relay address, such as http://192.168.1.50:8787."); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error("Relay address must use HTTP or HTTPS and cannot contain credentials.");
  const origin = url.origin;
  try { globalThis.localStorage?.setItem("substream.companion-url", origin); } catch { throw new Error("Relay address could not be saved in this browser."); }
  return origin;
}

export async function connectCompanionService(server: string, sourceFingerprint: string, identity: CompanionDeviceIdentity, tvCredential?: string): Promise<CompanionConnection> {
  if (sourceFingerprint && !/^vod_[a-z0-9]{1,8}$/.test(sourceFingerprint)) throw new Error("Provider source identity is invalid.");
  const deviceName = identity.deviceName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  if (!/^[a-f0-9]{32}$/.test(identity.deviceId) || !deviceName) throw new Error("A valid TV identity is required to connect this TV.");
  const { response, value } = await companionJsonRequest<Partial<CompanionConnection> & { protocolVersion?: unknown; error?: unknown }>(server + "/api/connect", {
    method: "POST",
    headers: { "content-type": "application/json", ...(tvCredential ? { authorization: `Bearer ${tvCredential}` } : {}) },
      body: JSON.stringify({ protocolVersion: COMPANION_PROTOCOL_VERSION, sourceFingerprint, capabilities: { localMedia: true }, deviceId: identity.deviceId, deviceName }),
    }, "Companion service response was unavailable or invalid.");
  // Translate only known relay errors; never expose arbitrary network response text.
  if (!response.ok) {
    if (value?.error === "Companion protocol version is unsupported." || value?.error === "Local media capability negotiation is required.") {
      throw new Error("TV app and LAN service versions do not match. Restart the LAN service and install the latest TV app.");
    }
    if (response.status === 404 && value?.error === "Companion connection could not be established.") {
      throw new Error("The LAN service rejected this TV's saved pairing. Restart the LAN service, then connect and pair this TV again.");
    }
    if (value?.error === "Request origin is not allowed.") throw new Error("The LAN service rejected this app's origin. Check the relay's allowed origins.");
    if (value?.error === "The relay has reached its TV connection limit.") throw new Error("The LAN service has reached its TV connection limit. Disconnect unused TVs or restart the LAN service.");
    throw new Error("TV connection could not be established.");
  }
  if (!value || !supportsCompanionProtocolVersion(value.protocolVersion) || value.deviceId !== identity.deviceId || value.deviceName !== deviceName || !/^[a-f0-9]{64}$/i.test(value.tvCredential || "")
    || (value.paired !== true && !/^\d{8}$/.test(value.pairingCode || "")) || typeof value.paired !== "boolean"
    || !Number.isFinite(value.pairingExpiresAt) || !Number.isFinite(value.expiresAt) || value.sourceFingerprint !== sourceFingerprint || value.capabilities?.localMedia !== true) throw new Error("TV connection could not be established.");
  return value as CompanionConnection;
}

/** Read public TV status only; this endpoint never returns either scoped credential. */
export async function getCompanionConnection(server: string, browserCredential: string): Promise<ActiveCompanionConnection> {
  let response: Response;
  let value: Partial<ActiveCompanionConnection> & { protocolVersion?: unknown };
  try { response = await fetch(server + "/api/active", { cache: "no-store", headers: { authorization: `Bearer ${browserCredential}` } }); }
  catch { throw new CompanionConnectionError("unreachable"); }
  try { value = await response.json() as typeof value; }
  catch { throw new CompanionConnectionError("invalid"); }
  if (response.status === 404) throw new CompanionConnectionError("no-tv");
  if (!response.ok || !supportsCompanionProtocolVersion(value.protocolVersion) || !/^[a-f0-9]{32}$/.test(value.deviceId || "") || typeof value.deviceName !== "string" || !Number.isFinite(value.expiresAt) || typeof value.sourceFingerprint !== "string" || value.capabilities?.localMedia !== true || "tvCredential" in value || "browserCredential" in value) throw new CompanionConnectionError("invalid");
  return value as ActiveCompanionConnection;
}

export async function redeemCompanionCode(server: string, code: string): Promise<BrowserCompanionConnection> {
  let response: Response;
  let value: Partial<BrowserCompanionConnection> & { protocolVersion?: unknown };
  try {
    response = await fetch(server + "/api/pair/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocolVersion: COMPANION_PROTOCOL_VERSION, code: code.trim() }) });
    value = await response.json() as typeof value;
  } catch { throw new Error("Could not redeem the TV pairing code."); }
  if (!response.ok || !supportsCompanionProtocolVersion(value.protocolVersion) || !/^[a-f0-9]{64}$/i.test(value.browserCredential || "") || !/^[a-f0-9]{32}$/.test(value.deviceId || "") || typeof value.deviceName !== "string" || !Number.isFinite(value.expiresAt) || typeof value.sourceFingerprint !== "string" || value.capabilities?.localMedia !== true) throw new Error("Pairing code is invalid or expired.");
  return value as BrowserCompanionConnection;
}

export async function resetCompanionPairing(server: string, tvCredential: string): Promise<{ deviceId: string; pairingCode: string; pairingExpiresAt: number }> {
  const { response, value } = await companionJsonRequest<{ deviceId?: unknown; pairingCode?: unknown; pairingExpiresAt?: unknown; protocolVersion?: unknown }>(server + "/api/pair/reset", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tvCredential}` },
      body: JSON.stringify({ protocolVersion: COMPANION_PROTOCOL_VERSION }),
    }, "Could not reset TV pairing.");
  if (!response.ok || !value || !supportsCompanionProtocolVersion(value.protocolVersion) || !/^[a-f0-9]{32}$/.test(String(value.deviceId || ""))
    || !/^\d{8}$/.test(String(value.pairingCode || "")) || !Number.isFinite(value.pairingExpiresAt)) throw new Error("Could not reset TV pairing.");
  return { deviceId: String(value.deviceId), pairingCode: String(value.pairingCode), pairingExpiresAt: Number(value.pairingExpiresAt) };
}

export async function sendCompanionPlayback(server: string, browserCredential: string, selection: CompanionPlaybackSelection): Promise<void> {
  const safeSelection = parseCompanionSelection(selection);
  if (!safeSelection || (safeSelection.kind !== "movie" && safeSelection.kind !== "episode")
    || (safeSelection.kind === "episode" && !safeSelection.seriesId)) throw new Error("Could not send playback to the TV.");
  let response: Response;
  let value: { accepted?: boolean; protocolVersion?: unknown };
  try {
    response = await fetch(server + "/api/pair/play", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${browserCredential}` },
    body: JSON.stringify({ protocolVersion: COMPANION_PROTOCOL_VERSION, selection: safeSelection }),
    });
    value = await response.json() as typeof value;
  } catch { throw new Error("Could not send playback to the TV."); }
  if (!response.ok || !supportsCompanionProtocolVersion(value.protocolVersion) || value.accepted !== true) throw new Error("Could not send playback to the TV.");
}

export type LocalMediaUploadStatus = { sessionId: string; state: "uploading" | "ready"; playbackState?: string; expectedSize: number; uploadOffset: number; expiresAt: number; chunkBytes?: number };

function readLocalMediaStatus(value: unknown): LocalMediaUploadStatus {
  if (!value || typeof value !== "object") throw new Error("Companion media response was invalid.");
  const status = value as Partial<LocalMediaUploadStatus>;
  if (!/^[a-f0-9]{32}$/.test(status.sessionId || "") || !["uploading", "ready"].includes(status.state || "")
    || !Number.isSafeInteger(status.expectedSize) || !Number.isSafeInteger(status.uploadOffset) || !Number.isFinite(status.expiresAt)) throw new Error("Companion media response was invalid.");
  return status as LocalMediaUploadStatus;
}

export async function stageLocalMedia(
  server: string,
  browserCredential: string,
  file: File,
  onProgress: (sentBytes: number, totalBytes: number) => void,
  signal?: AbortSignal,
): Promise<LocalMediaUploadStatus> {
  let response: Response;
  try {
    response = await fetch(server + "/api/local-media/sessions", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${browserCredential}` },
      body: JSON.stringify({ expectedSize: file.size, name: file.name }), ...(signal ? { signal } : {}),
    });
  } catch { throw new Error("Could not prepare the local media session."); }
  const created = await response.json() as unknown;
  if (!response.ok) throw new Error("The companion service could not prepare this video.");
  const status = readLocalMediaStatus(created);
  const chunkBytes = Number((created as { chunkBytes?: unknown }).chunkBytes);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 4 * 1024 * 1024) throw new Error("Companion upload settings were invalid.");
  let offset = status.uploadOffset;
  onProgress(offset, file.size);
  try {
    while (offset < file.size) {
      if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
      let attempts = 0;
      let uploaded = false;
      while (!uploaded) {
        const chunkStart = offset;
        const chunk = file.slice(chunkStart, Math.min(file.size, chunkStart + chunkBytes));
        let retryFromStatus = false;
        try {
          const chunkResponse = await fetch(server + `/api/local-media/sessions/${status.sessionId}/chunks?offset=${chunkStart}`, {
            method: "PUT", headers: { authorization: `Bearer ${browserCredential}`, "content-type": "application/octet-stream" }, body: chunk, ...(signal ? { signal } : {}),
          });
          if (chunkResponse.ok) {
            const result = await chunkResponse.json() as { uploadOffset?: unknown };
            if (result.uploadOffset !== chunkStart + chunk.size) throw new Error("Companion upload offset changed.");
            offset = Number(result.uploadOffset); onProgress(offset, file.size); uploaded = true; continue;
          }
          if (chunkResponse.status !== 409 && chunkResponse.status < 500) throw new Error("Could not upload local media.");
          retryFromStatus = true;
        } catch (cause) {
          if (signal?.aborted || (cause instanceof Error && cause.message === "Could not upload local media.")) throw cause;
          retryFromStatus = true;
        }
        if (!retryFromStatus) continue;
        attempts += 1;
        if (attempts > 3) throw new Error("Local media upload stopped. Retry from the current offset.");
        const check = await fetch(server + `/api/local-media/sessions/${status.sessionId}/status`, { headers: { authorization: `Bearer ${browserCredential}` }, cache: "no-store", ...(signal ? { signal } : {}) });
        if (!check.ok) throw new Error("Could not resume the local media upload.");
        const actual = readLocalMediaStatus(await check.json());
        if (actual.sessionId !== status.sessionId || actual.expectedSize !== file.size || actual.uploadOffset > file.size) throw new Error("Companion upload status did not match the selected file.");
        const advancedByCurrentChunk = actual.uploadOffset === chunkStart + chunk.size;
        offset = actual.uploadOffset; onProgress(offset, file.size);
        if (advancedByCurrentChunk) uploaded = true;
      }
    }
    const finalized = await fetch(server + `/api/local-media/sessions/${status.sessionId}/finalize`, {
      method: "POST", headers: { authorization: `Bearer ${browserCredential}`, "content-type": "application/json" }, body: JSON.stringify({ tvCompatibility: true }), ...(signal ? { signal } : {}),
    });
    if (!finalized.ok) throw new Error("The companion service could not prepare TV playback. Check that ffmpeg and ffprobe are installed on the computer.");
    return readLocalMediaStatus(await finalized.json());
  } catch (cause) {
    await stopLocalMedia(server, browserCredential, status.sessionId).catch(() => undefined);
    throw cause;
  }
}

export async function stopLocalMedia(server: string, browserCredential: string, sessionId: string): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(sessionId)) return;
  try {
    const response = await fetch(server + `/api/local-media/sessions/${sessionId}/status`, { method: "DELETE", headers: { authorization: `Bearer ${browserCredential}` } });
    if (!response.ok) throw new Error("Could not stop the hosted local media session.");
  } catch { throw new Error("Could not stop the hosted local media session."); }
}

export async function sendLocalCompanionPlayback(server: string, browserCredential: string, sessionId: string, metadata: Omit<CompanionLocalPlayback, "sessionId" | "ticket" | "mediaType" | "size">): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(sessionId) || !metadata.title.trim()) throw new Error("Could not send local playback to the TV.");
  let response: Response;
  let value: { accepted?: unknown; protocolVersion?: unknown };
  try {
    response = await fetch(server + "/api/pair/play-local", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${browserCredential}` },
      body: JSON.stringify({ protocolVersion: COMPANION_PROTOCOL_VERSION, sessionId, metadata }),
    });
    value = await response.json() as typeof value;
  } catch { throw new Error("Could not send local playback to the TV."); }
  if (!response.ok || !supportsCompanionProtocolVersion(value.protocolVersion) || value.accepted !== true) throw new Error("Could not send local playback to the TV.");
}

export async function sendStopLocalCompanionPlayback(server: string, browserCredential: string, sessionId: string): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(sessionId)) throw new Error("Could not stop local TV playback.");
  try {
    const response = await fetch(server + "/api/pair/stop-local", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${browserCredential}` },
      body: JSON.stringify({ protocolVersion: COMPANION_PROTOCOL_VERSION, sessionId }),
    });
    const value = await response.json() as { protocolVersion?: unknown; accepted?: unknown };
    if (!response.ok || !supportsCompanionProtocolVersion(value.protocolVersion) || value.accepted !== true) throw new Error();
  } catch { throw new Error("Could not stop local TV playback."); }
}

export function companionLocalMediaUrl(server: string, media: Pick<CompanionLocalPlayback, "sessionId" | "ticket">): string {
  if (!/^[a-f0-9]{32}$/.test(media.sessionId) || !/^[a-f0-9]{64}$/.test(media.ticket)) throw new Error("Local playback ticket was invalid.");
  return `${server}/api/local-media/${media.sessionId}?ticket=${media.ticket}`;
}

export async function publishLocalMediaSubtitle(server: string, browserCredential: string, sessionId: string, subtitle: Omit<CompanionLocalSubtitle, "version">): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(sessionId) || subtitle.text.length > 1_900_000 || !Number.isFinite(subtitle.offsetSeconds)) throw new Error("Local subtitle data is invalid.");
  const response = await fetch(server + `/api/local-media/sessions/${sessionId}/subtitle`, {
    method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${browserCredential}` },
    body: JSON.stringify(subtitle),
  }).catch(() => null);
  if (!response?.ok) throw new Error("Local subtitle could not be sent to the TV.");
}

export async function getLocalMediaSubtitle(server: string, media: Pick<CompanionLocalPlayback, "sessionId" | "ticket">): Promise<CompanionLocalSubtitle> {
  let response: Response;
  try { response = await fetch(`${server}/api/local-media/${media.sessionId}/subtitle?ticket=${media.ticket}`, { cache: "no-store" }); }
  catch { throw new Error("Local TV subtitle status is unavailable."); }
  if (!response.ok) throw new Error("Local TV subtitle status is unavailable.");
  const value = await response.json() as Partial<CompanionLocalSubtitle> & { protocolVersion?: unknown };
  if (!supportsCompanionProtocolVersion(value.protocolVersion) || !Number.isSafeInteger(value.version) || typeof value.text !== "string" || value.text.length > 1_900_000
    || typeof value.label !== "string" || typeof value.language !== "string" || typeof value.enabled !== "boolean" || !Number.isFinite(value.offsetSeconds)) throw new Error("Local TV subtitle response was invalid.");
  return { version: value.version!, text: value.text, label: value.label, language: value.language, enabled: value.enabled, offsetSeconds: value.offsetSeconds! };
}

export async function renewLocalMediaLease(server: string, tvCredential: string, sessionId: string): Promise<void> {
  const response = await fetch(server + `/api/local-media/sessions/${sessionId}/lease`, {
    method: "POST", headers: { authorization: `Bearer ${tvCredential}` },
  }).catch(() => null);
  if (!response?.ok) throw new Error("Local TV playback lease expired.");
}

export async function reportLocalMediaState(server: string, tvCredential: string, sessionId: string, state: "preparing" | "playing" | "paused" | "ended" | "failed" | "stopped"): Promise<void> {
  const response = await fetch(server + `/api/local-media/sessions/${sessionId}/state`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tvCredential}` },
    body: JSON.stringify({ protocolVersion: COMPANION_PROTOCOL_VERSION, state }),
  }).catch(() => null);
  if (!response?.ok) throw new Error("Local TV playback state could not be reported.");
}

export async function getLocalMediaUploadStatus(server: string, browserCredential: string, sessionId: string): Promise<LocalMediaUploadStatus> {
  const response = await fetch(server + `/api/local-media/sessions/${sessionId}/status`, { cache: "no-store", headers: { authorization: `Bearer ${browserCredential}` } }).catch(() => null);
  if (!response?.ok) throw new Error("Local TV playback status is unavailable.");
  return readLocalMediaStatus(await response.json());
}

export async function companionEvents(server: string, tvCredential: string, after: number, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<CompanionEventsResult> {
  let response: Response;
  let value: unknown;
  try {
    const waitMs = Math.max(0, Math.min(25_000, Math.floor(options.waitMs ?? 25_000)));
    response = await fetch(server + "/api/pair/events?after=" + after + "&protocolVersion=" + COMPANION_PROTOCOL_VERSION + "&wait=" + waitMs, { cache: "no-store", headers: { authorization: `Bearer ${tvCredential}` }, ...(options.signal ? { signal: options.signal } : {}) });
    value = await response.json() as typeof value;
  } catch { throw new Error("Companion service response was unavailable or invalid."); }
  if (!response.ok) throw new Error("Companion connection expired.");
  const parsed = parseCompanionEventsPayload(value);
  if (!parsed) throw new Error("Companion service response was unavailable or invalid.");
  return parsed;
}

/** Acknowledge a locally processed event sequence for this TV session. */
export async function acknowledgeCompanionEvents(server: string, tvCredential: string, sequence: number): Promise<void> {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Could not acknowledge companion events.");
  let response: Response;
  let value: { acknowledged?: unknown; protocolVersion?: unknown };
  try {
    response = await fetch(server + "/api/pair/ack", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tvCredential}` },
      body: JSON.stringify({ protocolVersion: COMPANION_PROTOCOL_VERSION, sequence }),
    });
    value = await response.json() as typeof value;
  } catch { throw new Error("Could not acknowledge companion events."); }
  if (!response.ok || !supportsCompanionProtocolVersion(value.protocolVersion) || value.acknowledged !== sequence) throw new Error("Could not acknowledge companion events.");
}

/** Converts a safe provider selection into a local playback candidate. */
export function companionSelectionTitle(selection: CompanionSelection): VodCatalogItem | null {
  const safe = parseCompanionSelection(selection);
  if (!safe) return null;
  const normalized = normalizeTitle(safe.title);
  return {
    id: `xtream:${safe.kind === "episode" ? "episode" : safe.kind}:${safe.id}`,
    title: normalized.title,
    searchTitle: normalized.searchTitle,
    searchTerms: searchTerms(normalized.searchTitle),
    year: normalized.year ?? safe.year,
    group: "Search",
    contentType: selection.kind === "movie" ? "movie" : "series",
    addedAt: Date.now(),
    ...(typeof safe.season === "number" ? { season: safe.season } : {}),
    ...(typeof safe.episode === "number" ? { episode: safe.episode } : {}),
    // The TV fills this from its locally stored Xtream credentials immediately
    // before playback. Never accept a stream URL from the companion service.
    streamUrl: "",
    sourceLine: 0,
    ...(safe.kind === "series" ? { providerSeriesId: Number(safe.id) } : {}),
  };
}
