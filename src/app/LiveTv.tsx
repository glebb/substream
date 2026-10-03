import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { attachDnaFallback, fillMissingGuideSlots, matchDnaChannel, selectCurrentAndNextProgramme, selectFinnishChannels, selectFinnishLiveCategories, type EpgProgramme, type LiveCategory, type LiveChannel } from "../core/live/index.ts";
import { preferredEmbeddedSubtitleTrack } from "../core/subtitles/embedded.ts";
import { preferredAudioTrackIndex } from "../core/media/audio.ts";
import { loadPlaylistUrl } from "../platform/browser/playlist-config.ts";
import { HtmlVideoPlayer } from "../platform/browser/html-video-player.ts";
import type { AudioTrack, LiveBufferWindow, MediaPlayer, PlaybackState } from "../platform/media-player.ts";
import { isTizenAvPlayAvailable, TizenAvPlayPlayer } from "../platform/tizen/avplay-player.ts";
import { TizenLiveRelayPlayer } from "../platform/tizen/live-relay-player.ts";
import { loadLiveRelayConfig, relayChannelId } from "../platform/live-relay/config.ts";
import { isBackKey, isTizenRuntime, normalizedRemoteKey } from "../platform/tizen/remote.ts";
import { XtreamClient } from "../platform/xtream/client.ts";
import { DnaGuideClient } from "../platform/dna/client.ts";
import { NordicSkyShowtimeEpgClient, nordicGuideSourceUrl, skyShowtimeNordicXmltvId } from "../platform/nordic/skyshowtime-epg.ts";
import { companionServerUrl } from "../platform/companion/client.ts";
import { focusTitleListItem } from "./title-list-focus.ts";
import { loadSubtitlePreferences } from "../platform/browser/subtitle-preferences.ts";
import { LanguageContext, Localized } from "./language.tsx";

type Props = { onMainMenu(): void };
type CachedLive = { savedAt: number; categories: LiveCategory[]; channelsByCategory: Record<string, LiveChannel[]> };
const CACHE_PREFIX = "substream.live.v2.";
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const BROWSER_PLAYBACK_START_TIMEOUT_MS = 8_000;
const EPG_CACHE_PREFIX = "substream.epg.v1.";
const DNA_EPG_CACHE_PREFIX = "substream.dna-epg.v1.";
const EPG_CACHE_TTL_MS = 12 * 60 * 1000;
const EPG_CONCURRENCY = 4;
const EPG_LIMIT = 10;

type CachedGuide = { savedAt: number; programmes: EpgProgramme[]; dnaAttemptAt?: number };
type CachedDnaGuide = { savedAt: number; programmes: EpgProgramme[] };

function safeGuideCache(key: string): CachedGuide | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as CachedGuide | null;
    return value && typeof value.savedAt === "number" && Array.isArray(value.programmes) ? value : null;
  } catch { return null; }
}

function safeDnaGuideCache(key: string, now: number): CachedDnaGuide | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as CachedDnaGuide | null;
    return value && typeof value.savedAt === "number" && Array.isArray(value.programmes)
      && now - value.savedAt < EPG_CACHE_TTL_MS ? value : null;
  } catch { return null; }
}

function dnaGuideCacheKey(channelId: string, now: number): string {
  const windowMs = 6 * 60 * 60 * 1000;
  return `${DNA_EPG_CACHE_PREFIX}${channelId}.${Math.floor(now / windowMs)}`;
}

function guideIsFresh(guide: CachedGuide, now: number): boolean {
  const programmeAtFetch = guide.programmes.find((item) => item.startTime <= guide.savedAt && item.endTime > guide.savedAt);
  return now - guide.savedAt < EPG_CACHE_TTL_MS && (!programmeAtFetch || now < programmeAtFetch.endTime);
}

function programmeTime(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function programmeProgress(programme: EpgProgramme, now: number): number {
  const duration = programme.endTime - programme.startTime;
  return duration > 0 ? Math.max(0, Math.min(100, (now - programme.startTime) / duration * 100)) : 0;
}

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
  const { language } = useContext(LanguageContext);
  const playlistUrl = loadPlaylistUrl();
  const client = useMemo(() => XtreamClient.fromPlaylistUrl(playlistUrl), [playlistUrl]);
  const dnaClient = useMemo(() => new DnaGuideClient(), []);
  const nordicEpgClient = useMemo(() => {
    const sourceUrl = nordicGuideSourceUrl({
      isTizen: isTizenRuntime(),
      relayUrl: companionServerUrl(),
      development: import.meta.env.DEV,
    });
    return new NordicSkyShowtimeEpgClient(undefined, sourceUrl);
  }, []);
  const cacheKey = client ? CACHE_PREFIX + client.pairingFingerprint() : "";
  const cached = useMemo(() => cacheKey ? safeCache(cacheKey) : null, [cacheKey]);
  const [cacheSavedAt, setCacheSavedAt] = useState(cached?.savedAt ?? 0);
  const [categories, setCategories] = useState<LiveCategory[]>(cached?.categories ?? []);
  const [selectedCategory, setSelectedCategory] = useState<LiveCategory | null>(null);
  const [channels, setChannels] = useState<LiveChannel[]>([]);
  const [status, setStatus] = useState(cached ? "Showing saved categories while checking for updates…" : "Loading Finnish categories…");
  const [focusIndex, setFocusIndex] = useState(0);
  const [guideByChannel, setGuideByChannel] = useState<Record<string, CachedGuide>>({});
  const [guideFailures, setGuideFailures] = useState<Record<string, boolean>>({});
  const [logoFailures, setLogoFailures] = useState<Record<string, { providerFailed?: boolean; dnaFailed?: boolean }>>({});
  const [guideNow, setGuideNow] = useState(() => Date.now());
  const [guideRefresh, setGuideRefresh] = useState(0);
  const [categoryFocusIndex, setCategoryFocusIndex] = useState(0);
  const [selected, setSelected] = useState<LiveChannel | null>(null);
  const [playerFullscreen, setPlayerFullscreen] = useState(false);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("loading");
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  const [liveBufferWindow, setLiveBufferWindow] = useState<LiveBufferWindow | null>(null);
  const playbackStateRef = useRef<PlaybackState>("loading");
  const [liveSubtitleStatus, setLiveSubtitleStatus] = useState("");
  const [liveSubtitlesEnabled, setLiveSubtitlesEnabled] = useState(true);
  const [embeddedSubtitleTracks, setEmbeddedSubtitleTracks] = useState<import("../platform/media-player.ts").EmbeddedSubtitleTrack[]>([]);
  const [liveSource, setLiveSource] = useState<"hls" | "ts">("hls");
  const liveSubtitlesEnabledRef = useRef(true);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [audioStatus, setAudioStatus] = useState("");
  const [relayPlaybackLabel, setRelayPlaybackLabel] = useState("");
  const [relayFailureMessage, setRelayFailureMessage] = useState("");
  const [relayDiagnostics, setRelayDiagnostics] = useState("");
  const previousPlayerTeardown = useRef<Promise<void>>(Promise.resolve());
  const subtitleSelectionManualRef = useRef(false);
  const [showLiveHint, setShowLiveHint] = useState(false);
  const liveHintTimerRef = useRef<number | null>(null);
  const audioSelectionManualRef = useRef(false);
  const [retryCount, setRetryCount] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const objectRef = useRef<HTMLObjectElement | null>(null);
  const playerStageRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<MediaPlayer | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const categoryRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listViewportRef = useRef<HTMLDivElement | null>(null);
  const mainMenuRef = useRef<HTMLButtonElement | null>(null);
  const categoriesButtonRef = useRef<HTMLButtonElement | null>(null);
  const emptyRefreshRef = useRef<HTMLButtonElement | null>(null);
  const focusListItem = (element: HTMLButtonElement | null) => {
    if (isTizenRuntime()) focusTitleListItem(element, listViewportRef.current);
    else element?.focus();
  };
  const playerControlRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const requestedFullscreenExitRef = useRef(false);
  const requestRef = useRef(0);
  playbackStateRef.current = playbackState;

  function reconcileEmbeddedSubtitles(player: MediaPlayer | null, tracks: import("../platform/media-player.ts").EmbeddedSubtitleTrack[]): void {
    if (!player || playbackStateRef.current !== "playing") return;
    if (!liveSubtitlesEnabledRef.current) {
      player.selectEmbeddedSubtitleTrack?.("off");
      setLiveSubtitleStatus("Subtitles: Off");
      return;
    }
    if (subtitleSelectionManualRef.current) {
      const active = tracks.find((track) => track.selected);
      if (active) { setLiveSubtitleStatus(`Subtitles: ${active.label}`); return; }
    }
    let remaining = [...tracks];
    while (remaining.length) {
      const preferred = preferredEmbeddedSubtitleTrack(remaining, loadSubtitlePreferences().languagePreference);
      if (!preferred) break;
      if (player.selectEmbeddedSubtitleTrack?.(preferred.id)) {
        const language = (preferred.language ?? preferred.label).trim().toLocaleLowerCase();
        setLiveSubtitleStatus(`Subtitles: ${language.startsWith("fi") || language.startsWith("fin") ? "Finnish" : "English"}${player instanceof TizenLiveRelayPlayer ? " · Timing test" : ""}`);
        return;
      }
      remaining = remaining.filter((track) => track.id !== preferred.id);
    }
    if (player instanceof TizenLiveRelayPlayer) {
      setLiveSubtitleStatus(player.getRelaySubtitleStatus());
      return;
    }
    if (player instanceof TizenAvPlayPlayer) {
      const status = player.getLiveDvbSubtitleStatus();
      if (status === "DVB subtitle stream unavailable") {
        setLiveSubtitleStatus("DVB subtitle stream unavailable");
        return;
      }
      if (status === "DVB subtitle scan not started" || status === "DVB subtitle feed not configured") {
        setLiveSubtitleStatus(`AVPlay has no subtitle track · DVB scan off · ${player.getLiveAudioMetadataStatus()}`);
        return;
      }
    }
    player.selectEmbeddedSubtitleTrack?.("off");
    setLiveSubtitleStatus(`Subtitles unavailable${player instanceof TizenAvPlayPlayer ? ` · ${player.getTrackDiagnostics()}` : ""}`);
  }
  function reconcileAudioTracks(player: MediaPlayer | null, tracks: AudioTrack[]): void {
    if (!player) return;
    if (!tracks.length) {
      if (!audioSelectionManualRef.current) setAudioTracks([]);
      return;
    }
    if (audioSelectionManualRef.current) {
      setAudioTracks(tracks);
      if (player instanceof TizenAvPlayPlayer && !tracks.some((track) => /^(fi|fin)$/i.test(track.language ?? ""))) {
        setAudioStatus(`Finnish audio unavailable · ${player.getLiveAudioMetadataStatus()}`);
      }
      return;
    }
    if (player.isAudioTrackSelectionPending?.()) {
      setAudioTracks(tracks);
      return;
    }
    const streamDefaultIndex = tracks.findIndex((track) => track.selected);
    const preferred = tracks[preferredAudioTrackIndex(tracks, streamDefaultIndex)];
    if (preferred && !preferred.selected && player.selectAudioTrack?.(preferred.id)) {
      setAudioTracks(tracks.map((track) => ({ ...track, selected: track.id === preferred.id })));
    } else setAudioTracks(tracks);
    if (player instanceof TizenAvPlayPlayer && !tracks.some((track) => /^(fi|fin)$/i.test(track.language ?? ""))) {
      setAudioStatus(`Finnish audio unavailable · ${player.getLiveAudioMetadataStatus()}`);
    }
  }
  const isTizen = isTizenRuntime() || __SUBSTREAM_TV_UI_PREVIEW__;

  const hideLiveHint = () => {
    if (liveHintTimerRef.current !== null) window.clearTimeout(liveHintTimerRef.current);
    liveHintTimerRef.current = null;
    setShowLiveHint(false);
  };
  const showLiveHintBriefly = () => {
    if (liveHintTimerRef.current !== null) window.clearTimeout(liveHintTimerRef.current);
    setShowLiveHint(true);
    liveHintTimerRef.current = window.setTimeout(() => {
      liveHintTimerRef.current = null;
      setShowLiveHint(false);
    }, 5_000);
  };
  useEffect(() => () => {
    if (liveHintTimerRef.current !== null) window.clearTimeout(liveHintTimerRef.current);
  }, []);

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
      window.requestAnimationFrame(() => {
        if (document.activeElement === mainMenuRef.current || document.activeElement === document.body) {
          if (finnishCategories.length) focusListItem(categoryRefs.current[0] ?? null);
          else emptyRefreshRef.current?.focus();
        }
      });
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
    if (savedChannels.length) window.requestAnimationFrame(() => focusListItem(rowRefs.current[0] ?? null));
    if (!client) return;
    try {
      const streams = await client.liveStreams(category.id);
      const result = selectFinnishChannels([category], streams, [], client.pairingFingerprint());
      if (request !== requestRef.current) return;
      setChannels(result.channels);
      setStatus(result.channels.length ? `${result.channels.length.toLocaleString()} channels ready` : "No channels were found in this category.");
      saveCache(categories, category.id, result.channels);
      if (result.channels.length) window.requestAnimationFrame(() => focusListItem(rowRefs.current[0] ?? null));
      void dnaClient.channels().then((dnaCatalog) => {
        if (request !== requestRef.current) return;
        const enriched = result.channels.map((channel) => attachDnaFallback(channel, matchDnaChannel(channel, dnaCatalog)));
        if (request !== requestRef.current) return;
        setChannels(enriched);
        saveCache(categories, category.id, enriched);
      }).catch(() => { /* DNA guide is an optional fallback */ });
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
    window.requestAnimationFrame(() => focusListItem(categoryRefs.current[categoryFocusIndex] ?? null));
  };

  useEffect(() => {
    if (selected || selectedCategory) return;
    window.requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      if (categories.length) focusListItem(categoryRefs.current[categoryFocusIndex] ?? null);
      else mainMenuRef.current?.focus();
    });
  }, []);
  useEffect(() => { void refreshCategories(); return () => { requestRef.current += 1; }; }, [cacheKey]);

  useLayoutEffect(() => {
    if (!selectedCategory || !channels.length) return;
    const activeElement = document.activeElement;
    if (activeElement === document.body || !(activeElement instanceof HTMLElement) || !activeElement.isConnected) {
      focusListItem(rowRefs.current[focusIndex] ?? null);
    }
  }, [channels.length, focusIndex, selectedCategory?.id]);

  useEffect(() => {
    if (!selectedCategory || !channels.length || !client) return;
    let cancelled = false;
    const cachePrefix = EPG_CACHE_PREFIX + client.pairingFingerprint() + ".";
    const initial: Record<string, CachedGuide> = {};
    channels.forEach((channel) => {
      const cachedGuide = safeGuideCache(cachePrefix + channel.providerStreamId);
      if (cachedGuide) initial[channel.id] = cachedGuide;
    });
    setGuideByChannel((previous) => ({ ...previous, ...initial }));
    setGuideFailures({});

    const missing = channels
      .map((channel, index) => ({ channel, index }))
      .filter(({ channel }) => {
        const guide = initial[channel.id];
        const now = Date.now();
        if (!guide) return true;
        const slots = selectCurrentAndNextProgramme(guide.programmes, now);
        // A partial cached guide for a Nordic channel may have been stored
        // while its direct/proxied public-feed request was unavailable.
        if (skyShowtimeNordicXmltvId(channel) && (!slots.current || !slots.next)) return true;
        if (!channel.dnaChannelId) return !guideIsFresh(guide, now);
        if (!slots.current || !slots.next) {
          return !guideIsFresh(guide, now)
            || !guide.dnaAttemptAt || now - guide.dnaAttemptAt >= EPG_CACHE_TTL_MS;
        }
        return !guideIsFresh(guide, now);
      })
      .sort((left, right) => Math.abs(left.index - focusIndex) - Math.abs(right.index - focusIndex));
    let cursor = 0;
    const worker = async () => {
      while (!cancelled && cursor < missing.length) {
        const item = missing[cursor++];
        if (!item) return;
        const { channel } = item;
        try {
          let programmes: EpgProgramme[] = [];
          let dnaAttemptAt: number | undefined;
          const nordicXmltvId = skyShowtimeNordicXmltvId(channel);
          if (nordicXmltvId) {
            try { programmes = await nordicEpgClient.schedule(nordicXmltvId, channel.providerStreamId); }
            catch { try { programmes = await client.shortEpg(channel.providerStreamId, EPG_LIMIT); } catch { /* guide remains unavailable */ } }
          } else {
            try { programmes = await client.shortEpg(channel.providerStreamId, EPG_LIMIT); } catch { /* continue to DNA fallback */ }
          }
          const slotsAfterNordicFallback = selectCurrentAndNextProgramme(programmes, Date.now());
          if (channel.dnaChannelId && (!slotsAfterNordicFallback.current || !slotsAfterNordicFallback.next)) {
            dnaAttemptAt = Date.now();
            try {
              const now = Date.now();
              const dnaCacheKey = dnaGuideCacheKey(channel.dnaChannelId, now);
              const cachedDnaGuide = safeDnaGuideCache(dnaCacheKey, now);
              let fallback: EpgProgramme[];
              if (cachedDnaGuide) fallback = cachedDnaGuide.programmes;
              else {
                const windowMs = 6 * 60 * 60 * 1000;
                const start = Math.floor(now / windowMs) * windowMs - windowMs;
                fallback = await dnaClient.schedule(channel.dnaChannelId, start, start + 24 * 60 * 60 * 1000);
                try { localStorage.setItem(dnaCacheKey, JSON.stringify({ savedAt: Date.now(), programmes: fallback } satisfies CachedDnaGuide)); } catch { /* guide cache is optional */ }
              }
              programmes = fillMissingGuideSlots(programmes, fallback, Date.now());
            } catch { /* provider guide remains usable when DNA is unavailable */ }
          }
          if (cancelled) return;
          const guide: CachedGuide = { savedAt: Date.now(), programmes, ...(dnaAttemptAt ? { dnaAttemptAt } : {}) };
          setGuideByChannel((previous) => ({ ...previous, [channel.id]: guide }));
          setGuideFailures((previous) => ({ ...previous, [channel.id]: false }));
          try { localStorage.setItem(cachePrefix + channel.providerStreamId, JSON.stringify(guide)); } catch { /* guide cache is optional */ }
        } catch {
          if (cancelled) return;
          setGuideFailures((previous) => ({ ...previous, [channel.id]: true }));
        }
      }
    };
    for (let workerIndex = 0; workerIndex < Math.min(EPG_CONCURRENCY, missing.length); workerIndex += 1) void worker();
    return () => { cancelled = true; };
  }, [cacheKey, channels, client, guideRefresh, nordicEpgClient, selectedCategory]);

  useEffect(() => {
    const timer = window.setInterval(() => setGuideNow(Date.now()), 30_000);
    const onResume = () => {
      if (document.visibilityState === "visible") {
        setGuideNow(Date.now());
        setGuideRefresh((value) => value + 1);
      }
    };
    document.addEventListener("visibilitychange", onResume);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onResume); };
  }, []);

  useEffect(() => {
    if (!selectedCategory || !channels.length) return;
    let nextEnd = Infinity;
    channels.forEach((channel) => {
      (guideByChannel[channel.id]?.programmes ?? []).forEach((programme) => {
        if (programme.endTime > guideNow) nextEnd = Math.min(nextEnd, programme.endTime);
      });
    });
    if (!Number.isFinite(nextEnd)) return;
    const timer = window.setTimeout(() => {
      setGuideNow(Date.now());
      setGuideRefresh((value) => value + 1);
    }, Math.max(1_000, nextEnd - guideNow + 500));
    return () => window.clearTimeout(timer);
  }, [channels, guideByChannel, guideNow, selectedCategory]);

  useEffect(() => {
    if (selectedCategory || !categories.length) return;
    window.requestAnimationFrame(() => focusListItem(categoryRefs.current[categoryFocusIndex] ?? null));
  }, [categories.length, categoryFocusIndex, selectedCategory]);

  useEffect(() => {
    if (!selected || !client) return;
    setHasStartedPlayback(false);
    audioSelectionManualRef.current = false;
    subtitleSelectionManualRef.current = false;
    setEmbeddedSubtitleTracks([]);
    setAudioTracks([]);
    setRelayPlaybackLabel("");
    setRelayFailureMessage("");
    setRelayDiagnostics("");
    let cancelled = false;
    let player: MediaPlayer | null = null;
    let fallingBack = false;
    let relayRecovery: Promise<void> | null = null;
    let relayErrorDuringRecovery: TizenLiveRelayPlayer | null = null;
    let relayReconnects = 0;
    let relayHasPlayed = false;
    let diagnosticTimer: ReturnType<typeof setInterval> | undefined;
    const config = loadLiveRelayConfig();
    const hostedChannelId = config ? relayChannelId(config, selected.providerStreamId, selected.name) : null;
    const bind = (active: MediaPlayer) => {
      player = active;
      playerRef.current = active;
      active.setLiveSubtitleMode?.(true);
      active.setEventHandlers({
      onStateChange: (state) => {
        if (cancelled || playerRef.current !== active) return;
        if (state === "error" && active instanceof TizenLiveRelayPlayer) {
          if (relayRecovery) { relayErrorDuringRecovery = active; return; }
          if (relayHasPlayed || relayReconnects > 0) { void recoverRelay(active); return; }
          void fallBack(active);
          return;
        }
        const wasPlaying = playbackStateRef.current === "playing";
        playbackStateRef.current = state;
        setPlaybackState(state);
        if (state === "playing") {
          if (fallingBack) setRelayPlaybackLabel("Playing directly · Subtitles may be unavailable");
          if (active instanceof TizenLiveRelayPlayer) relayHasPlayed = true;
          setHasStartedPlayback(true);
          if (!wasPlaying) reconcileAudioTracks(active, active.getAudioTracks?.() ?? []);
        }
        if (state === "playing") reconcileEmbeddedSubtitles(active, active.getEmbeddedSubtitleTracks?.() ?? []);
      },
      onProgress: () => { if (!cancelled && playerRef.current === active && active instanceof TizenLiveRelayPlayer) relayHasPlayed = true; },
      onLiveBufferWindowChange: (value) => { if (!cancelled && playerRef.current === active) setLiveBufferWindow(value); },
      onEmbeddedSubtitleTracksChange: (tracks) => {
        if (cancelled || playerRef.current !== active) return;
        setEmbeddedSubtitleTracks(tracks); reconcileEmbeddedSubtitles(active, tracks);
      },
      onAudioTracksChange: (tracks) => { if (!cancelled && playerRef.current === active) reconcileAudioTracks(active, tracks); },
      });
    };
    const startDirect = () => {
      if (cancelled) return;
      const direct: MediaPlayer | null = isTizenAvPlayAvailable() && objectRef.current ? new TizenAvPlayPlayer(objectRef.current, () => {})
        : videoRef.current ? new HtmlVideoPlayer(videoRef.current) : null;
      if (!direct) { setPlaybackState("error"); return; }
      bind(direct);
      // Avoid a second provider connection while recovering a broken live stream.
      if (liveSource === "hls" && !fallingBack) direct.setLiveAudioMetadataUrl?.(client.liveStreamUrl(selected.providerStreamId, "ts"));
      direct.load(client.liveStreamUrl(selected.providerStreamId, liveSource === "hls" ? "m3u8" : "ts"));
    };
    const makeRelay = (): TizenLiveRelayPlayer => {
      relayHasPlayed = false;
      const hosted = new TizenLiveRelayPlayer(objectRef.current!, config!, hostedChannelId!, {
        mediaToPlayheadOffsetMs: config?.offsetMs ?? 0,
        preferredLanguage: loadSubtitlePreferences().languagePreference,
      });
      bind(hosted);
      if (diagnosticTimer !== undefined) clearInterval(diagnosticTimer);
      if (config?.diagnosticsEnabled) diagnosticTimer = setInterval(() => {
        if (!cancelled && player === hosted) setRelayDiagnostics(hosted.getRelayDiagnostics());
      }, 500);
      return hosted;
    };
    const resetRelayPlaybackState = () => {
      playbackStateRef.current = "loading";
      setPlaybackState("loading");
      setHasStartedPlayback(false);
      setLiveBufferWindow(null);
      setEmbeddedSubtitleTracks([]);
      setAudioTracks([]);
      setAudioStatus("");
      setLiveSubtitleStatus("");
      setRelayDiagnostics("");
    };
    async function fallBack(failed: TizenLiveRelayPlayer): Promise<void> {
      if (cancelled || fallingBack || player !== failed) return;
      fallingBack = true;
      failed.setEventHandlers(null);
      if (diagnosticTimer !== undefined) clearInterval(diagnosticTimer);
      setRelayDiagnostics("");
      setRelayFailureMessage("The subtitle service could not load this channel, and direct playback failed. Select Retry or try another channel.");
      setRelayPlaybackLabel("Channel connection failed · Stopping the previous stream…");
      try { await failed.close(); }
      catch {
        if (!cancelled) {
          setRelayPlaybackLabel("Could not stop the previous stream");
          setRelayFailureMessage("The previous stream could not be stopped. Wait a minute, then select Retry.");
          setPlaybackState("error");
        }
        return;
      }
      if (cancelled) return;
      setRelayPlaybackLabel("Subtitle service unavailable · Trying direct playback…");
      setEmbeddedSubtitleTracks([]);
      startDirect();
    }
    async function recoverRelay(failed: TizenLiveRelayPlayer): Promise<void> {
      if (cancelled || fallingBack || player !== failed) return;
      if (relayRecovery) return relayRecovery;
      relayRecovery = (async () => {
        let current = failed;
        while (!cancelled && relayReconnects < 2) {
          relayReconnects += 1;
          current.setEventHandlers(null);
          if (diagnosticTimer !== undefined) clearInterval(diagnosticTimer);
          diagnosticTimer = undefined;
          resetRelayPlaybackState();
          setRelayPlaybackLabel("Channel connection lost · Reconnecting…");
          try { await current.close(); }
          catch {
            if (!cancelled) {
              setRelayPlaybackLabel("Could not stop the previous stream");
              setRelayFailureMessage("The previous stream could not be stopped. Wait a minute, then select Retry.");
              playbackStateRef.current = "error";
              setPlaybackState("error");
            }
            return;
          }
          if (cancelled) return;
          if (!config || !hostedChannelId || !isTizenAvPlayAvailable() || !objectRef.current) break;
          try {
            current = makeRelay();
            await current.start();
            if (cancelled) return;
            if (relayErrorDuringRecovery === current) {
              relayErrorDuringRecovery = null;
              throw new Error("Relay playback failed while reconnecting.");
            }
            setRelayPlaybackLabel("Subtitle relay · Timing test");
            return;
          } catch {
            // start() may report an error through its event handler as well; the
            // recovery promise guard prevents that callback from starting a peer.
            if (cancelled) return;
            if (relayErrorDuringRecovery === current) relayErrorDuringRecovery = null;
          }
        }
        if (!cancelled && player === current) await fallBack(current);
        else if (!cancelled && player === failed) await fallBack(failed);
      })().finally(() => {
        relayRecovery = null;
        const lateFailedRelay = relayErrorDuringRecovery;
        relayErrorDuringRecovery = null;
        if (lateFailedRelay && !cancelled && player === lateFailedRelay) void recoverRelay(lateFailedRelay);
      });
      return relayRecovery;
    }
    void previousPlayerTeardown.current.then(async () => {
      if (cancelled) return;
      if (config?.enabled && hostedChannelId && isTizenAvPlayAvailable() && objectRef.current) {
        const hosted = makeRelay();
        setRelayPlaybackLabel("Subtitle relay · Timing test");
        try { await hosted.start(); }
        catch { await fallBack(hosted); }
      } else startDirect();
    }).catch(() => { if (!cancelled) setPlaybackState("error"); });
    return () => {
      cancelled = true;
      if (diagnosticTimer !== undefined) clearInterval(diagnosticTimer);
      player?.setEventHandlers(null);
      if (player instanceof TizenLiveRelayPlayer) {
        const closing = player.close().catch(() => undefined);
        previousPlayerTeardown.current = Promise.all([previousPlayerTeardown.current, closing, relayRecovery ?? Promise.resolve()]).then(() => undefined);
      } else player?.destroy();
      if (playerRef.current === player) playerRef.current = null;
    };
  }, [client, isTizen, liveSource, retryCount, selected]);

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
        window.requestAnimationFrame(() => focusListItem(rowRefs.current[index] ?? null));
      }
      requestedFullscreenExitRef.current = false;
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, [channels, isTizen, selected]);

  const tune = (channel: LiveChannel) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setPlaybackState("loading");
    setRetryCount(0);
    setLiveSubtitleStatus(liveSubtitlesEnabledRef.current ? "Finding Finnish subtitles…" : "Subtitles: Off");
    setEmbeddedSubtitleTracks([]);
    setAudioTracks([]);
    setAudioStatus("");
    showLiveHintBriefly();
    setLiveBufferWindow(null);
    setPlayerFullscreen(true);
    if (!isTizen && !document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => undefined);
    setSelected(channel);
    window.requestAnimationFrame(() => playerStageRef.current?.focus());
  };
  const changeChannel = (delta: number) => {
    if (!selected) return;
    const index = channels.findIndex((channel) => channel.id === selected.id);
    const next = channels[index + delta];
    if (next) tune(next);
  };
  const exitFullscreen = () => {
    setPlayerFullscreen(false);
    hideLiveHint();
    if (!isTizen && document.fullscreenElement) {
      requestedFullscreenExitRef.current = true;
      void document.exitFullscreen().catch(() => { requestedFullscreenExitRef.current = false; });
    }
  };
  const toggleFullscreen = () => {
    if (playerFullscreen) exitFullscreen();
    else {
      setPlayerFullscreen(true);
      showLiveHintBriefly();
      if (!isTizen && !document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => undefined);
      window.requestAnimationFrame(() => playerStageRef.current?.focus());
    }
  };
  const showControls = () => {
    exitFullscreen();
    window.requestAnimationFrame(() => playerControlRefs.current[7]?.focus());
  };
  const leavePlayer = () => {
    const index = Math.max(0, channels.findIndex((channel) => channel.id === selected?.id));
    exitFullscreen();
    setSelected(null); setFocusIndex(index);
    setLiveBufferWindow(null);
    window.requestAnimationFrame(() => focusListItem(rowRefs.current[index] ?? null));
  };
  const selectNextAudioTrack = () => {
    const player = playerRef.current;
    const tracks = player?.getAudioTracks?.() ?? [];
    if (!tracks.length) {
      setAudioStatus(playbackState === "loading" || playbackState === "buffering" ? "Audio tracks are loading…" : `Audio tracks unavailable${player instanceof TizenAvPlayPlayer ? ` · ${player.getTrackDiagnostics()}` : ""}`);
      return;
    }
    const selectedIndex = tracks.findIndex((track) => track.selected);
    const next = tracks[(selectedIndex + 1) % tracks.length];
    const wasManual = audioSelectionManualRef.current;
    audioSelectionManualRef.current = true;
    if (!next || !player?.selectAudioTrack?.(next.id)) {
      audioSelectionManualRef.current = wasManual;
      setAudioStatus("Audio track could not be changed.");
      return;
    }
    setAudioTracks(tracks.map((track) => ({ ...track, selected: track.id === next.id })));
    setAudioStatus(`Audio: ${next.label}`);
  };
  const toggleLiveSubtitles = () => {
    const enabled = !liveSubtitlesEnabledRef.current;
    liveSubtitlesEnabledRef.current = enabled;
    setLiveSubtitlesEnabled(enabled);
    const player = playerRef.current;
    if (!enabled) {
      player?.selectEmbeddedSubtitleTrack?.("off");
      setLiveSubtitleStatus("Subtitles: Off");
    } else {
      setLiveSubtitleStatus("Finding Finnish subtitles…");
      reconcileEmbeddedSubtitles(player, player?.getEmbeddedSubtitleTracks?.() ?? []);
    }
  };
  const selectNextSubtitleTrack = () => {
    const player = playerRef.current;
    const tracks = player?.getEmbeddedSubtitleTracks?.() ?? [];
    if (!player || !tracks.length) return;
    const current = tracks.findIndex((track) => track.selected);
    const next = tracks[(current + 1) % tracks.length];
    const previouslyManual = subtitleSelectionManualRef.current;
    const previouslyEnabled = liveSubtitlesEnabledRef.current;
    subtitleSelectionManualRef.current = true;
    liveSubtitlesEnabledRef.current = true;
    if (!next || !player.selectEmbeddedSubtitleTrack?.(next.id)) {
      subtitleSelectionManualRef.current = previouslyManual;
      liveSubtitlesEnabledRef.current = previouslyEnabled;
      setLiveSubtitleStatus("Subtitle track could not be changed.");
      return;
    }
    setLiveSubtitlesEnabled(true);
    setLiveSubtitleStatus(`Subtitles: ${next.label}`);
  };
  const toggleLiveSource = () => {
    if (playerFullscreen || !isTizenAvPlayAvailable()) return;
    setEmbeddedSubtitleTracks([]);
    setLiveSubtitleStatus("Reloading stream…");
    setLiveSubtitlesEnabled(true);
    liveSubtitlesEnabledRef.current = true;
    setLiveBufferWindow(null);
    setAudioTracks([]);
    setAudioStatus("");
    setPlaybackState("loading");
    setHasStartedPlayback(false);
    setLiveSource((source) => source === "hls" ? "ts" : "hls");
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = normalizedRemoteKey(event);
      if (isBackKey(event)) { event.preventDefault(); selected ? leavePlayer() : selectedCategory ? leaveCategory() : onMainMenu(); return; }
      if (selected) {
        if (playerFullscreen && key === "ArrowUp") { event.preventDefault(); changeChannel(-1); }
        else if (playerFullscreen && key === "ArrowDown") { event.preventDefault(); changeChannel(1); }
        else if (playerFullscreen && (key === "Enter" || key === "ArrowLeft" || key === "ArrowRight")) {
          event.preventDefault();
          showControls();
        }
        else if (!playerFullscreen && (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown")) {
          event.preventDefault();
          const controls = playerControlRefs.current.filter((control): control is HTMLButtonElement => !!control && !control.disabled);
          const activeIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
          const direction = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
          const next = activeIndex < 0 ? 0 : Math.max(0, Math.min(controls.length - 1, activeIndex + direction));
          controls[next]?.focus();
        }
        return;
      }
      const itemCount = selectedCategory ? channels.length : categories.length;
      const currentIndex = selectedCategory ? focusIndex : categoryFocusIndex;
      const refs = selectedCategory ? rowRefs : categoryRefs;
      const activeElement = document.activeElement;
      const headerButtons = selectedCategory ? [categoriesButtonRef.current, mainMenuRef.current] : [mainMenuRef.current];
      const activeHeaderIndex = headerButtons.indexOf(activeElement as HTMLButtonElement);
      const isEmptyRefreshFocused = activeElement === emptyRefreshRef.current;
      if (activeHeaderIndex >= 0) {
        if (key === "ArrowDown") {
          event.preventDefault();
          if (itemCount > 0) focusListItem(refs.current[currentIndex] ?? null);
          else if (emptyRefreshRef.current) emptyRefreshRef.current.focus();
          else if (selectedCategory) headerButtons[activeHeaderIndex === 0 ? 1 : 0]?.focus();
          else mainMenuRef.current?.focus();
        } else if (key === "ArrowLeft" || key === "ArrowRight") {
          event.preventDefault();
          const next = Math.max(0, Math.min(headerButtons.length - 1, activeHeaderIndex + (key === "ArrowLeft" ? -1 : 1)));
          headerButtons[next]?.focus();
        }
        return;
      }
      if (isEmptyRefreshFocused) {
        if (key === "ArrowUp") { event.preventDefault(); (selectedCategory ? categoriesButtonRef.current : mainMenuRef.current)?.focus(); }
        return;
      }
      if (!itemCount && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) {
        event.preventDefault();
        (emptyRefreshRef.current ?? (selectedCategory ? categoriesButtonRef.current : mainMenuRef.current))?.focus();
        return;
      }
      if (key === "ArrowUp" || key === "ArrowDown") {
        event.preventDefault();
        if (key === "ArrowUp" && currentIndex === 0) {
          (selectedCategory ? categoriesButtonRef.current : mainMenuRef.current)?.focus();
          return;
        }
        const next = Math.max(0, Math.min(itemCount - 1, currentIndex + (key === "ArrowUp" ? -1 : 1)));
        selectedCategory ? setFocusIndex(next) : setCategoryFocusIndex(next);
        focusListItem(refs.current[next] ?? null);
        if (!isTizenRuntime()) refs.current[next]?.scrollIntoView({ block: "nearest" });
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
        event.preventDefault();
        if (selectedCategory) (key === "ArrowLeft" ? categoriesButtonRef.current : mainMenuRef.current)?.focus();
        else mainMenuRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [categories.length, categoryFocusIndex, channels, focusIndex, onMainMenu, playerFullscreen, selected, selectedCategory]);

  if (selected) {
    const selectedIndex = channels.findIndex((channel) => channel.id === selected.id);
    const bufferBehindSeconds = liveBufferWindow ? Math.max(0, liveBufferWindow.currentSeconds - liveBufferWindow.startSeconds) : 0;
    const behindLiveSeconds = liveBufferWindow ? Math.max(0, liveBufferWindow.endSeconds - liveBufferWindow.currentSeconds) : 0;
    const hasLiveBuffer = !!liveBufferWindow && liveBufferWindow.endSeconds - liveBufferWindow.startSeconds >= 2;
    const atLiveEdge = behindLiveSeconds < 3;
    return <Localized language={language}><main className={`screen player-screen live-player-screen ${playerFullscreen ? "is-fullscreen" : ""}`}>
    <header className="app-header player-heading"><div><p className="eyebrow">LIVE TV</p><h1>{selected.name}</h1></div><span className="live-badge">LIVE</span></header>
    <div className="player-stage" ref={playerStageRef} tabIndex={-1} onClick={() => { if (playerFullscreen) showControls(); }}>
      {isTizenAvPlayAvailable() ? <object ref={objectRef} className="player tizen-player" type="application/avplayer" /> : <video ref={videoRef} className="player tizen-player" playsInline />}
      {playbackState === "loading" || (playbackState === "buffering" && !hasStartedPlayback) ? <div className="buffering-overlay">Connecting…</div> : null}
      {playbackState === "error" && <div className="playback-error-overlay"><strong>{relayFailureMessage ? "Channel connection failed" : "Channel unavailable"}</strong><span>{relayFailureMessage || "The stream could not be played on this device."}</span></div>}
      {playerFullscreen && showLiveHint && playbackState !== "error" && <span className="live-controls-hint">Press OK or Enter for controls</span>}
    </div>
    <div className="player-controls live-controls">
      <button type="button" disabled={selectedIndex <= 0} onClick={() => changeChannel(-1)} ref={(element) => { playerControlRefs.current[0] = element; }}>Previous channel</button>
      <button type="button" disabled={selectedIndex >= channels.length - 1} onClick={() => changeChannel(1)} ref={(element) => { playerControlRefs.current[1] = element; }}>Next channel</button>
      <button type="button" onClick={toggleFullscreen} ref={(element) => { playerControlRefs.current[2] = element; }}>{playerFullscreen ? "Exit full screen" : "Full screen"}</button>
      {playbackState === "error" && <button type="button" onClick={() => { setPlaybackState("loading"); setRetryCount((count) => count + 1); }} ref={(element) => { playerControlRefs.current[3] = element; }}>Retry</button>}
      {hasLiveBuffer && <button type="button" disabled={bufferBehindSeconds < 1} onClick={() => playerRef.current?.seekLiveBuffer?.(liveBufferWindow!.currentSeconds - 30)} ref={(element) => { playerControlRefs.current[4] = element; }}>Rewind 30 seconds</button>}
      {hasLiveBuffer && <button type="button" disabled={atLiveEdge} onClick={() => playerRef.current?.goLive?.()} ref={(element) => { playerControlRefs.current[5] = element; }}>Go live</button>}
      <button type="button" onClick={leavePlayer} ref={(element) => { playerControlRefs.current[6] = element; }}>Back to channels</button>
      <button type="button" onClick={selectNextAudioTrack} ref={(element) => { playerControlRefs.current[7] = element; }}>{audioTracks.length ? `Audio: ${(audioTracks.find((track) => track.selected) ?? audioTracks[0])?.label}` : "Audio: unavailable"}</button>
      <button type="button" aria-pressed={liveSubtitlesEnabled} onClick={toggleLiveSubtitles} ref={(element) => { playerControlRefs.current[8] = element; }}>{`Subtitles: ${liveSubtitlesEnabled ? "On" : "Off"}`}</button>
      {isTizenAvPlayAvailable() && !playerFullscreen && <button type="button" onClick={toggleLiveSource} ref={(element) => { playerControlRefs.current[9] = element; }}>{liveSource === "hls" ? "Try direct TS source" : "Switch back to HLS"}</button>}
      {embeddedSubtitleTracks.length > 1 && <button type="button" onClick={selectNextSubtitleTrack} ref={(element) => { playerControlRefs.current[10] = element; }}>Subtitle language</button>}
      {audioStatus && <span className="live-buffer-status" role="status">{audioStatus}</span>}
      <span className="playback-status" role="status" aria-live="polite">{relayPlaybackLabel === "Channel connection lost · Reconnecting…" ? relayPlaybackLabel : <>{relayPlaybackLabel || (liveSource === "hls" ? "HLS" : "Direct TS")}{" · "}{playbackState === "playing" || hasStartedPlayback ? liveSubtitleStatus || "Live" : playbackState === "error" ? "Error" : "Connecting"}{relayDiagnostics ? ` · ${relayDiagnostics}` : ""}</>}</span>
      {hasLiveBuffer && <span className="live-buffer-status">{atLiveEdge ? "LIVE" : `${Math.ceil(behindLiveSeconds)}s behind live`}</span>}
    </div>
  </main></Localized>;
  }

  if (!selectedCategory) return <Localized language={language}><main className="screen live-screen">
    <header className="app-header"><div><p className="eyebrow">SUBSTREAM · LIVE TV</p><h1>Finland</h1></div><button type="button" onClick={onMainMenu} ref={mainMenuRef}>Main menu</button></header>
    <p className="hint" role="status" aria-live="polite">{status}{cacheSavedAt && Date.now() - cacheSavedAt > STALE_AFTER_MS ? " · Saved list may be out of date." : ""}</p>
    <div className="live-list" ref={listViewportRef}>
      {categories.map((category, index) => <button className={`live-row live-category-row ${index === categoryFocusIndex ? "remote-focused" : ""}`} type="button" key={category.id} ref={(element) => { categoryRefs.current[index] = element; }} onFocus={() => setCategoryFocusIndex(index)} onClick={() => void openCategory(category)}>
        <span className="live-category-mark" aria-hidden="true">●</span><strong>{categoryLabel(category.name)}</strong><span className="live-category-arrow" aria-hidden="true">›</span>
      </button>)}
      {!categories.length && !status.startsWith("Loading") && <div className="empty-state"><h2>No Finnish categories</h2><p>The provider did not return any matching Finland categories.</p><button type="button" ref={emptyRefreshRef} onClick={() => void refreshCategories()}>Refresh</button></div>}
    </div>
  </main></Localized>;

  return <Localized language={language}><main className="screen live-screen">
    <header className="app-header"><div><p className="eyebrow">SUBSTREAM · LIVE TV · FINLAND</p><h1>{categoryLabel(selectedCategory.name)}</h1></div><div className="header-actions"><button type="button" onClick={leaveCategory} ref={categoriesButtonRef}>Categories</button><button type="button" onClick={onMainMenu} ref={mainMenuRef}>Main menu</button></div></header>
    <p className="hint" role="status" aria-live="polite">{status}</p>
    <div className="live-list" ref={listViewportRef}>
      {channels.map((channel, index) => <button className={`live-row ${index === focusIndex ? "remote-focused" : ""}`} type="button" key={channel.id} ref={(element) => { rowRefs.current[index] = element; }} onFocus={() => setFocusIndex(index)} onClick={() => tune(channel)}>
        {(() => {
          const failures = logoFailures[channel.id] ?? {};
          const logoUrl = channel.logo && !failures.providerFailed
            ? channel.logo
            : !failures.dnaFailed ? channel.dnaLogo : undefined;
          return <span className="live-logo">{logoUrl
            ? <img src={logoUrl} alt="" loading="lazy" onError={() => {
              setLogoFailures((previous) => {
                const current = previous[channel.id] ?? {};
                return logoUrl === channel.logo && channel.dnaLogo !== channel.logo
                  ? { ...previous, [channel.id]: { ...current, providerFailed: true } }
                  : { ...previous, [channel.id]: { ...current, dnaFailed: true } };
              });
            }} />
            : channel.name.charAt(0).toLocaleUpperCase()}</span>;
        })()}
        <span className="live-channel-copy"><span className="live-channel-heading"><strong>{channel.name}</strong>{channel.variant && <span className="live-variant">{channel.variant}</span>}</span>
          {(() => {
            const guide = guideByChannel[channel.id];
            const { current, next } = selectCurrentAndNextProgramme(guide?.programmes ?? [], guideNow);
            if (!current) {
              if (next) return <span className="live-guide"><span className="live-guide-next">Next: {next.title} · {programmeTime(next.startTime)}</span></span>;
              return <span className="live-guide-unavailable">{guideFailures[channel.id] || guide ? "Programme information unavailable" : "Loading programme information…"}</span>;
            }
            const remaining = Math.max(0, Math.ceil((current.endTime - guideNow) / 60_000));
            return <span className="live-guide">
              <span className="live-guide-current"><strong>{current.title}</strong><span>{programmeTime(current.startTime)}–{programmeTime(current.endTime)} · {remaining} min left</span></span>
              <progress className="live-guide-progress" max={100} value={programmeProgress(current, guideNow)} aria-label={`${programmeProgress(current, guideNow).toFixed(0)}% of ${current.title}`} />
              {index === focusIndex && next && <span className="live-guide-next">Next: {next.title} · {programmeTime(next.startTime)}</span>}
            </span>;
          })()}
        </span>
      </button>)}
      {!channels.length && !status.startsWith("Loading") && <div className="empty-state"><h2>No channels</h2><p>Refresh this category to try again.</p><button type="button" ref={emptyRefreshRef} onClick={() => void openCategory(selectedCategory)}>Refresh</button></div>}
    </div>
  </main></Localized>;
}
