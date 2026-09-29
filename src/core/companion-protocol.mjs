/**
 * Safe wire contract shared by the companion relay and platform adapters.
 * Selection/event objects contain provider identifiers and display metadata
 * only. Credentials belong in authorization headers; stream URLs stay local.
 */
export const COMPANION_PROTOCOL_VERSION = 3;

const ID_PATTERN = /^\d{1,20}$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,10}$/i;
const KINDS = new Set(["movie", "series", "episode"]);
const ACTIONS = new Set(["play", "select"]);

export function supportsCompanionProtocolVersion(value) {
  return value === COMPANION_PROTOCOL_VERSION;
}

/** Return a new allow-listed selection, or null when required fields are invalid. */
export function parseCompanionSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !KINDS.has(value.kind) || !ID_PATTERN.test(String(value.id ?? ""))) return null;

  const title = typeof value.title === "string" ? value.title.trim().slice(0, 240) : "";
  const sourceFingerprint = typeof value.sourceFingerprint === "string" ? value.sourceFingerprint.trim().slice(0, 200) : "";
  if (!title || !sourceFingerprint) return null;

  const parsed = {
    kind: value.kind,
    id: String(value.id),
    title,
    year: Number.isSafeInteger(value.year) ? value.year : null,
    season: Number.isSafeInteger(value.season) && value.season > 0 ? value.season : null,
    episode: Number.isSafeInteger(value.episode) && value.episode > 0 ? value.episode : null,
    extension: EXTENSION_PATTERN.test(String(value.extension ?? "")) ? String(value.extension).toLowerCase() : "mp4",
    sourceFingerprint,
  };
  if (value.kind === "episode" && ID_PATTERN.test(String(value.seriesId ?? ""))) parsed.seriesId = String(value.seriesId);
  return parsed;
}

/** Return an allow-listed event, or null if its sequence or selection is invalid. */
export function parseCompanionEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1) return null;
  const selection = parseCompanionSelection(value.selection);
  if (!selection || (value.action !== undefined && !ACTIONS.has(value.action))) return null;
  return {
    sequence: value.sequence,
    ...(value.action ? { action: value.action } : {}),
    selection,
  };
}

/** Validate a versioned event response without allowing unknown fields through. */
export function parseCompanionEventsPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !supportsCompanionProtocolVersion(value.protocolVersion)
    || !Array.isArray(value.events) || typeof value.paired !== "boolean") return null;
  const events = value.events.map(parseCompanionEvent);
  if (events.some((event) => event === null)) return null;
  let retentionGap = null;
  if (value.retentionGap !== undefined && value.retentionGap !== null) {
    const gap = value.retentionGap;
    if (typeof gap !== "object" || Array.isArray(gap)
      || !Number.isSafeInteger(gap.throughSequence) || gap.throughSequence < 1
      || !Number.isSafeInteger(gap.firstAvailableSequence) || gap.firstAvailableSequence <= gap.throughSequence) return null;
    retentionGap = { throughSequence: gap.throughSequence, firstAvailableSequence: gap.firstAvailableSequence };
  }
  return { protocolVersion: COMPANION_PROTOCOL_VERSION, events, paired: value.paired, retentionGap };
}
