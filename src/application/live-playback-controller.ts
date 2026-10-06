import { createCancellationController, type CancellationSignal } from "../contracts/cancellation.ts";
import type { AudioTrack, EmbeddedSubtitleTrack, LiveBufferWindow, MediaPlayer, PlaybackState, RelayMediaPlayer } from "../platform/media-player.ts";

export type RelayServiceState = "disabled" | "starting" | "ready" | "recovering" | "fallback" | "unavailable" | "cleanup-blocked";

export interface LivePlaybackControllerOptions {
  /** Finite, cancellable discovery completes before any playback connection. */
  prepareRelay?(signal: CancellationSignal): Promise<void>;
  createDirect(): MediaPlayer | null;
  directStreamUrl: string;
  createRelay?(): RelayMediaPlayer | null;
  onPlayer(player: MediaPlayer | null): void;
  onState?(state: PlaybackState): void;
  onRelayState?(state: RelayServiceState, detail?: string): void;
  onPlayerEvents?: (player: MediaPlayer) => {
    onProgress?(): void;
    onLiveBufferWindowChange?(value: LiveBufferWindow | null): void;
    onAudioTracksChange?(tracks: AudioTrack[]): void;
    onEmbeddedSubtitleTracksChange?(tracks: EmbeddedSubtitleTrack[]): void;
  };
  maxReconnects?: number;
  cleanupTimeoutMs?: number;
}

/** Owns one live playback session, including relay recovery and exclusive-player teardown. */
export class LivePlaybackController {
  private readonly preparationAbort = createCancellationController();
  private player: MediaPlayer | null = null;
  private generation = 0;
  private closed = false;
  private starting: Promise<void> | null = null;
  private recovery: Promise<void> | null = null;
  private relayReconnects = 0;
  private relayPlayed = false;
  private fallingBack = false;
  private startingRelay: MediaPlayer | null = null;
  private relayErrorDuringStart: MediaPlayer | null = null;
  private readonly ownedPlayers = new Set<MediaPlayer>();
  private readonly disposal = new WeakMap<MediaPlayer, Promise<boolean>>();
  private closePromise: Promise<void> | null = null;
  private readonly maxReconnects: number;
  private readonly cleanupTimeoutMs: number;

  constructor(private readonly options: LivePlaybackControllerOptions) {
    this.maxReconnects = Math.max(0, options.maxReconnects ?? 2);
    this.cleanupTimeoutMs = Math.max(1_000, options.cleanupTimeoutMs ?? 15_000);
  }

  get currentPlayer(): MediaPlayer | null { return this.player; }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Playback session is closed."));
    if (this.starting) return this.starting;
    const generation = ++this.generation;
    this.starting = (async () => {
      try { if (this.options.prepareRelay) await this.options.prepareRelay(this.preparationAbort.signal); } catch { /* Discovery failure retains direct playback. */ }
      if (this.isSession(generation)) await this.startRelayOrDirect(generation);
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startRelayOrDirect(generation: number): Promise<void> {
    const relay = this.options.createRelay?.() ?? null;
    if (!relay) { this.startDirect(generation); return; }
    this.options.onRelayState?.("starting");
    this.bind(relay, generation, true);
    this.startingRelay = relay;
    try {
      await relay.start();
      if (this.relayErrorDuringStart === relay) throw new Error("Relay failed during startup.");
      if (!this.isCurrent(generation, relay)) return;
      this.options.onRelayState?.("ready");
    } catch {
      if (!this.isCurrent(generation, relay)) return;
      await this.fallback(relay, generation);
    } finally {
      if (this.startingRelay === relay) this.startingRelay = null;
      if (this.relayErrorDuringStart === relay) this.relayErrorDuringStart = null;
    }
  }

  private startDirect(generation: number): void {
    if (this.closed || generation !== this.generation) return;
    const direct = this.options.createDirect();
    if (!direct) { this.options.onState?.("error"); return; }
    this.bind(direct, generation, false);
    direct.load(this.options.directStreamUrl);
  }

  /** Start a direct player whose URL is already configured by the factory. */
  private bind(player: MediaPlayer, generation: number, relay: boolean): void {
    this.player = player;
    this.ownedPlayers.add(player);
    this.options.onPlayer(player);
    player.setEventHandlers({
      onStateChange: (state) => {
        if (!this.isCurrent(generation, player)) return;
        if (state === "error" && relay) {
          if (this.startingRelay === player) { this.relayErrorDuringStart = player; return; }
          if (this.recovery) return;
          if (this.relayPlayed || this.relayReconnects > 0) void this.recover(player as RelayMediaPlayer, generation);
          else void this.fallback(player as RelayMediaPlayer, generation);
          return;
        }
        if (state === "playing" && relay) this.relayPlayed = true;
        this.options.onState?.(state);
      },
      onProgress: () => { if (!this.isCurrent(generation, player)) return; if (relay) this.relayPlayed = true; this.options.onPlayerEvents?.(player).onProgress?.(); },
      onLiveBufferWindowChange: (value) => { if (this.isCurrent(generation, player)) this.options.onPlayerEvents?.(player).onLiveBufferWindowChange?.(value); },
      onAudioTracksChange: (tracks) => { if (this.isCurrent(generation, player)) this.options.onPlayerEvents?.(player).onAudioTracksChange?.(tracks); },
      onEmbeddedSubtitleTracksChange: (tracks) => { if (this.isCurrent(generation, player)) this.options.onPlayerEvents?.(player).onEmbeddedSubtitleTracksChange?.(tracks); },
    });
  }

  private isCurrent(generation: number, player: MediaPlayer): boolean {
    return this.isSession(generation) && this.player === player;
  }

  private isSession(generation: number): boolean { return !this.closed && generation === this.generation; }

  private async recover(failed: RelayMediaPlayer, generation: number): Promise<void> {
    if (!this.isCurrent(generation, failed) || this.fallingBack) return;
    if (this.recovery) return this.recovery;
    this.recovery = (async () => {
      let current = failed;
      while (this.relayReconnects < this.maxReconnects && this.isSession(generation)) {
        this.relayReconnects += 1;
        this.options.onRelayState?.("recovering");
        this.detach(current);
        if (!await this.disposeRelay(current)) return;
        if (!this.isSession(generation)) return;
        const next = this.options.createRelay?.() ?? null;
        if (!next) break;
        current = next;
        this.relayPlayed = false;
        this.bind(current, generation, true);
        this.startingRelay = current;
        try {
          await current.start();
          if (this.relayErrorDuringStart === current) throw new Error("Relay failed during startup.");
          if (!this.isCurrent(generation, current)) return;
          this.options.onRelayState?.("ready");
          return;
        } catch { /* A failed retry consumes one of the bounded attempts. */ }
        finally {
          if (this.startingRelay === current) this.startingRelay = null;
          if (this.relayErrorDuringStart === current) this.relayErrorDuringStart = null;
        }
      }
      if (this.isSession(generation) && this.player && isRelay(this.player)) await this.fallback(this.player, generation);
      else if (this.isSession(generation) && !this.player) this.startDirect(generation);
    })().finally(() => { this.recovery = null; });
    return this.recovery;
  }

  private async fallback(failed: RelayMediaPlayer, generation: number): Promise<void> {
    if (!this.isCurrent(generation, failed) || this.fallingBack) return;
    this.fallingBack = true;
    this.options.onRelayState?.("fallback");
    this.detach(failed);
    if (!await this.disposeRelay(failed)) { this.fallingBack = false; return; }
    if (this.closed || generation !== this.generation) return;
    this.options.onRelayState?.("unavailable");
    this.fallingBack = false;
    this.startDirect(generation);
  }

  private detach(player: MediaPlayer): void {
    player.setEventHandlers(null);
    if (this.player === player) this.player = null;
    this.options.onPlayer(null);
  }

  private async disposeRelay(player: RelayMediaPlayer): Promise<boolean> {
    const previous = this.disposal.get(player);
    if (previous) return previous;
    const task = this.disposeRelayOnce(player);
    this.disposal.set(player, task);
    const success = await task;
    if (success) this.ownedPlayers.delete(player);
    return success;
  }

  private async disposeRelayOnce(player: RelayMediaPlayer): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([player.close(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Playback cleanup timed out.")), this.cleanupTimeoutMs);
      })]);
      return true;
    } catch {
      this.options.onRelayState?.("cleanup-blocked");
      this.options.onState?.("error");
      // Do not open another provider stream while exclusive AVPlay release is unconfirmed.
      return false;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.preparationAbort.abort();
    ++this.generation;
    this.player = null;
    this.options.onPlayer(null);
    this.closePromise = this.cleanupOwnedPlayers();
    return this.closePromise;
  }

  /** Explicit retry after a bounded close failed; callers must keep other playback blocked until this resolves. */
  retryCleanup(): Promise<void> {
    this.closed = true;
    this.preparationAbort.abort();
    ++this.generation;
    this.ownedPlayers.forEach((player) => this.disposal.delete(player));
    this.closePromise = this.cleanupOwnedPlayers();
    return this.closePromise;
  }

  private async cleanupOwnedPlayers(): Promise<void> {
    const targets = [...this.ownedPlayers];
    const results = await Promise.all(targets.map(async (target) => {
      target.setEventHandlers(null);
      if (isRelay(target)) {
        const released = await this.disposeRelay(target);
        if (!released) throw new PlaybackCleanupError();
      }
      else {
        try { if (target.dispose) await disposeWithTimeout(target, this.cleanupTimeoutMs); else target.destroy(); }
        catch { throw new PlaybackCleanupError(); }
        this.ownedPlayers.delete(target);
      }
    }).map((task) => task.then(() => null, (error: unknown) => error)));
    const failure = results.find((result) => result !== null);
    if (failure) throw failure;
  }
}

export class PlaybackCleanupError extends Error {
  constructor() {
    super("The previous playback session could not be released. Playback is blocked until cleanup succeeds.");
    this.name = "PlaybackCleanupError";
  }
}

function isRelay(player: MediaPlayer): player is RelayMediaPlayer {
  return "start" in player && typeof player.start === "function" && "close" in player && typeof player.close === "function";
}

function disposeWithTimeout(player: MediaPlayer, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve().then(() => player.dispose!()),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Playback operation timed out.")), ms); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
