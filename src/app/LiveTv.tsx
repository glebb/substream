import { useEffect, useMemo, useRef, useState } from "react";
import { selectFinnishChannels, selectFinnishLiveCategories, type LiveCategory, type LiveChannel } from "../core/live/index.ts";
import { expectsEmbeddedLiveSubtitles, preferredEmbeddedSubtitleTrack } from "../core/subtitles/embedded.ts";
import { loadPlaylistUrl } from "../platform/browser/playlist-config.ts";
import { HtmlVideoPlayer } from "../platform/browser/html-video-player.ts";
import type { MediaPlayer, PlaybackState } from "../platform/media-player.ts";
import { isTizenAvPlayAvailable, TizenAvPlayPlayer } from "../platform/tizen/avplay-player.ts";
import { isBackKey, isTizenRuntime, normalizedRemoteKey } from "../platform/tizen/remote.ts";
import { XtreamClient } from "../platform/xtream/client.ts";

type Props = { onMainMenu(): void };
type CachedLive = { savedAt: number; categories: LiveCategory[]; channelsByCategory: Record<string, LiveChannel[]> };
const CACHE_PREFIX = "substream.live.v2.";
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const BROWSER_PLAYBACK_START_TIMEOUT_MS = 8_000;

function safeCache(key: string): CachedLive | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as CachedLive | null;
    return value && Array.isArray(value.categories) && value.channelsByCategory && typeof value.channelsByCategory === "object" && typeof value.savedAt === "number" ? value : null;
  } catch { return null; }
}

function categoryLabel(name: string): string {
  return name.replace(/^finland\s*[-:|]\s*/i, "").trim() || name;
}

export function LiveTv({ onMainMenu }: Props) {
  const playlistUrl = loadPlaylistUrl();
  const client = useMemo(() => XtreamClient.fromPlaylistUrl(playlistUrl), [playlistUrl]);
  const cacheKey = client ? CACHE_PREFIX + client.pairingFingerprint() : "";
  const cached = useMemo(() => cacheKey ? safeCache(cacheKey) : null, [cacheKey]);
  const [cacheSavedAt, setCacheSavedAt] = useState(cached?.savedAt ?? 0);
  const [categories, setCategories] = useState<LiveCategory[]>(cached?.categories ?? []);
  const [selectedCategory, setSelectedCategory] = useState<LiveCategory | null>(null);
  const [channels, setChannels] = useState<LiveChannel[]>([]);
  const [status, setStatus] = useState(cached ? "Showing saved categories while checking for updates…" : "Loading Finnish categories…");
  const [focusIndex, setFocusIndex] = useState(0);
  const [categoryFocusIndex, setCategoryFocusIndex] = useState(0);
  const [selected, setSelected] = useState<LiveChannel | null>(null);
  const [playerFullscreen, setPlayerFullscreen] = useState(false);
  const [playerControlIndex, setPlayerControlIndex] = useState(0);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("loading");
  const playbackStateRef = useRef<PlaybackState>("loading");
  const [liveSubtitleStatus, setLiveSubtitleStatus] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const objectRef = useRef<HTMLObjectElement | null>(null);
  const playerRef = useRef<MediaPlayer | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const categoryRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const mainMenuRef = useRef<HTMLButtonElement | null>(null);
  const categoriesButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerControlRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const requestedFullscreenExitRef = useRef(false);
  const requestRef = useRef(0);
  playbackStateRef.current = playbackState;

  function reconcileEmbeddedSubtitles(player: MediaPlayer | null, tracks: import("../platform/media-player.ts").EmbeddedSubtitleTrack[]): void {
    if (!player || playbackStateRef.current !== "playing") return;
    let remaining = [...tracks];
    while (remaining.length) {
      const preferred = preferredEmbeddedSubtitleTrack(remaining);
      if (!preferred) break;
      if (player.selectEmbeddedSubtitleTrack?.(preferred.id)) {
        const language = (preferred.language ?? preferred.label).trim().toLocaleLowerCase();
        setLiveSubtitleStatus(`Subtitles: ${language.startsWith("fi") || language.startsWith("fin") ? "Finnish" : "English"}`);
        return;
      }
      remaining = remaining.filter((track) => track.id !== preferred.id);
    }
    if (player.selectEmbeddedSubtitleTrack?.("off")) setLiveSubtitleStatus("Subtitles: off");
    else setLiveSubtitleStatus("Subtitles unavailable");
  }
  const isTizen = isTizenRuntime() || __SUBSTREAM_TV_UI_PREVIEW__;

  const saveCache = (nextCategories: LiveCategory[], categoryId?: string, nextChannels?: LiveChannel[]) => {
    if (!cacheKey) return;
    const previous = safeCache(cacheKey);
    const channelsByCategory = { ...(previous?.channelsByCategory ?? {}) };
    if (categoryId && nextChannels) channelsByCategory[categoryId] = nextChannels;
    const savedAt = Date.now();
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ savedAt, categories: nextCategories, channelsByCategory } satisfies CachedLive));
      setCacheSavedAt(savedAt);
    } catch { /* cache is optional */ }
  };

  const refreshCategories = async () => {
    const request = ++requestRef.current;
    if (!client) { setStatus("Live TV requires an Xtream-compatible playlist in Settings."); return; }
    if (!categories.length) setStatus("Loading Finnish categories…");
    try {
      const finnishCategories = selectFinnishLiveCategories(await client.liveCategories());
      if (request !== requestRef.current) return;
      setCategories(finnishCategories);
      setCategoryFocusIndex((index) => Math.min(index, Math.max(0, finnishCategories.length - 1)));
      setStatus(finnishCategories.length ? `${finnishCategories.length.toLocaleString()} Finnish categories ready` : "No Finnish categories were found at the provider.");
      saveCache(finnishCategories);
    } catch {
      if (request !== requestRef.current) return;
      setStatus(categories.length ? "Saved categories are available, but the provider refresh failed." : "Finnish categories could not be loaded. Check the TV network and playlist settings.");
    }
  };

  const openCategory = async (category: LiveCategory) => {
    const request = ++requestRef.current;
    const savedChannels = safeCache(cacheKey)?.channelsByCategory[category.id] ?? [];
    setSelectedCategory(category);
    setChannels(savedChannels);
    setFocusIndex(0);
    setStatus(savedChannels.length ? "Showing saved channels while checking for updates…" : `Loading ${categoryLabel(category.name)} channels…`);
    if (savedChannels.length) window.requestAnimationFrame(() => rowRefs.current[0]?.focus());
    if (!client) return;
    try {
      const streams = await client.liveStreams(category.id);
      const result = selectFinnishChannels([category], streams, [], client.pairingFingerprint());
      if (request !== requestRef.current) return;
      setChannels(result.channels);
      setStatus(result.channels.length ? `${result.channels.length.toLocaleString()} channels ready` : "No channels were found in this category.");
      saveCache(categories, category.id, result.channels);
      if (result.channels.length) window.requestAnimationFrame(() => rowRefs.current[0]?.focus());
    } catch {
      if (request !== requestRef.current) return;
      setStatus(savedChannels.length ? "Saved channels are available, but the provider refresh failed." : "This category could not be loaded. Check the TV network and playlist settings.");
    }
  };

  const leaveCategory = () => {
    requestRef.current += 1;
    setSelectedCategory(null);
    setChannels([]);
    setStatus(`${categories.length.toLocaleString()} Finnish categories ready`);
    window.requestAnimationFrame(() => categoryRefs.current[categoryFocusIndex]?.focus());
  };

  useEffect(() => { void refreshCategories(); return () => { requestRef.current += 1; }; }, [cacheKey]);

  useEffect(() => {
    if (selectedCategory || !categories.length) return;
    window.requestAnimationFrame(() => categoryRefs.current[categoryFocusIndex]?.focus());
  }, [categories.length, categoryFocusIndex, selectedCategory]);

  useEffect(() => {
    if (!selected || !client) return;
    const player = isTizenAvPlayAvailable() && objectRef.current ? new TizenAvPlayPlayer(objectRef.current, () => {}) : videoRef.current ? new HtmlVideoPlayer(videoRef.current) : null;
    if (!player) { setPlaybackState("error"); return; }
    playerRef.current = player;
    const subtitleMode = expectsEmbeddedLiveSubtitles(selected.name);
    if (!isTizen && expectsEmbeddedLiveSubtitles(selected.name)) {
      setLiveSubtitleStatus("Embedded subtitles unavailable in browser playback");
    }
    player.setLiveSubtitleMode?.(subtitleMode);
    player.setEventHandlers({
      onStateChange: setPlaybackState,
      onEmbeddedSubtitleTracksChange: (tracks) => reconcileEmbeddedSubtitles(player, tracks),
    });
    player.load(client.liveStreamUrl(selected.providerStreamId, isTizenAvPlayAvailable() ? "ts" : "m3u8"));
    return () => {
      player.setEventHandlers(null); player.destroy(); if (playerRef.current === player) playerRef.current = null;
    };
  }, [client, isTizen, retryCount, selected]);

  useEffect(() => {
    if (!selected || isTizenAvPlayAvailable()) return;
    const startupTimer = window.setTimeout(() => {
      const video = videoRef.current;
      const playbackIsAdvancing = !!video && !video.paused && video.readyState >= 2 && video.currentTime > 0;
      if (playbackIsAdvancing || playbackStateRef.current === "error") return;
      // Stop hls.js before a malformed or continuously busy transport stream
      // can monopolize Chromium's renderer. Retry starts another bounded attempt.
      const player = playerRef.current;
      player?.setEventHandlers(null);
      player?.destroy();
      if (playerRef.current === player) playerRef.current = null;
      setPlaybackState("error");
    }, BROWSER_PLAYBACK_START_TIMEOUT_MS);
    return () => window.clearTimeout(startupTimer);
  }, [selected?.id, retryCount]);

  useEffect(() => {
    if (!selected || playbackState !== "playing") return;
    reconcileEmbeddedSubtitles(playerRef.current, playerRef.current?.getEmbeddedSubtitleTracks?.() ?? []);
  }, [playbackState, selected]);

  useEffect(() => {
    if (!selected) return;
    const frame = window.requestAnimationFrame(() => playerRef.current?.resize());
    return () => window.cancelAnimationFrame(frame);
  }, [playerFullscreen, selected]);

  useEffect(() => {
    if (isTizen) return;
    const syncFullscreen = () => {
      const isFullscreen = document.fullscreenElement === document.documentElement;
      setPlayerFullscreen(isFullscreen);
      if (!isFullscreen && selected && !requestedFullscreenExitRef.current) {
        const index = Math.max(0, channels.findIndex((channel) => channel.id === selected.id));
        setSelected(null);
        setFocusIndex(index);
        window.requestAnimationFrame(() => rowRefs.current[index]?.focus());
      }
      requestedFullscreenExitRef.current = false;
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, [channels, isTizen, selected]);

  const tune = (channel: LiveChannel) => {
    setPlaybackState("loading");
    setRetryCount(0);
    setPlayerControlIndex(0);
    setLiveSubtitleStatus("Finding Finnish subtitles…");
    setPlayerFullscreen(true);
    if (!isTizen && !document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => undefined);
    setSelected(channel);
  };
  const changeChannel = (delta: number) => {
    if (!selected) return;
    const index = channels.findIndex((channel) => channel.id === selected.id);
    const next = channels[index + delta];
    if (next) tune(next);
  };
  const exitFullscreen = () => {
    setPlayerFullscreen(false);
    if (!isTizen && document.fullscreenElement) {
      requestedFullscreenExitRef.current = true;
      void document.exitFullscreen().catch(() => { requestedFullscreenExitRef.current = false; });
    }
  };
  const toggleFullscreen = () => {
    if (playerFullscreen) exitFullscreen();
    else {
      setPlayerFullscreen(true);
      if (!isTizen && !document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => undefined);
    }
  };
  const leavePlayer = () => {
    const index = Math.max(0, channels.findIndex((channel) => channel.id === selected?.id));
    exitFullscreen();
    setSelected(null); setFocusIndex(index);
    window.requestAnimationFrame(() => rowRefs.current[index]?.focus());
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = normalizedRemoteKey(event);
      if (isBackKey(event)) { event.preventDefault(); selected ? leavePlayer() : selectedCategory ? leaveCategory() : onMainMenu(); return; }
      if (selected) {
        if (key === "ArrowUp") { event.preventDefault(); changeChannel(-1); }
        else if (key === "ArrowDown") { event.preventDefault(); changeChannel(1); }
        else if (!playerFullscreen && (key === "ArrowLeft" || key === "ArrowRight")) {
          event.preventDefault();
          const controls = playerControlRefs.current.filter((control): control is HTMLButtonElement => !!control && !control.disabled);
          const activeIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
          const currentIndex = activeIndex >= 0 ? activeIndex : playerControlIndex;
          const next = Math.max(0, Math.min(controls.length - 1, currentIndex + (key === "ArrowLeft" ? -1 : 1)));
          setPlayerControlIndex(next); controls[next]?.focus();
        }
        return;
      }
      const itemCount = selectedCategory ? channels.length : categories.length;
      const currentIndex = selectedCategory ? focusIndex : categoryFocusIndex;
      const refs = selectedCategory ? rowRefs : categoryRefs;
      const activeElement = document.activeElement;
      const headerButtons = selectedCategory ? [categoriesButtonRef.current, mainMenuRef.current] : [mainMenuRef.current];
      const activeHeaderIndex = headerButtons.indexOf(activeElement as HTMLButtonElement);
      if (activeHeaderIndex >= 0) {
        if (key === "ArrowDown" && itemCount > 0) {
          event.preventDefault(); refs.current[currentIndex]?.focus();
        } else if (selectedCategory && (key === "ArrowLeft" || key === "ArrowRight")) {
          event.preventDefault();
          const next = Math.max(0, Math.min(headerButtons.length - 1, activeHeaderIndex + (key === "ArrowLeft" ? -1 : 1)));
          headerButtons[next]?.focus();
        }
        return;
      }
      if (key === "ArrowUp" || key === "ArrowDown") {
        event.preventDefault();
        if (key === "ArrowUp" && currentIndex === 0) {
          (selectedCategory ? categoriesButtonRef.current : mainMenuRef.current)?.focus();
          return;
        }
        const next = Math.max(0, Math.min(itemCount - 1, currentIndex + (key === "ArrowUp" ? -1 : 1)));
        selectedCategory ? setFocusIndex(next) : setCategoryFocusIndex(next); refs.current[next]?.focus(); refs.current[next]?.scrollIntoView({ block: "nearest" });
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
        event.preventDefault();
        const next = Math.max(0, Math.min(itemCount - 1, currentIndex + (key === "ArrowLeft" ? -10 : 10)));
        selectedCategory ? setFocusIndex(next) : setCategoryFocusIndex(next); refs.current[next]?.focus(); refs.current[next]?.scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [categories.length, categoryFocusIndex, channels, focusIndex, onMainMenu, playerControlIndex, playerFullscreen, selected, selectedCategory]);

  if (selected) {
    const selectedIndex = channels.findIndex((channel) => channel.id === selected.id);
    return <main className={`screen player-screen live-player-screen ${playerFullscreen ? "is-fullscreen" : ""}`}>
    <header className="app-header player-heading"><div><p className="eyebrow">LIVE TV</p><h1>{selected.name}</h1></div><span className="live-badge">LIVE</span></header>
    <div className="player-stage">
      {isTizenAvPlayAvailable() ? <object ref={objectRef} className="player tizen-player" type="application/avplayer" /> : <video ref={videoRef} className="player tizen-player" playsInline />}
      {playbackState === "loading" || playbackState === "buffering" ? <div className="buffering-overlay">Connecting…</div> : null}
      {playbackState === "error" && <div className="playback-error-overlay"><strong>Channel unavailable</strong><span>The stream could not be played on this device.</span></div>}
    </div>
    <div className="player-controls live-controls">
      <button type="button" disabled={selectedIndex <= 0} onClick={() => changeChannel(-1)} ref={(element) => { playerControlRefs.current[0] = element; }}>Previous channel</button>
      <button type="button" disabled={selectedIndex >= channels.length - 1} onClick={() => changeChannel(1)} ref={(element) => { playerControlRefs.current[1] = element; }}>Next channel</button>
      <button type="button" onClick={toggleFullscreen} ref={(element) => { playerControlRefs.current[2] = element; }}>{playerFullscreen ? "Exit full screen" : "Full screen"}</button>
      {playbackState === "error" && <button type="button" onClick={() => { setPlaybackState("loading"); setRetryCount((count) => count + 1); }} ref={(element) => { playerControlRefs.current[3] = element; }}>Retry</button>}
      <button type="button" onClick={leavePlayer} ref={(element) => { playerControlRefs.current[4] = element; }}>Back to channels</button>
      <span className="playback-status">{playbackState === "playing" ? liveSubtitleStatus || "Live" : playbackState === "error" ? "Error" : "Connecting"}</span>
    </div>
  </main>;
  }

  if (!selectedCategory) return <main className="screen live-screen">
    <header className="app-header"><div><p className="eyebrow">SUBSTREAM · LIVE TV</p><h1>Finland</h1></div><button type="button" onClick={onMainMenu} ref={mainMenuRef}>Main menu</button></header>
    <p className="hint" role="status" aria-live="polite">{status}{cacheSavedAt && Date.now() - cacheSavedAt > STALE_AFTER_MS ? " · Saved list may be out of date." : ""}</p>
    <div className="live-list">
      {categories.map((category, index) => <button className={`live-row live-category-row ${index === categoryFocusIndex ? "remote-focused" : ""}`} type="button" key={category.id} ref={(element) => { categoryRefs.current[index] = element; }} onFocus={() => setCategoryFocusIndex(index)} onClick={() => void openCategory(category)}>
        <span className="live-category-mark" aria-hidden="true">●</span><strong>{categoryLabel(category.name)}</strong><span className="live-category-arrow" aria-hidden="true">›</span>
      </button>)}
      {!categories.length && !status.startsWith("Loading") && <div className="empty-state"><h2>No Finnish categories</h2><p>The provider did not return any matching Finland categories.</p><button type="button" onClick={() => void refreshCategories()}>Refresh</button></div>}
    </div>
  </main>;

  return <main className="screen live-screen">
    <header className="app-header"><div><p className="eyebrow">SUBSTREAM · LIVE TV · FINLAND</p><h1>{categoryLabel(selectedCategory.name)}</h1></div><div className="header-actions"><button type="button" onClick={leaveCategory} ref={categoriesButtonRef}>Categories</button><button type="button" onClick={onMainMenu} ref={mainMenuRef}>Main menu</button></div></header>
    <p className="hint" role="status" aria-live="polite">{status}</p>
    <div className="live-list">
      {channels.map((channel, index) => <button className={`live-row ${index === focusIndex ? "remote-focused" : ""}`} type="button" key={channel.id} ref={(element) => { rowRefs.current[index] = element; }} onFocus={() => setFocusIndex(index)} onClick={() => tune(channel)}>
        <span className="live-logo">{channel.logo ? <img src={channel.logo} alt="" loading="lazy" /> : channel.name.charAt(0).toLocaleUpperCase()}</span>
        <strong>{channel.name}</strong>{channel.variant && <span className="live-variant">{channel.variant}</span>}
      </button>)}
      {!channels.length && !status.startsWith("Loading") && <div className="empty-state"><h2>No channels</h2><p>Refresh this category to try again.</p><button type="button" onClick={() => void openCategory(selectedCategory)}>Refresh</button></div>}
    </div>
  </main>;
}
