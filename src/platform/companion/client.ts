import { normalizeTitle, searchTerms, type VodCatalogItem } from "../../core/catalog/index.ts";
import { packageDefaults } from "../package-defaults.ts";

export type CompanionSelection = {
  kind: "movie" | "series";
  id: string;
  title: string;
  year: number | null;
  extension: string;
  sourceFingerprint: string;
};

export type CompanionEvent = { sequence: number; selection: CompanionSelection };
export type CompanionConnection = { sessionId: string; expiresAt: number };

export function companionServerUrl(): string {
  const configured = new URLSearchParams(globalThis.location?.search ?? "").get("companion");
  const value = configured || globalThis.localStorage?.getItem("substream.companion-url") || packageDefaults.companionServerUrl || "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch { return ""; }
}

export async function connectCompanionService(server: string, playlistUrl: string): Promise<CompanionConnection> {
  const response = await fetch(server + "/api/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playlistUrl }),
  });
  const value = await response.json() as { sessionId?: string; expiresAt?: number; error?: string };
  if (!response.ok || !value.sessionId || !value.expiresAt) throw new Error(value.error || "Companion service is unavailable.");
  return { sessionId: value.sessionId, expiresAt: value.expiresAt };
}

export async function companionEvents(server: string, sessionId: string, after: number): Promise<CompanionEvent[]> {
  const response = await fetch(server + "/api/pair/events?sessionId=" + encodeURIComponent(sessionId) + "&after=" + after, { cache: "no-store" });
  const value = await response.json() as { events?: CompanionEvent[]; error?: string };
  if (!response.ok) throw new Error(value.error || "Companion connection expired.");
  return Array.isArray(value.events) ? value.events : [];
}

/** Converts a safe provider selection into a local playback candidate. */
export function companionSelectionTitle(selection: CompanionSelection): VodCatalogItem | null {
  if (!/^(movie|series)$/.test(selection.kind) || !/^\d{1,20}$/.test(selection.id)) return null;
  const normalized = normalizeTitle(selection.title);
  return {
    id: `xtream:${selection.kind}:${selection.id}`,
    title: normalized.title,
    searchTitle: normalized.searchTitle,
    searchTerms: searchTerms(normalized.searchTitle),
    year: normalized.year ?? selection.year,
    group: "Companion search",
    contentType: selection.kind,
    addedAt: Date.now(),
    // The TV fills this from its locally stored Xtream credentials immediately
    // before playback. Never accept a stream URL from the companion service.
    streamUrl: "",
    sourceLine: 0,
    ...(selection.kind === "series" ? { providerSeriesId: Number(selection.id) } : {}),
  };
}
