import { loadLiveGuideSource } from "../application/live-guide-source.ts";
import { StreamInfoOverlay } from "./StreamInfoOverlay.tsx";
import { requestPlayerFullscreen, exitBrowserFullscreen, releasePlayerOrientation } from "../platform/browser/fullscreen.ts";
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { attachDnaFallback, fillMissingGuideSlots, matchDnaChannel, selectCurrentAndNextProgramme, selectFinnishChannels, selectFinnishLiveCategories, type EpgProgramme, type LiveCategory, type LiveChannel } from "../core/live/index.ts";
import { preferredEmbeddedSubtitleTrack } from "../core/subtitles/embedded.ts";
import { preferredAudioTrackIndex } from "../core/media/audio.ts";
import type { AudioTrack, LiveBufferWindow, MediaPlayer, PlaybackState } from "../platform/media-player.ts";
import { resolveLiveRelayChannel } from "../application/live-relay-routing.ts";
import { isBackKey, normalizedRemoteKey } from "../contracts/input.ts";
import { XtreamClient } from "../platform/xtream/client.ts";
import { DnaGuideClient } from "../platform/dna/client.ts";
import { createAbortController } from "../platform/abort-controller.ts";
import { NordicSkyShowtimeEpgClient, nordicGuideSourceUrl, skyShowtimeNordicXmltvId } from "../platform/nordic/skyshowtime-epg.ts";
import { useCompanion } from "./companion.tsx";
import { safeGuideCache as readGuideCache, safeDnaGuideCache as readDnaGuideCache, safeCache as readLiveCache, dnaGuideCacheKey, guideIsFresh, EPG_CACHE_TTL_MS, type CachedGuide, type CachedLive, type CachedDnaGuide } from "../application/live-cache.ts";
import { providerRequestUrl } from "../platform/provider-request.ts";
import { focusTitleListItem } from "./title-list-focus.ts";
import { useFixedListRowHeight } from "./fixed-list-sizing.ts";
import { ScreenNavigation } from "./ScreenNavigation.tsx";
import { createGuideWorkScope, prioritizeGuideItems } from "./guide-priority.ts";
import { createDeviceSettings } from "../bootstrap/settings.ts";
import { LanguageContext, Localized, translate, type UiLanguage } from "./language.tsx";
import { useRuntime } from "./runtime.tsx";
import { LivePlaybackController } from "../application/live-playback-controller.ts";

type Props = { onMainMenu(): void };
const CACHE_PREFIX = "substream.live.v2.";
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const BROWSER_PLAYBACK_START_TIMEOUT_MS = 8_000;
// Refresh titles cached before short Base64 programme names were decoded.
const EPG_CACHE_PREFIX = "substream.epg.v2.";
const EPG_CONCURRENCY = 4;
const EPG_LIMIT = 10;
const EPG_CACHE_READ_BATCH = 24;
const EPG_UPDATE_BATCH_MS = 100;






function programmeTime(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function programmeProgress(programme: EpgProgramme, now: number): number {
  const duration = programme.endTime - programme.startTime;
  return duration > 0 ? Math.max(0, Math.min(100, (now - programme.startTime) / duration * 100)) : 0;
}


function categoryLabel(name: string): string {
  return name.replace(/^finland\s*[-:|]\s*/i, "").trim() || name;
}

type LiveChannelRowProps = {
  channel: LiveChannel;
  index: number;
  focused: boolean;
  guide?: CachedGuide | undefined;
  guideFailed: boolean;
  current: EpgProgramme | null;
  next: EpgProgramme | null;
  guideNow: number;
  logoFailure?: { providerFailed?: boolean; dnaFailed?: boolean } | undefined;
  language: UiLanguage;
  rowRefs: MutableRefObject<Array<HTMLButtonElement | null>>;
  focusIndexSetter: Dispatch<SetStateAction<number>>;
  logoFailureSetter: Dispatch<SetStateAction<Record<string, { providerFailed?: boolean; dnaFailed?: boolean }>>>;
  rowStyle: CSSProperties | undefined;
  onTune(channel: LiveChannel): void;
};

const LiveChannelRow = memo(function LiveChannelRow({ channel, index, focused, guide, guideFailed, current, next, guideNow, logoFailure, language, rowRefs, focusIndexSetter, logoFailureSetter, rowStyle, onTune }: LiveChannelRowProps) {
  const logoUrl = channel.logo && !logoFailure?.providerFailed ? channel.logo : !logoFailure?.dnaFailed ? channel.dnaLogo : undefined;
  const remaining = current ? Math.max(0, Math.ceil((current.endTime - guideNow) / 60_000)) : 0;
  const progress = current ? programmeProgress(current, guideNow) : 0;
  return <button className={`live-row fixed-list-item ${focused ? "remote-focused" : ""}`} style={rowStyle} type="button" key={channel.id} ref={(element) => { rowRefs.current[index] = element; }} onFocus={() => focusIndexSetter(index)} onClick={() => onTune(channel)}>
    <span className="live-logo">{logoUrl
      ? <img src={logoUrl} alt="" loading="lazy" onError={() => logoFailureSetter((previous) => {
        const existing = previous[channel.id] ?? {};
        return logoUrl === channel.logo && channel.dnaLogo !== channel.logo
          ? { ...previous, [channel.id]: { ...existing, providerFailed: true } }
          : { ...previous, [channel.id]: { ...existing, dnaFailed: true } };
      })} />
      : channel.name.charAt(0).toLocaleUpperCase()}</span>
    <span className="live-channel-copy"><span className="live-channel-heading"><strong>{translate(channel.name, language)}</strong>{channel.variant && <span className="live-variant">{translate(channel.variant, language)}</span>}</span>
      {!current ? next
        ? <span className="live-guide"><span className="live-guide-next">{translate(`Next: ${next.title} · ${programmeTime(next.startTime)}`, language)}</span></span>
        : <span className="live-guide-unavailable">{translate(guideFailed || guide ? "Programme information unavailable" : "Loading programme information…", language)}</span>
        : <span className="live-guide">
          <span className="live-guide-current"><strong>{translate(current.title, language)}</strong><span>{translate(`${programmeTime(current.startTime)}–${programmeTime(current.endTime)} · ${remaining} min left`, language)}</span></span>
          <progress className="live-guide-progress" max={100} value={progress} aria-label={translate(`${progress.toFixed(0)}% of ${current.title}`, language)} />
          {next && <span className="live-guide-next">{translate(`Next: ${next.title} · ${programmeTime(next.startTime)}`, language)}</span>}
        </span>}
    </span>
  </button>;
});

export function LiveTv({ onMainMenu }: Props) {
  const runtime = useRuntime();
  const isTouchProfile = runtime.interactionProfile === "touch";
  const companion = useCompanion();
  const safeGuideCache = (key: string) => readGuideCache(runtime.preferences, key);
  const safeDnaGuideCache = (key: string, now: number) => readDnaGuideCache(runtime.preferences, key, now);
  const safeCache = (key: string) => readLiveCache(runtime.preferences, key);
  const { language } = useContext(LanguageContext);
  const settings = useMemo(() => createDeviceSettings(runtime.preferences), [runtime.preferences]);
  const playlistUrl = settings.loadPlaylistUrl();
  const client = useMemo(() => XtreamClient.fromPlaylistUrl(playlistUrl, (url, init) => runtime.transport.fetch(providerRequestUrl(url), init)), [playlistUrl, runtime.transport]);
  const dnaClient = useMemo(() => new DnaGuideClient((url) => runtime.transport.fetch(url)), [runtime.transport]);
  const nordicEpgClient = useMemo(() => {
    const sourceUrl = nordicGuideSourceUrl({
      canFetchDirectly: runtime.capabilities.directGuideRequests,
      relayUrl: companion.enabled ? companion.controller.getSnapshot().server : "",
      development: import.meta.env.DEV,
    });
    return new NordicSkyShowtimeEpgClient((url, init) => runtime.transport.fetch(url, init), sourceUrl);
  }, [runtime, companion.enabled, companion.controller.getSnapshot().server]);
  const cacheKey = client ? CACHE_PREFIX + client.pairingFingerprint() : "";
  const cached = useMemo(() => cacheKey ? safeCache(cacheKey) : null, [cacheKey]);
  const [cacheSavedAt, setCacheSavedAt] = useState(cached?.savedAt ?? 0);
  const [categories, setCategories] = useState<LiveCategory[]>(cached?.categories ?? []);
  const [selectedCategory, setSelectedCategory] = useState<LiveCategory | null>(null);
  const [channels, setChannels] = useState<LiveChannel[]>([]);
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const [status, setStatus] = useState(cached ? "Showing saved categories while checking for updates…" : "Loading Finnish categories…");
  const [focusIndex, setFocusIndex] = useState(0);
  const focusIndexRef = useRef(0);
  const [guideByChannel, setGuideByChannel] = useState<Record<string, CachedGuide>>({});
  const [guideFailures, setGuideFailures] = useState<Record<string, boolean>>({});
  const [logoFailures, setLogoFailures] = useState<Record<string, { providerFailed?: boolean; dnaFailed?: boolean }>>({});
  const [guideNow, setGuideNow] = useState(() => Date.now());
  const [guideRefresh, setGuideRefresh] = useState(0);
  const [categoryFocusIndex, setCategoryFocusIndex] = useState(0);
  const [selected, setSelected] = useState<LiveChannel | null>(null);
  const [showStreamInfo, setShowStreamInfo] = useState(false);
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
    const subtitleSelectionManualRef = useRef(false);
  const [showLiveHint, setShowLiveHint] = useState(false);
  const [showTouchControls, setShowTouchControls] = useState(false);
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
  const categoryRowStyle = useFixedListRowHeight(listViewportRef, categories.length, undefined, `${selectedCategory?.id ?? "categories"}:${selected?.id ?? "list"}:${playerFullscreen}`);
  const channelRowStyle = useFixedListRowHeight(listViewportRef, channels.length, undefined, `${selectedCategory?.id ?? "no-category"}:${selected?.id ?? "list"}:${playerFullscreen}`);
  const mainMenuRef = useRef<HTMLButtonElement | null>(null);
  const categoriesButtonRef = useRef<HTMLButtonElement | null>(null);
  const emptyRefreshRef = useRef<HTMLButtonElement | null>(null);
  const focusListItem = (element: HTMLButtonElement | null, keyboard = false) => {
    if (isTouchProfile && !keyboard) return;
    if (runtime.interactionProfile === "tv") focusTitleListItem(element, listViewportRef.current);
    else element?.focus();
  };
  const playerControlRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const requestedFullscreenExitRef = useRef(false);
  const requestRef = useRef(0);
  focusIndexRef.current = focusIndex;
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
      const preferred = preferredEmbeddedSubtitleTrack(remaining, settings.loadSubtitlePreferences().languagePreference);
      if (!preferred) break;
      if (player.selectEmbeddedSubtitleTrack?.(preferred.id)) {
        const language = (preferred.language ?? preferred.label).trim().toLocaleLowerCase();
        setLiveSubtitleStatus(`Subtitles: ${language.startsWith("fi") || language.startsWith("fin") ? "Finnish" : "English"}${player.isSubtitleTimingTestPlayer?.() ? " · Timing test" : ""}`);
        return;
      }
      remaining = remaining.filter((track) => track.id !== preferred.id);
    }
    if (player.getLiveSubtitleServiceStatus) {
      setLiveSubtitleStatus(player.getLiveSubtitleServiceStatus());
      return;
    }
    if (player.getLiveDvbSubtitleStatus) {
      const status = player.getLiveDvbSubtitleStatus();
      if (status === "DVB subtitle stream unavailable") {
        setLiveSubtitleStatus("DVB subtitle stream unavailable");
        return;
      }
      if (status === "DVB subtitle scan not started" || status === "DVB subtitle feed not configured") {
        setLiveSubtitleStatus(`AVPlay has no subtitle track · DVB scan off · ${player.getLiveAudioLanguageStatus?.() ?? ""}`);
        return;
      }
    }
    player.selectEmbeddedSubtitleTrack?.("off");
    setLiveSubtitleStatus(`Subtitles unavailable${player.getPlaybackDiagnostics ? ` · ${player.getPlaybackDiagnostics()}` : ""}`);
  }
  function reconcileAudioTracks(player: MediaPlayer | null, tracks: AudioTrack[]): void {
    if (!player) return;
    if (!tracks.length) {
      if (!audioSelectionManualRef.current) setAudioTracks([]);
      return;
    }
    if (audioSelectionManualRef.current) {
      setAudioTracks(tracks);
      if (player.getLiveAudioLanguageStatus && !tracks.some((track) => /^(fi|fin)$/i.test(track.language ?? ""))) {
        setAudioStatus(`Finnish audio unavailable · ${player.getLiveAudioLanguageStatus()}`);
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
    if (player.getLiveAudioLanguageStatus && !tracks.some((track) => /^(fi|fin)$/i.test(track.language ?? ""))) {
      setAudioStatus(`Finnish audio unavailable · ${player.getLiveAudioLanguageStatus()}`);
    }
  }
  const isTvProfile = runtime.interactionProfile === "tv";
  useEffect(() => {
    if (!selected || isTvProfile) return;
    return () => {
      releasePlayerOrientation();
      if (document.fullscreenElement === document.documentElement) void exitBrowserFullscreen(document);
    };
  }, [Boolean(selected), isTvProfile]);

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
      runtime.preferences.set(cacheKey, JSON.stringify({ savedAt, categories: nextCategories, channelsByCategory } satisfies CachedLive));
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
      const focusedRow = rowRefs.current.indexOf(document.activeElement as HTMLButtonElement);
      const focusedChannelId = focusedRow >= 0 ? channelsRef.current[focusedRow]?.id : undefined;
      const nextFocusIndex = focusedChannelId ? result.channels.findIndex((channel) => channel.id === focusedChannelId) : 0;
      setFocusIndex(nextFocusIndex >= 0 ? nextFocusIndex : 0);
      setChannels(result.channels);
      setStatus(result.channels.length ? `${result.channels.length.toLocaleString()} channels ready` : "No channels were found in this category.");
      saveCache(categories, category.id, result.channels);
      if (result.channels.length && !savedChannels.length) window.requestAnimationFrame(() => focusListItem(rowRefs.current[0] ?? null));
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
  }, [channels, focusIndex, selectedCategory?.id]);

  useEffect(() => {
    if (!selectedCategory || !channels.length || !client) return;
    const workScope = createGuideWorkScope();
    const cachePrefix = EPG_CACHE_PREFIX + client.pairingFingerprint() + ".";
    const initial: Record<string, CachedGuide> = {};
    const pendingUpdates: Record<string, CachedGuide> = {};
    const pendingFailures: Record<string, boolean> = {};
    const cacheWrites: Array<[string, CachedGuide | CachedDnaGuide]> = [];
    let updateTimer: number | null = null;
    let cacheWriteTimer: number | null = null;
    let scanTimer: number | null = null;
    const flushUpdates = () => {
      updateTimer = null;
      if (workScope.cancelled) return;
      const updates = Object.keys(pendingUpdates);
      const failures = Object.keys(pendingFailures);
      if (updates.length) {
        const batch: Record<string, CachedGuide> = {};
        updates.forEach((id) => { batch[id] = pendingUpdates[id]!; delete pendingUpdates[id]; });
        setGuideByChannel((previous) => ({ ...previous, ...batch }));
      }
      if (failures.length) {
        const batch: Record<string, boolean> = {};
        failures.forEach((id) => { batch[id] = pendingFailures[id]!; delete pendingFailures[id]; });
        setGuideFailures((previous) => ({ ...previous, ...batch }));
      }
    };
    const scheduleUpdateFlush = () => {
      if (updateTimer === null) updateTimer = window.setTimeout(flushUpdates, EPG_UPDATE_BATCH_MS);
    };
    const flushCacheWrites = () => {
      cacheWriteTimer = null;
      if (workScope.cancelled) return;
      // Keep storage serialization off the response path and limit each turn to
      // one synchronous localStorage write on older TV browsers.
      const write = cacheWrites.shift();
      if (write) {
        try { runtime.preferences.set(write[0], JSON.stringify(write[1])); } catch { /* guide cache is optional */ }
      }
      if (cacheWrites.length) cacheWriteTimer = window.setTimeout(flushCacheWrites, 80);
    };
    const scheduleCacheWrite = (key: string, value: CachedGuide | CachedDnaGuide) => {
      cacheWrites.push([key, value]);
      if (cacheWriteTimer === null) cacheWriteTimer = window.setTimeout(flushCacheWrites, 250);
    };

    const loadGuides = async () => {
      // Spread cache parsing across event-loop turns so a large category does
      // not monopolize the Tizen renderer before network work can start.
      for (let start = 0; start < channels.length; start += EPG_CACHE_READ_BATCH) {
        if (workScope.cancelled) return;
        const end = Math.min(channels.length, start + EPG_CACHE_READ_BATCH);
        const batch: Record<string, CachedGuide> = {};
        for (let index = start; index < end; index += 1) {
          const channel = channels[index]!;
          const cachedGuide = safeGuideCache(cachePrefix + channel.providerStreamId);
          if (cachedGuide && (!skyShowtimeNordicXmltvId(channel) || cachedGuide.source === "nordic-skyshowtime")) { initial[channel.id] = cachedGuide; batch[channel.id] = cachedGuide; }
        }
        if (Object.keys(batch).length) setGuideByChannel((previous) => ({ ...previous, ...batch }));
        if (end < channels.length) await new Promise<void>((resolve) => {
          scanTimer = window.setTimeout(() => { scanTimer = null; resolve(); }, 0);
        });
      }
      if (workScope.cancelled) return;
      setGuideFailures({});
      const channelIndexes = new Map<string, number>();
      channels.forEach((channel, index) => channelIndexes.set(channel.id, index));
      const missing = prioritizeGuideItems(channels.filter((channel) => {
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
      }), focusIndexRef.current, (channel) => channelIndexes.get(channel.id)!);
      let cursor = 0;
      let priorityFocusIndex = focusIndexRef.current;
      const worker = async () => {
        while (!workScope.cancelled && cursor < missing.length) {
          const focusedIndex = focusIndexRef.current;
          if (focusedIndex !== priorityFocusIndex) {
            const queued = prioritizeGuideItems(missing.slice(cursor), focusedIndex, (item) => channelIndexes.get(item.id)!);
            for (let index = 0; index < queued.length; index += 1) missing[cursor + index] = queued[index]!;
            missing.length = cursor + queued.length;
            priorityFocusIndex = focusedIndex;
          }
          const channel = missing[cursor++];
          if (!channel) return;
          const controller = createAbortController();
          workScope.track(controller);
          try {
            let programmes: EpgProgramme[] = [];
            let dnaAttemptAt: number | undefined;
            const nordicXmltvId = skyShowtimeNordicXmltvId(channel);
            programmes = await loadLiveGuideSource(nordicXmltvId, {
              replacement: (id) => nordicEpgClient.schedule(id, channel.providerStreamId),
              provider: () => client.shortEpg(channel.providerStreamId, EPG_LIMIT, controller?.signal),
            });
            if (workScope.cancelled || controller?.signal.aborted) return;
            const slotsAfterNordicFallback = selectCurrentAndNextProgramme(programmes, Date.now());
            if (!nordicXmltvId && channel.dnaChannelId && (!slotsAfterNordicFallback.current || !slotsAfterNordicFallback.next)) {
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
                  if (workScope.cancelled || controller?.signal.aborted) return;
                  fallback = await dnaClient.schedule(channel.dnaChannelId, start, start + 24 * 60 * 60 * 1000);
                  if (workScope.cancelled || controller?.signal.aborted) return;
                  scheduleCacheWrite(dnaCacheKey, { savedAt: Date.now(), programmes: fallback });
                }
                programmes = fillMissingGuideSlots(programmes, fallback, Date.now());
              } catch { /* provider guide remains usable when DNA is unavailable */ }
            }
            if (workScope.cancelled) return;
            const guide: CachedGuide = { savedAt: Date.now(), programmes, ...(nordicXmltvId ? { source: "nordic-skyshowtime" as const } : {}), ...(dnaAttemptAt ? { dnaAttemptAt } : {}) };
            pendingUpdates[channel.id] = guide;
            pendingFailures[channel.id] = false;
            scheduleUpdateFlush();
            scheduleCacheWrite(cachePrefix + channel.providerStreamId, guide);
          } catch {
            if (workScope.cancelled) return;
            pendingFailures[channel.id] = true;
            scheduleUpdateFlush();
          } finally {
            workScope.release(controller);
          }
        }
      };
      for (let workerIndex = 0; workerIndex < Math.min(EPG_CONCURRENCY, missing.length); workerIndex += 1) void worker();
    };
    void loadGuides();
    return () => {
      workScope.cancel();
      if (updateTimer !== null) window.clearTimeout(updateTimer);
      if (cacheWriteTimer !== null) window.clearTimeout(cacheWriteTimer);
      if (scanTimer !== null) window.clearTimeout(scanTimer);
    };
  }, [cacheKey, channels, client, guideRefresh, nordicEpgClient, selectedCategory]);

  useEffect(() => {
    const timer = window.setInterval(() => setGuideNow(Date.now()), 30_000);
    const refreshTimer = window.setInterval(() => setGuideRefresh((value) => value + 1), 60_000);
    const onResume = () => {
      if (document.visibilityState === "visible") {
        setGuideNow(Date.now());
        setGuideRefresh((value) => value + 1);
      }
    };
    document.addEventListener("visibilitychange", onResume);
    return () => { window.clearInterval(timer); window.clearInterval(refreshTimer); document.removeEventListener("visibilitychange", onResume); };
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

  const guideSlotsCacheRef = useRef<Record<string, { guide: CachedGuide | undefined; now: number; slots: ReturnType<typeof selectCurrentAndNextProgramme> }>>({});
  const guideSlotsByChannel = useMemo(() => {
    const slots: Record<string, ReturnType<typeof selectCurrentAndNextProgramme>> = {};
    const cache: typeof guideSlotsCacheRef.current = {};
    channels.forEach((channel) => {
      const guide = guideByChannel[channel.id];
      const previous = guideSlotsCacheRef.current[channel.id];
      const channelSlots = previous && previous.guide === guide && previous.now === guideNow
        ? previous.slots
        : selectCurrentAndNextProgramme(guide?.programmes ?? [], guideNow);
      slots[channel.id] = channelSlots;
      cache[channel.id] = { guide, now: guideNow, slots: channelSlots };
    });
    guideSlotsCacheRef.current = cache;
    return slots;
  }, [channels, guideByChannel, guideNow]);

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
    let directFallback = false;
    let diagnosticTimer: ReturnType<typeof setInterval> | undefined;
    const config = settings.loadLiveRelayConfig();
    const hostedChannelId = resolveLiveRelayChannel(config, selected.providerStreamId, selected.name).channelId;
    const streamUrl = client.liveStreamUrl(selected.providerStreamId, liveSource === "hls" ? "m3u8" : "ts");
    const controller = new LivePlaybackController({
      directStreamUrl: streamUrl,
      createDirect: () => runtime.playbackFactory.createDirect({
        videoElement: videoRef.current,
        container: objectRef.current,
        streamUrl,
        ...(!directFallback && liveSource === "hls" ? { transportStreamMetadataUrl: client.liveStreamUrl(selected.providerStreamId, "ts") } : {}),
      }),
      createRelay: () => config?.enabled && hostedChannelId && runtime.capabilities.supportsLiveRelay && runtime.capabilities.nativeVideoSurface && objectRef.current
        ? runtime.playbackFactory.createRelay?.({ container: objectRef.current, config, channelId: hostedChannelId,
          preferredLanguage: settings.loadSubtitlePreferences().languagePreference, mediaToPlayheadOffsetMs: config.offsetMs ?? 0 }) ?? null
        : null,
      onPlayer: (active) => { if (cancelled) return; playerRef.current = active; active?.setLiveSubtitleMode?.(true); },
      onRelayState: (state) => {
        if (cancelled) return;
        if (state === "starting" || state === "ready") setRelayPlaybackLabel("Subtitle relay · Timing test");
        if (state === "recovering") {
          playbackStateRef.current = "loading";
          setPlaybackState("loading"); setHasStartedPlayback(false); setLiveBufferWindow(null);
          setEmbeddedSubtitleTracks([]); setAudioTracks([]); setAudioStatus(""); setLiveSubtitleStatus(""); setRelayDiagnostics("");
          setRelayPlaybackLabel("Channel connection lost · Reconnecting…");
        }
        if (state === "fallback") {
          directFallback = true;
          setRelayFailureMessage("The subtitle service could not load this channel, and direct playback failed. Select Retry or try another channel.");
          setRelayPlaybackLabel("Subtitle service unavailable · Trying direct playback…");
          setEmbeddedSubtitleTracks([]);
        }
        if (state === "unavailable") setRelayPlaybackLabel("Playing directly · Subtitles may be unavailable");
        if (state === "cleanup-blocked") {
          setRelayPlaybackLabel("Could not stop the previous stream");
          setRelayFailureMessage("The previous stream could not be stopped. Wait a minute, then select Retry.");
        }
      },
      onState: (state) => {
        if (cancelled) return;
        const wasPlaying = playbackStateRef.current === "playing";
        playbackStateRef.current = state;
        setPlaybackState(state);
        const active = playerRef.current;
        if (state === "playing") {
          setHasStartedPlayback(true);
          if (active && !wasPlaying) reconcileAudioTracks(active, active.getAudioTracks?.() ?? []);
          if (active) reconcileEmbeddedSubtitles(active, active.getEmbeddedSubtitleTracks?.() ?? []);
        }
      },
      onPlayerEvents: (active) => ({
        onLiveBufferWindowChange: (value) => { if (!cancelled && playerRef.current === active) setLiveBufferWindow(value); },
        onEmbeddedSubtitleTracksChange: (tracks) => {
          if (cancelled || playerRef.current !== active) return;
          setEmbeddedSubtitleTracks(tracks); reconcileEmbeddedSubtitles(active, tracks);
        },
        onAudioTracksChange: (tracks) => { if (!cancelled && playerRef.current === active) reconcileAudioTracks(active, tracks); },
      }),
    });
    if (config?.enabled && runtime.capabilities.supportsLiveRelay && config.diagnosticsEnabled) diagnosticTimer = setInterval(() => {
      const active = playerRef.current;
      if (!cancelled && active?.getRelayDiagnostics) setRelayDiagnostics(active.getRelayDiagnostics());
    }, 500);
    void runtime.playbackRelease.waitForRelease().then(async () => {
      if (cancelled) return;
      await controller.start();
    }).catch(() => { if (!cancelled) { setPlaybackState("error"); setRelayFailureMessage("The previous stream could not be stopped. Wait a minute, then select Retry."); } });
    return () => {
      cancelled = true;
      if (diagnosticTimer !== undefined) clearInterval(diagnosticTimer);
      void runtime.playbackRelease.release(() => controller.close(), () => controller.retryCleanup()).catch(() => undefined);
      playerRef.current?.setEventHandlers(null);
      playerRef.current = null;
    };
  }, [client, isTvProfile, liveSource, retryCount, selected, runtime, settings]);

  useEffect(() => {
    if (!selected || runtime.capabilities.nativeVideoSurface) return;
    const startupTimer = window.setTimeout(() => {
      const video = videoRef.current;
      const playbackIsAdvancing = !!video && !video.paused && video.readyState >= 2 && video.currentTime > 0;
      if (playbackIsAdvancing || playbackStateRef.current === "error" || playbackStateRef.current === "paused") return;
      // Stop hls.js before a malformed or continuously busy transport stream
      // can monopolize Chromium's renderer. Retry starts another bounded attempt.
      const player = playerRef.current;
      player?.setEventHandlers(null);
      player?.destroy();
      if (playerRef.current === player) playerRef.current = null;
      setPlaybackState("error");
    }, BROWSER_PLAYBACK_START_TIMEOUT_MS);
    return () => window.clearTimeout(startupTimer);
  }, [selected?.id, retryCount, runtime.capabilities.nativeVideoSurface]);

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
    if (isTvProfile) return;
    const syncFullscreen = () => {
      const isFullscreen = document.fullscreenElement === document.documentElement;
      setPlayerFullscreen(isFullscreen);
      if (!isFullscreen) releasePlayerOrientation();
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
  }, [channels, isTvProfile, selected]);

  const tune = (channel: LiveChannel) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setPlaybackState("loading");
    setShowStreamInfo(false);
    setRetryCount(0);
    setLiveSubtitleStatus(liveSubtitlesEnabledRef.current ? "Finding Finnish subtitles…" : "Subtitles: Off");
    setEmbeddedSubtitleTracks([]);
    setAudioTracks([]);
    setAudioStatus("");
    showLiveHintBriefly();
    setLiveBufferWindow(null);
    setPlayerFullscreen(true);
    setShowTouchControls(false);
    if (!isTvProfile && !document.fullscreenElement) void requestPlayerFullscreen(document.documentElement);
    setSelected(channel);
    window.requestAnimationFrame(() => playerStageRef.current?.focus());
  };
  const tuneRef = useRef(tune);
  tuneRef.current = tune;
  const tuneFromRow = useCallback((channel: LiveChannel) => tuneRef.current(channel), []);
  const changeChannel = (delta: number) => {
    if (!selected) return;
    const index = channels.findIndex((channel) => channel.id === selected.id);
    const next = channels[index + delta];
    if (next) tune(next);
  };
  const exitFullscreen = () => {
    releasePlayerOrientation();
    setPlayerFullscreen(false);
    hideLiveHint();
    if (!isTvProfile && document.fullscreenElement) {
      requestedFullscreenExitRef.current = true;
      void exitBrowserFullscreen(document).then((exited) => { if (!exited) requestedFullscreenExitRef.current = false; });
    }
  };
  const toggleFullscreen = () => {
    if (playerFullscreen) exitFullscreen();
    else {
      setPlayerFullscreen(true);
      showLiveHintBriefly();
      if (!isTvProfile && !document.fullscreenElement) void requestPlayerFullscreen(document.documentElement);
      window.requestAnimationFrame(() => playerStageRef.current?.focus());
    }
  };
  const showControls = () => {
    if (!isTvProfile) { setShowTouchControls(true); return; }
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
      setAudioStatus(playbackState === "loading" || playbackState === "buffering" ? "Audio tracks are loading…" : `Audio tracks unavailable${player?.getPlaybackDiagnostics ? ` · ${player.getPlaybackDiagnostics()}` : ""}`);
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
    if (playerFullscreen || !runtime.capabilities.nativeVideoSurface) return;
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
        if (key === "Info") { event.preventDefault(); setShowStreamInfo((visible) => !visible); return; }
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
          if (itemCount > 0) focusListItem(refs.current[currentIndex] ?? null, true);
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
        focusListItem(refs.current[next] ?? null, true);
        if (runtime.interactionProfile !== "tv") refs.current[next]?.scrollIntoView({ block: "nearest" });
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
        event.preventDefault();
        if (selectedCategory) (key === "ArrowLeft" ? categoriesButtonRef.current : mainMenuRef.current)?.focus();
        else mainMenuRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [categories.length, categoryFocusIndex, channels, focusIndex, onMainMenu, playerFullscreen, selected, selectedCategory, runtime.interactionProfile]);

  if (selected) {
    const selectedIndex = channels.findIndex((channel) => channel.id === selected.id);
    const bufferBehindSeconds = liveBufferWindow ? Math.max(0, liveBufferWindow.currentSeconds - liveBufferWindow.startSeconds) : 0;
    const behindLiveSeconds = liveBufferWindow ? Math.max(0, liveBufferWindow.endSeconds - liveBufferWindow.currentSeconds) : 0;
    const hasLiveBuffer = !!liveBufferWindow && liveBufferWindow.endSeconds - liveBufferWindow.startSeconds >= 2;
    const atLiveEdge = behindLiveSeconds < 3;
    return <Localized language={language}><main className={`screen player-screen live-player-screen ${playerFullscreen ? "is-fullscreen" : ""} ${!isTvProfile && showTouchControls ? "has-visible-controls" : ""}`}>
    <header className="app-header player-heading"><div><p className="eyebrow">LIVE TV</p><h1>{selected.name}</h1></div><span className="live-badge">LIVE</span>{!isTvProfile && <button type="button" onClick={leavePlayer}>Back to channels</button>}</header>
    <div className="player-stage" ref={playerStageRef} tabIndex={-1} onClick={() => { if (!isTvProfile && playerFullscreen) setShowTouchControls((visible) => !visible); else if (playerFullscreen) showControls(); }}>
      {runtime.capabilities.nativeVideoSurface ? <object ref={objectRef} className="player tizen-player" type="application/avplayer" /> : <video ref={videoRef} className="player tizen-player" playsInline />}
      {showStreamInfo && <StreamInfoOverlay playerRef={playerRef} />}
      {playbackState === "loading" || (playbackState === "buffering" && !hasStartedPlayback) ? <div className="buffering-overlay">Connecting…</div> : null}
      {playbackState === "paused" && !isTvProfile && <div className="playback-error-overlay"><button type="button" onClick={(event) => { event.stopPropagation(); playerRef.current?.play(); }}>Play</button></div>}
      {playbackState === "error" && <div className="playback-error-overlay"><strong>{relayFailureMessage ? "Channel connection failed" : "Channel unavailable"}</strong><span>{relayFailureMessage || "The stream could not be played on this device."}</span></div>}
      {playerFullscreen && isTvProfile && showLiveHint && playbackState !== "error" && <span className="live-controls-hint">Press OK or Enter for controls</span>}
    </div>
    <div className="player-controls live-controls">
      <button type="button" disabled={selectedIndex <= 0} onClick={() => changeChannel(-1)} ref={(element) => { playerControlRefs.current[0] = element; }}>Previous channel</button>
      <button type="button" disabled={selectedIndex >= channels.length - 1} onClick={() => changeChannel(1)} ref={(element) => { playerControlRefs.current[1] = element; }}>Next channel</button>
      <button type="button" onClick={() => { if (isTouchProfile && playerFullscreen) setShowTouchControls(false); else toggleFullscreen(); }} ref={(element) => { playerControlRefs.current[2] = element; }}>{isTouchProfile && playerFullscreen ? "Hide controls" : playerFullscreen ? "Exit full screen" : "Full screen"}</button>
      {playbackState === "error" && <button type="button" onClick={() => {
        setPlaybackState("loading");
        void runtime.playbackRelease.retryRelease().then(() => setRetryCount((count) => count + 1)).catch(() => { setPlaybackState("error"); setRelayFailureMessage("The previous stream could not be stopped. Wait a minute, then select Retry."); });
      }} ref={(element) => { playerControlRefs.current[3] = element; }}>Retry</button>}
      {hasLiveBuffer && <button type="button" disabled={bufferBehindSeconds < 1} onClick={() => playerRef.current?.seekLiveBuffer?.(liveBufferWindow!.currentSeconds - 30)} ref={(element) => { playerControlRefs.current[4] = element; }}>Rewind 30 seconds</button>}
      {hasLiveBuffer && <button type="button" disabled={atLiveEdge} onClick={() => playerRef.current?.goLive?.()} ref={(element) => { playerControlRefs.current[5] = element; }}>Go live</button>}
      <button type="button" onClick={leavePlayer} ref={(element) => { playerControlRefs.current[6] = element; }}>Back to channels</button>
      <button type="button" onClick={selectNextAudioTrack} ref={(element) => { playerControlRefs.current[7] = element; }}>{audioTracks.length ? `Audio: ${(audioTracks.find((track) => track.selected) ?? audioTracks[0])?.label}` : "Audio: unavailable"}</button>
      <button type="button" aria-pressed={liveSubtitlesEnabled} onClick={toggleLiveSubtitles} ref={(element) => { playerControlRefs.current[8] = element; }}>{`Subtitles: ${liveSubtitlesEnabled ? "On" : "Off"}`}</button>
      {runtime.capabilities.nativeVideoSurface && !playerFullscreen && <button type="button" onClick={toggleLiveSource} ref={(element) => { playerControlRefs.current[9] = element; }}>{liveSource === "hls" ? "Try direct TS source" : "Switch back to HLS"}</button>}
      {embeddedSubtitleTracks.length > 1 && <button type="button" onClick={selectNextSubtitleTrack} ref={(element) => { playerControlRefs.current[10] = element; }}>Subtitle language</button>}
      <button type="button" onClick={() => setShowStreamInfo((visible) => !visible)} aria-pressed={showStreamInfo} ref={(element) => { playerControlRefs.current[11] = element; }}>Info</button>
      {audioStatus && <span className="live-buffer-status" role="status">{audioStatus}</span>}
      <span className="playback-status" role="status" aria-live="polite">{relayPlaybackLabel === "Channel connection lost · Reconnecting…" ? relayPlaybackLabel : <>{relayPlaybackLabel || (liveSource === "hls" ? "HLS" : "Direct TS")}{" · "}{playbackState === "playing" || hasStartedPlayback ? liveSubtitleStatus || "Live" : playbackState === "error" ? "Error" : "Connecting"}{relayDiagnostics ? ` · ${relayDiagnostics}` : ""}</>}</span>
      {hasLiveBuffer && <span className="live-buffer-status">{atLiveEdge ? "LIVE" : `${Math.ceil(behindLiveSeconds)}s behind live`}</span>}
    </div>
  </main></Localized>;
  }

  if (!selectedCategory) return <Localized language={language}><main className={`screen live-screen${isTvProfile ? " tv-ui tv-fixed-list-screen" : ""}`}>
    <header className="app-header"><div><p className="eyebrow">SUBSTREAM · LIVE TV</p><h1>Finland</h1></div><ScreenNavigation onMainMenu={onMainMenu} mainMenuRef={mainMenuRef} /></header>
    <p className="hint" role="status" aria-live="polite">{status}{cacheSavedAt && Date.now() - cacheSavedAt > STALE_AFTER_MS ? " · Saved list may be out of date." : ""}</p>
    <div className="live-list fixed-list-viewport" ref={listViewportRef}>
      {categories.map((category, index) => <button className={`live-row live-category-row fixed-list-item ${!isTouchProfile && index === categoryFocusIndex ? "remote-focused" : ""}`} style={categoryRowStyle} type="button" key={category.id} ref={(element) => { categoryRefs.current[index] = element; }} onFocus={() => setCategoryFocusIndex(index)} onClick={() => void openCategory(category)}>
        <span className="live-category-mark" aria-hidden="true">●</span><strong>{categoryLabel(category.name)}</strong><span className="live-category-arrow" aria-hidden="true">›</span>
      </button>)}
      {!categories.length && !status.startsWith("Loading") && <div className="empty-state"><h2>No Finnish categories</h2><p>The provider did not return any matching Finland categories.</p><button type="button" ref={emptyRefreshRef} onClick={() => void refreshCategories()}>Refresh</button></div>}
    </div>
  </main></Localized>;

  return <Localized language={language}><main className={`screen live-screen${isTvProfile ? " tv-ui tv-fixed-list-screen" : ""}`}>
    <header className="app-header"><div><p className="eyebrow">SUBSTREAM · LIVE TV · FINLAND</p><h1>{categoryLabel(selectedCategory.name)}</h1></div><ScreenNavigation onPrevious={leaveCategory} previousLabel="Categories" previousRef={categoriesButtonRef} onMainMenu={onMainMenu} mainMenuRef={mainMenuRef} /></header>
    <p className="hint" role="status" aria-live="polite">{status}</p>
    <div className="live-list fixed-list-viewport" ref={listViewportRef}>
      {channels.map((channel, index) => {
        const guide = guideByChannel[channel.id];
        const slots = guideSlotsByChannel[channel.id] ?? { current: null, next: null };
        return <LiveChannelRow key={channel.id} channel={channel} index={index} focused={!isTouchProfile && index === focusIndex}
          guide={guide} guideFailed={!!guideFailures[channel.id]} current={slots.current} next={slots.next} guideNow={guideNow}
          logoFailure={logoFailures[channel.id]} language={language} rowRefs={rowRefs} focusIndexSetter={setFocusIndex} rowStyle={channelRowStyle}
          logoFailureSetter={setLogoFailures} onTune={tuneFromRow} />;
      })}
      {!channels.length && !status.startsWith("Loading") && <div className="empty-state"><h2>No channels</h2><p>Refresh this category to try again.</p><button type="button" ref={emptyRefreshRef} onClick={() => void openCategory(selectedCategory)}>Refresh</button></div>}
    </div>
  </main></Localized>;
}
