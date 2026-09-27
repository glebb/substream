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

/** Keep provider order within each preference tier. */
export function preferredAudioTrackIndex<T extends AudioChoice>(tracks: readonly T[]): number {
  if (tracks.length === 0) return -1;
  let bestIndex = 0;
  let bestRank = languageRank(tracks[0]!);
  for (let index = 1; index < tracks.length; index += 1) {
    const rank = languageRank(tracks[index]!);
    if (rank < bestRank) {
      bestRank = rank;
      bestIndex = index;
    }
  }
  return bestIndex;
}
