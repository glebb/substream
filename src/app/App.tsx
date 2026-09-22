import { FormEvent, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import { importM3uChunks, normalizeTitle, type VodCatalogItem } from "../core/catalog/index.ts";
import { DEFAULT_MAX_WHOLE_RESPONSE_BYTES, responseTextChunks, validateWholeResponseFallback, WholeResponseFallbackError } from "../platform/browser/fetch-chunks.ts";
import { clearSavedPlaylistUrl, loadPlaylistUrl, savePlaylistUrl } from "../platform/browser/playlist-config.ts";
import { isBackKey, isRedKey, isTizenRuntime, normalizedRemoteKey, registerTizenPlaybackKeys } from "../platform/tizen/remote.ts";
import { IndexedDbCatalogOpenError, IndexedDbCatalogStore, type VodGroup, type VodSort } from "../platform/web/indexed-db-catalog.ts";
import { HtmlVideoPlayer } from "../platform/browser/html-video-player.ts";
import type { MediaPlayer, PlaybackProgress, VideoDisplayMode } from "../platform/media-player.ts";
import { isTizenAvPlayAvailable, TizenAvPlayPlayer } from "../platform/tizen/avplay-player.ts";
import { clearSavedOpenSubtitlesSettings, loadOpenSubtitlesApiKey, saveOpenSubtitlesApiKey } from "../platform/browser/opensubtitles-config.ts";
import { OpenSubtitlesClient, OpenSubtitlesRequestError, type SubtitleResult } from "../platform/opensubtitles/client.ts";
import { rankSubtitleResults } from "../core/subtitles/rank.ts";
import { adjustSubtitleOffsetSeconds } from "../core/subtitles/timing.ts";
import { XtreamClient } from "../platform/xtream/client.ts";
import { clearSubtitleTimingOffsets, loadSubtitleTimingOffset, saveSubtitleTimingOffset } from "../platform/browser/subtitle-timing-config.ts";
import { clearSubtitlePreferences, loadSubtitlePreferences, saveLastSubtitleLanguage, saveSubtitleFontSize, saveSubtitleLanguagePreference, type SubtitleLanguage } from "../platform/browser/subtitle-preferences.ts";
import { clearCatalogClearedMarker, markCatalogCleared, wasCatalogCleared } from "../platform/browser/catalog-preferences.ts";
import { clearFavouriteGroups, defaultFavouriteGroupIds, hasSavedFavouriteGroupIds, loadFavouriteGroupIds, saveFavouriteGroupIds, setFavouriteGroup } from "../platform/browser/favourites-config.ts";
import { clearPlaybackProgress, loadPlaybackHistory, removePlaybackProgress, savePlaybackProgress, type PlaybackHistoryItem } from "../platform/browser/playback-progress-config.ts";
import { APP_SECTION_ORDER, BrowseRequestGate, browseGroupsForCollection, browsePageCount, favouriteGroupsFirst, favouriteToggleFocusIndex, sortAndPageBrowseItems, type AppSection } from "./browse.ts";
import { formatGroupDisplayName } from "./display-formatting.ts";
import { formatRuntime, titleDetailsFor } from "./title-details.ts";
import { clearSavedTmdbCredentials, loadTmdbCredentials, saveTmdbCredentials } from "../platform/browser/tmdb-config.ts";
import { TmdbClient, type TmdbMetadata } from "../platform/tmdb/client.ts";
import { TmdbImageCache, TmdbMetadataCache } from "../platform/browser/tmdb-cache.ts";
import { actionRowNavigationTarget, browseCollectionFocusIndex, browseCollectionFocusTarget, browseGridColumnCount, dashboardControlNavigationTarget, fullscreenControlNavigationTarget, gridNavigationTarget, homeBrowseFocusTarget, isPlayerPlaybackShortcut, playerTextEntryNavigationKey, recentNavigationTarget, remoteEditableKeyAction, resolveAppBackAction, settingsControlOrder, shouldHandleHeldTitleKeyRepeat, subtitleFocusLayout, titleListEndpointAction, titleListNavigationTarget, titleListPageNavigationTarget, type HeldTitleKeyState, type SettingsControlKey } from "./remote-navigation.ts";
import { focusTitleListItem } from "./title-list-focus.ts";
import { RemoteEditable } from "./remote-editable.tsx";
import "./app.css";
import { CompanionPanel } from "./CompanionPanel.tsx";
import { createBrowserSearchClient, searchSafeRecords, toVodCatalogItem, type SafeSearchRecord } from "../platform/companion/search-catalog.ts";
import { companionServerUrl, CompanionConnectionError, getCompanionConnection, saveCompanionServerUrl, sendCompanionPlayback, type CompanionPlaybackSelection } from "../platform/companion/client.ts";

type ScreenState = "loading" | "setup" | "auto-import" | "ready" | "importing" | "error" | "storage-error";
const PAGE_SIZE = 100;
const OPEN_SUBTITLES_BASE_URL = import.meta.env.DEV ? "/opensubtitles-api/api/v1" : undefined;
type BrowseMode = "local" | "provider" | "episodes";
type SettingsConfirmation = "clear-catalog" | "clear-subtitles" | "reset-all";
type SettingsFocusKey = SettingsControlKey;
type SubtitleSearchType = "movie" | "series";

function playbackHistoryItem(title: VodCatalogItem, progress: PlaybackProgress, providerSourceId?: string, updatedAt = Date.now()): PlaybackHistoryItem {
  const provider = title.id.match(/^xtream:(movie|episode):(\d{1,20})$/);
  const extension = title.streamUrl.match(/\.([a-z0-9]{1,10})(?:[?#]|$)/i)?.[1]?.toLowerCase();
  return {
    id: title.id,
    title: title.title,
    group: title.group,
    contentType: title.contentType,
    year: title.year,
    ...(title.season !== undefined ? { season: title.season } : {}),
    ...(title.episode !== undefined ? { episode: title.episode } : {}),
    currentTimeSeconds: progress.currentTimeSeconds,
    durationSeconds: progress.durationSeconds,
    updatedAt,
    ...(provider ? {
      providerKind: provider[1] === "movie" ? "movie" as const : "series" as const,
      providerId: provider[2],
      ...(providerSourceId ? { providerSourceId } : {}),
      ...(extension && /^[a-z0-9]{1,10}$/i.test(extension) ? { providerExtension: extension } : {}),
    } : {}),
  };
}

function formatPlaybackTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const remainingSeconds = safeSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatSubtitleTimingOffset(seconds: number): string {
  if (seconds === 0) return "0.0 s (in sync)";
  return `${seconds > 0 ? "+" : ""}${seconds.toFixed(1)} s (${seconds > 0 ? "later" : "earlier"})`;
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function App() {
  const subtitleTimingAvailable = true;
  const isTizen = isTizenRuntime();
  const sectionOrder = isTizen ? APP_SECTION_ORDER.filter((section) => section !== "search") : APP_SECTION_ORDER;
  const [state, setState] = useState<ScreenState>("loading");
  const [startupStatus, setStartupStatus] = useState("Opening catalogue…");
  const [playlistUrl, setPlaylistUrl] = useState(loadPlaylistUrl);
  const latestPlaylistUrlRef = useRef(playlistUrl);
  latestPlaylistUrlRef.current = playlistUrl;
  const [showPlaylistForm, setShowPlaylistForm] = useState(() => !loadPlaylistUrl());
  const [playlistDraft, setPlaylistDraft] = useState(loadPlaylistUrl);
  const [editingPlaylistUrl, setEditingPlaylistUrl] = useState(false);
  const [groups, setGroups] = useState<VodGroup[]>([]);
  const [activeGroup, setActiveGroup] = useState<VodGroup | null>(null);
  const [titles, setTitles] = useState<VodCatalogItem[]>([]);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<VodSort>("playlist");
  const [browseMode, setBrowseMode] = useState<BrowseMode>("local");
  const [browseCollection, setBrowseCollection] = useState<AppSection>("recent");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchRecords, setSearchRecords] = useState<SafeSearchRecord[]>([]);
  const [localSearchRecords, setLocalSearchRecords] = useState<VodCatalogItem[]>([]);
  const [localSearchSourceUrl, setLocalSearchSourceUrl] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const [searchRefreshLoading, setSearchRefreshLoading] = useState(false);
  const [detailsOrigin, setDetailsOrigin] = useState<{ kind: "browse" | "search"; focusIndex: number } | null>(null);
  const [detailsSearchRecord, setDetailsSearchRecord] = useState<SafeSearchRecord | null>(null);
  const [tvPlaybackStatus, setTvPlaybackStatus] = useState("");
  const searchRefreshRequestRef = useRef(0);
  const searchRefreshControllerRef = useRef<AbortController | null>(null);
  const [favouriteGroupIds, setFavouriteGroupIds] = useState<string[]>(loadFavouriteGroupIds);
  const visibleGroups = useMemo(() => browseCollection === "recent" || browseCollection === "search" ? [] : favouriteGroupsFirst(browseCollection === "favourites" ? groups.filter((group) => favouriteGroupIds.includes(group.id)) : browseGroupsForCollection(groups, browseCollection), favouriteGroupIds), [browseCollection, favouriteGroupIds, groups]);
  const searchProviderFingerprint = XtreamClient.fromPlaylistUrl(playlistUrl)?.pairingFingerprint() ?? "";
  const visibleSearchRecords = useMemo(() => searchProviderFingerprint
    ? searchSafeRecords(searchRecords.filter((record) => record.sourceFingerprint === searchProviderFingerprint), searchQuery)
    : [], [searchProviderFingerprint, searchRecords, searchQuery]);
  const visibleSearchItems = useMemo(() => [
    ...visibleSearchRecords.flatMap((record) => {
      const item = toVodCatalogItem(record);
      if (!item) return [];
      if (record.kind === "movie") {
        const provider = XtreamClient.fromPlaylistUrl(playlistUrl);
        if (provider) item.streamUrl = provider.streamUrlFor("movie", record.id, record.extension);
      }
      return [{ key: `provider:${record.kind}:${record.id}`, title: record.title, kind: record.kind, year: record.year, category: record.category, item, record }];
    }),
    ...(localSearchSourceUrl === playlistUrl ? localSearchRecords : []).map((item) => ({ key: `local:${item.id}`, title: item.title, kind: item.contentType, year: item.year, category: item.group, item, record: null as SafeSearchRecord | null })),
  ], [localSearchRecords, localSearchSourceUrl, playlistUrl, visibleSearchRecords]);
  const [browseCount, setBrowseCount] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const titleListViewportRef = useRef<HTMLDivElement | null>(null);
  const heldTitleKeyRef = useRef<HeldTitleKeyState | null>(null);
  const [favouriteStatus, setFavouriteStatus] = useState("");
  useEffect(() => {
    if (!groups.length || hasSavedFavouriteGroupIds()) return;
    const defaults = defaultFavouriteGroupIds(groups);
    saveFavouriteGroupIds(defaults);
    setFavouriteGroupIds(defaults);
  }, [groups]);
  const [playerFocusIndex, setPlayerFocusIndex] = useState(0);
  const [resumeChoiceFocusIndex, setResumeChoiceFocusIndex] = useState(0);
  const [settingsButtonFocused, setSettingsButtonFocused] = useState(false);
  const [settingsFocusKey, setSettingsFocusKey] = useState<SettingsFocusKey>("back");
  const [playerFullscreen, setPlayerFullscreen] = useState(false);
  const [showFullscreenControls, setShowFullscreenControls] = useState(false);
  const [videoDisplayMode, setVideoDisplayMode] = useState<VideoDisplayMode>("auto");
  const [playbackStatus, setPlaybackStatus] = useState("Loading…");
  const [playbackProgress, setPlaybackProgress] = useState<PlaybackProgress | null>(null);
  const [isPlaybackPaused, setIsPlaybackPaused] = useState(false);
  const [isPlaybackBuffering, setIsPlaybackBuffering] = useState(false);
  const [isSkipFeedbackVisible, setIsSkipFeedbackVisible] = useState(false);
  const [selectedTitle, setSelectedTitle] = useState<VodCatalogItem | null>(null);
  const [detailsTitle, setDetailsTitle] = useState<VodCatalogItem | null>(null);
  const [detailsMetadata, setDetailsMetadata] = useState<TmdbMetadata | null>(null);
  const [detailsMetadataStatus, setDetailsMetadataStatus] = useState("");
  const [detailsSubtitleLanguages, setDetailsSubtitleLanguages] = useState<string[]>([]);
  const [detailsPosterUrl, setDetailsPosterUrl] = useState<string | null>(null);
  const [detailsEpisodes, setDetailsEpisodes] = useState<VodCatalogItem[]>([]);
  const [detailsEpisodeId, setDetailsEpisodeId] = useState("");
  const [editingDetailsEpisode, setEditingDetailsEpisode] = useState(false);
  const [detailsFocusIndex, setDetailsFocusIndex] = useState(0);
  const [episodePickerOpen, setEpisodePickerOpen] = useState(false);
  const [episodePickerLevel, setEpisodePickerLevel] = useState<"seasons" | "episodes">("seasons");
  const [episodePickerSeason, setEpisodePickerSeason] = useState<number | undefined>(undefined);
  const [episodePickerFocusIndex, setEpisodePickerFocusIndex] = useState(0);
  const [resumeChoice, setResumeChoice] = useState<{ title: VodCatalogItem; history: PlaybackHistoryItem } | null>(null);
  const [continueHistory, setContinueHistory] = useState<PlaybackHistoryItem[]>(loadPlaybackHistory);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsConfirmation, setSettingsConfirmation] = useState<SettingsConfirmation | null>(null);
  const [settingsStatus, setSettingsStatus] = useState("");
  const [editingCompanionServer, setEditingCompanionServer] = useState(false);
  const [companionServerDraft, setCompanionServerDraft] = useState(companionServerUrl);
  const [webTvConnectionStatus, setWebTvConnectionStatus] = useState("");
  const [showVideoInfo, setShowVideoInfo] = useState(false);
  const [openSubtitlesApiKey, setOpenSubtitlesApiKey] = useState(loadOpenSubtitlesApiKey);
  const [settingsApiKeyDraft, setSettingsApiKeyDraft] = useState("");
  const [tmdbCredentials, setTmdbCredentials] = useState(loadTmdbCredentials);
  const [tmdbTokenDraft, setTmdbTokenDraft] = useState("");
  const [tmdbApiKeyDraft, setTmdbApiKeyDraft] = useState("");
  const [subtitleLanguagePreference, setSubtitleLanguagePreference] = useState<SubtitleLanguage>(() => loadSubtitlePreferences().languagePreference);
  const [editingSubtitleLanguage, setEditingSubtitleLanguage] = useState(false);
  const [editingTmdbToken, setEditingTmdbToken] = useState(false);
  const [editingTmdbApiKey, setEditingTmdbApiKey] = useState(false);
  const [showPlayerApiKeyEditor, setShowPlayerApiKeyEditor] = useState(false);
  const [showSettingsApiKeyEditor, setShowSettingsApiKeyEditor] = useState(false);
  const [subtitleSearchQuery, setSubtitleSearchQuery] = useState("");
  const [subtitleSearchType, setSubtitleSearchType] = useState<SubtitleSearchType>("movie");
  const [subtitleSearchSeason, setSubtitleSearchSeason] = useState("");
  const [subtitleSearchEpisode, setSubtitleSearchEpisode] = useState("");
  const [editingSubtitleQuery, setEditingSubtitleQuery] = useState(false);
  const [editingSubtitleType, setEditingSubtitleType] = useState(false);
  const [editingSubtitleSeason, setEditingSubtitleSeason] = useState(false);
  const [editingSubtitleEpisode, setEditingSubtitleEpisode] = useState(false);
  const [subtitleResults, setSubtitleResults] = useState<SubtitleResult[]>([]);
  const [subtitleStatus, setSubtitleStatus] = useState("");
  const [visibleSubtitle, setVisibleSubtitle] = useState("");
  const [isSubtitleAttached, setIsSubtitleAttached] = useState(false);
  const [isSubtitleEnabled, setIsSubtitleEnabled] = useState(false);
  const [isSubtitleOffsetVisible, setIsSubtitleOffsetVisible] = useState(false);
  const [subtitleTimingOffsetSeconds, setSubtitleTimingOffsetSeconds] = useState(0);
  const [subtitleFontSize, setSubtitleFontSize] = useState(2.3);
  const [catalogStatus, setCatalogStatus] = useState("");
  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const browseTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const playlistUrlRef = useRef<HTMLInputElement | null>(null);
  const playlistControlRef = useRef<HTMLElement | null>(null);
  const importButtonRef = useRef<HTMLButtonElement | null>(null);
  const retryPlaylistRef = useRef<HTMLButtonElement | null>(null);
  const changePlaylistRef = useRef<HTMLButtonElement | null>(null);
  const settingsOpenButtonRef = useRef<HTMLButtonElement | null>(null);
  const browseEmptyRecoveryRef = useRef<HTMLButtonElement | null>(null);
  const browseTabTransitionRef = useRef(false);
  const browseReturnFocusIndexRef = useRef(0);
  const browseReturnFocusPendingRef = useRef(false);
  const settingsControlsRef = useRef<Partial<Record<SettingsControlKey, HTMLElement | null>>>({});
  const resumeChoiceControlsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const detailsControlsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const detailsEpisodeSelectRef = useRef<HTMLSelectElement | null>(null);
  const detailsEpisodeControlRef = useRef<HTMLElement | null>(null);
  const episodePickerOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const detailsRequestRef = useRef(0);
  const sortSelectRef = useRef<HTMLSelectElement | null>(null);
  const backToGroupsRef = useRef<HTMLButtonElement | null>(null);
  const previousPageRef = useRef<HTMLButtonElement | null>(null);
  const nextPageRef = useRef<HTMLButtonElement | null>(null);
  const playerBackButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerTogglePlaybackButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerRestartButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerFullscreenButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerAspectButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerInfoButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleToggleButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleSmallerButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleLargerButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleTimingMinusTwoButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleTimingMinusHalfButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleTimingPlusHalfButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleTimingPlusTwoButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleKeyInputRef = useRef<HTMLInputElement | null>(null);
  const subtitleKeyControlRef = useRef<HTMLElement | null>(null);
  const subtitleSetupButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleSearchInputRef = useRef<HTMLInputElement | null>(null);
  const subtitleSearchTypeRef = useRef<HTMLSelectElement | null>(null);
  const subtitleSearchSeasonRef = useRef<HTMLInputElement | null>(null);
  const subtitleSearchEpisodeRef = useRef<HTMLInputElement | null>(null);
  const subtitleSearchControlRef = useRef<HTMLElement | null>(null);
  const subtitleSearchTypeControlRef = useRef<HTMLElement | null>(null);
  const subtitleSearchSeasonControlRef = useRef<HTMLElement | null>(null);
  const subtitleSearchEpisodeControlRef = useRef<HTMLElement | null>(null);
  const findSubtitlesButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleSaveButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsApiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const subtitleLanguageControlRef = useRef<HTMLElement | null>(null);
  const tmdbTokenControlRef = useRef<HTMLElement | null>(null);
  const tmdbApiKeyControlRef = useRef<HTMLElement | null>(null);
  const subtitleButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const subtitleRequestRef = useRef(0);
  const browseRequestRef = useRef(new BrowseRequestGate());
  const remoteBrowseRef = useRef<{ key: string; items: VodCatalogItem[] } | null>(null);
  const playerRef = useRef<MediaPlayer | null>(null);
  const playbackProgressRef = useRef<PlaybackProgress | null>(null);
  const resumeStartSecondsRef = useRef(0);
  const lastPersistedAtRef = useRef(0);
  const skipFeedbackTimerRef = useRef<number | null>(null);
  const subtitleOffsetTimerRef = useRef<number | null>(null);
  const avPlayContainerRef = useRef<HTMLObjectElement | null>(null);
  const playerStageRef = useRef<HTMLDivElement | null>(null);
  const openSubtitlesApiKeyRef = useRef<HTMLInputElement | null>(null);
  const startupImportStartedRef = useRef(false);
  const importStageRef = useRef("Preparing import");
  const [progress, setProgress] = useState("Preparing import…");
  const [error, setError] = useState("");

  const showSubtitleOffset = () => {
    setIsSubtitleOffsetVisible(true);
    if (subtitleOffsetTimerRef.current !== null) window.clearTimeout(subtitleOffsetTimerRef.current);
    subtitleOffsetTimerRef.current = window.setTimeout(() => {
      subtitleOffsetTimerRef.current = null;
      setIsSubtitleOffsetVisible(false);
    }, 5_000);
  };

  const updateImportStage = (message: string) => {
    importStageRef.current = message;
    setProgress(message);
  };

  const playerControls = () => {
    const playbackControls = [
      playerBackButtonRef.current,
      playerStageRef.current,
      playerTogglePlaybackButtonRef.current,
      playerRestartButtonRef.current,
      playerFullscreenButtonRef.current,
      playerAspectButtonRef.current,
      playerInfoButtonRef.current,
    ];
    // The compact subtitle size/toggle buttons remain in the fullscreen
    // control bar, so include them in the focus loop when that bar is shown.
    if (playerFullscreen) return [
      ...playbackControls,
      subtitleSmallerButtonRef.current,
      subtitleLargerButtonRef.current,
      ...(isSubtitleAttached ? [subtitleToggleButtonRef.current] : []),
    ].filter(Boolean) as HTMLElement[];
    return [
      ...playbackControls,
      subtitleSmallerButtonRef.current,
      subtitleLargerButtonRef.current,
      ...(isSubtitleAttached ? [subtitleToggleButtonRef.current] : []),
      ...(subtitleTimingAvailable ? [
        subtitleTimingMinusTwoButtonRef.current,
        subtitleTimingMinusHalfButtonRef.current,
        subtitleTimingPlusHalfButtonRef.current,
        subtitleTimingPlusTwoButtonRef.current,
      ] : []),
      ...(!openSubtitlesApiKey.trim()
        ? [subtitleKeyControlRef.current, ...(showPlayerApiKeyEditor ? [subtitleSaveButtonRef.current] : [])]
        : []),
      subtitleSearchControlRef.current,
      subtitleSearchTypeControlRef.current,
      ...(subtitleSearchType === "series" ? [subtitleSearchSeasonControlRef.current, subtitleSearchEpisodeControlRef.current] : []),
      findSubtitlesButtonRef.current,
      ...subtitleButtonRefs.current,
    ].filter(Boolean) as HTMLElement[];
  };

  const refreshCatalog = async () => {
    setState("loading");
    let store: IndexedDbCatalogStore | undefined;
    try {
      store = await IndexedDbCatalogStore.open(({ stage, processedItems }) => {
        setStartupStatus(stage === "upgrading"
          ? "Updating saved catalogue… " + processedItems.toLocaleString() + " titles processed. Large libraries can take a few minutes; keep this page open."
          : stage === "blocked"
            ? "Catalogue update is waiting for another app tab to close."
            : "Opening catalogue…");
      });
      setStartupStatus("Reading saved catalogue…");
      const metadata = await store.metadata();
      if (metadata.status === "ready") {
        setGroups(await store.groups());
        setState("ready");
      } else if (wasCatalogCleared()) {
        setGroups(await store.groups());
        setCatalogStatus("The local VOD catalogue is empty. Import a playlist to fill it again.");
        setState("ready");
      } else {
        setState(playlistUrl.trim() ? "auto-import" : "setup");
      }
    } catch (cause) {
      setError(cause instanceof IndexedDbCatalogOpenError
        ? cause.message
        : "Local catalogue storage could not be opened. Restart the app and try again.");
      setState("storage-error");
    } finally {
      store?.close();
    }
  };

  useEffect(() => {
    registerTizenPlaybackKeys();
    void refreshCatalog();
  }, []);

  useEffect(() => {
    if (browseCollection !== "search" || state !== "ready" || searchQuery.trim().length < 2) {
      setLocalSearchRecords([]);
      setLocalSearchSourceUrl(playlistUrl);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        let store: IndexedDbCatalogStore | undefined;
        try {
          store = await IndexedDbCatalogStore.open();
          const results = await store.search(searchQuery, 50);
          if (!cancelled) { setLocalSearchRecords(results); setLocalSearchSourceUrl(playlistUrl); }
        } catch {
          if (!cancelled) { setLocalSearchRecords([]); setLocalSearchSourceUrl(playlistUrl); }
        } finally { store?.close(); }
      })();
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [browseCollection, playlistUrl, searchQuery, state]);

  useEffect(() => {
    searchRefreshRequestRef.current += 1;
    searchRefreshControllerRef.current?.abort();
    searchRefreshControllerRef.current = null;
    setSearchRefreshLoading(false);
    setSearchStatus("");
  }, [playlistUrl]);

  useEffect(() => {
    if (state !== "auto-import" || startupImportStartedRef.current) return;
    startupImportStartedRef.current = true;
    if (playlistUrl.trim()) void importPlaylistUrl(playlistUrl);
    else {
      setShowPlaylistForm(true);
      setState("setup");
    }
  }, [state]);

  useEffect(() => {
    if (showPlaylistForm && state !== "loading" && state !== "importing") {
      (isTizen ? playlistControlRef.current : playlistUrlRef.current)?.focus();
    }
  }, [isTizen, showPlaylistForm, state]);

  const openGroup = async (group: VodGroup, targetPage: number, targetSort = sort, focusAtEnd = false) => {
    if (group.providerCategoryId && group.providerContentType) {
      const key = "provider:" + group.providerContentType + ":" + group.providerCategoryId;
      let items = remoteBrowseRef.current?.key === key ? remoteBrowseRef.current.items : null;
      if (!items) {
        const client = XtreamClient.fromPlaylistUrl(playlistUrl);
        if (!client) {
          setCatalogStatus("Provider catalogue is unavailable. Re-import the playlist to use the M3U fallback.");
          return;
        }
        setCatalogStatus("Loading " + group.name + " from the provider…");
        const result = await browseRequestRef.current.run(
          () => group.providerContentType === "movie" ? client.movies(group.providerCategoryId!) : client.series(group.providerCategoryId!),
          "This provider category could not be loaded. Check the TV network and try again.",
        );
        if (result.kind === "stale") return;
        if (result.kind === "error") { setCatalogStatus(result.message); return; }
        items = result.value.map((item) => ({ ...item, group: group.name }));
        remoteBrowseRef.current = { key, items };
      } else {
        browseRequestRef.current.invalidate();
      }
      setBrowseMode("provider");
      setBrowseCount(items.length);
      setActiveGroup(group);
      const pageItems = sortAndPageBrowseItems(items, targetPage, PAGE_SIZE, targetSort);
      setTitles(pageItems);
      setPage(targetPage);
      setSort(targetSort);
      setFocusIndex(focusAtEnd ? Math.max(0, pageItems.length - 1) : 0);
      setCatalogStatus(items.length.toLocaleString() + " titles ready");
      return;
    }
    setCatalogStatus("Loading " + group.name + "…");
    const result = await browseRequestRef.current.run(async () => {
      const store = await IndexedDbCatalogStore.open();
      try { return await store.byGroupPage(group.name, targetPage * PAGE_SIZE, PAGE_SIZE, targetSort); }
      finally { store.close(); }
    }, "Local catalogue could not be loaded. Try again.");
    if (result.kind === "stale") return;
    if (result.kind === "error") { setCatalogStatus(result.message); return; }
    remoteBrowseRef.current = null;
    setBrowseMode("local");
    setBrowseCount(group.count);
    setActiveGroup(group);
    setTitles(result.value);
    setPage(targetPage);
    setSort(targetSort);
    setFocusIndex(focusAtEnd ? Math.max(0, result.value.length - 1) : 0);
    setCatalogStatus("");
  };

  const exitPlayerFullscreen = () => {
    if (isTizen) {
      setPlayerFullscreen(false);
      return;
    }
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };

  const startPlayback = (title: VodCatalogItem, resumeSeconds = 0) => {
    browseRequestRef.current.invalidate();
    resumeStartSecondsRef.current = resumeSeconds;
    playbackProgressRef.current = null;
    lastPersistedAtRef.current = 0;
    setResumeChoice(null);
    setShowVideoInfo(false);
    setPlayerFocusIndex(0);
    setShowFullscreenControls(false);
    // Tizen uses the app's viewport presentation. On the web, ask the browser
    // for real fullscreen while this user action is still active.
    setPlayerFullscreen(isTizen);
    if (!isTizen && !document.fullscreenElement) {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    }
    setVideoDisplayMode("auto");
    setPlaybackStatus("Loading…");
    setPlaybackProgress(null);
    setIsPlaybackPaused(false);
    setVisibleSubtitle("");
    setIsSubtitleAttached(false);
    setIsSubtitleEnabled(false);
    setSubtitleTimingOffsetSeconds(loadSubtitleTimingOffset(title.id));
    setSubtitleFontSize(loadSubtitlePreferences().fontSize);
    const titleForSearch = normalizeTitle(title.title);
    setSubtitleSearchQuery(titleForSearch.searchTitle || title.searchTitle);
    setSubtitleSearchType(title.contentType === "series" ? "series" : "movie");
    setSubtitleSearchSeason(String(title.season ?? titleForSearch.season ?? ""));
    setSubtitleSearchEpisode(String(title.episode ?? titleForSearch.episode ?? ""));
    setEditingSubtitleQuery(false);
    setEditingSubtitleType(false);
    setEditingSubtitleSeason(false);
    setEditingSubtitleEpisode(false);
    setShowPlayerApiKeyEditor(false);
    setSelectedTitle(title);
  };

  const openTitle = async (title: VodCatalogItem, origin: { kind: "browse" | "search"; focusIndex: number } | null = null, searchRecord: SafeSearchRecord | null = null) => {
    const request = ++detailsRequestRef.current;
    setDetailsOrigin(origin);
    setDetailsSearchRecord(searchRecord);
    setDetailsTitle(title);
    setDetailsMetadata(null);
    setDetailsMetadataStatus("");
    setDetailsSubtitleLanguages([]);
    setDetailsPosterUrl(null);
    setDetailsEpisodes([]); setDetailsEpisodeId("");
    setEditingDetailsEpisode(false);
    const credentials = loadTmdbCredentials();
    if (credentials.readAccessToken || credentials.apiKey) {
      const client = new TmdbClient(credentials, undefined, import.meta.env.DEV ? "/tmdb-api" : undefined);
      const mediaType = title.contentType === "series" ? "tv" : "movie";
      try {
      const normalized = normalizeTitle(title.title);
      const resolved = await client.resolve(normalized.searchTitle || title.searchTitle || title.title, mediaType, title.year);
      if (resolved.kind !== "match") {
        if (resolved.kind === "ambiguous") setDetailsMetadataStatus("TMDb found multiple possible matches; artwork and synopsis were withheld.");
        return;
      }
      const cache = new TmdbMetadataCache();
      const cached = cache.get(resolved.candidate.id, mediaType);
      const metadata = cached ?? await client.getMetadata(resolved.candidate.id, mediaType);
      if (!cached) cache.set(metadata);
      if (request !== detailsRequestRef.current) return;
      setDetailsMetadata(metadata);
      if (metadata.posterUrl) {
        const image = await new TmdbImageCache().getOrFetch(metadata.posterUrl, (url) => fetch(url));
        if (image && request === detailsRequestRef.current) setDetailsPosterUrl(image);
      }
      } catch {
        if (request === detailsRequestRef.current) setDetailsMetadataStatus("TMDb metadata is temporarily unavailable.");
      }
    }
    const subtitleKey = openSubtitlesApiKey.trim();
    if (subtitleKey) {
      try {
        const normalized = normalizeTitle(title.title);
        const results = await new OpenSubtitlesClient(subtitleKey, undefined, OPEN_SUBTITLES_BASE_URL).search({
          query: normalized.searchTitle || title.searchTitle,
          languages: ["fi", "en"],
          ...(title.year ?? normalized.year ? { year: title.year ?? normalized.year! } : {}),
          ...(title.season !== undefined ? { season: title.season } : {}),
          ...(title.episode !== undefined ? { episode: title.episode } : {}),
          type: title.contentType === "series" ? "episode" : "movie",
        });
        if (request === detailsRequestRef.current) setDetailsSubtitleLanguages([...new Set(results.map((result) => result.language).filter((language) => language === "fi" || language === "en"))]);
      } catch { /* Details remain useful when subtitle lookup is unavailable. */ }
    }
  };

  const companionOrigin = () => {
    try { return companionServerUrl() || (!isTizen && import.meta.env.DEV ? window.location.origin : ""); }
    catch { return !isTizen && import.meta.env.DEV ? window.location.origin : ""; }
  };

  const saveWebTvRelay = () => {
    try {
      const origin = saveCompanionServerUrl(companionServerDraft);
      setCompanionServerDraft(origin);
      setWebTvConnectionStatus(origin ? `Relay address saved: ${origin}` : "Relay address cleared. Configure a relay to send playback to TV.");
    } catch (error) {
      setWebTvConnectionStatus(error instanceof Error ? error.message : "Relay address could not be saved.");
    }
  };

  const checkWebTvConnection = async () => {
    const server = companionOrigin();
    if (!server) {
      setWebTvConnectionStatus("Set the LAN relay address here before checking for a TV.");
      return;
    }
    try {
      const active = await getCompanionConnection(server);
      const provider = XtreamClient.fromPlaylistUrl(playlistUrl);
      if (active.expiresAt <= Date.now()) setWebTvConnectionStatus("TV connection has expired. Reconnect Substream on the TV.");
      else if (!provider || active.sourceFingerprint !== provider.pairingFingerprint()) setWebTvConnectionStatus("TV is connected, but its provider does not match this browser playlist.");
      else setWebTvConnectionStatus("TV is connected and the provider matches.");
    } catch (error) {
      setWebTvConnectionStatus(error instanceof CompanionConnectionError && error.kind === "no-tv"
        ? "Relay is reachable, but no TV is connected. Open Substream on the TV and connect it in Settings."
        : error instanceof CompanionConnectionError && error.kind === "unreachable"
          ? "TV relay is unreachable. Check the address and that the relay is running on your network."
          : "Relay returned an invalid TV connection response.");
    }
  };

  const openSearchRecord = (record: SafeSearchRecord, index: number) => {
    const client = XtreamClient.fromPlaylistUrl(playlistUrl);
    if (!client || record.sourceFingerprint !== client.pairingFingerprint()) {
      setSearchStatus("This result belongs to a different provider connection.");
      return;
    }
    const candidate = toVodCatalogItem(record);
    if (!candidate) return;
    if (record.kind === "movie") candidate.streamUrl = client.streamUrlFor("movie", record.id, record.extension);
    setFocusIndex(index);
    void openTitle(candidate, { kind: "search", focusIndex: index }, record);
  };

  const openLocalSearchItem = (title: VodCatalogItem, index: number) => {
    setFocusIndex(index);
    void openTitle(title, { kind: "search", focusIndex: index });
  };

  const playSearchResultOnTv = async (title: VodCatalogItem) => {
    const sourceTitle = detailsTitle?.providerSeriesId ? detailsTitle : title;
    const providerMatch = sourceTitle.id.match(/^xtream:(movie|series):(\d{1,20})$/)
      ?? (sourceTitle.providerSeriesId ? ["", "series", String(sourceTitle.providerSeriesId)] : null);
    const extensionFromUrl = title.streamUrl.match(/\.([a-z0-9]{1,10})(?:[?#]|$)/i)?.[1]?.toLowerCase();
    const record = detailsSearchRecord ?? (providerMatch ? {
      kind: providerMatch[1] as "movie" | "series", id: providerMatch[2], title: title.title,
      year: title.year ?? null, extension: extensionFromUrl ?? "mkv", category: title.group,
      sourceFingerprint: XtreamClient.fromPlaylistUrl(playlistUrl)?.pairingFingerprint() ?? "",
      searchTitle: title.searchTitle ?? title.title,
    } : null);
    const server = companionOrigin();
    const provider = XtreamClient.fromPlaylistUrl(playlistUrl);
    if (!server) {
      setTvPlaybackStatus("Set the LAN relay address in Settings before sending playback to TV.");
      return;
    }
    if (!record || !provider || record.sourceFingerprint !== provider.pairingFingerprint()) {
      setTvPlaybackStatus("This title cannot be sent to the connected TV.");
      return;
    }
    let active;
    try { active = await getCompanionConnection(server); }
    catch (error) {
      setTvPlaybackStatus(error instanceof CompanionConnectionError && error.kind === "no-tv"
        ? "Relay is reachable, but no TV is connected."
        : error instanceof CompanionConnectionError && error.kind === "unreachable"
          ? "TV relay is unreachable. Check its address and that it is running."
          : "TV connection could not be read. Check the relay response.");
      return;
    }
    if (active.expiresAt <= Date.now()) {
      setTvPlaybackStatus("TV connection has expired. Reconnect Substream on the TV.");
      return;
    }
    if (active.sourceFingerprint !== record.sourceFingerprint) {
      setTvPlaybackStatus("TV is connected, but its provider does not match this title.");
      return;
    }
    const episodeMatch = title.id.match(/^xtream:episode:(\d{1,20})$/);
    const kind = episodeMatch ? "episode" : "movie";
    const extension = kind === "episode"
      ? title.streamUrl.match(/\.([a-z0-9]{1,10})(?:[?#]|$)/i)?.[1]?.toLowerCase() ?? record.extension
      : record.extension;
    const selectionId = episodeMatch?.[1] ?? record.id;
    if (!selectionId) {
      setTvPlaybackStatus("This title cannot be sent to the connected TV.");
      return;
    }
    const selectionDetails = {
      id: selectionId,
      title: title.title,
      year: title.year ?? null,
      ...(title.season !== undefined ? { season: title.season } : {}),
      ...(title.episode !== undefined ? { episode: title.episode } : {}),
      extension,
      sourceFingerprint: record.sourceFingerprint,
    };
    const selection: CompanionPlaybackSelection = episodeMatch
      ? { ...selectionDetails, kind: "episode", seriesId: String(detailsTitle?.providerSeriesId ?? record.id) }
      : { ...selectionDetails, kind: "movie" };
    try {
      await sendCompanionPlayback(server, active.sessionId, selection);
      setTvPlaybackStatus(`Sent “${title.title}” to TV.`);
    } catch {
      setTvPlaybackStatus("Could not send playback to the TV. Check the connection and try again.");
    }
  };

  const closeDetails = () => {
    detailsRequestRef.current += 1;
    setDetailsTitle(null);
    setTvPlaybackStatus("");
    window.requestAnimationFrame(() => {
      if (detailsOrigin?.kind === "search") {
        const index = detailsOrigin.focusIndex;
        setBrowseCollection("search");
        setFocusIndex(index);
        tileRefs.current[index]?.focus();
      } else if (activeGroup && isTizen) focusTitleListItem(tileRefs.current[focusIndex] ?? null, titleListViewportRef.current);
      else tileRefs.current[focusIndex]?.focus();
    });
  };

  const refreshSearchCatalogue = async () => {
    if (!searchProviderFingerprint) {
      setSearchStatus("Full catalogue refresh requires an Xtream playlist. Your imported M3U titles are searchable here.");
      return;
    }
    searchRefreshControllerRef.current?.abort();
    const controller = new AbortController();
    searchRefreshControllerRef.current = controller;
    const request = ++searchRefreshRequestRef.current;
    setSearchRefreshLoading(true);
    setSearchStatus("Loading the provider catalogue…");
    try {
      const result = await createBrowserSearchClient({ playlistUrl }).refresh({
        signal: controller.signal,
        onProgress: ({ completed, total }) => {
          if (request === searchRefreshRequestRef.current && latestPlaylistUrlRef.current === playlistUrl) setSearchStatus(`Loading ${completed} of ${total} categories…`);
        },
      });
      if (request !== searchRefreshRequestRef.current || latestPlaylistUrlRef.current !== playlistUrl) return;
      setSearchRecords(result.records);
      setSearchStatus(`${result.records.length.toLocaleString()} titles loaded from your provider.`);
    } catch {
      if (request !== searchRefreshRequestRef.current || latestPlaylistUrlRef.current !== playlistUrl) return;
      const cached = await createBrowserSearchClient({ playlistUrl }).loadCached(searchProviderFingerprint);
      if (request !== searchRefreshRequestRef.current || latestPlaylistUrlRef.current !== playlistUrl) return;
      setSearchRecords(cached);
      setSearchStatus(cached.length ? `Provider refresh failed. Searching ${cached.length.toLocaleString()} saved titles.` : "Provider catalogue could not be loaded. Check the playlist and browser network access.");
    } finally {
      if (request === searchRefreshRequestRef.current && latestPlaylistUrlRef.current === playlistUrl) {
        setSearchRefreshLoading(false);
        searchRefreshControllerRef.current = null;
      }
    }
  };

  useEffect(() => {
    if (state !== "ready" || !searchProviderFingerprint) return;
    void createBrowserSearchClient({ playlistUrl }).loadCached(searchProviderFingerprint).then((cached) => {
      if (cached.length) setSearchRecords(cached);
      setSearchStatus(cached.length ? `Searching ${cached.length.toLocaleString()} saved provider titles. Refresh to update.` : "Search your imported M3U titles or refresh the Xtream catalogue.");
    }).catch(() => undefined);
  }, [playlistUrl, searchProviderFingerprint, state]);

  const playFromDetails = (title: VodCatalogItem) => {
    detailsRequestRef.current += 1;
    setDetailsTitle(null);
    const saved = loadPlaybackHistory().find((item) => item.id === title.id);
    if (saved) { setResumeChoice({ title, history: saved }); return; }
    startPlayback(title);
  };

  const chooseSeriesEpisodes = async (title: VodCatalogItem) => {
    if (!title.providerSeriesId) { playFromDetails(title); return; }
    const client = XtreamClient.fromPlaylistUrl(playlistUrl);
    if (!client) {
      setCatalogStatus("Series episodes are unavailable. Re-import the playlist to use the M3U fallback.");
      return;
    }
    setCatalogStatus("Loading episodes for " + title.title + "…");
    const result = await browseRequestRef.current.run(
      () => client.episodes(title.providerSeriesId!, title.title),
      "Episodes could not be loaded. Check the TV network and try again.",
    );
    if (result.kind === "stale") return;
    if (result.kind === "error") { setCatalogStatus(result.message); return; }
    const episodes = result.value;
    setDetailsEpisodes(episodes);
    setDetailsEpisodeId("");
    if (!episodes.length) { detailsRequestRef.current += 1; setDetailsTitle(null); }
    if (!episodes.length) return;
    // The first Action on a series must enter episode selection.  The details
    // action button changes from "Choose season and episode" to "Play selected
    // episode" after the fetch, so leaving focus on it makes the next Action
    // start playback without ever exposing the picker.
    if (isTizen) {
      const seasons = [...new Set(episodes.map((episode) => episode.season).filter((season): season is number => season !== undefined))].sort((a, b) => a - b);
      setEpisodePickerSeason(seasons[0]);
      setEpisodePickerLevel(seasons.length > 1 ? "seasons" : "episodes");
      setEpisodePickerFocusIndex(0);
      setEpisodePickerOpen(true);
      window.requestAnimationFrame(() => episodePickerOptionRefs.current[0]?.focus());
    }
    setCatalogStatus(episodes.length.toLocaleString() + " episodes ready");
  };

  const playSelectedSeriesEpisode = () => {
    const episode = detailsEpisodes.find((item) => item.id === detailsEpisodeId);
    if (episode) playFromDetails(episode);
  };

  const openHistoryEntry = async (history: PlaybackHistoryItem) => {
    try {
      const store = await IndexedDbCatalogStore.open();
      let item: VodCatalogItem | undefined;
      try { item = (await store.byIds([history.id]))[0]; }
      finally { store.close(); }
      if (!item && history.providerKind && history.providerId) {
        const client = XtreamClient.fromPlaylistUrl(playlistUrl);
        if (!client || (history.providerSourceId && client.sourceFingerprint() !== history.providerSourceId)) {
          setCatalogStatus("This provider title cannot be resumed. Change the playlist in Settings and try again.");
          return;
        }
        const normalized = normalizeTitle(history.title);
        item = {
          id: history.id,
          title: history.title,
          searchTitle: normalized.searchTitle,
          searchTerms: normalized.searchTitle.split(" ").filter(Boolean),
          year: history.year,
          ...(history.season !== undefined ? { season: history.season } : {}),
          ...(history.episode !== undefined ? { episode: history.episode } : {}),
          group: history.group,
          contentType: history.contentType,
          addedAt: history.updatedAt,
          streamUrl: client.streamUrlFor(history.providerKind, history.providerId, history.providerExtension),
          sourceLine: 0,
        };
      }
      if (!item) {
        setCatalogStatus("This title is no longer in the local catalogue. Re-import its playlist to resume it.");
        return;
      }
      setCatalogStatus("");
      await openTitle(item);
    } catch {
      setCatalogStatus("Playback history could not be opened from local storage.");
    }
  };

  const removeHistoryEntry = (history: PlaybackHistoryItem) => {
    removePlaybackProgress(history.id);
    setContinueHistory(loadPlaybackHistory());
  };

  const toggleFavouriteForGroup = (group: VodGroup) => {
    const nextFavourite = !favouriteGroupIds.includes(group.id);
    const nextIds = setFavouriteGroup(group.id, nextFavourite);
    setFavouriteGroupIds(nextIds);
    if (browseCollection !== "recent" && browseCollection !== "search") {
      setFocusIndex(favouriteToggleFocusIndex(groups, browseCollection, nextIds, group.id, focusIndex));
    }
    setFavouriteStatus(`${group.name} ${nextFavourite ? "added to" : "removed from"} favourites.`);
  };

  const toggleFocusedFavourite = () => {
    if (activeGroup || browseCollection === "recent") return false;
    const group = visibleGroups[focusIndex];
    if (!group) return false;
    toggleFavouriteForGroup(group);
    return true;
  };

  const chooseResumeAction = (resume: boolean) => {
    if (!resumeChoice) return;
    if (resume) startPlayback(resumeChoice.title, resumeChoice.history.currentTimeSeconds);
    else {
      removePlaybackProgress(resumeChoice.history.id);
      setContinueHistory(loadPlaybackHistory());
      startPlayback(resumeChoice.title);
    }
  };

  const changeBrowsePage = (targetPage: number, targetSort = sort, focusAtEnd = false) => {
    if (browseMode !== "local" && remoteBrowseRef.current) {
      browseRequestRef.current.invalidate();
      const pageItems = sortAndPageBrowseItems(remoteBrowseRef.current.items, targetPage, PAGE_SIZE, targetSort);
      setTitles(pageItems);
      setPage(targetPage);
      setSort(targetSort);
      setFocusIndex(focusAtEnd ? Math.max(0, pageItems.length - 1) : 0);
      return;
    }
    if (activeGroup) void openGroup(activeGroup, targetPage, targetSort, focusAtEnd);
  };

  useEffect(() => {
    const focusBrowseIndex = (index: number) => {
      setFocusIndex(index);
      const tile = tileRefs.current[index];
      if (activeGroup && isTizen) focusTitleListItem(tile ?? null, titleListViewportRef.current);
      else {
        tile?.focus();
        tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    };
    const navigateTizenTitleList = (key: string, allowEndpointExit = true) => {
      const itemCount = titles.length;
      if (!itemCount) return;
      if (key === "ArrowLeft" || key === "ArrowRight") {
        const pageJump = titleListPageNavigationTarget(key, page, browsePageCount(browseCount, PAGE_SIZE));
        if (pageJump) changeBrowsePage(pageJump.page, sort, pageJump.focusAtEnd);
        return;
      }
      const targetIndex = titleListNavigationTarget(key, focusIndex, itemCount);
      if (targetIndex !== null) {
        focusBrowseIndex(targetIndex);
      } else if (titleListEndpointAction(key, focusIndex, itemCount, allowEndpointExit) === "sort") {
        setFocusIndex(0);
        sortSelectRef.current?.focus();
      } else if (titleListEndpointAction(key, focusIndex, itemCount, allowEndpointExit) === "pagination") {
        if (page + 1 < browsePageCount(browseCount, PAGE_SIZE) && nextPageRef.current) nextPageRef.current.focus();
        else if (page > 0 && previousPageRef.current) previousPageRef.current.focus();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const key = normalizedRemoteKey(event);
      if (key !== "ArrowUp" && key !== "ArrowDown") heldTitleKeyRef.current = null;
      if (isRedKey(event) && state === "ready" && !selectedTitle && !detailsTitle && !showSettings && !resumeChoice && !settingsConfirmation
        && !showPlaylistForm && !activeGroup && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLSelectElement)) {
        if (toggleFocusedFavourite()) {
          event.preventDefault();
          // The focused group remains the same; only its indicator/status
          // changes, so the next remote direction starts from the same tile.
        }
        return;
      }
      if (isBackKey(event)) {
        if (editingPlaylistUrl && showPlaylistForm) {
          event.preventDefault();
          setEditingPlaylistUrl(false);
          window.requestAnimationFrame(() => playlistControlRef.current?.focus());
          return;
        }
        if (showSettings && (showSettingsApiKeyEditor || editingCompanionServer || editingSubtitleLanguage || editingTmdbToken || editingTmdbApiKey)) {
          event.preventDefault();
          const target = event.target;
          if (target === settingsApiKeyInputRef.current) {
            setShowSettingsApiKeyEditor(false);
            window.requestAnimationFrame(() => settingsControlsRef.current["api-key-edit"]?.focus());
          } else if (target === settingsControlsRef.current["companion-url"]) {
            setEditingCompanionServer(false);
            window.requestAnimationFrame(() => settingsControlsRef.current["companion-url"]?.focus());
          } else if (target === subtitleLanguageControlRef.current) {
            setEditingSubtitleLanguage(false);
            window.requestAnimationFrame(() => subtitleLanguageControlRef.current?.focus());
          } else if (target === tmdbTokenControlRef.current) {
            setEditingTmdbToken(false);
            window.requestAnimationFrame(() => tmdbTokenControlRef.current?.focus());
          } else if (target === tmdbApiKeyControlRef.current) {
            setEditingTmdbApiKey(false);
            window.requestAnimationFrame(() => tmdbApiKeyControlRef.current?.focus());
          } else {
            setShowSettingsApiKeyEditor(false);
            setEditingCompanionServer(false);
            setEditingSubtitleLanguage(false);
            setEditingTmdbToken(false);
            setEditingTmdbApiKey(false);
          }
          return;
        }
        if (detailsTitle && editingDetailsEpisode) {
          event.preventDefault();
          setEditingDetailsEpisode(false);
          window.requestAnimationFrame(() => detailsEpisodeControlRef.current?.focus());
          return;
        }
        if (selectedTitle && (editingSubtitleQuery || editingSubtitleType || editingSubtitleSeason || editingSubtitleEpisode)) {
          event.preventDefault();
          const target = event.target;
          const restoreControl = target === subtitleSearchInputRef.current
            ? subtitleSearchControlRef
            : target === subtitleSearchTypeRef.current
              ? subtitleSearchTypeControlRef
              : target === subtitleSearchSeasonRef.current
                ? subtitleSearchSeasonControlRef
                : subtitleSearchEpisodeControlRef;
          if (target === subtitleSearchInputRef.current) setEditingSubtitleQuery(false);
          else if (target === subtitleSearchTypeRef.current) setEditingSubtitleType(false);
          else if (target === subtitleSearchSeasonRef.current) setEditingSubtitleSeason(false);
          else if (target === subtitleSearchEpisodeRef.current) setEditingSubtitleEpisode(false);
          window.requestAnimationFrame(() => {
            restoreControl.current?.focus();
          });
          return;
        }
        if (selectedTitle && playerFullscreen && showFullscreenControls) {
          const target = event.target;
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
        }
        if (episodePickerOpen) {
          event.preventDefault();
          if (episodePickerLevel === "episodes") {
            const seasons = [...new Set(detailsEpisodes.map((episode) => episode.season).filter((season): season is number => season !== undefined))];
            if (seasons.length > 1) {
              setEpisodePickerLevel("seasons");
              setEpisodePickerFocusIndex(Math.max(0, seasons.indexOf(episodePickerSeason ?? seasons[0] ?? 0)));
              window.requestAnimationFrame(() => episodePickerOptionRefs.current[Math.max(0, seasons.indexOf(episodePickerSeason ?? seasons[0] ?? 0))]?.focus());
              return;
            }
          }
          setEpisodePickerOpen(false);
          setDetailsFocusIndex(1);
          window.requestAnimationFrame(() => detailsEpisodeSelectRef.current?.focus());
          return;
        }
        if (detailsTitle) {
          event.preventDefault();
          closeDetails();
          return;
        }
        const errorFormOpen = state === "error" && showPlaylistForm;
        const action = resolveAppBackAction({
          settingsConfirmationOpen: Boolean(settingsConfirmation),
          resumeChoiceOpen: Boolean(resumeChoice),
          settingsOpen: showSettings,
          playlistFormOpen: state === "ready" && showPlaylistForm,
          errorFormOpen,
          selectedTitle: Boolean(selectedTitle),
          playerFullscreen,
          playerFullscreenControlsVisible: showFullscreenControls,
          activeGroup: Boolean(activeGroup),
          browseLoading: state === "ready" && catalogStatus.startsWith("Loading "),
        });
        if (action !== "stay" || state !== "ready") event.preventDefault();
        browseRequestRef.current.invalidate();
        switch (action) {
          case "cancel-settings-confirmation":
            setSettingsConfirmation(null);
            break;
          case "close-resume-choice":
            setResumeChoice(null);
            break;
          case "close-settings":
            setShowSettings(false);
            window.requestAnimationFrame(() => settingsOpenButtonRef.current?.focus());
            break;
          case "close-playlist-form":
            setShowPlaylistForm(false);
            setPlaylistDraft("");
            break;
          case "exit-fullscreen":
            exitPlayerFullscreen();
            setShowFullscreenControls(false);
            setPlayerFocusIndex(videoAreaFocusIndex);
            break;
          case "hide-fullscreen-controls":
            setShowFullscreenControls(false);
            setPlayerFocusIndex(videoAreaFocusIndex);
            break;
          case "close-player":
            setSelectedTitle(null);
            break;
          case "close-group":
            remoteBrowseRef.current = null;
            browseReturnFocusPendingRef.current = true;
            setBrowseMode("local");
            setBrowseCount(0);
            setActiveGroup(null);
            setTitles([]);
            setPage(0);
            setFocusIndex(browseReturnFocusIndexRef.current);
            setCatalogStatus("");
            break;
          case "cancel-browse-loading":
            setCatalogStatus("");
            break;
          case "stay":
            break;
        }
        return;
      }
      if (state !== "ready") {
        if (editingPlaylistUrl && event.target === playlistUrlRef.current
          && (key === "ArrowUp" || key === "ArrowDown")) {
          event.preventDefault();
          setEditingPlaylistUrl(false);
          window.requestAnimationFrame(() => playlistControlRef.current?.focus());
          return;
        }
        const controls = (showPlaylistForm
          ? [playlistControlRef.current, importButtonRef.current]
          : [retryPlaylistRef.current, changePlaylistRef.current])
          .filter((control): control is HTMLElement => control !== null);
        if (controls.length === 0) return;
        const currentIndex = Math.max(0, controls.indexOf(document.activeElement as HTMLElement));
        if (key === "ArrowDown" || key === "ArrowRight") {
          event.preventDefault();
          controls[Math.min(controls.length - 1, currentIndex + 1)]?.focus();
          return;
        }
        if (key === "ArrowUp" || key === "ArrowLeft") {
          event.preventDefault();
          controls[Math.max(0, currentIndex - 1)]?.focus();
          return;
        }
        if (key === "Enter" && document.activeElement instanceof HTMLButtonElement) {
          event.preventDefault();
          document.activeElement.click();
        }
        return;
      }
      if (resumeChoice) {
        const controls = resumeChoiceControlsRef.current.filter((control): control is HTMLButtonElement => control !== null && !control.disabled);
        if (controls.length === 0) return;
        const activeIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
        const currentIndex = activeIndex >= 0 ? activeIndex : resumeChoiceFocusIndex;
        const targetIndex = actionRowNavigationTarget(key, currentIndex, controls.length);
        if (targetIndex !== null) {
          event.preventDefault();
          setResumeChoiceFocusIndex(targetIndex);
          controls[targetIndex]?.focus();
          return;
        }
        if (key === "Enter") {
          event.preventDefault();
          controls[currentIndex]?.click();
        }
        return;
      }
      if (detailsTitle) {
        if (episodePickerOpen) {
          const seasons = [...new Set(detailsEpisodes.map((episode) => episode.season).filter((season): season is number => season !== undefined))].sort((a, b) => a - b);
          const pickerEpisodes = detailsEpisodes.filter((episode) => episodePickerSeason === undefined || episode.season === episodePickerSeason);
          const options = episodePickerOptionRefs.current.filter((option): option is HTMLButtonElement => Boolean(option));
          if (options.length === 0) return;
          const activeIndex = options.indexOf(document.activeElement as HTMLButtonElement);
          const currentIndex = activeIndex >= 0 ? activeIndex : episodePickerFocusIndex;
          if (key === "ArrowDown" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowLeft") {
            event.preventDefault();
            const delta = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
            const nextIndex = Math.max(0, Math.min(options.length - 1, currentIndex + delta));
            setEpisodePickerFocusIndex(nextIndex);
            options[nextIndex]?.focus();
            return;
          }
          if (key === "Enter") {
            event.preventDefault();
            if (episodePickerLevel === "seasons") {
              const season = seasons[currentIndex];
              if (season !== undefined) {
                setEpisodePickerSeason(season);
                setEpisodePickerLevel("episodes");
                setEpisodePickerFocusIndex(0);
                window.requestAnimationFrame(() => episodePickerOptionRefs.current[0]?.focus());
              }
            } else {
              const episode = pickerEpisodes[currentIndex];
              if (episode) setDetailsEpisodeId(episode.id);
              setEpisodePickerOpen(false);
              setDetailsFocusIndex(2);
              window.requestAnimationFrame(() => detailsControlsRef.current[2]?.focus());
            }
          }
          return;
        }
        const controls = [detailsControlsRef.current[0], ...(detailsTitle.providerSeriesId && detailsEpisodes.length ? [detailsEpisodeControlRef.current] : []), detailsControlsRef.current[2] ?? detailsControlsRef.current[1], detailsControlsRef.current[3]].filter((control): control is HTMLElement => Boolean(control) && !(control instanceof HTMLButtonElement && control.disabled));
        if (controls.length === 0) return;
        const activeIndex = controls.indexOf(document.activeElement as HTMLElement);
        const currentIndex = activeIndex >= 0 ? activeIndex : detailsFocusIndex;
        if (document.activeElement === detailsEpisodeSelectRef.current && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) {
          if (!isTizen || !editingDetailsEpisode) return;
          event.preventDefault();
          setEditingDetailsEpisode(false);
          const targetIndex = Math.max(0, Math.min(controls.length - 1, currentIndex + (key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1)));
          window.requestAnimationFrame(() => controls[targetIndex]?.focus());
          return;
        }
        if (document.activeElement === detailsEpisodeSelectRef.current && key === "Enter") {
          if (isTizen) {
            event.preventDefault();
            const selectedIndex = Math.max(0, detailsEpisodes.findIndex((episode) => episode.id === detailsEpisodeId));
            const selectedEpisode = detailsEpisodes[selectedIndex];
            const seasons = [...new Set(detailsEpisodes.map((episode) => episode.season).filter((season): season is number => season !== undefined))].sort((a, b) => a - b);
            setEpisodePickerSeason(selectedEpisode?.season ?? seasons[0]);
            setEpisodePickerLevel(seasons.length > 1 ? "seasons" : "episodes");
            setEpisodePickerFocusIndex(seasons.length > 1 ? Math.max(0, seasons.indexOf(selectedEpisode?.season ?? seasons[0] ?? 0)) : selectedIndex);
            setEpisodePickerOpen(true);
            const focusIndex = seasons.length > 1 ? Math.max(0, seasons.indexOf(selectedEpisode?.season ?? seasons[0] ?? 0)) : selectedIndex;
            window.requestAnimationFrame(() => episodePickerOptionRefs.current[focusIndex]?.focus());
          }
          return;
        }
        if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(key)) {
          event.preventDefault();
          const delta = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
          controls[Math.max(0, Math.min(controls.length - 1, currentIndex + delta))]?.focus();
          return;
        }
        if (key === "Enter") { event.preventDefault(); if (controls[currentIndex] instanceof HTMLButtonElement) controls[currentIndex].click(); }
        return;
      }
      if (settingsConfirmation || showSettings) {
        const settingsTextEntry = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
        if (editingCompanionServer && event.target === settingsControlsRef.current["companion-url"] && (key === "ArrowUp" || key === "ArrowDown")) setEditingCompanionServer(false);
        if (editingSubtitleLanguage && event.target === subtitleLanguageControlRef.current && (key === "ArrowUp" || key === "ArrowDown")) setEditingSubtitleLanguage(false);
        if (editingTmdbToken && event.target === tmdbTokenControlRef.current && (key === "ArrowUp" || key === "ArrowDown")) setEditingTmdbToken(false);
        if (editingTmdbApiKey && event.target === tmdbApiKeyControlRef.current && (key === "ArrowUp" || key === "ArrowDown")) setEditingTmdbApiKey(false);
        if (settingsTextEntry && !["ArrowUp", "ArrowDown"].includes(key)) return;
        const order = settingsControlOrder({
          confirmationOpen: Boolean(settingsConfirmation),
          apiKeyEditorOpen: showSettingsApiKeyEditor,
          hasSubtitleKey,
        });
        const controls = order
          .map((controlKey) => settingsControlsRef.current[controlKey])
          .filter((control): control is HTMLElement => Boolean(control) && !(control instanceof HTMLButtonElement && control.disabled));
        if (controls.length === 0) return;
        const activeIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
        const focusIndex = order.indexOf(settingsFocusKey);
        const currentIndex = activeIndex >= 0 ? activeIndex : Math.max(0, focusIndex);
        if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(key)) {
          event.preventDefault();
          const delta = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
          const targetIndex = Math.max(0, Math.min(controls.length - 1, currentIndex + delta));
          setSettingsFocusKey(order[targetIndex] ?? settingsFocusKey);
          controls[targetIndex]?.focus();
          return;
        }
        if (key === "Enter") {
          event.preventDefault();
          if (controls[currentIndex] instanceof HTMLButtonElement) controls[currentIndex].click();
        }
        return;
      }
      if (selectedTitle) {
        const controls = playerControls();
        if (controls.length === 0) return;
        const activeIndex = controls.indexOf(document.activeElement as HTMLElement);
        const currentIndex = activeIndex >= 0 ? activeIndex : Math.max(0, Math.min(controls.length - 1, playerFocusIndex));
        const isTextEntry = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
        const isEditableTarget = isTextEntry || event.target instanceof HTMLSelectElement;
        const editingRemoteField = (editingSubtitleQuery && event.target === subtitleSearchInputRef.current)
          || (editingSubtitleType && event.target === subtitleSearchTypeRef.current)
          || (editingSubtitleSeason && event.target === subtitleSearchSeasonRef.current)
          || (editingSubtitleEpisode && event.target === subtitleSearchEpisodeRef.current);
        const editableAction = remoteEditableKeyAction(key, editingRemoteField, isTizen);
        if (editableAction === "leave-edit") {
          event.preventDefault();
          if (event.target === subtitleSearchInputRef.current) setEditingSubtitleQuery(false);
          else if (event.target === subtitleSearchTypeRef.current) setEditingSubtitleType(false);
          else if (event.target === subtitleSearchSeasonRef.current) setEditingSubtitleSeason(false);
          else if (event.target === subtitleSearchEpisodeRef.current) setEditingSubtitleEpisode(false);
          // Continue through the direction handler below so Up/Down also
          // return to the surrounding remote controls.
        } else if (editableAction === "ignore" && editingRemoteField && key === "Enter") {
          return;
        }
        if (isPlayerPlaybackShortcut(key, {
          videoActive: controls[currentIndex] === playerStageRef.current,
          fullscreen: playerFullscreen,
          fullscreenControlsVisible: showFullscreenControls,
          editableTarget: isEditableTarget,
          tizen: isTizen,
        })) {
          event.preventDefault();
          togglePlayback();
          return;
        }
        if (isTextEntry && !["MediaPlayPause", "MediaPlay", "MediaPause", "MediaRewind", "MediaFastForward"].includes(key) && !playerTextEntryNavigationKey(key)) return;
        if (key === "Info" && !isTextEntry) {
          event.preventDefault();
          setShowVideoInfo((visible) => !visible);
          return;
        }
        if (key === "MediaPlayPause") {
          event.preventDefault();
          togglePlayback();
          return;
        }
        if (key === "MediaPlay") {
          event.preventDefault();
          playVideo();
          return;
        }
        if (key === "MediaPause") {
          event.preventDefault();
          pauseVideo();
          return;
        }
        if (key === "MediaRewind") {
          event.preventDefault();
          skipVideo(-60);
          return;
        }
        if (key === "MediaFastForward") {
          event.preventDefault();
          skipVideo(60);
          return;
        }
        if (key === "ArrowLeft" || key === "ArrowRight") {
          event.preventDefault();
          if (playerFullscreen && showFullscreenControls) {
            const targetIndex = fullscreenControlNavigationTarget(key, currentIndex, controls.length, videoAreaFocusIndex);
            if (targetIndex !== null) {
              setPlayerFocusIndex(targetIndex);
              controls[targetIndex]?.focus();
            }
          } else if (playerFullscreen || controls[currentIndex] === playerStageRef.current) {
            skipVideo(key === "ArrowLeft" ? -60 : 60);
          } else {
            setPlayerFocusIndex(Math.max(0, Math.min(controls.length - 1, currentIndex + (key === "ArrowLeft" ? -1 : 1))));
          }
          return;
        }
        if (key === "ArrowDown" || key === "ArrowUp") {
          event.preventDefault();
          if (playerFullscreen && showFullscreenControls) {
            const targetIndex = fullscreenControlNavigationTarget(key, currentIndex, controls.length, videoAreaFocusIndex);
            if (targetIndex !== null) {
              setPlayerFocusIndex(targetIndex);
              controls[targetIndex]?.focus();
            }
            return;
          }
          if (playerFullscreen) {
            setShowFullscreenControls(true);
            setPlayerFocusIndex(playbackToggleFocusIndex);
            window.requestAnimationFrame(() => playerTogglePlaybackButtonRef.current?.focus());
            return;
          }
          setPlayerFocusIndex(Math.max(0, Math.min(controls.length - 1, currentIndex + (key === "ArrowDown" ? 1 : -1))));
          return;
        }
        if (key === "Enter") {
          event.preventDefault();
          controls[currentIndex]?.click();
        }
        return;
      }
      if (event.target === searchInputRef.current) {
        if (key === "ArrowDown" && tileRefs.current[0]) {
          event.preventDefault();
          setFocusIndex(0);
          tileRefs.current[0]?.focus();
        } else if (key === "ArrowUp") {
          event.preventDefault();
          browseTabRefs.current[sectionOrder.indexOf("search")]?.focus();
        }
        return;
      }
      if (event.target instanceof HTMLInputElement) return;
      if (event.target instanceof HTMLSelectElement) {
        if (activeGroup && isTizen && (key === "ArrowUp" || key === "ArrowDown")
          && event.repeat && heldTitleKeyRef.current?.key === key) {
          event.preventDefault();
        } else if (key === "ArrowRight") {
          event.preventDefault();
          backToGroupsRef.current?.focus();
        } else if (key === "Enter") {
          window.requestAnimationFrame(() => {
            if (activeGroup && isTizen) focusBrowseIndex(focusIndex);
            else tileRefs.current[focusIndex]?.focus();
          });
        }
        return;
      }
      const targetButton = event.target instanceof HTMLButtonElement ? event.target : null;
      if (targetButton?.classList.contains("browse-tab")) {
        const tabs = browseTabRefs.current.filter((tab): tab is HTMLButtonElement => tab !== null);
        const currentTab = Math.max(0, tabs.indexOf(targetButton));
        if (key === "ArrowLeft" || key === "ArrowRight") {
          event.preventDefault();
          const nextTab = Math.max(0, Math.min(tabs.length - 1, currentTab + (key === "ArrowLeft" ? -1 : 1)));
          const nextCollection = sectionOrder;
          browseTabTransitionRef.current = true;
          setFocusIndex(0);
          setBrowseCollection(nextCollection[nextTab] ?? "recent");
          tabs[nextTab]?.focus();
          return;
        }
        if (key === "ArrowDown") {
          if (browseCollection === "search") {
            event.preventDefault();
            searchInputRef.current?.focus();
            return;
          }
          const itemCount = browseCollection === "recent" ? continueHistory.length * 2 : visibleGroups.length;
          if (itemCount > 0) {
            event.preventDefault();
            setFocusIndex(0);
            tileRefs.current[0]?.focus();
          }
          return;
        }
        if (key === "ArrowUp" && settingsOpenButtonRef.current) {
          event.preventDefault();
          settingsOpenButtonRef.current.focus();
          return;
        }
      }
      if (targetButton && !targetButton.classList.contains("tile")) {
        if (dashboardControlNavigationTarget(key, targetButton === settingsOpenButtonRef.current) === "tabs") {
          event.preventDefault();
          browseTabRefs.current[sectionOrder.indexOf(browseCollection)]?.focus();
          return;
        }
        const browseControls = [settingsOpenButtonRef.current, sortSelectRef.current, backToGroupsRef.current, previousPageRef.current, nextPageRef.current, changePlaylistRef.current]
          .filter((control): control is HTMLSelectElement | HTMLButtonElement => control !== null && !(control instanceof HTMLButtonElement && control.disabled));
        const index = browseControls.indexOf(targetButton);
        if (key === "Enter") return;
        if (key === "ArrowLeft" || key === "ArrowRight") {
          event.preventDefault();
          browseControls[Math.max(0, Math.min(browseControls.length - 1, index + (key === "ArrowLeft" ? -1 : 1)))]?.focus();
          return;
        }
        if (key === "ArrowDown" && index <= 2) {
          event.preventDefault();
          if (activeGroup && isTizen) focusBrowseIndex(0);
          else {
            setFocusIndex(0);
            tileRefs.current[0]?.focus();
          }
          return;
        }
        if (key === "ArrowUp" && (targetButton === previousPageRef.current || targetButton === nextPageRef.current)) {
          event.preventDefault();
          const columns = isTizen ? 1 : browseGridColumnCount(true, window.innerWidth <= 800, window.innerWidth < 520);
          const lastTitleIndex = isTizen ? Math.max(0, titles.length - 1) : Math.floor(Math.max(0, titles.length - 1) / columns) * columns;
          if (isTizen) focusBrowseIndex(lastTitleIndex);
          else {
            setFocusIndex(lastTitleIndex);
            tileRefs.current[lastTitleIndex]?.focus();
          }
          return;
        }
        return;
      }
      if (targetButton && key === "Enter") return;
      const continueActionCount = browseCollection === "recent" ? continueHistory.length * 2 : 0;
      const itemCount = activeGroup ? titles.length : browseCollection === "search" ? visibleSearchRecords.length : continueActionCount + visibleGroups.length;
      if (itemCount === 0) return;
      if (activeGroup && isTizen && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) {
        event.preventDefault();
        const verticalKey = key === "ArrowUp" || key === "ArrowDown";
        if (event.repeat) {
          if (verticalKey && shouldHandleHeldTitleKeyRepeat(key, Date.now(), heldTitleKeyRef.current)) {
            heldTitleKeyRef.current = { key, lastHandledAt: Date.now() };
            navigateTizenTitleList(key, false);
          }
        } else if (verticalKey && heldTitleKeyRef.current?.key === key) {
          if (shouldHandleHeldTitleKeyRepeat(key, Date.now(), heldTitleKeyRef.current)) {
            heldTitleKeyRef.current = { key, lastHandledAt: Date.now() };
            navigateTizenTitleList(key, false);
          }
        } else {
          if (verticalKey) heldTitleKeyRef.current = { key, lastHandledAt: Date.now() };
          else heldTitleKeyRef.current = null;
          navigateTizenTitleList(key);
        }
        return;
      }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) {
        event.preventDefault();
        const compactViewport = window.innerWidth <= 800;
        const narrowViewport = window.innerWidth < 520;
        const homeColumns = browseGridColumnCount(false, compactViewport, narrowViewport);
        const targetIndex = activeGroup
          ? gridNavigationTarget(key, focusIndex, itemCount, browseGridColumnCount(true, compactViewport, narrowViewport))
          : browseCollection === "recent"
            ? recentNavigationTarget(key, focusIndex, itemCount)
          : gridNavigationTarget(key, focusIndex, itemCount, homeColumns);
        if (!activeGroup && key === "ArrowUp" && targetIndex === null && (browseCollection === "recent" ? focusIndex < 2 : focusIndex < homeColumns)) {
          browseTabRefs.current[sectionOrder.indexOf(browseCollection)]?.focus();
          return;
        }
        if (activeGroup && key === "ArrowUp" && targetIndex === null && focusIndex < browseGridColumnCount(true, compactViewport, narrowViewport)) {
          sortSelectRef.current?.focus();
          return;
        }
        if (activeGroup && key === "ArrowDown" && targetIndex === null) {
          if (page + 1 < browsePageCount(browseCount, PAGE_SIZE) && nextPageRef.current) {
            nextPageRef.current.focus();
            return;
          }
          if (page > 0 && previousPageRef.current) {
            previousPageRef.current.focus();
            return;
          }
        }
        if (targetIndex !== null) {
          focusBrowseIndex(targetIndex);
        }
        return;
      }
      if (key === "Enter") {
        if (!activeGroup) {
          if (browseCollection === "recent" && focusIndex < continueActionCount) {
            const entry = continueHistory[Math.floor(focusIndex / 2)];
            if (!entry) return;
            event.preventDefault();
            if (focusIndex % 2 === 0) void openHistoryEntry(entry);
            else removeHistoryEntry(entry);
            return;
          }
          const group = visibleGroups[focusIndex - continueActionCount];
          if (!group) return;
          event.preventDefault();
          browseReturnFocusIndexRef.current = focusIndex - continueActionCount;
          void openGroup(group, 0);
          return;
        }
        const title = titles[focusIndex];
        if (!title) return;
        event.preventDefault();
        void openTitle(title);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeGroup, browseCollection, browseCount, catalogStatus, changeBrowsePage, continueHistory, detailsEpisodeId, detailsEpisodes, detailsFocusIndex, detailsTitle, editingCompanionServer, editingDetailsEpisode, editingPlaylistUrl, editingSubtitleEpisode, editingSubtitleLanguage, editingSubtitleQuery, editingSubtitleSeason, editingSubtitleType, editingTmdbApiKey, editingTmdbToken, episodePickerFocusIndex, episodePickerOpen, favouriteGroupIds, focusIndex, groups, isPlaybackPaused, isSubtitleAttached, isTizen, page, playerFocusIndex, playerFullscreen, playlistUrl, resumeChoice, resumeChoiceFocusIndex, selectedTitle, settingsConfirmation, showPlayerApiKeyEditor, showPlaylistForm, showFullscreenControls, showSettings, sort, state, subtitleSearchType, titles, visibleGroups]);

  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent) => {
      const key = normalizedRemoteKey(event);
      if (heldTitleKeyRef.current?.key === key) heldTitleKeyRef.current = null;
    };
    const onBlur = () => { heldTitleKeyRef.current = null; };
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useLayoutEffect(() => {
    if (!browseTabTransitionRef.current || activeGroup || selectedTitle || detailsTitle || resumeChoice || showSettings || settingsConfirmation) return;
    browseTabTransitionRef.current = false;
    const itemCount = browseCollection === "recent" ? continueHistory.length * 2 : browseCollection === "search" ? visibleSearchRecords.length : visibleGroups.length;
    if (browseCollection === "search") {
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
      browseTabTransitionRef.current = false;
      return;
    }
    const target = browseCollectionFocusTarget(itemCount > 0, Boolean(browseEmptyRecoveryRef.current));
    if (target === "content") {
      const targetIndex = browseCollectionFocusIndex(target, itemCount);
      if (targetIndex === null) return;
      // A tab transition can replace a different number of tiles.  Never use
      // an old ref as a fallback here: doing so moves DOM focus to a tile that
      // does not match focusIndex (and therefore the highlighted tile).  The
      // layout effect normally sees all callback refs, while the frame retry
      // covers TV engines that commit refs a tick after their React update.
      const focusFirstTile = () => {
        const tile = tileRefs.current[targetIndex];
        if (!tile) return false;
        tile.focus();
        tile.scrollIntoView({ block: "nearest", inline: "nearest" });
        return true;
      };
      if (focusFirstTile()) return;
      const frame = window.requestAnimationFrame(focusFirstTile);
      return () => window.cancelAnimationFrame(frame);
    }
    if (target === "recovery") {
      browseEmptyRecoveryRef.current?.focus();
    }
  }, [activeGroup, browseCollection, continueHistory.length, detailsTitle, resumeChoice, selectedTitle, settingsConfirmation, showSettings, visibleGroups.length]);

  useEffect(() => {
    if (selectedTitle || detailsTitle || resumeChoice || showSettings || settingsConfirmation) return;
    setSettingsButtonFocused(false);
    if (!activeGroup) {
      if (browseReturnFocusPendingRef.current) {
        browseReturnFocusPendingRef.current = false;
        const frame = window.requestAnimationFrame(() => {
          const tile = tileRefs.current[browseReturnFocusIndexRef.current];
          tile?.focus();
          tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
        return () => window.cancelAnimationFrame(frame);
      }
      const activeElement = document.activeElement;
      const tile = tileRefs.current[focusIndex];
      const activeFocus = activeElement === document.body
        ? "body"
        : activeElement?.classList.contains("browse-tab")
          ? "tab"
          : activeElement?.classList.contains("tile") ? "tile" : "other";
      const focusTarget = homeBrowseFocusTarget(activeFocus, Boolean(tile));
      if (focusTarget === "tile" && tile) {
        tile.focus();
        tile.scrollIntoView({ block: "nearest", inline: "nearest" });
        return;
      }
      if (focusTarget === "tab") {
        const index = sectionOrder.indexOf(browseCollection);
        browseTabRefs.current[index]?.focus();
      }
      return;
    }
    const tile = tileRefs.current[focusIndex];
    if (isTizen) {
      if (document.activeElement !== tile) focusTitleListItem(tile ?? null, titleListViewportRef.current);
    }
    else {
      tile?.focus();
      tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeGroup, browseCollection, detailsTitle, focusIndex, groups.length, isTizen, page, resumeChoice, selectedTitle, settingsConfirmation, showSettings, state, titles.length, continueHistory.length]);

  useEffect(() => {
    if (!detailsTitle) return;
    setDetailsFocusIndex(0);
    window.requestAnimationFrame(() => detailsControlsRef.current[0]?.focus());
  }, [detailsTitle]);

  useEffect(() => {
    if (!showSettings && !settingsConfirmation) return;
    const firstKey = settingsConfirmation ? "confirm-cancel" : "back";
    setSettingsFocusKey(firstKey);
    window.requestAnimationFrame(() => settingsControlsRef.current[firstKey]?.focus());
  }, [settingsConfirmation, showSettings]);

  useEffect(() => {
    if (!showSettings) return;
    if (showSettingsApiKeyEditor) {
      setSettingsFocusKey("api-key-input");
      window.requestAnimationFrame(() => settingsApiKeyInputRef.current?.focus());
      return;
    }
    // The editor's input/save/cancel controls are conditionally mounted. Return
    // to the API-key action after closing it so Tizen never retains a dead focus.
    setSettingsFocusKey("api-key-edit");
    window.requestAnimationFrame(() => settingsControlsRef.current["api-key-edit"]?.focus());
  }, [showSettingsApiKeyEditor]);

  useEffect(() => {
    if (!resumeChoice) return;
    setResumeChoiceFocusIndex(0);
    window.requestAnimationFrame(() => resumeChoiceControlsRef.current[0]?.focus());
  }, [resumeChoice]);

  useEffect(() => {
    if (!selectedTitle) return;
    if (playerFullscreen && !showFullscreenControls) {
      setPlayerFocusIndex(videoAreaFocusIndex);
      playerStageRef.current?.focus();
      return;
    }
    const controls = playerControls();
    const control = controls[Math.min(playerFocusIndex, Math.max(0, controls.length - 1))];
    control?.focus();
  }, [editingSubtitleEpisode, editingSubtitleQuery, editingSubtitleSeason, editingSubtitleType, openSubtitlesApiKey, isSubtitleAttached, playerFocusIndex, playerFullscreen, selectedTitle, showFullscreenControls, showPlayerApiKeyEditor, subtitleResults.length, subtitleSearchType]);

  useEffect(() => {
    if (selectedTitle) window.scrollTo(0, 0);
  }, [selectedTitle]);

  useEffect(() => {
    if (!selectedTitle) return;
    const frame = window.requestAnimationFrame(() => playerRef.current?.resize());
    return () => window.cancelAnimationFrame(frame);
  }, [playerFullscreen, selectedTitle]);

  useEffect(() => {
    if (isTizen) return;
    const syncFullscreenState = () => {
      const isPlayerFullscreen = document.fullscreenElement === document.documentElement;
      setPlayerFullscreen(isPlayerFullscreen);
      if (!isPlayerFullscreen) setShowFullscreenControls(false);
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, [isTizen]);

  useEffect(() => {
    playerRef.current?.setDisplayMode(videoDisplayMode);
  }, [videoDisplayMode, selectedTitle]);

  useEffect(() => {
    subtitleRequestRef.current += 1;
    setSubtitleResults([]);
    setSubtitleStatus("");
    if (!selectedTitle) return;
    setIsSkipFeedbackVisible(false);
    setIsSubtitleAttached(false);
    setIsSubtitleEnabled(false);
    setIsSubtitleOffsetVisible(false);
    if (subtitleOffsetTimerRef.current !== null) {
      window.clearTimeout(subtitleOffsetTimerRef.current);
      subtitleOffsetTimerRef.current = null;
    }
    const initialSubtitleOffset = loadSubtitleTimingOffset(selectedTitle.id);
    setSubtitleTimingOffsetSeconds(initialSubtitleOffset);
    const player = isTizenAvPlayAvailable() && avPlayContainerRef.current
      ? new TizenAvPlayPlayer(avPlayContainerRef.current, setVisibleSubtitle)
      : videoRef.current ? new HtmlVideoPlayer(videoRef.current) : null;
    if (!player) return;
    playerRef.current = player;
    player.setSubtitleTimingOffset?.(initialSubtitleOffset);
    const persistCurrentProgress = (value: PlaybackProgress | null) => {
      if (!value || value.currentTimeSeconds < 5 || value.durationSeconds <= 0) return;
      const providerSourceId = selectedTitle.id.startsWith("xtream:")
        ? XtreamClient.fromPlaylistUrl(playlistUrl)?.sourceFingerprint()
        : undefined;
      savePlaybackProgress(playbackHistoryItem(selectedTitle, value, providerSourceId));
      lastPersistedAtRef.current = Date.now();
      setContinueHistory(loadPlaybackHistory());
    };
    player.setEventHandlers({
      onStateChange: (playbackState) => {
        const status: Record<typeof playbackState, string> = {
          loading: "Loading…",
          buffering: "Buffering…",
          playing: "Playing",
          paused: "Paused",
          ended: "Ended",
          error: "Playback failed. Try restarting the stream.",
        };
        setPlaybackStatus(status[playbackState]);
        setIsPlaybackBuffering(playbackState === "buffering");
        setIsPlaybackPaused(playbackState === "paused" || playbackState === "ended" || playbackState === "error");
        if (playbackState === "paused") persistCurrentProgress(playbackProgressRef.current);
        if (playbackState === "ended") {
          removePlaybackProgress(selectedTitle.id);
          setContinueHistory(loadPlaybackHistory());
        }
      },
      onProgress: (value) => {
        playbackProgressRef.current = value;
        setPlaybackProgress(value);
        if (value.currentTimeSeconds >= 5 && Date.now() - lastPersistedAtRef.current >= 10_000) {
          persistCurrentProgress(value);
        }
      },
    });
    player.load(selectedTitle.streamUrl);
    if (resumeStartSecondsRef.current > 0) player.seekTo?.(resumeStartSecondsRef.current);
    resumeStartSecondsRef.current = 0;
    if (openSubtitlesApiKey.trim()) void findSubtitles(true);
    else setSubtitleStatus("Add an OpenSubtitles API key below to search automatically.");
    return () => {
      subtitleRequestRef.current += 1;
      if (skipFeedbackTimerRef.current !== null) {
        window.clearTimeout(skipFeedbackTimerRef.current);
        skipFeedbackTimerRef.current = null;
      }
      if (subtitleOffsetTimerRef.current !== null) {
        window.clearTimeout(subtitleOffsetTimerRef.current);
        subtitleOffsetTimerRef.current = null;
      }
      playerRef.current = null;
      player.setEventHandlers(null);
      player.destroy();
    };
  }, [selectedTitle]);

  const findSubtitles = async (automatic = false) => {
    const apiKey = openSubtitlesApiKeyRef.current
      ? openSubtitlesApiKeyRef.current.value.trim()
      : openSubtitlesApiKey.trim();
    if (!selectedTitle || !apiKey) {
      setSubtitleStatus("Enter an OpenSubtitles API key before searching.");
      return;
    }
    const requestId = ++subtitleRequestRef.current;
    setSubtitleResults([]);
    setSubtitleStatus("Searching OpenSubtitles…");
    try {
      setOpenSubtitlesApiKey(apiKey);
      saveOpenSubtitlesApiKey(apiKey);
      const client = new OpenSubtitlesClient(apiKey, undefined, OPEN_SUBTITLES_BASE_URL);
      const titleForSearch = normalizeTitle(selectedTitle.title);
      const defaultSearchTitle = titleForSearch.searchTitle || selectedTitle.searchTitle;
      const resolvedTitle = subtitleSearchQuery.trim() || defaultSearchTitle;
      const resolvedYear = selectedTitle.year ?? titleForSearch.year;
      const season = subtitleSearchType === "series" ? positiveInteger(subtitleSearchSeason) : undefined;
      const episode = subtitleSearchType === "series" ? positiveInteger(subtitleSearchEpisode) : undefined;
      const languages = subtitleLanguagePreference === "fi" ? ["fi", "en"] : ["en", "fi"];
      let results: SubtitleResult[] = [];
      let parentFeatureId: number | undefined;
      let usedSeriesFallback = false;
      if (subtitleSearchType === "series" && season !== undefined && episode !== undefined) {
        const feature = await client.findSeriesFeature(resolvedTitle, resolvedYear);
        if (requestId !== subtitleRequestRef.current) return;
        if (feature) {
          parentFeatureId = feature.id;
          results = await client.search({
            languages,
            parentFeatureId: feature.id,
            season,
            episode,
            type: "episode",
          });
        } else {
          usedSeriesFallback = true;
          results = await client.search({
            query: resolvedTitle,
            languages,
            season,
            episode,
            type: "episode",
          });
        }
      } else {
        results = await client.search({
          languages,
          query: resolvedTitle,
          type: subtitleSearchType === "movie" ? "movie" : "episode",
          ...(automatic && subtitleSearchType === "movie" && resolvedYear !== null ? { year: resolvedYear } : {}),
          ...(subtitleSearchType === "series" && season !== undefined ? { season } : {}),
          ...(subtitleSearchType === "series" && episode !== undefined ? { episode } : {}),
        });
      }
      if (requestId !== subtitleRequestRef.current) return;
      const ranked = rankSubtitleResults({
        title: resolvedTitle,
        // A manual title search can target a different release than the VOD
        // currently playing, so do not discard its results by that VOD's year.
        year: automatic ? resolvedYear : null,
        contentType: subtitleSearchType,
        ...(season !== undefined ? { season } : {}),
        ...(episode !== undefined ? { episode } : {}),
        ...(parentFeatureId !== undefined ? { parentFeatureId } : {}),
        languagePreference: subtitleLanguagePreference,
      }, results).slice(0, 8);
      setSubtitleResults(ranked);
      const best = ranked[0];
      if (automatic && best?.highConfidence) {
        setSubtitleStatus("Best match found. Loading " + best.language.toUpperCase() + " subtitles…");
        await loadSubtitle(best, apiKey);
      } else {
        setSubtitleStatus(ranked.length
          ? ranked.length.toLocaleString() + (usedSeriesFallback ? " possible episode subtitles found" : " subtitle matches found")
          : usedSeriesFallback ? "No exact series record or matching episode subtitles were found." : "No subtitle matches found");
      }
    } catch (cause) {
      if (requestId !== subtitleRequestRef.current) return;
      setSubtitleResults([]);
      const detail = cause instanceof OpenSubtitlesRequestError && cause.status ? " (HTTP " + cause.status + ")" : "";
      const localProxyHint = import.meta.env.DEV && !detail
        ? " The local subtitle proxy is unavailable; run npm run dev:personal and reload this page."
        : " Check the API key and network connection.";
      setSubtitleStatus("Subtitle search is unavailable" + detail + "." + localProxyHint);
    }
  };

  const loadSubtitle = async (subtitle: SubtitleResult, apiKeyOverride?: string) => {
    const apiKey = apiKeyOverride ?? (openSubtitlesApiKeyRef.current
      ? openSubtitlesApiKeyRef.current.value.trim()
      : openSubtitlesApiKey.trim());
    if (!apiKey || !playerRef.current) {
      setSubtitleStatus("Enter an OpenSubtitles API key to download a subtitle.");
      return;
    }
    const player = playerRef.current;
    const requestId = ++subtitleRequestRef.current;
    setSubtitleStatus("Downloading subtitle…");
    try {
      const client = new OpenSubtitlesClient(apiKey, undefined, OPEN_SUBTITLES_BASE_URL);
      const download = await client.download(subtitle.fileId);
      const text = await client.fetchSubtitleText(download.link);
      if (requestId !== subtitleRequestRef.current || playerRef.current !== player) return;
      const attachment = await player.setSubtitle(text, subtitle.language.toUpperCase(), subtitle.language);
      if (requestId !== subtitleRequestRef.current || playerRef.current !== player) return;
      setSubtitleStatus(attachment.enabled
        ? "Subtitle enabled: " + subtitle.language.toUpperCase()
        : "Subtitle downloaded, but the TV could not attach it. " + (attachment.reason ?? "Try another subtitle."));
      setIsSubtitleAttached(attachment.enabled);
      setIsSubtitleEnabled(attachment.enabled);
      saveLastSubtitleLanguage(subtitle.language);
      if (attachment.enabled) {
        showSubtitleOffset();
        setPlayerFocusIndex(1);
        window.requestAnimationFrame(() => playerStageRef.current?.scrollIntoView({ block: "start", inline: "nearest" }));
      }
    } catch {
      if (requestId !== subtitleRequestRef.current) return;
      setSubtitleStatus("Subtitle download is unavailable. Check the API key and network connection, then try again.");
    }
  };

  const playVideo = () => {
    playerRef.current?.play();
  };

  const pauseVideo = () => {
    playerRef.current?.pause();
  };

  const togglePlayback = () => {
    if (isPlaybackPaused) playVideo();
    else pauseVideo();
  };

  const toggleSubtitles = () => {
    if (!isSubtitleAttached) return;
    const enabled = !isSubtitleEnabled;
    playerRef.current?.setSubtitleEnabled(enabled);
    setIsSubtitleEnabled(enabled);
    setSubtitleStatus(enabled ? "Subtitles enabled." : "Subtitles disabled.");
  };

  const toggleFullscreen = () => {
    if (isTizen) {
      setPlayerFullscreen((current) => !current);
    } else if (document.fullscreenElement) {
      exitPlayerFullscreen();
    } else {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    }
    setShowFullscreenControls(false);
    setPlayerFocusIndex(videoAreaFocusIndex);
  };

  const restartVideo = () => {
    if (selectedTitle) {
      removePlaybackProgress(selectedTitle.id);
      setContinueHistory(loadPlaybackHistory());
      playbackProgressRef.current = null;
    }
    playerRef.current?.restart();
  };

  const skipVideo = (seconds: number) => {
    if (playerFullscreen) {
      setIsSkipFeedbackVisible(true);
      if (skipFeedbackTimerRef.current !== null) window.clearTimeout(skipFeedbackTimerRef.current);
      skipFeedbackTimerRef.current = window.setTimeout(() => {
        skipFeedbackTimerRef.current = null;
        setIsSkipFeedbackVisible(false);
      }, 1_800);
    }
    playerRef.current?.skip(seconds);
  };

  const adjustSubtitleTiming = (deltaSeconds: number) => {
    if (!selectedTitle) return;
    const offset = saveSubtitleTimingOffset(
      selectedTitle.id,
      adjustSubtitleOffsetSeconds(subtitleTimingOffsetSeconds, deltaSeconds),
    );
    setSubtitleTimingOffsetSeconds(offset);
    showSubtitleOffset();
    playerRef.current?.setSubtitleTimingOffset?.(offset);
  };

  const adjustSubtitleFontSize = (delta: number) => {
    setSubtitleFontSize((current) => saveSubtitleFontSize(current + delta));
  };

  const cycleVideoDisplayMode = () => {
    const next: Record<VideoDisplayMode, VideoDisplayMode> = { auto: "fit", fit: "fill", fill: "auto" };
    setVideoDisplayMode((current) => next[current]);
  };

  const saveSubtitleSettings = () => {
    const apiKey = openSubtitlesApiKeyRef.current
      ? openSubtitlesApiKeyRef.current.value.trim()
      : openSubtitlesApiKey.trim();
    if (!apiKey) {
      setSubtitleStatus("Enter an OpenSubtitles API key before saving.");
      return;
    }
    setOpenSubtitlesApiKey(apiKey);
    saveOpenSubtitlesApiKey(apiKey);
    setShowPlayerApiKeyEditor(false);
    setSubtitleStatus("Subtitle settings saved.");
  };

  const showPlayerApiKeySetup = () => {
    setShowPlayerApiKeyEditor(true);
    window.requestAnimationFrame(() => subtitleKeyInputRef.current?.focus());
  };

  const openSettings = () => {
    setSettingsStatus("");
    setSettingsConfirmation(null);
    setShowSettingsApiKeyEditor(false);
    setEditingCompanionServer(false);
    setShowSettings(true);
  };

  const editSettingsApiKey = () => {
    setSettingsStatus("");
    setSettingsApiKeyDraft("");
    setShowSettingsApiKeyEditor(true);
    window.requestAnimationFrame(() => settingsApiKeyInputRef.current?.focus());
  };

  const saveTmdbSettings = () => {
    const readAccessToken = tmdbTokenDraft.trim();
    const apiKey = tmdbApiKeyDraft.trim();
    if (!readAccessToken && !apiKey && !tmdbCredentials.readAccessToken && !tmdbCredentials.apiKey) {
      setSettingsStatus("Enter a TMDb Read Access Token or API key before saving."); return;
    }
    saveTmdbCredentials({ readAccessToken, apiKey });
    setTmdbCredentials({ readAccessToken, apiKey });
    setTmdbTokenDraft(""); setTmdbApiKeyDraft("");
    setEditingTmdbToken(false);
    setEditingTmdbApiKey(false);
    setSettingsStatus("TMDb settings saved securely.");
  };

  const saveSettingsApiKey = () => {
    const apiKey = settingsApiKeyDraft.trim();
    if (!apiKey) {
      setSettingsStatus("Enter an OpenSubtitles API key before saving.");
      window.requestAnimationFrame(() => settingsApiKeyInputRef.current?.focus());
      return;
    }
    setOpenSubtitlesApiKey(apiKey);
    saveOpenSubtitlesApiKey(apiKey);
    setShowSettingsApiKeyEditor(false);
    setSettingsStatus("OpenSubtitles API key saved securely.");
  };

  const changePlaylist = () => {
    setError("");
    setPlaylistDraft("");
    setShowSettings(false);
    setShowPlaylistForm(true);
  };

  const performSettingsConfirmation = async () => {
    if (!settingsConfirmation) return;
    const action = settingsConfirmation;
    setSettingsConfirmation(null);
    if (action === "clear-subtitles") {
      clearSavedOpenSubtitlesSettings();
      clearSavedTmdbCredentials();
      setTmdbCredentials({ readAccessToken: "", apiKey: "" });
      setOpenSubtitlesApiKey("");
      setShowSettingsApiKeyEditor(false);
      setSettingsStatus("Saved OpenSubtitles API key removed. Add a new key here when you want subtitle search.");
      return;
    }

    let store: IndexedDbCatalogStore | undefined;
    try {
      store = await IndexedDbCatalogStore.open();
      await store.clearCatalog();
      setGroups([]);
      setActiveGroup(null);
      setTitles([]);
      setBrowseCount(0);
      setPage(0);
      setFocusIndex(0);
      setBrowseMode("local");
      remoteBrowseRef.current = null;
      if (action === "clear-catalog") {
        markCatalogCleared();
        setCatalogStatus("The local VOD catalogue is empty. Import a playlist to fill it again.");
        setSettingsStatus("Local VOD catalogue cleared. Your saved playlist setting is unchanged.");
      } else {
        clearSavedPlaylistUrl();
        clearSavedOpenSubtitlesSettings();
        clearSavedTmdbCredentials();
        setTmdbCredentials({ readAccessToken: "", apiKey: "" });
        clearPlaybackProgress();
        clearSubtitleTimingOffsets();
        clearSubtitlePreferences();
        setSubtitleLanguagePreference("fi");
        clearFavouriteGroups();
        clearCatalogClearedMarker();
        setPlaylistUrl("");
        setPlaylistDraft("");
        setOpenSubtitlesApiKey("");
        setContinueHistory([]);
        setFavouriteGroupIds([]);
        setCatalogStatus("");
        setSettingsStatus("");
        setShowSettings(false);
        setShowPlaylistForm(true);
        setState("setup");
      }
    } catch {
      setSettingsStatus(action === "clear-catalog"
        ? "The local VOD catalogue could not be cleared. Close other app tabs and try again."
        : "Local app data could not be reset. Close other app tabs and try again.");
    } finally {
      store?.close();
    }
  };

  async function importPlaylistUrl(url: string) {
    if (!url.trim()) return;
    setError("");
    updateImportStage("Connecting to the playlist…");
    setState("importing");
    try {
      setPlaylistUrl(url);
      setPlaylistDraft(url);
      savePlaylistUrl(url);
      clearCatalogClearedMarker();
      const provider = XtreamClient.fromPlaylistUrl(url);
      if (provider) {
        updateImportStage("Checking the provider catalogue…");
        try {
          const categories = await provider.categories();
          if (categories.length > 0) {
            const store = await IndexedDbCatalogStore.open();
            try {
              await store.replaceProviderGroups(categories.map((category) => ({
                id: "provider:" + category.contentType + ":" + category.id,
                name: (category.contentType === "movie" ? "Movies: " : "Series: ") + category.name,
                count: 0,
                contentType: category.contentType,
                providerCategoryId: category.id,
                providerContentType: category.contentType,
              })));
              setGroups(await store.groups());
            } finally {
              store.close();
            }
            updateImportStage(categories.length.toLocaleString() + " provider categories ready");
            setShowPlaylistForm(false);
            setState("ready");
            return;
          }
        } catch {
          updateImportStage("Provider catalogue unavailable. Falling back to M3U import…");
        }
      }
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        updateImportStage("Playlist server responded with HTTP " + response.status);
        throw new Error("Playlist request failed");
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        validateWholeResponseFallback(response);
      }
      updateImportStage("Playlist connection succeeded (HTTP " + response.status + "). Opening local storage…");
      const store = await IndexedDbCatalogStore.open();
      try {
        updateImportStage("Local storage is ready. Reading playlist data…");
        const result = await importM3uChunks(responseTextChunks(response, {
          maxWholeResponseBytes: DEFAULT_MAX_WHOLE_RESPONSE_BYTES,
          onWholeResponseFallback: () => updateImportStage("TV streaming support is unavailable. Checking and reading responses up to 8 MiB in memory…"),
        }), store, {
          batchSize: isTizenAvPlayAvailable() ? 2_000 : 500,
          progressInterval: 5_000,
          onProgress: ({ processedEntries, importedItems }) => {
            setProgress(processedEntries.toLocaleString() + " entries scanned · " + importedItems.toLocaleString() + " VOD items saved");
          },
        });
        setGroups(await store.groups());
        setProgress(result.importedItems.toLocaleString() + " VOD items imported");
        setShowPlaylistForm(false);
        setState("ready");
      } finally {
        store.close();
      }
    } catch (cause) {
      if (cause instanceof WholeResponseFallbackError) {
        setError(cause.message);
        setState("error");
        return;
      }
      setError("Import failed after: " + importStageRef.current + ". Check TV network access and the playlist server, then try again.");
      setState("error");
    }
  }

  const importPlaylist = (event: FormEvent) => {
    event.preventDefault();
    if (playlistDraft.trim()) void importPlaylistUrl(playlistDraft);
  };

  const hasSubtitleKey = Boolean(openSubtitlesApiKey.trim());
  const registerSettingsControl = (key: SettingsControlKey, element: HTMLElement | null) => {
    if (element) settingsControlsRef.current[key] = element;
    else delete settingsControlsRef.current[key];
  };
  const settingsFocusClass = (key: SettingsFocusKey): string => settingsFocusKey === key ? "remote-focused" : "";
  const handleSettingsFocusCapture = (event: FocusEvent<HTMLElement>) => {
    const focusKey = (event.target as HTMLElement).dataset.settingsFocus as SettingsFocusKey | undefined;
    if (focusKey) setSettingsFocusKey(focusKey);
  };
  const videoAreaFocusIndex = 1;
  const playbackToggleFocusIndex = 2;
  const restartFocusIndex = 3;
  const fullscreenFocusIndex = 4;
  const aspectFocusIndex = 5;
  const infoFocusIndex = 6;
  const subtitleSmallerFocusIndex = 7;
  const subtitleLargerFocusIndex = 8;
  const subtitleFocus = subtitleFocusLayout({
    subtitleAttached: isSubtitleAttached,
    timingAvailable: subtitleTimingAvailable,
    apiKeyConfigured: hasSubtitleKey,
    apiKeyEditorOpen: showPlayerApiKeyEditor,
    seriesSearch: subtitleSearchType === "series",
  });
  const subtitleToggleFocusIndex = subtitleFocus.subtitleToggle;
  const subtitleTimingStartFocusIndex = subtitleFocus.timingStart;
  const subtitleSettingsFocusIndex = subtitleFocus.setupKey ?? subtitleFocus.saveKey ?? subtitleFocus.search;
  const subtitleSearchFocusIndex = subtitleFocus.search;
  const subtitleSearchTypeFocusIndex = subtitleFocus.searchType;
  const subtitleSeasonFocusIndex = subtitleFocus.season;
  const subtitleEpisodeFocusIndex = subtitleFocus.episode;
  const findSubtitleFocusIndex = subtitleFocus.find;
  const firstSubtitleFocusIndex = subtitleFocus.firstResult;
  const continueActionCount = browseCollection === "recent" ? continueHistory.length * 2 : 0;
  const videoResolution = showVideoInfo ? playerRef.current?.getVideoResolution?.() ?? "Unavailable" : "";
  const details = detailsTitle ? {
    ...titleDetailsFor(detailsTitle),
    ...(detailsMetadata?.posterUrl ? { posterUrl: detailsMetadata.posterUrl } : {}),
    ...(detailsMetadata?.overview ? { synopsis: detailsMetadata.overview } : {}),
    ...(detailsMetadata?.year ? { year: detailsMetadata.year } : {}),
    ...(detailsMetadata?.genres.length ? { genres: detailsMetadata.genres } : {}),
    ...(detailsMetadata?.runtime ? { runtimeMinutes: detailsMetadata.runtime } : {}),
    ...(detailsMetadata?.rating !== null && detailsMetadata?.rating !== undefined ? { rating: detailsMetadata.rating } : {}),
    ...(detailsSubtitleLanguages.length ? { subtitleLanguages: detailsSubtitleLanguages } : {}),
  } : null;
  const detailsHistory = detailsTitle ? continueHistory.find((entry) => entry.id === detailsTitle.id) : undefined;
  const pickerSeasons = detailsTitle ? [...new Set(detailsEpisodes.map((episode) => episode.season).filter((season): season is number => season !== undefined))].sort((a, b) => a - b) : [];
  const pickerEpisodes = detailsEpisodes.filter((episode) => episodePickerSeason === undefined || episode.season === episodePickerSeason);
  const pickerOptions = episodePickerLevel === "seasons" ? pickerSeasons : pickerEpisodes;
  episodePickerOptionRefs.current.length = pickerOptions.length;

  if (state === "loading") return <main className="screen"><p role="status" aria-live="polite">{startupStatus}</p><div className="groups skeleton-grid" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <div className="skeleton-tile" key={index} />)}</div></main>;
  if (state === "storage-error") return <main className="screen">
    <h1>Catalogue unavailable</h1>
    <p role="alert">{error}</p>
    <button type="button" autoFocus onClick={() => void refreshCatalog()}>Try again</button>
  </main>;
  if (state === "importing" || state === "auto-import") return <main className="screen"><h1>Importing library</h1><p role="status" aria-live="polite">{progress}</p></main>;

  const playlistSetupForm = <form onSubmit={importPlaylist}>
    <RemoteEditable
      label="M3U playlist URL"
      value="Stored privately"
      editing={editingPlaylistUrl}
      remoteMode={isTizen}
      controlRef={(element) => { playlistControlRef.current = element; }}
      onBeginEdit={() => { setEditingPlaylistUrl(true); window.requestAnimationFrame(() => playlistUrlRef.current?.focus()); }}
      renderEditor={(controlRef) => <label htmlFor="playlist-url">M3U playlist URL<input id="playlist-url" type="password" value={playlistDraft} onChange={(event) => setPlaylistDraft(event.target.value)} autoComplete="off" ref={(element) => { playlistUrlRef.current = element; controlRef(element); }} /></label>}
    />
    <p className="hint">Stored only in this app’s private local data. Do not use a VITE environment variable for this URL.</p>
    <div className="settings-actions">
      <button type="submit" ref={importButtonRef}>Import VOD library</button>
      {(state === "ready" || playlistDraft.trim()) && <button type="button" onClick={() => { setShowPlaylistForm(false); setPlaylistDraft(""); }}>Cancel</button>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;

  const isTvTitleBrowse = state === "ready" && isTizen && Boolean(activeGroup) && !selectedTitle && !detailsTitle && !showSettings && !resumeChoice && !showPlaylistForm;
  const openCompanionTitle = (title: VodCatalogItem) => {
    // A paired companion is a global input source. Its selection must win over
    // whatever transient TV screen is open, including the player.
    setSettingsConfirmation(null);
    setShowSettings(false);
    setShowPlaylistForm(false);
    setResumeChoice(null);
    setSelectedTitle(null);
    setPlayerFullscreen(false);
    setShowFullscreenControls(false);
    setDetailsTitle(null);
    setDetailsSearchRecord(null);
    setDetailsOrigin(null);
    startPlayback(title);
  };
  return <main className={"screen" + (isTvTitleBrowse ? " tv-title-screen" : "")}>
    <header className="app-header"><div><p className="eyebrow">SUBSTREAM</p><h1>{state === "ready" ? "Your VOD library" : "Connect your IPTV playlist"}</h1></div>
      {state === "ready" && !selectedTitle && !showPlaylistForm && !showSettings && <button className={settingsButtonFocused ? "remote-focused" : ""} type="button" ref={settingsOpenButtonRef} onBlur={() => setSettingsButtonFocused(false)} onFocus={() => setSettingsButtonFocused(true)} onClick={openSettings}>Settings</button>}
    </header>
    {state !== "ready" && showPlaylistForm && playlistSetupForm}
    {state !== "ready" && !showPlaylistForm && state === "error" && <section className="setup-recovery">
      <p className="error" role="alert">{error || "The saved playlist could not be imported."}</p>
      <div className="settings-actions">
        {playlistUrl.trim() && <button type="button" ref={retryPlaylistRef} onClick={() => void importPlaylistUrl(playlistUrl)}>Retry saved playlist</button>}
        <button type="button" ref={changePlaylistRef} onClick={() => { setError(""); setPlaylistDraft(""); setShowPlaylistForm(true); }}>Change playlist</button>
      </div>
    </section>}
    {state === "ready" && isTizen && <div hidden={!showSettings}>
      <CompanionPanel playlistUrl={playlistUrl} onPlay={openCompanionTitle} editingServer={editingCompanionServer} onEditingServerChange={setEditingCompanionServer} remoteMode={isTizen} registerControl={registerSettingsControl} focusClass={settingsFocusClass} />
    </div>}
    {state === "ready" && <section>
      {showSettings ? <section className="settings-screen settings-panel" onFocusCapture={handleSettingsFocusCapture}>
        {settingsConfirmation ? <div className="modal-backdrop"><section className="confirmation-panel modal-panel" role="dialog" aria-modal="true" aria-labelledby="settings-confirm-title">
          <h2 id="settings-confirm-title">{settingsConfirmation === "clear-catalog" ? "Clear local VOD catalogue?" : settingsConfirmation === "clear-subtitles" ? "Remove saved OpenSubtitles API key?" : "Reset all local app data?"}</h2>
          <p className="hint">{settingsConfirmation === "clear-catalog"
            ? "This removes downloaded VOD catalogue records. Your saved playlist setting and playback history remain."
            : settingsConfirmation === "clear-subtitles"
              ? "This removes only the OpenSubtitles API key saved by this app. Other local catalogue and subtitle timing data remain."
              : "This removes the local catalogue, playback history, saved playlist and subtitle settings, and subtitle timing offsets. Defaults bundled into this app build remain available."}</p>
          <div className="settings-actions">
            <button className={settingsFocusClass("confirm-cancel")} data-settings-focus="confirm-cancel" type="button" ref={(element) => registerSettingsControl("confirm-cancel", element)} onClick={() => setSettingsConfirmation(null)}>Cancel</button>
            <button className={`danger-button ${settingsFocusClass("confirm-confirm")}`} data-settings-focus="confirm-confirm" type="button" ref={(element) => registerSettingsControl("confirm-confirm", element)} onClick={() => void performSettingsConfirmation()}>Confirm</button>
          </div>
        </section></div> : <>
          <h2>Settings</h2>
          <p className="hint">Playlist URLs and subtitle keys are masked on entry and are never displayed on this screen. The LAN relay address is not a credential.</p>
          <div className="settings-actions settings-primary-actions">
              <button className={settingsFocusClass("back")} data-settings-focus="back" type="button" ref={(element) => registerSettingsControl("back", element)} onClick={() => { setEditingCompanionServer(false); setShowSettings(false); }}>Back to library</button>
          </div>
          <section className="settings-section">
            <h3>Navigation and playlist</h3>
            <p className="hint">Your playlist URL is stored locally and remains masked.</p>
            <button className={settingsFocusClass("playlist")} data-settings-focus="playlist" type="button" ref={(element) => registerSettingsControl("playlist", element)} onClick={changePlaylist}>Change playlist URL</button>
          </section>
          {!isTizen && <section className="settings-section">
            <h3>TV connection</h3>
            <p className="hint">Enter the LAN relay address shown by the relay service, for example http://192.168.1.50:8787. On Vite development, an empty address uses the local /api proxy.</p>
            <label htmlFor="web-tv-relay-url">LAN relay address</label>
            <input id="web-tv-relay-url" data-settings-focus="companion-url" className={settingsFocusClass("companion-url")} type="url" value={companionServerDraft} placeholder="http://192.168.1.50:8787" autoComplete="url" onChange={(event) => setCompanionServerDraft(event.target.value)} ref={(element) => registerSettingsControl("companion-url", element)} />
            <div className="settings-actions">
              <button className={settingsFocusClass("companion-start")} data-settings-focus="companion-start" type="button" ref={(element) => registerSettingsControl("companion-start", element)} onClick={saveWebTvRelay}>Save relay address</button>
              <button type="button" onClick={() => void checkWebTvConnection()}>Check TV connection</button>
            </div>
            {webTvConnectionStatus && <p className="hint" role="status" aria-live="polite">{webTvConnectionStatus}</p>}
          </section>}
          <section className="settings-section">
            <h3>Subtitle language</h3>
            <p className="hint">Search and ranking prefer this language, then fall back to the other supported language.</p>
            <RemoteEditable label="Preferred subtitle language" value={subtitleLanguagePreference === "fi" ? "Finnish (then English)" : "English (then Finnish)"} editing={editingSubtitleLanguage} remoteMode={isTizen} className={settingsFocusClass("subtitle-language")} controlRef={(element) => { subtitleLanguageControlRef.current = element; registerSettingsControl("subtitle-language", element); }} onBeginEdit={() => { setEditingSubtitleLanguage(true); window.requestAnimationFrame(() => (subtitleLanguageControlRef.current as HTMLSelectElement | null)?.focus()); }} renderEditor={(controlRef) => <label htmlFor="subtitle-language-preference">Preferred subtitle language<select className={settingsFocusClass("subtitle-language")} data-settings-focus="subtitle-language" id="subtitle-language-preference" value={subtitleLanguagePreference} ref={(element) => { controlRef(element); subtitleLanguageControlRef.current = element; registerSettingsControl("subtitle-language", element); }} onChange={(event) => { const value = event.target.value as SubtitleLanguage; setSubtitleLanguagePreference(value); saveSubtitleLanguagePreference(value); }}><option value="fi">Finnish (then English)</option><option value="en">English (then Finnish)</option></select></label>} />
          </section>
          <section className="settings-section">
            <h3>OpenSubtitles</h3>
            <p className="hint" role="status">API key: {hasSubtitleKey ? "Configured (hidden)" : "Not configured"}</p>
            {showSettingsApiKeyEditor && <div className="subtitle-actions settings-key-editor">
              <label className="sr-only" htmlFor="settings-opensubtitles-api-key">New OpenSubtitles API key</label>
              <input className={settingsFocusClass("api-key-input")} data-settings-focus="api-key-input" id="settings-opensubtitles-api-key" type="password" value={settingsApiKeyDraft} onChange={(event) => setSettingsApiKeyDraft(event.target.value)} autoComplete="off" ref={(element) => { settingsApiKeyInputRef.current = element; registerSettingsControl("api-key-input", element); }} />
              <button className={settingsFocusClass("api-key-save")} data-settings-focus="api-key-save" type="button" ref={(element) => registerSettingsControl("api-key-save", element)} onClick={saveSettingsApiKey}>Save API key</button>
              <button className={settingsFocusClass("api-key-cancel")} data-settings-focus="api-key-cancel" type="button" ref={(element) => registerSettingsControl("api-key-cancel", element)} onClick={() => setShowSettingsApiKeyEditor(false)}>Cancel</button>
            </div>}
            {!showSettingsApiKeyEditor && <button className={settingsFocusClass("api-key-edit")} data-settings-focus="api-key-edit" type="button" ref={(element) => registerSettingsControl("api-key-edit", element)} onClick={editSettingsApiKey}>{hasSubtitleKey ? "Change OpenSubtitles API key" : "Add OpenSubtitles API key"}</button>}
            {hasSubtitleKey && <button className={`quiet-danger ${settingsFocusClass("remove-api-key")}`} data-settings-focus="remove-api-key" type="button" ref={(element) => registerSettingsControl("remove-api-key", element)} onClick={() => setSettingsConfirmation("clear-subtitles")}>Remove saved API key</button>}
          </section>
          <section className="settings-section">
            <h3>TMDb metadata</h3>
            <p className="hint">Read Access Token is preferred; the API key is an optional fallback. Credentials stay hidden.</p>
            <p className="hint" role="status">Read Access Token: {tmdbCredentials.readAccessToken ? "Configured (hidden)" : "Not configured"} · API key: {tmdbCredentials.apiKey ? "Configured (hidden)" : "Not configured"}</p>
            <div className="subtitle-actions settings-key-editor">
              <RemoteEditable label="TMDb Read Access Token" value={tmdbCredentials.readAccessToken ? "Configured (hidden)" : "Not configured"} editing={editingTmdbToken} remoteMode={isTizen} className={settingsFocusClass("tmdb-token-input")} controlRef={(element) => { tmdbTokenControlRef.current = element; registerSettingsControl("tmdb-token-input", element); }} onBeginEdit={() => { setEditingTmdbToken(true); window.requestAnimationFrame(() => settingsControlsRef.current["tmdb-token-input"]?.focus()); }} renderEditor={(controlRef) => <label htmlFor="tmdb-read-token">TMDb Read Access Token<input className={settingsFocusClass("tmdb-token-input")} data-settings-focus="tmdb-token-input" id="tmdb-read-token" type="password" placeholder="New Read Access Token" value={tmdbTokenDraft} onChange={(event) => setTmdbTokenDraft(event.target.value)} autoComplete="off" ref={(element) => { tmdbTokenControlRef.current = element; registerSettingsControl("tmdb-token-input", element); controlRef(element); }} /></label>} />
              <RemoteEditable label="TMDb API key fallback" value={tmdbCredentials.apiKey ? "Configured (hidden)" : "Not configured"} editing={editingTmdbApiKey} remoteMode={isTizen} className={settingsFocusClass("tmdb-key-input")} controlRef={(element) => { tmdbApiKeyControlRef.current = element; registerSettingsControl("tmdb-key-input", element); }} onBeginEdit={() => { setEditingTmdbApiKey(true); window.requestAnimationFrame(() => settingsControlsRef.current["tmdb-key-input"]?.focus()); }} renderEditor={(controlRef) => <label htmlFor="tmdb-api-key">TMDb API key fallback<input className={settingsFocusClass("tmdb-key-input")} data-settings-focus="tmdb-key-input" id="tmdb-api-key" type="password" placeholder="Optional API key fallback" value={tmdbApiKeyDraft} onChange={(event) => setTmdbApiKeyDraft(event.target.value)} autoComplete="off" ref={(element) => { tmdbApiKeyControlRef.current = element; registerSettingsControl("tmdb-key-input", element); controlRef(element); }} /></label>} />
              <button className={settingsFocusClass("tmdb-save")} data-settings-focus="tmdb-save" type="button" ref={(element) => registerSettingsControl("tmdb-save", element)} onClick={saveTmdbSettings}>Save TMDb settings</button>
              <button className={settingsFocusClass("tmdb-cancel")} data-settings-focus="tmdb-cancel" type="button" ref={(element) => registerSettingsControl("tmdb-cancel", element)} onClick={() => { setTmdbTokenDraft(""); setTmdbApiKeyDraft(""); }}>Clear edits</button>
            </div>
          </section>
          <section className="settings-section">
            <h3>Local catalogue data</h3>
            <p className="hint">Playback history and per-title subtitle timing are kept separately from your playlist.</p>
            <button className={settingsFocusClass("clear-catalog")} data-settings-focus="clear-catalog" type="button" ref={(element) => registerSettingsControl("clear-catalog", element)} onClick={() => setSettingsConfirmation("clear-catalog")}>Clear local VOD catalogue</button>
          </section>
          <section className="settings-section danger-zone">
            <h3>Danger zone</h3>
            <p className="hint">Resetting removes all local app data and cannot be undone.</p>
            <button className={`danger-button ${settingsFocusClass("reset-all")}`} data-settings-focus="reset-all" type="button" ref={(element) => registerSettingsControl("reset-all", element)} onClick={() => setSettingsConfirmation("reset-all")}>Reset all local app data</button>
          </section>
          {settingsStatus && <p className="hint" role="status" aria-live="polite">{settingsStatus}</p>}
        </>}
      </section> : detailsTitle && details ? <section className="title-details" aria-labelledby="title-details-heading">
        <div className="details-actions">
          <button className={`secondary-button ${detailsFocusIndex === 0 ? "remote-focused" : ""}`} type="button" ref={(element) => { detailsControlsRef.current[0] = element; }} onFocus={() => setDetailsFocusIndex(0)} onClick={closeDetails}>{detailsOrigin?.kind === "search" ? "Back to search" : "Back to titles"}</button>
          <button className={detailsFocusIndex === (detailsTitle.providerSeriesId && detailsEpisodes.length ? 2 : 1) ? "remote-focused" : ""} type="button" ref={(element) => { detailsControlsRef.current[2] = element; detailsControlsRef.current[1] = element; }} onFocus={() => setDetailsFocusIndex(detailsTitle.providerSeriesId && detailsEpisodes.length ? 2 : 1)} disabled={Boolean(detailsTitle.providerSeriesId && detailsEpisodes.length && !detailsEpisodeId)} onClick={() => void (detailsTitle.providerSeriesId ? (detailsEpisodes.length ? playSelectedSeriesEpisode() : chooseSeriesEpisodes(detailsTitle)) : playFromDetails(detailsTitle))}>{detailsTitle.providerSeriesId ? (detailsEpisodes.length ? "Play selected episode" : "Choose season and episode") : "Play here"}</button>
          {!isTizen && (detailsSearchRecord || /^xtream:(movie|series):\d{1,20}$/.test(detailsTitle.id)) && <button className={detailsFocusIndex === 3 ? "remote-focused" : ""} type="button" ref={(element) => { detailsControlsRef.current[3] = element; }} onFocus={() => setDetailsFocusIndex(3)} disabled={Boolean(detailsTitle.providerSeriesId && (!detailsEpisodes.length || !detailsEpisodeId))} onClick={() => void playSearchResultOnTv(detailsTitle.providerSeriesId ? (detailsEpisodes.find((episode) => episode.id === detailsEpisodeId) ?? detailsTitle) : detailsTitle)}>Play on TV</button>}
        </div>
        {tvPlaybackStatus && <p className="hint" role="status" aria-live="polite">{tvPlaybackStatus}</p>}
        <div className="details-layout">
          <div className="details-poster" aria-label={detailsPosterUrl || details.posterUrl ? `Poster for ${detailsTitle.title}` : "Poster unavailable"}>
            {detailsPosterUrl || details.posterUrl ? <img src={detailsPosterUrl || details.posterUrl} alt="" loading="lazy" /> : <span>Artwork unavailable</span>}
          </div>
          <div className="details-copy">
            <p className="eyebrow">{detailsTitle.contentType === "series" ? "SERIES" : "MOVIE"}</p>
            <h2 id="title-details-heading">{detailsTitle.title}</h2>
            <p className="details-facts">{details.year ?? "Year unavailable"}{details.runtimeMinutes ? ` · ${formatRuntime(details.runtimeMinutes)}` : ""}{details.rating !== undefined ? ` · ★ ${details.rating.toFixed(1)}/10` : ""}</p>
            {details.genres.length > 0 && <p className="details-genres">{details.genres.join(" · ")}</p>}
            <p className="details-synopsis">{details.synopsis ?? "Synopsis unavailable for this title."}</p>
            {details.subtitleLanguages.length > 0 ? <p className="hint">Subtitles available: {details.subtitleLanguages.join(", ")}</p> : <p className="hint">Subtitle languages will appear after searching OpenSubtitles.</p>}
            {detailsHistory && <p className="details-resume" role="status">Resume available at {formatPlaybackTime(detailsHistory.currentTimeSeconds)} of {formatPlaybackTime(detailsHistory.durationSeconds)}</p>}
            {detailsTitle.providerSeriesId && detailsEpisodes.length > 0 && <RemoteEditable label="Season / episode" value={(() => { const episode = detailsEpisodes.find((item) => item.id === detailsEpisodeId); return episode ? `${episode.season !== undefined ? `Season ${episode.season}, ` : ""}${episode.episode !== undefined ? `Episode ${episode.episode}` : episode.title}` : "Choose episode"; })()} editing={editingDetailsEpisode} remoteMode={isTizen} className={detailsFocusIndex === 1 ? "remote-focused" : ""} controlRef={(element) => { detailsEpisodeControlRef.current = element; }} onBeginEdit={() => { setEditingDetailsEpisode(true); window.requestAnimationFrame(() => detailsEpisodeSelectRef.current?.focus()); }} renderEditor={(controlRef) => <label className="details-episode-picker" htmlFor="details-episode-picker">Season / episode<select className={detailsFocusIndex === 1 ? "remote-focused" : ""} id="details-episode-picker" ref={(element) => { detailsEpisodeSelectRef.current = element; controlRef(element); }} onFocus={() => setDetailsFocusIndex(1)} value={detailsEpisodeId} onChange={(event) => setDetailsEpisodeId(event.target.value)} aria-label="Choose season and episode">{detailsEpisodes.map((episode) => <option key={episode.id} value={episode.id}>{episode.season !== undefined ? `Season ${episode.season}, ` : ""}{episode.episode !== undefined ? `Episode ${episode.episode}` : episode.title}</option>)}</select></label>} />}
          </div>
        </div>
        {episodePickerOpen && isTizen && <div className="episode-picker-backdrop" role="presentation">
          <section className="episode-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="episode-picker-heading">
            <h3 id="episode-picker-heading">{episodePickerLevel === "seasons" ? "Choose a season" : `Choose an episode (Season ${episodePickerSeason ?? "—"})`}</h3>
            <p className="hint">Use arrows to move, Action to select, Back to {episodePickerLevel === "seasons" ? "cancel" : pickerSeasons.length > 1 ? "return to seasons" : "close"}.</p>
            <div className="episode-picker-options" role="listbox" aria-label={episodePickerLevel === "seasons" ? "Seasons" : "Episodes"}>
              {pickerOptions.map((option, index) => <button
                key={typeof option === "number" ? `season-${option}` : option.id}
                className={episodePickerFocusIndex === index ? "remote-focused" : ""}
                type="button"
                role="option"
                aria-selected={typeof option !== "number" && option.id === detailsEpisodeId}
                ref={(element) => { episodePickerOptionRefs.current[index] = element; }}
                onFocus={() => setEpisodePickerFocusIndex(index)}
                onClick={() => {
                  if (typeof option === "number") {
                    setEpisodePickerSeason(option); setEpisodePickerLevel("episodes"); setEpisodePickerFocusIndex(0);
                    window.requestAnimationFrame(() => episodePickerOptionRefs.current[0]?.focus());
                  } else {
                    setDetailsEpisodeId(option.id); setEpisodePickerOpen(false); setDetailsFocusIndex(2);
                    window.requestAnimationFrame(() => detailsControlsRef.current[2]?.focus());
                  }
                }}
              >{typeof option === "number" ? `Season ${option}` : option.episode !== undefined ? `Episode ${option.episode}` : option.title}</button>)}
            </div>
          </section>
        </div>}
      </section> : resumeChoice ? <div className="modal-backdrop"><section className="resume-choice modal-panel" role="dialog" aria-modal="true" aria-labelledby="resume-title">
        <h2 id="resume-title">Continue “{resumeChoice.title.title}”?</h2>
        <p className="hint">Saved at {formatPlaybackTime(resumeChoice.history.currentTimeSeconds)} of {formatPlaybackTime(resumeChoice.history.durationSeconds)}.</p>
        <div className="settings-actions">
          <button className={resumeChoiceFocusIndex === 0 ? "remote-focused" : ""} type="button" ref={(element) => { resumeChoiceControlsRef.current[0] = element; }} onFocus={() => setResumeChoiceFocusIndex(0)} onClick={() => chooseResumeAction(true)}>Resume</button>
          <button className={resumeChoiceFocusIndex === 1 ? "remote-focused" : ""} type="button" ref={(element) => { resumeChoiceControlsRef.current[1] = element; }} onFocus={() => setResumeChoiceFocusIndex(1)} onClick={() => chooseResumeAction(false)}>Start over</button>
          <button className={resumeChoiceFocusIndex === 2 ? "remote-focused" : ""} type="button" ref={(element) => { resumeChoiceControlsRef.current[2] = element; }} onFocus={() => setResumeChoiceFocusIndex(2)} onClick={() => setResumeChoice(null)}>Cancel</button>
        </div>
      </section></div> : showPlaylistForm ? playlistSetupForm : selectedTitle ? <section className={"player-screen " + (playerFullscreen ? "is-fullscreen" : "") + (playerFullscreen && showFullscreenControls ? " has-visible-controls" : "")} onFocusCapture={(event) => {
        const target = event.target as HTMLElement;
        const controls = playerControls();
        const index = target === playerStageRef.current || playerStageRef.current?.contains(target)
          ? videoAreaFocusIndex
          : controls.indexOf(target);
        if (index >= 0) setPlayerFocusIndex(index);
      }}>
        <div className="player-heading">
          <div className="player-title"><h2>{selectedTitle.title}</h2><p className="hint">{selectedTitle.year ?? selectedTitle.contentType}</p></div>
          <button className={playerFocusIndex === 0 ? "remote-focused" : ""} type="button" onClick={() => { browseRequestRef.current.invalidate(); exitPlayerFullscreen(); setShowFullscreenControls(false); setSelectedTitle(null); }} ref={playerBackButtonRef}>Back to titles</button>
        </div>
        <div
          className={"player-stage " + (playerFocusIndex === videoAreaFocusIndex ? "video-area-focused" : "")}
          ref={playerStageRef}
          role="group"
          aria-label="Video area. Press left or right to skip while selected."
          tabIndex={0}
          onClick={() => playerStageRef.current?.focus()}
        >
          {isTizenAvPlayAvailable()
            ? <object className="player tizen-player" ref={avPlayContainerRef} type="application/avplayer" aria-label="Video player" />
            : <video className="player" autoPlay ref={videoRef} />}
          {playerFullscreen && isPlaybackBuffering && <div className="buffering-overlay" role="status" aria-live="polite">Buffering…</div>}
          {playerFullscreen && playbackStatus === "Paused" && <div className="paused-title-overlay">{selectedTitle.title}</div>}
          {showVideoInfo && <aside className="video-info-overlay" role="status" aria-live="polite"><strong>Video information</strong><span>Resolution: {videoResolution}</span></aside>}
          {visibleSubtitle && <p className="subtitle-overlay" aria-live="off" style={{ fontSize: subtitleFontSize + "rem" }}>{visibleSubtitle}</p>}
          {subtitleTimingAvailable && isSubtitleAttached && isSubtitleOffsetVisible && <div className="subtitle-offset-overlay" aria-live="polite">Subtitle offset {formatSubtitleTimingOffset(subtitleTimingOffsetSeconds)}</div>}
        </div>
        {playbackProgress && (!playerFullscreen || playbackStatus === "Paused" || isSkipFeedbackVisible) && <div className="playback-progress" aria-label="Playback progress">
          <span>{formatPlaybackTime(playbackProgress.currentTimeSeconds)}</span>
          <progress max={playbackProgress.durationSeconds} value={Math.min(playbackProgress.currentTimeSeconds, playbackProgress.durationSeconds)} aria-label="Video progress" />
          <span>{formatPlaybackTime(playbackProgress.durationSeconds)}</span>
        </div>}
        <div className="player-controls" aria-label="Playback controls">
          <button className={playerFocusIndex === playbackToggleFocusIndex ? "remote-focused" : ""} type="button" onClick={togglePlayback} aria-label={isPlaybackPaused ? "Play video" : "Pause video"} aria-pressed={!isPlaybackPaused} ref={playerTogglePlaybackButtonRef}>{isPlaybackPaused ? "Play" : "Pause"}</button>
          <button className={playerFocusIndex === restartFocusIndex ? "remote-focused" : ""} type="button" onClick={restartVideo} ref={playerRestartButtonRef}>Restart</button>
          <button className={playerFocusIndex === fullscreenFocusIndex ? "remote-focused" : ""} type="button" onClick={toggleFullscreen} ref={playerFullscreenButtonRef}>{playerFullscreen ? "Exit full screen" : "Full screen"}</button>
          <button className={playerFocusIndex === aspectFocusIndex ? "remote-focused" : ""} type="button" onClick={cycleVideoDisplayMode} ref={playerAspectButtonRef}>Aspect: {videoDisplayMode === "auto" ? "Auto" : videoDisplayMode === "fit" ? "Fit" : "Fill"}</button>
          <button className={playerFocusIndex === infoFocusIndex ? "remote-focused" : ""} type="button" onClick={() => setShowVideoInfo((visible) => !visible)} ref={playerInfoButtonRef}>Info</button>
          <button className={playerFocusIndex === subtitleSmallerFocusIndex ? "remote-focused" : ""} type="button" onClick={() => adjustSubtitleFontSize(-.2)} ref={subtitleSmallerButtonRef}>Subtitle A−</button>
          <button className={playerFocusIndex === subtitleLargerFocusIndex ? "remote-focused" : ""} type="button" onClick={() => adjustSubtitleFontSize(.2)} ref={subtitleLargerButtonRef}>Subtitle A+</button>
          {isSubtitleAttached && <button className={playerFocusIndex === subtitleToggleFocusIndex ? "remote-focused" : ""} type="button" onClick={toggleSubtitles} aria-label="Subtitles" aria-pressed={isSubtitleEnabled} ref={subtitleToggleButtonRef}>Subtitles: {isSubtitleEnabled ? "Enabled" : "Disabled"}</button>}
          <span className={"playback-status " + (playbackStatus.startsWith("Playback failed") ? "error" : "")} role="status" aria-live="polite">{playbackStatus}</span>
        </div>
        <section className="subtitles">
          <h3>Subtitles</h3>
          {subtitleTimingAvailable && <div className="subtitle-timing" aria-label="Subtitle timing controls">
            <p><strong>Current offset: {formatSubtitleTimingOffset(subtitleTimingOffsetSeconds)}</strong></p>
            <p className="hint">Positive values show subtitles later; negative values show them earlier. Saved for this title on this device.</p>
            <div className="subtitle-timing-actions">
              <button className={playerFocusIndex === subtitleTimingStartFocusIndex ? "remote-focused" : ""} type="button" onClick={() => adjustSubtitleTiming(-2)} ref={subtitleTimingMinusTwoButtonRef}>−2 s</button>
              <button className={playerFocusIndex === subtitleTimingStartFocusIndex + 1 ? "remote-focused" : ""} type="button" onClick={() => adjustSubtitleTiming(-0.5)} ref={subtitleTimingMinusHalfButtonRef}>−0.5 s</button>
              <button className={playerFocusIndex === subtitleTimingStartFocusIndex + 2 ? "remote-focused" : ""} type="button" onClick={() => adjustSubtitleTiming(0.5)} ref={subtitleTimingPlusHalfButtonRef}>+0.5 s</button>
              <button className={playerFocusIndex === subtitleTimingStartFocusIndex + 3 ? "remote-focused" : ""} type="button" onClick={() => adjustSubtitleTiming(2)} ref={subtitleTimingPlusTwoButtonRef}>+2 s</button>
            </div>
          </div>}
          {!hasSubtitleKey && <div className="subtitle-actions">
            <RemoteEditable label="OpenSubtitles API key" value="Not configured" editing={showPlayerApiKeyEditor} remoteMode={isTizen} className={playerFocusIndex === subtitleSettingsFocusIndex ? "remote-focused" : ""} controlRef={(element) => { subtitleKeyControlRef.current = element; }} onBeginEdit={showPlayerApiKeySetup} renderEditor={(controlRef) => <label htmlFor="opensubtitles-api-key">OpenSubtitles API key<input id="opensubtitles-api-key" type="password" value={openSubtitlesApiKey} onChange={(event) => setOpenSubtitlesApiKey(event.target.value)} autoComplete="off" ref={(element) => { openSubtitlesApiKeyRef.current = element; subtitleKeyInputRef.current = element; controlRef(element); }} /></label>} />
            {showPlayerApiKeyEditor && <button className={playerFocusIndex === subtitleSettingsFocusIndex ? "remote-focused" : ""} type="button" onClick={saveSubtitleSettings} ref={subtitleSaveButtonRef}>Save settings</button>}
          </div>}
          <p className="subtitle-search-heading">Subtitle search</p>
          <div className="subtitle-search-options">
            <RemoteEditable label="Title" value={subtitleSearchQuery} editing={editingSubtitleQuery} remoteMode={isTizen} className={`subtitle-search-query ${playerFocusIndex === subtitleSearchFocusIndex ? "remote-focused" : ""}`} controlRef={(element) => { subtitleSearchControlRef.current = element; }} onBeginEdit={() => { setEditingSubtitleQuery(true); window.requestAnimationFrame(() => subtitleSearchInputRef.current?.focus()); }} renderEditor={(controlRef) => <label className="subtitle-search-query" htmlFor="subtitle-search-query">Title<input id="subtitle-search-query" type="search" value={subtitleSearchQuery} onChange={(event) => setSubtitleSearchQuery(event.target.value)} autoComplete="off" enterKeyHint="search" aria-label="Subtitle search term" ref={(element) => { subtitleSearchInputRef.current = element; controlRef(element); }} /></label>} />
            <RemoteEditable label="Type" value={subtitleSearchType === "movie" ? "Movie" : "Series"} editing={editingSubtitleType} remoteMode={isTizen} className={playerFocusIndex === subtitleSearchTypeFocusIndex ? "remote-focused" : ""} controlRef={(element) => { subtitleSearchTypeControlRef.current = element; }} onBeginEdit={() => { setEditingSubtitleType(true); window.requestAnimationFrame(() => subtitleSearchTypeRef.current?.focus()); }} renderEditor={(controlRef) => <label htmlFor="subtitle-search-type">Type<select id="subtitle-search-type" value={subtitleSearchType} onChange={(event) => setSubtitleSearchType(event.target.value as SubtitleSearchType)} ref={(element) => { subtitleSearchTypeRef.current = element; controlRef(element); }}><option value="movie">Movie</option><option value="series">Series</option></select></label>} />
            {subtitleSearchType === "series" && <>
              <RemoteEditable label="Season" value={subtitleSearchSeason} editing={editingSubtitleSeason} remoteMode={isTizen} className={`subtitle-search-number ${playerFocusIndex === subtitleSeasonFocusIndex ? "remote-focused" : ""}`} controlRef={(element) => { subtitleSearchSeasonControlRef.current = element; }} onBeginEdit={() => { setEditingSubtitleSeason(true); window.requestAnimationFrame(() => subtitleSearchSeasonRef.current?.focus()); }} renderEditor={(controlRef) => <label className="subtitle-search-number" htmlFor="subtitle-search-season">Season<input id="subtitle-search-season" type="number" min="1" step="1" inputMode="numeric" value={subtitleSearchSeason} onChange={(event) => setSubtitleSearchSeason(event.target.value)} ref={(element) => { subtitleSearchSeasonRef.current = element; controlRef(element); }} /></label>} />
              <RemoteEditable label="Episode" value={subtitleSearchEpisode} editing={editingSubtitleEpisode} remoteMode={isTizen} className={`subtitle-search-number ${playerFocusIndex === subtitleEpisodeFocusIndex ? "remote-focused" : ""}`} controlRef={(element) => { subtitleSearchEpisodeControlRef.current = element; }} onBeginEdit={() => { setEditingSubtitleEpisode(true); window.requestAnimationFrame(() => subtitleSearchEpisodeRef.current?.focus()); }} renderEditor={(controlRef) => <label className="subtitle-search-number" htmlFor="subtitle-search-episode">Episode<input id="subtitle-search-episode" type="number" min="1" step="1" inputMode="numeric" value={subtitleSearchEpisode} onChange={(event) => setSubtitleSearchEpisode(event.target.value)} ref={(element) => { subtitleSearchEpisodeRef.current = element; controlRef(element); }} /></label>} />
            </>}
            <button className={playerFocusIndex === findSubtitleFocusIndex ? "remote-focused" : ""} type="button" onClick={() => void findSubtitles()} ref={findSubtitlesButtonRef}>Find subtitles</button>
          </div>
          <p className="hint">An API key permits anonymous subtitle downloads within OpenSubtitles’ daily allowance.</p>
          {subtitleStatus && <p className="hint">{subtitleStatus}</p>}
          <div className="subtitle-results">
            {subtitleResults.map((subtitle, index) => <article key={subtitle.id}>
              <strong>{subtitle.language.toUpperCase()} · {subtitle.releaseName}</strong>
              <span>{subtitle.downloads.toLocaleString()} downloads{subtitle.hearingImpaired ? " · HI" : ""}</span>
              <button className={playerFocusIndex === index + firstSubtitleFocusIndex ? "remote-focused" : ""} type="button" onClick={() => void loadSubtitle(subtitle)} ref={(element) => { subtitleButtonRefs.current[index] = element; }}>Use this subtitle</button>
            </article>)}
          </div>
        </section>
      </section> : activeGroup ? <>
        <div className="catalogue-heading">
          <div><h2 title={activeGroup.name} aria-label={activeGroup.name}>{formatGroupDisplayName(activeGroup.name)}</h2><p className="hint">{browseCount.toLocaleString()} {browseMode === "episodes" ? "episodes" : "titles"} · page {page + 1} of {browsePageCount(browseCount, PAGE_SIZE)}</p></div>
          <label className="sort-control">Sort
            <select ref={sortSelectRef} value={sort} onChange={(event) => {
              const nextSort = event.target.value as VodSort;
              setSort(nextSort);
              changeBrowsePage(0, nextSort);
            }}>
              <option value="title">Title A–Z</option>
              <option value="playlist">Playlist order</option>
              <option value="year">Release year (newest)</option>
            </select>
          </label>
          <button type="button" ref={backToGroupsRef} onClick={() => { browseRequestRef.current.invalidate(); remoteBrowseRef.current = null; browseReturnFocusPendingRef.current = true; setBrowseMode("local"); setBrowseCount(0); setActiveGroup(null); setTitles([]); setPage(0); setFocusIndex(browseReturnFocusIndexRef.current); setCatalogStatus(""); }}>Back to groups</button>
        </div>
        {isTizen && <p className="remote-key-hint tv-title-list-hint">Up/Down: previous or next title · Left/Right: previous or next page</p>}
        <div className={isTizen ? "tv-title-list-viewport" : ""} ref={isTizen ? titleListViewportRef : undefined}>
        <div className={"groups title-grid" + (isTizen ? " tv-title-list" : "")}>
          {catalogStatus && <p className="hint browse-status" role="status" aria-live="polite">{catalogStatus}</p>}
          {titles.map((title, index) => <button className={"tile " + (index === focusIndex ? "focused remote-focused" : "")} key={title.id} onClick={() => { setFocusIndex(index); void openTitle(title); }} ref={(element) => { tileRefs.current[index] = element; }} type="button">
            <strong>{title.title}</strong><span className="tile-meta">{title.season !== undefined && title.episode !== undefined ? "S" + String(title.season).padStart(2, "0") + "E" + String(title.episode).padStart(2, "0") : title.year ?? title.contentType}</span>
          </button>)}
          {!titles.length && !catalogStatus.startsWith("Loading ") && <p className="empty-state">No titles are available in this group yet.</p>}
        </div>
        </div>
        <div className="pagination">
          <button aria-label={isTizen ? "Previous page (Left)" : "Previous page"} disabled={page === 0} ref={previousPageRef} onClick={() => changeBrowsePage(page - 1)} type="button">{isTizen ? "Previous page · ←" : "Previous"}</button>
          <button aria-label={isTizen ? "Next page (Right)" : "Next page"} disabled={page + 1 >= browsePageCount(browseCount, PAGE_SIZE)} ref={nextPageRef} onClick={() => changeBrowsePage(page + 1)} type="button">{isTizen ? "Next page · →" : "Next"}</button>
        </div>
      </> : <>
        <nav className="browse-tabs" role="tablist" aria-label="Browse your library">
          {sectionOrder.map((collection, index) => <button
            aria-selected={browseCollection === collection}
            className={"browse-tab " + (browseCollection === collection ? "selected" : "")}
            key={collection}
            onClick={() => { browseTabTransitionRef.current = true; setFocusIndex(0); setBrowseCollection(collection); }}
            ref={(element) => { browseTabRefs.current[index] = element; }}
            role="tab"
            type="button"
          >{collection === "recent" ? "Recent" : collection === "movies" ? "Movies" : collection === "series" ? "Series" : collection === "search" ? "Search" : "Favourites"}</button>)}
        </nav>
        {catalogStatus && !catalogStatus.startsWith("Loading ") && <p className="hint browse-status" role="status" aria-live="polite">{catalogStatus}</p>}
        {catalogStatus.startsWith("Loading ") && <>
          <p className="hint browse-status" role="status" aria-live="polite">{catalogStatus}</p>
          <div className="groups skeleton-grid" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <div className="skeleton-tile" key={index} />)}</div>
        </>}
        {browseCollection === "recent" && continueHistory.length > 0 && <>
          <h2 className="section-heading">Continue watching</h2>
          <div className="groups continue-grid">
            {continueHistory.map((entry, index) => <Fragment key={entry.id}>
              <button className={"tile " + (index * 2 === focusIndex ? "focused remote-focused" : "")} onClick={() => { setFocusIndex(index * 2); void openHistoryEntry(entry); }} ref={(element) => { tileRefs.current[index * 2] = element; }} type="button">
                <strong>{entry.title}</strong><span>Resume · {formatPlaybackTime(entry.currentTimeSeconds)} of {formatPlaybackTime(entry.durationSeconds)}</span>
                <progress className="history-progress" max={Math.max(1, entry.durationSeconds)} value={Math.min(Math.max(0, entry.currentTimeSeconds), Math.max(1, entry.durationSeconds))} aria-label={`Watched ${formatPlaybackTime(entry.currentTimeSeconds)} of ${formatPlaybackTime(entry.durationSeconds)}`} />
              </button>
              <button className={"tile remove-history " + (index * 2 + 1 === focusIndex ? "focused remote-focused" : "")} onClick={() => { setFocusIndex(index * 2 + 1); removeHistoryEntry(entry); }} ref={(element) => { tileRefs.current[index * 2 + 1] = element; }} type="button" aria-label={`Remove ${entry.title} from Continue watching`}>
                <strong>Remove from history</strong><span>{entry.title}</span>
              </button>
            </Fragment>)}
          </div>
        </>}
        {browseCollection === "recent" && continueHistory.length === 0 && <div className="empty-state"><h2>Nothing here yet</h2><p>Titles you start watching will appear here so you can pick up where you left off.</p><button className="empty-state-action" type="button" ref={browseEmptyRecoveryRef} onClick={() => { browseTabTransitionRef.current = true; setBrowseCollection("movies"); setFocusIndex(0); }}>Browse movies</button></div>}
        {browseCollection === "search" && <section className="catalog-search" aria-labelledby="catalog-search-heading">
          <div className="collection-heading"><h2 id="catalog-search-heading">Search your catalogue</h2><p className="hint">Search your imported M3U titles and the full catalogue from your Xtream playlist.</p></div>
          <div className="catalog-search-form">
            <label htmlFor="catalog-search-input">Title</label>
            <div className="catalog-search-controls"><input id="catalog-search-input" ref={searchInputRef} type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search movies and series" autoComplete="off" /><button type="button" disabled={!searchProviderFingerprint || searchRefreshLoading} onClick={() => void refreshSearchCatalogue()}>{searchProviderFingerprint ? searchRefreshLoading ? "Refreshing catalogue…" : "Refresh Xtream catalogue" : "M3U catalogue is local"}</button></div>
          </div>
          <p className="hint" role="status" aria-live="polite">{searchStatus || (searchProviderFingerprint ? "Search is available without a TV connection. Refresh the Xtream catalogue when needed." : "Searching titles saved on this device. Add an Xtream playlist to refresh a full provider catalogue.")}</p>
          <div className="groups search-results" role="list">
            {visibleSearchItems.map((result, index) => <button className={`tile ${index === focusIndex ? "focused remote-focused" : ""}`} key={result.key} ref={(element) => { tileRefs.current[index] = element; }} type="button" role="listitem" onClick={() => result.record ? openSearchRecord(result.record, index) : openLocalSearchItem(result.item, index)}>
              <strong>{result.title}</strong><span className="tile-meta">{result.kind === "series" ? "Series" : result.kind === "movie" ? "Movie" : "Other"}{result.year ? ` · ${result.year}` : ""}{result.category ? ` · ${result.category}` : ""}</span>
            </button>)}
            {!visibleSearchItems.length && searchQuery.trim().length >= 2 && <p className="empty-state">No matching titles found.</p>}
            {!visibleSearchItems.length && searchQuery.trim().length < 2 && <p className="empty-state">Enter at least two characters to search.</p>}
          </div>
        </section>}
        {browseCollection !== "recent" && browseCollection !== "search" && <>
          <div className="collection-heading"><h2>{browseCollection === "favourites" ? "Favourite groups" : browseCollection === "movies" ? "Movies" : "Series"}</h2><p className="hint">{browseCollection === "favourites" ? "Your saved movie genres and series categories." : "Choose a group to browse its titles. Provider groups load when selected."}</p><p className="remote-key-hint">Press the red remote key to toggle the focused group as a favourite.</p>{favouriteStatus && <p className="hint" role="status" aria-live="polite">{favouriteStatus}</p>}</div>
          <div className="groups group-grid">
          {visibleGroups.map((group, index) => <div className="favourite-tile" key={group.id}><button className={"tile " + (index === focusIndex ? "focused remote-focused" : "")} onClick={() => { browseReturnFocusIndexRef.current = index; setFocusIndex(index); void openGroup(group, 0); }} ref={(element) => { tileRefs.current[index] = element; }} type="button">
            <strong title={group.name} aria-label={group.name}>{formatGroupDisplayName(group.name)}</strong><span>{group.count.toLocaleString()} titles</span>
          </button><button className="quiet-button favourite-toggle" type="button" tabIndex={isTizen ? -1 : undefined} aria-label={`${favouriteGroupIds.includes(group.id) ? "Remove" : "Add"} ${group.name} ${favouriteGroupIds.includes(group.id) ? "from" : "to"} favourites`} onFocus={() => { if (isTizen) { setFocusIndex(index); window.requestAnimationFrame(() => tileRefs.current[index]?.focus()); } }} onClick={() => toggleFavouriteForGroup(group)}>{favouriteGroupIds.includes(group.id) ? "★ Favourite" : "☆ Add favourite"}</button></div>)}
          {!visibleGroups.length && <div className="empty-state"><h2>{browseCollection === "favourites" ? "No favourite groups yet" : `No ${browseCollection === "movies" ? "movie" : "series"} groups found`}</h2><p>{browseCollection === "favourites" ? "Use the red remote key on a group, or the button on a card, to save it on this device." : `Import a library with ${browseCollection === "movies" ? "movies" : "series"} to browse titles here.`}</p><button className="empty-state-action" type="button" ref={browseEmptyRecoveryRef} onClick={() => { browseTabTransitionRef.current = true; setBrowseCollection("recent"); setFocusIndex(0); }}>Browse recent</button></div>}
          </div>
        </>}
      </>}
    </section>}
  </main>;
}
