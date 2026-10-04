import type { MediaPlayer } from "../platform/media-player.ts";

/** Monotonic guard for ignoring late player callbacks across tune/retry/unmount. */
export class PlaybackSessionGuard {
  private generation = 0;
  private closed = false;

  next(): number {
    this.closed = false;
    return ++this.generation;
  }

  isCurrent(session: number): boolean {
    return !this.closed && session === this.generation;
  }

  invalidate(): void { ++this.generation; }
  close(): void { this.closed = true; ++this.generation; }
}

const disposalByPlayer = new WeakMap<MediaPlayer, Promise<void>>();

/** Consistent player release contract for screen cleanup. */
export function disposeMediaPlayer(player: MediaPlayer | null, timeoutMs = 15_000): Promise<void> {
  if (!player) return Promise.resolve();
  const existing = disposalByPlayer.get(player);
  if (existing) return existing;
  const boundedMs = Math.max(1, Math.min(60_000, Math.floor(timeoutMs)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disposal = Promise.resolve().then(() => {
    player.setEventHandlers(null);
    return player.dispose ? player.dispose() : player.destroy();
  }).then(() => new Promise<void>((resolve) => { resolve(); })).catch((error: unknown) => { throw error; });
  const boundedDisposal = Promise.race([
    disposal,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Playback player cleanup timed out.")), boundedMs); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  const retryableDisposal = boundedDisposal.catch((error: unknown) => {
    if (disposalByPlayer.get(player) === retryableDisposal) disposalByPlayer.delete(player);
    throw error;
  });
  disposalByPlayer.set(player, retryableDisposal);
  return retryableDisposal;
}
