export interface AudioChoice {
  language?: string;
  label: string;
}

function languageRank(track: AudioChoice): number {
  const value = `${track.language ?? ""} ${track.label}`.toLocaleLowerCase();
  if (/(^|[^a-z])(fi|fin|finnish)([^a-z]|$)/.test(value)) return 0;
  if (/(^|[^a-z])(en|eng|english)([^a-z]|$)/.test(value)) return 1;
  return 2;
}

/**
 * Keep provider order within each preference tier. If neither preferred
 * language is present, retain the supplied stream-default track.
 */
export function preferredAudioTrackIndex<T extends AudioChoice>(tracks: readonly T[], fallbackIndex = 0): number {
  if (tracks.length === 0) return -1;
  const safeFallbackIndex = Number.isInteger(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < tracks.length
    ? fallbackIndex
    : 0;
  let bestIndex = safeFallbackIndex;
  let bestRank = 2;
  for (let index = 0; index < tracks.length; index += 1) {
    const rank = languageRank(tracks[index]!);
    if (rank < bestRank) {
      bestRank = rank;
      bestIndex = index;
    }
  }
  return bestIndex;
}
