import { normalizeTitle, searchTerms, type VodCatalogItem } from "../../core/catalog/index.ts";
import { COMPANION_PROTOCOL_VERSION, parseCompanionEventsPayload, parseCompanionSelection, supportsCompanionProtocolVersion, type CompanionEventWire, type CompanionSelectionWire } from "../../core/companion-protocol.mjs";
import { packageDefaults } from "../package-defaults.ts";

export type CompanionSelection = CompanionSelectionWire;
export type CompanionEvent = CompanionEventWire;
export type CompanionEventsResult = { protocolVersion: 1; events: CompanionEvent[]; paired: boolean };
export type CompanionConnection = { tvCredential: string; pairingCode: string; pairingExpiresAt: number; expiresAt: number; sourceFingerprint: string };
export type ActiveCompanionConnection = { expiresAt: number; sourceFingerprint: string };
export type BrowserCompanionConnection = ActiveCompanionConnection & { browserCredential: string };
export type CompanionPlaybackSelection = Omit<CompanionSelection, "kind" | "seriesId"> & ({ kind: "movie" } | { kind: "episode"; seriesId: string });

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

export async function connectCompanionService(server: string, playlistUrl: string, tvCredential?: string): Promise<CompanionConnection> {
  let response: Response;
  let value: Partial<CompanionConnection> & { protocolVersion?: unknown };
  try {
    response = await fetch(server + "/api/connect", {
    method: "POST",
    headers: { "content-type": "application/json", ...(tvCredential ? { authorization: `Bearer ${tvCredential}` } : {}) },
    body: JSON.stringify({ protocolVersion: COMPANION_PROTOCOL_VERSION, playlistUrl }),
    });
    value = await response.json() as typeof value;
  } catch { throw new Error("Companion service response was unavailable or invalid."); }
  if (!response.ok || !supportsCompanionProtocolVersion(value.protocolVersion) || !/^[a-f0-9]{64}$/i.test(value.tvCredential || "") || !/^\d{8}$/.test(value.pairingCode || "")
    || !Number.isFinite(value.pairingExpiresAt) || !Number.isFinite(value.expiresAt) || !value.sourceFingerprint) throw new Error("TV connection could not be established.");
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
  if (!response.ok || !supportsCompanionProtocolVersion(value.protocolVersion) || !Number.isFinite(value.expiresAt) || !value.sourceFingerprint || "tvCredential" in value || "browserCredential" in value) throw new CompanionConnectionError("invalid");
  return value as ActiveCompanionConnection;
}

export async function redeemCompanionCode(server: string, code: string): Promise<BrowserCompanionConnection> {
  let response: Response;
  let value: Partial<BrowserCompanionConnection> & { protocolVersion?: unknown };
  try {
    response = await fetch(server + "/api/pair/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocolVersion: COMPANION_PROTOCOL_VERSION, code: code.trim() }) });
    value = await response.json() as typeof value;
  } catch { throw new Error("Could not redeem the TV pairing code."); }
  if (!response.ok || !supportsCompanionProtocolVersion(value.protocolVersion) || !/^[a-f0-9]{64}$/i.test(value.browserCredential || "") || !Number.isFinite(value.expiresAt) || !value.sourceFingerprint) throw new Error("Pairing code is invalid or expired.");
  return value as BrowserCompanionConnection;
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
