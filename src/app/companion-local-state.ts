import type { PlaybackState } from "../platform/media-player.ts";

export type CompanionLocalPlaybackState = "preparing" | "playing" | "paused" | "ended" | "failed" | "stopped";

/** Maps a player state to the state reported to the companion for a TV local-media session. */
export function companionLocalPlaybackState(state: PlaybackState): CompanionLocalPlaybackState {
  return state === "playing" ? "playing"
    : state === "paused" ? "paused"
      : state === "ended" ? "ended"
        : state === "error" ? "failed" : "preparing";
}

/**
 * Returns the updated session only when the reported state changes. Players
 * repeat state callbacks several times a second during steady playback, and a
 * new session object re-runs the lease and subtitle effects. Reporting every
 * callback made LG webOS send about 15 companion requests a second, which
 * exhausted device memory within minutes.
 */
export function nextCompanionLocalSession<T extends { playbackState: CompanionLocalPlaybackState }>(session: T, state: PlaybackState): T | null {
  const playbackState = companionLocalPlaybackState(state);
  return session.playbackState === playbackState ? null : { ...session, playbackState };
}
