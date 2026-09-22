import { normalizeTitle, searchTerms, type VodCatalogItem } from "../../core/catalog/index.ts";
import { packageDefaults } from "../package-defaults.ts";

export type CompanionSelection = {
  kind: "movie" | "series" | "episode";
  id: string;
  seriesId?: string;
  title: string;
  year: number | null;
  season?: number;
  episode?: number;
  extension: string;
  sourceFingerprint: string;
};

export type CompanionEvent = { sequence: number; action?: "play" | "select"; selection: CompanionSelection };
export type CompanionConnection = { sessionId: string; expiresAt: number; sourceFingerprint?: string };
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

export async function connectCompanionService(server: string, playlistUrl: string): Promise<CompanionConnection> {
  let response: Response;
  let value: { sessionId?: string; expiresAt?: number; sourceFingerprint?: string };
  try {
    response = await fetch(server + "/api/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playlistUrl }),
    });
    value = await response.json() as typeof value;
  } catch { throw new Error("Companion service response was unavailable or invalid."); }
  if (!response.ok || !value.sessionId || !value.expiresAt) throw new Error("TV connection could not be established.");
  return { sessionId: value.sessionId, expiresAt: value.expiresAt, ...(value.sourceFingerprint ? { sourceFingerprint: value.sourceFingerprint } : {}) };
}

/** Read the TV-owned active session. This does not register or replace the TV session. */
export async function getCompanionConnection(server: string): Promise<CompanionConnection> {
  let response: Response;
  let value: { sessionId?: string; expiresAt?: number; sourceFingerprint?: string };
  try { response = await fetch(server + "/api/active", { cache: "no-store" }); }
  catch { throw new CompanionConnectionError("unreachable"); }
  try { value = await response.json() as typeof value; }
  catch { throw new CompanionConnectionError("invalid"); }
  if (response.status === 404) throw new CompanionConnectionError("no-tv");
  if (!response.ok || !value.sessionId || !value.expiresAt || !value.sourceFingerprint) throw new CompanionConnectionError("invalid");
  return { sessionId: value.sessionId, expiresAt: value.expiresAt, sourceFingerprint: value.sourceFingerprint };
}

export async function sendCompanionPlayback(server: string, sessionId: string, selection: CompanionPlaybackSelection): Promise<void> {
  let response: Response;
  let value: { accepted?: boolean };
  try {
    response = await fetch(server + "/api/pair/play", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, selection }),
    });
    value = await response.json() as typeof value;
  } catch { throw new Error("Could not send playback to the TV."); }
  if (!response.ok || value.accepted !== true) throw new Error("Could not send playback to the TV.");
}

export async function companionEvents(server: string, sessionId: string, after: number): Promise<CompanionEvent[]> {
  let response: Response;
  let value: { events?: CompanionEvent[] };
  try {
    response = await fetch(server + "/api/pair/events?sessionId=" + encodeURIComponent(sessionId) + "&after=" + after, { cache: "no-store" });
    value = await response.json() as typeof value;
  } catch { throw new Error("Companion service response was unavailable or invalid."); }
  if (!response.ok) throw new Error("Companion connection expired.");
  return Array.isArray(value.events) ? value.events : [];
}

/** Converts a safe provider selection into a local playback candidate. */
export function companionSelectionTitle(selection: CompanionSelection): VodCatalogItem | null {
  if (!/^(movie|series|episode)$/.test(selection.kind) || !/^\d{1,20}$/.test(selection.id)) return null;
  if (selection.kind === "episode" && !/^\d{1,20}$/.test(selection.seriesId ?? "")) return null;
  const normalized = normalizeTitle(selection.title);
  return {
    id: `xtream:${selection.kind === "episode" ? "episode" : selection.kind}:${selection.id}`,
    title: normalized.title,
    searchTitle: normalized.searchTitle,
    searchTerms: searchTerms(normalized.searchTitle),
    year: normalized.year ?? selection.year,
    group: "Search",
    contentType: selection.kind === "movie" ? "movie" : "series",
    addedAt: Date.now(),
    ...(selection.season !== undefined ? { season: selection.season } : {}),
    ...(selection.episode !== undefined ? { episode: selection.episode } : {}),
    // The TV fills this from its locally stored Xtream credentials immediately
    // before playback. Never accept a stream URL from the companion service.
    streamUrl: "",
    sourceLine: 0,
    ...(selection.kind === "series" ? { providerSeriesId: Number(selection.id) } : {}),
  };
}
