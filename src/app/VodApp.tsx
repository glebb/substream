import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type FocusEvent, type FormEvent, type SetStateAction } from "react";
import { importM3uChunks, normalizeTitle, type VodCatalogItem } from "../core/catalog/index.ts";
import { DEFAULT_MAX_WHOLE_RESPONSE_BYTES, responseTextChunks, validateWholeResponseFallback, WholeResponseFallbackError } from "../platform/browser/fetch-chunks.ts";
import { clearSavedPlaylistUrl, loadPlaylistUrl, savePlaylistUrl } from "../platform/browser/playlist-config.ts";
import { isBackKey, isRedKey, isTizenRuntime, normalizedRemoteKey, registerTizenPlaybackKeys } from "../platform/tizen/remote.ts";
import { IndexedDbCatalogOpenError, IndexedDbCatalogStore, type VodGroup, type VodSort } from "../platform/web/indexed-db-catalog.ts";
import { HtmlVideoPlayer } from "../platform/browser/html-video-player.ts";
import type { AudioTrack, MediaPlayer, PlaybackProgress, VideoDisplayMode } from "../platform/media-player.ts";
import { isTizenAvPlayAvailable, TizenAvPlayPlayer } from "../platform/tizen/avplay-player.ts";
import { clearSavedOpenSubtitlesSettings, loadOpenSubtitlesApiKey, saveOpenSubtitlesApiKey } from "../platform/browser/opensubtitles-config.ts";
import { OpenSubtitlesClient, OpenSubtitlesRequestError, type SubtitleResult } from "../platform/opensubtitles/client.ts";
import { rankSubtitleResults } from "../core/subtitles/rank.ts";
import { adjustSubtitleOffsetSeconds } from "../core/subtitles/timing.ts";
import { XtreamClient } from "../platform/xtream/client.ts";
import { fetchProviderPlaylist } from "../platform/browser/provider-fetch.ts";
import { clearSubtitleTimingOffsets, loadSubtitleTimingOffset, saveSubtitleTimingOffset } from "../platform/browser/subtitle-timing-config.ts";
import { clearSubtitlePreferences, loadSubtitlePreferences, saveLastSubtitleLanguage, saveSubtitleFontSize, saveSubtitleLanguagePreference, type SubtitleLanguage } from "../platform/browser/subtitle-preferences.ts";
import { clearCatalogClearedMarker, markCatalogCleared, wasCatalogCleared } from "../platform/browser/catalog-preferences.ts";
import { clearFavouriteGroups, defaultFavouriteGroupIds, hasSavedFavouriteGroupIds, loadFavouriteGroupIds, saveFavouriteGroupIds, setFavouriteGroup } from "../platform/browser/favourites-config.ts";
import { clearPlaybackProgress, loadPlaybackHistory, removePlaybackProgress, savePlaybackProgress, type PlaybackHistoryItem } from "../platform/browser/playback-progress-config.ts";
import { LatestVodLoader } from "../platform/browser/latest-vod.ts";
import { APP_SECTION_ORDER, BrowseRequestGate, browseGroupsForCollection, browsePageCount, favouriteGroupsFirst, favouriteToggleFocusIndex, groupsWithLatest, isLatestVirtualGroup, latestVirtualGroup, sortAndPageBrowseItems, type AppSection } from "./browse.ts";
import { formatCategoryBadge, formatGroupDisplayName } from "./display-formatting.ts";
import { TitleMetadataExtras } from "./TitleMetadataExtras.tsx";
import { formatRuntime, titleDetailsFor } from "./title-details.ts";
import { clearSavedTmdbCredentials, loadTmdbCredentials, saveTmdbCredentials } from "../platform/browser/tmdb-config.ts";
import { TmdbClient, type TmdbMetadata } from "../platform/tmdb/client.ts";
import { TmdbArtworkCache, TmdbImageCache, TmdbMetadataCache } from "../platform/browser/tmdb-cache.ts";
import { actionRowNavigationTarget, browseCollectionFocusIndex, browseCollectionFocusTarget, browseGridColumnCount, detailsControlNavigationTarget, fullscreenControlNavigationTarget, gridNavigationTarget, homeBrowseFocusTarget, isPlayerPlaybackShortcut, nestedScreenSettingsTarget, playerTextEntryNavigationKey, recentNavigationTarget, remoteEditableKeyAction, resolveAppBackAction, screenNavigationTarget, settingsControlOrder, shouldHandleHeldTitleKeyRepeat, subtitleFocusLayout, type HeldTitleKeyState, type SettingsControlKey } from "./remote-navigation.ts";
import { focusPageItem, focusTitleListItem } from "./title-list-focus.ts";
import { RemoteEditable } from "./remote-editable.tsx";
import "./app.css";
import { CompanionPanel } from "./CompanionPanel.tsx";
import { createBrowserSearchClient, searchSafeRecords, toVodCatalogItem, type SafeSearchRecord } from "../platform/companion/search-catalog.ts";
import { companionDeviceLabel, companionServerUrl, CompanionConnectionError, getCompanionConnection, redeemCompanionCode, saveCompanionDeviceLabel, saveCompanionServerUrl, sendCompanionPlayback, stageLocalMedia, sendLocalCompanionPlayback, sendStopLocalCompanionPlayback, stopLocalMedia, getLocalMediaUploadStatus, getLocalMediaSubtitle, publishLocalMediaSubtitle, companionLocalMediaUrl, renewLocalMediaLease, reportLocalMediaState, isLanCompanionAddress, type BrowserCompanionConnection, type CompanionPlaybackSelection, type CompanionLocalPlayback, type CompanionLocalSubtitle, type LocalMediaUploadStatus } from "../platform/companion/client.ts";
import { LiveRelaySettings } from "./LiveRelaySettings.tsx";
import { clearLiveRelayConfig, loadLiveRelayConfig, saveLiveRelayConfig, type NormalizedLiveRelayConfig } from "../platform/live-relay/config.ts";
import { createAbortController } from "../platform/abort-controller.ts";
import { LanguageContext, Localized, translate, type UiLanguage } from "./language.tsx";
import { LocalMediaSource, classifyLocalFilename, localDisplayTitle, localSubtitleQuery } from "../platform/browser/local-media-source.ts";
import { readLocalSubtitleFile } from "../platform/browser/local-subtitle-file.ts";
import { loadPreferredLocalSubtitle, type LocalSubtitleSnapshot } from "../platform/browser/local-subtitle-match.ts";
import { ScreenNavigation } from "./ScreenNavigation.tsx";
import { useFixedListRowHeight } from "./fixed-list-sizing.ts";

type ScreenState = "loading" | "auto-import" | "ready" | "importing" | "error" | "storage-error";
const PAGE_SIZE = 16;
const OPEN_SUBTITLES_BASE_URL = import.meta.env.DEV ? "/opensubtitles-api/api/v1" : undefined;
const PLAYBACK_UNAVAILABLE_MESSAGE = "The provider or network did not return playable media for this title. Try another title or retry later.";
const LOCAL_PLAYBACK_ERROR_MESSAGE = "This browser could not decode the local video. Try another file or Play on TV.";
type BrowseMode = "local" | "provider" | "episodes" | "latest";
type SettingsConfirmation = "clear-catalog" | "clear-subtitles" | "reset-all";
type SettingsFocusKey = SettingsControlKey;
type SubtitleSearchType = "movie" | "series";
type BrowseControlFocus = "back" | "latest-refresh" | "previous-page" | "next-page" | null;
type BrowseArtworkTarget = Pick<VodCatalogItem, "id" | "title" | "searchTitle" | "year" | "contentType">;

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

function subtitleApiKeyTag(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return value.length + ":" + (hash >>> 0).toString(36);
}

function safeSourceFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function sortLabel(sort: VodSort): string {
  if (sort === "title") return "Title A–Z";
  if (sort === "year") return "Release year (newest)";
  return "Playlist order";
}

function BrowseArtwork({ title, image }: { title: string; image: string | null | undefined }) {
  const initial = title.trim().charAt(0).toLocaleUpperCase() || "?";
  return <span className="browse-artwork" aria-hidden="true">
    {image ? <img src={image} alt="" decoding="async" loading="lazy" /> : <span className="browse-artwork-placeholder">{initial}</span>}
  </span>;
}

function artworkLookupKey(title: Pick<BrowseArtworkTarget, "title" | "searchTitle" | "year" | "contentType">): string | null {
  if (title.contentType === "other") return null;
  const normalized = normalizeTitle(title.title);
  const query = normalized.searchTitle || title.searchTitle || title.title;
  return `${title.contentType === "series" ? "tv" : "movie"}:${query.toLocaleLowerCase()}:${title.year ?? ""}`;
}

export type VodAppProps = { onMainMenu(): void; onPlaylistSetup(): void; settingsOnOpen?: boolean; localSource?: LocalMediaSource | null; onChooseLocalFile?(): void; browserCompanions: BrowserCompanionConnection[]; setBrowserCompanions: Dispatch<SetStateAction<BrowserCompanionConnection[]>>; selectedTvDeviceId: string; setSelectedTvDeviceId: Dispatch<SetStateAction<string>> };

export function VodApp({ onMainMenu, onPlaylistSetup, settingsOnOpen = false, localSource = null, onChooseLocalFile, browserCompanions, setBrowserCompanions, selectedTvDeviceId, setSelectedTvDeviceId }: VodAppProps) {
  const { language, setLanguage } = useContext(LanguageContext);
  const subtitleTimingAvailable = true;
  // The Chromium 47 preview exercises the TV layout and remote flow without
  // claiming that Tizen media APIs are present in the browser container.
  const isTizen = isTizenRuntime() || __SUBSTREAM_TV_UI_PREVIEW__;
  const sectionOrder = isTizen ? APP_SECTION_ORDER.filter((section) => section !== "search") : APP_SECTION_ORDER;
  const [state, setState] = useState<ScreenState>(settingsOnOpen || localSource ? "ready" : "loading");
  const [startupStatus, setStartupStatus] = useState("Opening catalogue…");
  const [playlistUrl, setPlaylistUrl] = useState(loadPlaylistUrl);
  const latestPlaylistUrlRef = useRef(playlistUrl);
  latestPlaylistUrlRef.current = playlistUrl;
  const [groups, setGroups] = useState<VodGroup[]>([]);
  const [activeGroup, setActiveGroup] = useState<VodGroup | null>(null);
  const [titles, setTitles] = useState<VodCatalogItem[]>([]);
  const [page, setPage] = useState(0);
  const pageRef = useRef(page);
  pageRef.current = page;
  const [sort, setSort] = useState<VodSort>("playlist");
  const [sortDraft, setSortDraft] = useState<VodSort>("playlist");
  const [editingSort, setEditingSort] = useState(false);
  const [browseMode, setBrowseMode] = useState<BrowseMode>("local");
  const [browseCollection, setBrowseCollection] = useState<AppSection>("recent");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchRecords, setSearchRecords] = useState<SafeSearchRecord[]>([]);
  const [localSearchRecords, setLocalSearchRecords] = useState<VodCatalogItem[]>([]);
  const [localSearchSourceUrl, setLocalSearchSourceUrl] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const [searchRefreshLoading, setSearchRefreshLoading] = useState(false);
  const [detailsOrigin, setDetailsOrigin] = useState<{ kind: "browse" | "search" | "local"; focusIndex: number } | null>(null);
  const [detailsSearchRecord, setDetailsSearchRecord] = useState<SafeSearchRecord | null>(null);
  const [tvPlaybackStatus, setTvPlaybackStatus] = useState("");
  const [localUpload, setLocalUpload] = useState<{ session: LocalMediaUploadStatus | null; sentBytes: number; totalBytes: number; state: "idle" | "uploading" | "preparing" | "ready" }>({ session: null, sentBytes: 0, totalBytes: 0, state: "idle" });
  const localUploadControllerRef = useRef<AbortController | null>(null);
  const localComputerStartPendingRef = useRef(false);
  type ActiveLocalTvSession = { media: CompanionLocalPlayback; server: string; tvCredential: string; playbackState: "preparing" | "playing" | "paused" | "ended" | "failed" | "stopped" };
  const remoteLocalMediaRef = useRef<ActiveLocalTvSession | null>(null);
  const pendingRemoteLocalStopsRef = useRef(new Map<string, ActiveLocalTvSession>());
  const [activeRemoteLocalMedia, setActiveRemoteLocalMedia] = useState<ActiveLocalTvSession | null>(null);
  const searchRefreshRequestRef = useRef(0);
  const searchRefreshControllerRef = useRef<AbortController | null>(null);
  const [favouriteGroupIds, setFavouriteGroupIds] = useState<string[]>(loadFavouriteGroupIds);
  const visibleGroups = useMemo(() => browseCollection === "recent" || browseCollection === "search" ? [] : browseCollection === "movies" || browseCollection === "series" ? groupsWithLatest(groups, browseCollection, favouriteGroupIds) : favouriteGroupsFirst(groups.filter((group) => favouriteGroupIds.includes(group.id)), favouriteGroupIds), [browseCollection, favouriteGroupIds, groups]);
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
  const [selectedTitleSource, setSelectedTitleSource] = useState<"catalogue" | "local">("catalogue");
  const [nextEpisode, setNextEpisode] = useState<VodCatalogItem | null>(null);
  const [detailsTitle, setDetailsTitle] = useState<VodCatalogItem | null>(null);
  const [localDetailsSearchTitle, setLocalDetailsSearchTitle] = useState("");
  const [detailsMetadata, setDetailsMetadata] = useState<TmdbMetadata | null>(null);
  const [detailsMetadataStatus, setDetailsMetadataStatus] = useState("");
  const [detailsSubtitleLanguages, setDetailsSubtitleLanguages] = useState<string[]>([]);
  const [detailsPosterUrl, setDetailsPosterUrl] = useState<string | null>(null);
  const [detailsEpisodes, setDetailsEpisodes] = useState<VodCatalogItem[]>([]);
  const [detailsEpisodeId, setDetailsEpisodeId] = useState("");
  const [episodeStatus, setEpisodeStatus] = useState("");
  const [editingDetailsEpisode, setEditingDetailsEpisode] = useState(false);
  const [detailsFocusIndex, setDetailsFocusIndex] = useState(0);
  const [episodePickerOpen, setEpisodePickerOpen] = useState(false);
  const [episodePickerLevel, setEpisodePickerLevel] = useState<"seasons" | "episodes">("seasons");
  const [episodePickerSeason, setEpisodePickerSeason] = useState<number | undefined>(undefined);
  const [episodePickerFocusIndex, setEpisodePickerFocusIndex] = useState(0);
  const [resumeChoice, setResumeChoice] = useState<{ title: VodCatalogItem; history: PlaybackHistoryItem; nextEpisode: VodCatalogItem | null } | null>(null);
  const [continueHistory, setContinueHistory] = useState<PlaybackHistoryItem[]>(loadPlaybackHistory);
  const [pendingHistoryRemoval, setPendingHistoryRemoval] = useState<PlaybackHistoryItem | null>(null);
  const historyCancelRef = useRef<HTMLButtonElement | null>(null);
  const historyConfirmRef = useRef<HTMLButtonElement | null>(null);
  const [showSettings, setShowSettings] = useState(settingsOnOpen);
  const [settingsConfirmation, setSettingsConfirmation] = useState<SettingsConfirmation | null>(null);
  const [settingsStatus, setSettingsStatus] = useState("");
  const [liveRelayConfig, setLiveRelayConfig] = useState<NormalizedLiveRelayConfig | null>(loadLiveRelayConfig);
  const [editingCompanionServer, setEditingCompanionServer] = useState(false);
  const [editingUiLanguage, setEditingUiLanguage] = useState(false);
  const uiLanguageControlRef = useRef<HTMLElement | null>(null);
  const [companionServerDraft, setCompanionServerDraft] = useState(companionServerUrl);
  const [webTvConnectionStatus, setWebTvConnectionStatus] = useState("");
  const [webTvPairingCode, setWebTvPairingCode] = useState("");
  const [webTvPairingName, setWebTvPairingName] = useState("");
  const browserCompanion = browserCompanions.find((connection) => connection.deviceId === selectedTvDeviceId) ?? null;
  const [showVideoInfo, setShowVideoInfo] = useState(false);
  const [showPlayerTools, setShowPlayerTools] = useState(false);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
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
  const [browseArtwork, setBrowseArtwork] = useState<Record<string, string | null>>({});
  const [browseControlFocus, setBrowseControlFocus] = useState<BrowseControlFocus>(null);
  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const browseTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const retryPlaylistRef = useRef<HTMLButtonElement | null>(null);
  const mainMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousButtonRef = useRef<HTMLButtonElement | null>(null);
  const browseEmptyRecoveryRef = useRef<HTMLButtonElement | null>(null);
  const browseTabTransitionRef = useRef<"menu" | "content" | null>(null);
  const browseReturnFocusIndexRef = useRef(0);
  const browseReturnFocusPendingRef = useRef(false);
  const settingsControlsRef = useRef<Partial<Record<SettingsControlKey, HTMLElement | null>>>({});
  const resumeChoiceControlsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const detailsControlsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const detailsEpisodeSelectRef = useRef<HTMLSelectElement | null>(null);
  const webEpisodeSelectionChangedRef = useRef(false);
  const detailsEpisodeControlRef = useRef<HTMLElement | null>(null);
  const episodePickerOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const detailsRequestRef = useRef(0);
  const sortSelectRef = useRef<HTMLSelectElement | null>(null);
  const sortControlRef = useRef<HTMLElement | null>(null);
  const sortReloadFocusGuardRef = useRef(false);
  const backToGroupsRef = useRef<HTMLButtonElement | null>(null);
  const latestRefreshRef = useRef<HTMLButtonElement | null>(null);
  const previousPageRef = useRef<HTMLButtonElement | null>(null);
  const nextPageRef = useRef<HTMLButtonElement | null>(null);
  const playerBackButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerTogglePlaybackButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerRestartButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerNextEpisodeButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerFullscreenButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerAspectButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerInfoButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerTechnicalInfoButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerAudioTrackButtonRef = useRef<HTMLButtonElement | null>(null);
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
  const localSubtitleInputRef = useRef<HTMLInputElement | null>(null);
  const subtitleSearchTypeRef = useRef<HTMLSelectElement | null>(null);
  const subtitleSearchSeasonRef = useRef<HTMLInputElement | null>(null);
  const subtitleSearchEpisodeRef = useRef<HTMLInputElement | null>(null);
  const subtitleSearchControlRef = useRef<HTMLElement | null>(null);
  const subtitleSearchTypeControlRef = useRef<HTMLElement | null>(null);
  const subtitleSearchSeasonControlRef = useRef<HTMLElement | null>(null);
  const subtitleSearchEpisodeControlRef = useRef<HTMLElement | null>(null);
  const findSubtitlesButtonRef = useRef<HTMLButtonElement | null>(null);
  const openLocalSubtitleButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleSaveButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsApiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const subtitleLanguageControlRef = useRef<HTMLElement | null>(null);
  const tmdbTokenControlRef = useRef<HTMLElement | null>(null);
  const tmdbApiKeyControlRef = useRef<HTMLElement | null>(null);
  const subtitleButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const subtitleRequestRef = useRef(0);
  const localSubtitleSnapshotRef = useRef<Omit<CompanionLocalSubtitle, "version"> | null>(null);
  const localSubtitlePreparationRef = useRef<{ sourceUrl: string; query: string; preference: SubtitleLanguage; apiKeyTag: string; promise: Promise<LocalSubtitleSnapshot | null>; cancel: () => void } | null>(null);
  const localAutomaticSubtitleRef = useRef<{ sourceUrl: string; query: string; preference: SubtitleLanguage; apiKeyTag: string } | null>(null);
  const localSubtitlePublishQueueRef = useRef<Promise<void>>(Promise.resolve());
  const remoteSubtitleVersionRef = useRef<{ sessionId: string; version: number } | null>(null);
  const browseRequestRef = useRef(new BrowseRequestGate());
  const latestLoaderRef = useRef(new LatestVodLoader());
  const latestRequestRef = useRef(0);
  const latestLoadingRequestRef = useRef<number | null>(null);
  useEffect(() => { latestLoaderRef.current.invalidate(); latestRequestRef.current += 1; }, [playlistUrl, groups, favouriteGroupIds]);
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

  // Resolve only the first visible stretch of a view. The cache makes a
  // revisit instant, while this cap keeps a provider page from
  // competing with playback or remote navigation on older Tizen hardware.
  const browseArtworkTargets = useMemo<BrowseArtworkTarget[]>(() => {
    if (activeGroup) return titles;
    if (browseCollection === "search") return visibleSearchItems.map((result) => result.item);
    if (browseCollection === "recent") return continueHistory.map((entry) => ({
      id: entry.id, title: entry.title, searchTitle: entry.title, year: entry.year,
      contentType: entry.contentType,
    }));
    return [];
  }, [activeGroup, browseCollection, continueHistory, titles, visibleSearchItems]);

  useEffect(() => {
    if (!tmdbCredentials.readAccessToken && !tmdbCredentials.apiKey) return;
    const hasArtwork = (id: string) => Object.prototype.hasOwnProperty.call(browseArtwork, id);
    const pending = browseArtworkTargets.filter((item) => !hasArtwork(item.id)).slice(0, isTizen ? 8 : 16);
    if (!pending.length) return;
    let cancelled = false;
    const client = new TmdbClient(tmdbCredentials, undefined, import.meta.env.DEV ? "/tmdb-api" : undefined);
    const artworkCache = new TmdbArtworkCache();
    const load = async (item: BrowseArtworkTarget) => {
      if (item.contentType === "other") return null;
      const mediaType = item.contentType === "series" ? "tv" : "movie";
      const normalized = normalizeTitle(item.title);
      const query = normalized.searchTitle || item.searchTitle || item.title;
      const key = artworkLookupKey(item);
      if (!key) return null;
      let posterUrl = artworkCache.get(key);
      if (posterUrl === undefined) {
        try {
          const resolved = await client.resolve(query, mediaType, item.year);
          posterUrl = resolved.kind === "match" ? resolved.candidate.posterUrl : null;
        } catch { posterUrl = null; }
        artworkCache.set(key, posterUrl);
      }
      // Let the browser load the small poster asynchronously. Converting image
      // bytes to a data URL blocks Chromium 47's main thread and makes remote
      // navigation hitch while a page is being painted.
      return posterUrl;
    };
    const workers = Array.from({ length: Math.min(2, pending.length) }, async () => {
      const loaded: Array<{ id: string; image: string | null }> = [];
      while (!cancelled && pending.length) {
        const item = pending.shift();
        if (!item) break;
        const image = await load(item);
        if (!cancelled) loaded.push({ id: item.id, image });
      }
      return loaded;
    });
    void Promise.all(workers).then((completed) => {
      if (cancelled) return;
      const loaded = completed.reduce<Array<{ id: string; image: string | null }>>((all, items) => all.concat(items), []);
      if (!loaded.length) return;
      setBrowseArtwork((previous) => {
        const next = { ...previous };
        for (const item of loaded) if (!Object.prototype.hasOwnProperty.call(next, item.id)) next[item.id] = item.image;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [browseArtwork, browseArtworkTargets, isTizen, tmdbCredentials]);

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
      ...(nextEpisode ? [playerNextEpisodeButtonRef.current] : []),
      playerFullscreenButtonRef.current,
      subtitleToggleButtonRef.current,
      playerInfoButtonRef.current,
    ];
    if (!showPlayerTools) return playbackControls.filter(Boolean) as HTMLElement[];
    return [
      ...playbackControls,
      playerAspectButtonRef.current,
      playerTechnicalInfoButtonRef.current,
      playerAudioTrackButtonRef.current,
      subtitleSmallerButtonRef.current,
      subtitleLargerButtonRef.current,
      ...(selectedTitleSource === "local" ? [openLocalSubtitleButtonRef.current] : []),
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
    if (!settingsOnOpen) setState("loading");
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
      } else if (settingsOnOpen) {
        setGroups(await store.groups());
        setState("ready");
      } else if (wasCatalogCleared()) {
        setGroups(await store.groups());
        setCatalogStatus("The local VOD catalogue is empty. Import a playlist to fill it again.");
        setState("ready");
      } else {
        if (playlistUrl.trim()) setState("auto-import");
        else onPlaylistSetup();
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
    if (localSource) return;
    void refreshCatalog();
  }, []);

  useEffect(() => {
    if (!localSource) return;
    const subtitleQuery = localSubtitleQuery(localSource.name);
    const titleText = subtitleQuery || localDisplayTitle(localSource.name);
    const normalized = normalizeTitle(titleText);
    const filenameClass = classifyLocalFilename(localSource.name);
    setLocalDetailsSearchTitle(subtitleQuery || normalized.searchTitle);
    localSubtitlePreparationRef.current?.cancel();
    localSubtitleSnapshotRef.current = null;
    localAutomaticSubtitleRef.current = null;
    remoteSubtitleVersionRef.current = null;
    const title: VodCatalogItem = {
      id: `temporary-local-title-${Date.now().toString(36)}`,
      title: titleText,
      searchTitle: localSubtitleQuery(localSource.name) || normalized.searchTitle,
      searchTerms: normalized.searchTitle ? [normalized.searchTitle] : [],
      year: normalized.year,
      group: "Local file",
      contentType: filenameClass.contentType,
      ...(filenameClass.season !== undefined ? { season: filenameClass.season } : {}),
      ...(filenameClass.episode !== undefined ? { episode: filenameClass.episode } : {}),
      classification: { kind: filenameClass.contentType === "series" ? "vod" : "unknown", confidence: filenameClass.contentType === "series" ? "high" : "low", evidence: filenameClass.evidence },
      addedAt: Date.now(),
      streamUrl: localSource.url || "",
      sourceLine: 0,
    };
    setSelectedTitle(null);
    void openTitle(title, { kind: "local", focusIndex: 0 });
    const apiKey = openSubtitlesApiKey.trim();
    if (apiKey && title.searchTitle) {
      const sourceUrl = localSource.url ?? "";
      const requestController = createAbortController();
      const client = new OpenSubtitlesClient(apiKey, (url, init) => fetch(url, { ...init, signal: requestController?.signal ?? init.signal ?? null }), OPEN_SUBTITLES_BASE_URL);
      const promise = loadPreferredLocalSubtitle(
        client,
        { title: title.searchTitle, year: title.year, contentType: filenameClass.contentType === "series" ? "series" : "movie", ...(filenameClass.season !== undefined ? { season: filenameClass.season } : {}), ...(filenameClass.episode !== undefined ? { episode: filenameClass.episode } : {}) },
        subtitleLanguagePreference,
        { ...(requestController?.signal ? { signal: requestController.signal } : {}), abortRequest: () => requestController?.abort(), timeoutMs: 15_000 },
      ).catch(() => null);
      const preparation = { sourceUrl, query: title.searchTitle, preference: subtitleLanguagePreference, apiKeyTag: subtitleApiKeyTag(apiKey), promise, cancel: () => requestController?.abort() };
      localSubtitlePreparationRef.current = preparation;
      void promise.then((prepared) => {
        if (!prepared || localSubtitlePreparationRef.current !== preparation || localSubtitleSnapshotRef.current !== null) return;
        const { text, label, language, enabled, offsetSeconds } = prepared;
        localSubtitleSnapshotRef.current = { text, label, language, enabled, offsetSeconds };
        localAutomaticSubtitleRef.current = { sourceUrl, query: title.searchTitle, preference: subtitleLanguagePreference, apiKeyTag: preparation.apiKeyTag };
      });
    } else {
      localSubtitlePreparationRef.current = null;
    }
    setTvPlaybackStatus("");
  }, [localSource]);

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
    else onPlaylistSetup();
  }, [onPlaylistSetup, playlistUrl, state]);

  const openLatest = async (contentType: "movie" | "series", force = false) => {
    if (force && latestLoadingRequestRef.current === latestRequestRef.current) return;
    const virtualGroup = latestVirtualGroup(contentType);
    const request = ++latestRequestRef.current;
    latestLoadingRequestRef.current = request;
    browseRequestRef.current.invalidate();
    remoteBrowseRef.current = null;
    setBrowseMode("latest");
    setActiveGroup(virtualGroup);
    setTitles([]);
    setBrowseCount(0);
    setPage(0);
    setFocusIndex(0);
    setCatalogStatus("Loading Latest…");
    let sourceVersion = "";
    try {
      const store = await IndexedDbCatalogStore.open();
      try {
        const metadata = await store.metadata();
        sourceVersion = `${metadata.activeGeneration ?? ""}:${metadata.importedAt ?? ""}`;
      } finally { store.close(); }
    } catch { /* provider-only categories may not have local catalogue metadata */ }
    if (request !== latestRequestRef.current) return;
    const provider = XtreamClient.fromPlaylistUrl(playlistUrl);
    const sourceKey = `${provider?.pairingFingerprint() ?? safeSourceFingerprint(playlistUrl)}:${sourceVersion}`;
    const loaderOptions = {
      sourceKey,
      contentType,
      groups,
      favouriteIds: favouriteGroupIds,
      force,
      loadGroup: async (group: VodGroup) => {
        if (group.providerCategoryId && group.providerContentType) {
          if (!provider) throw new Error("Provider unavailable");
          const items = group.providerContentType === "movie"
            ? await provider.movies(group.providerCategoryId)
            : await provider.series(group.providerCategoryId);
          return items.map((item) => ({ ...item, group: group.name }));
        }
        const store = await IndexedDbCatalogStore.open();
        try { return await store.byGroupPage(group.name, 0, group.count, "playlist"); }
        finally { store.close(); }
      },
    };
    const cached = latestLoaderRef.current.peek(loaderOptions);
    if (cached) {
      remoteBrowseRef.current = { key: "latest:" + contentType, items: cached.items };
      setTitles(cached.items.slice(0, PAGE_SIZE));
      setBrowseCount(cached.items.length);
      setCatalogStatus(force ? "Refreshing Latest…" : cached.items.length.toLocaleString() + " titles ready");
    }
    const result = await latestLoaderRef.current.load(loaderOptions);
    if (request !== latestRequestRef.current) return;
    latestLoadingRequestRef.current = null;
    remoteBrowseRef.current = { key: "latest:" + contentType, items: result.items };
    const lastPage = Math.max(0, Math.ceil(result.items.length / PAGE_SIZE) - 1);
    const currentPage = Math.min(pageRef.current, lastPage);
    const pageItems = result.items.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
    setPage(currentPage);
    setTitles(pageItems);
    setFocusIndex((index) => Math.max(0, Math.min(index, pageItems.length - 1)));
    setBrowseCount(result.items.length);
    setCatalogStatus(result.groupCount === 0 ? "Favourite categories to see Latest titles." : result.failedGroups ? `Latest loaded with ${result.failedGroups} unavailable ${result.failedGroups === 1 ? "category" : "categories"}.` : result.items.length.toLocaleString() + " titles ready");
  };

  const openGroup = async (group: VodGroup, targetPage: number, targetSort = sort, focusAtEnd = false) => {
    if (isLatestVirtualGroup(group)) { void openLatest(group.contentType === "series" ? "series" : "movie"); return; }
    latestRequestRef.current += 1;
    if (group.providerCategoryId && group.providerContentType) {
      const key = "provider:" + group.providerContentType + ":" + group.providerCategoryId;
      let items = remoteBrowseRef.current?.key === key ? remoteBrowseRef.current.items : null;
      if (!items) {
        const client = XtreamClient.fromPlaylistUrl(playlistUrl);
        if (!client) {
          setCatalogStatus("Provider catalogue is unavailable. Re-import the playlist to use the M3U fallback.");
          return;
        }
        setCatalogStatus("Loading " + (isLatestVirtualGroup(group) ? translate("Latest", language) : formatGroupDisplayName(group.name, language)) + " from the provider…");
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
    setCatalogStatus("Loading " + (isLatestVirtualGroup(group) ? translate("Latest", language) : formatGroupDisplayName(group.name, language)) + "…");
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

  const startPlayback = (title: VodCatalogItem, resumeSeconds = 0, followingEpisode: VodCatalogItem | null = null, source: "catalogue" | "local" = "catalogue") => {
    latestRequestRef.current += 1;
    browseRequestRef.current.invalidate();
    resumeStartSecondsRef.current = resumeSeconds;
    playbackProgressRef.current = null;
    lastPersistedAtRef.current = 0;
    setResumeChoice(null);
    setShowVideoInfo(false);
    setShowPlayerTools(false);
    setAudioTracks([]);
    setPlayerFocusIndex(0);
    setNextEpisode(followingEpisode);
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
    setSubtitleTimingOffsetSeconds(source === "local" ? 0 : loadSubtitleTimingOffset(title.id));
    setSubtitleFontSize(loadSubtitlePreferences().fontSize);
    const titleForSearch = normalizeTitle(title.title);
    setSubtitleSearchQuery(source === "local" ? localDetailsSearchTitle || title.searchTitle : titleForSearch.searchTitle || title.searchTitle);
    setSubtitleSearchType(title.contentType === "series" ? "series" : "movie");
    setSubtitleSearchSeason(String(title.season ?? titleForSearch.season ?? ""));
    setSubtitleSearchEpisode(String(title.episode ?? titleForSearch.episode ?? ""));
    setEditingSubtitleQuery(false);
    setEditingSubtitleType(false);
    setEditingSubtitleSeason(false);
    setEditingSubtitleEpisode(false);
    setShowPlayerApiKeyEditor(false);
    setSelectedTitleSource(source);
    setSelectedTitle(title);
  };

  const openTitle = async (title: VodCatalogItem, origin: { kind: "browse" | "search" | "local"; focusIndex: number } | null = null, searchRecord: SafeSearchRecord | null = null) => {
    latestRequestRef.current += 1;
    const request = ++detailsRequestRef.current;
    setDetailsOrigin(origin);
    setDetailsSearchRecord(searchRecord);
    setDetailsTitle(title);
    setDetailsMetadata(null);
    setDetailsMetadataStatus("");
    setDetailsSubtitleLanguages([]);
    setDetailsPosterUrl(null);
    setDetailsEpisodes([]); setDetailsEpisodeId(""); setEpisodeStatus("");
    setEditingDetailsEpisode(false);
    const credentials = loadTmdbCredentials();
    if (credentials.readAccessToken || credentials.apiKey) {
      setDetailsMetadataStatus("Loading title details…");
      const client = new TmdbClient(credentials, undefined, import.meta.env.DEV ? "/tmdb-api" : undefined);
      const mediaType = title.contentType === "series" ? "tv" : "movie";
      try {
      const normalized = normalizeTitle(title.title);
      const resolved = await client.resolve(origin?.kind === "local" ? (localDetailsSearchTitle || title.searchTitle || title.title) : normalized.searchTitle || title.searchTitle || title.title, mediaType, title.year);
      if (resolved.kind !== "match") {
        if (request === detailsRequestRef.current) setDetailsMetadataStatus(resolved.kind === "ambiguous"
          ? "Multiple metadata matches found. Artwork and synopsis are unavailable."
          : "No confident metadata match was found for this title.");
        return;
      }
      const cache = new TmdbMetadataCache();
      const stored = cache.get(resolved.candidate.id, mediaType);
      const cached = stored?.detailsVersion === 1 ? stored : null;
      const metadata = cached ?? await client.getMetadata(resolved.candidate.id, mediaType);
      if (!cached) cache.set(metadata);
      new TmdbArtworkCache().set(artworkLookupKey(title)!, metadata.posterUrl);
      if (request !== detailsRequestRef.current) return;
      setDetailsMetadata(metadata);
      setDetailsMetadataStatus("");
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

  const publishLocalSubtitleSnapshot = (snapshot: Omit<CompanionLocalSubtitle, "version">) => {
    localSubtitleSnapshotRef.current = snapshot;
    localAutomaticSubtitleRef.current = null;
    const session = localUpload.session;
    const browser = browserCompanion;
    if (!session || session.state !== "ready" || !browser) return;
    const origin = companionOrigin();
    localSubtitlePublishQueueRef.current = localSubtitlePublishQueueRef.current
      .catch(() => undefined)
      .then(() => publishLocalMediaSubtitle(origin, browser.browserCredential, session.sessionId, snapshot))
      .catch(() => setTvPlaybackStatus("The local subtitle is ready on this computer but could not be sent to the TV."));
  };

  const ensureLocalSubtitlePrepared = async (signal?: AbortSignal) => {
    const sourceUrl = localSource?.url ?? "";
    const title = detailsTitle;
    const query = (localDetailsSearchTitle || title?.searchTitle || "").trim();
    if (!sourceUrl || !title || !query) return;
    const existing = localSubtitlePreparationRef.current;
    let promise: Promise<LocalSubtitleSnapshot | null>;
    const apiKey = openSubtitlesApiKey.trim();
    const keyTag = subtitleApiKeyTag(apiKey);
    const cachedAuto = localAutomaticSubtitleRef.current;
    if (localSubtitleSnapshotRef.current && !cachedAuto) return;
    const snapshotMatches = cachedAuto?.sourceUrl === sourceUrl && cachedAuto.query === query && cachedAuto.preference === subtitleLanguagePreference && cachedAuto.apiKeyTag === keyTag;
    if (snapshotMatches) return;
    if (cachedAuto && !snapshotMatches) {
      localSubtitleSnapshotRef.current = null;
      localAutomaticSubtitleRef.current = null;
    }
    let preparation = existing;
    if (existing?.sourceUrl === sourceUrl && existing.query === query && existing.preference === subtitleLanguagePreference && existing.apiKeyTag === keyTag) {
      promise = existing.promise;
    } else {
      if (!apiKey) {
        localSubtitlePreparationRef.current = null;
        return;
      }
      existing?.cancel();
      const requestController = createAbortController();
      const client = new OpenSubtitlesClient(apiKey, (url, init) => fetch(url, { ...init, signal: requestController?.signal ?? init.signal ?? null }), OPEN_SUBTITLES_BASE_URL);
      promise = loadPreferredLocalSubtitle(
        client,
        {
          title: query,
          year: title.year,
          contentType: title.contentType === "series" ? "series" : "movie",
          ...(title.season !== undefined ? { season: title.season } : {}),
          ...(title.episode !== undefined ? { episode: title.episode } : {}),
        },
        subtitleLanguagePreference,
        { ...(requestController?.signal ? { signal: requestController.signal } : {}), abortRequest: () => requestController?.abort(), timeoutMs: 15_000 },
      ).catch(() => null);
      preparation = { sourceUrl, query, preference: subtitleLanguagePreference, apiKeyTag: keyTag, promise, cancel: () => requestController?.abort() };
      localSubtitlePreparationRef.current = preparation;
    }
    const onAbort = () => {
      preparation?.cancel();
      if (localSubtitlePreparationRef.current === preparation) localSubtitlePreparationRef.current = null;
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const prepared = await promise;
    signal?.removeEventListener("abort", onAbort);
    if (!prepared) {
      if (localSubtitlePreparationRef.current?.promise === promise) localSubtitlePreparationRef.current = null;
      return;
    }
    if (localSource?.url !== sourceUrl || localSubtitlePreparationRef.current?.promise !== promise || localSubtitleSnapshotRef.current !== null) return;
    const { text, label, language, enabled, offsetSeconds } = prepared;
    localSubtitleSnapshotRef.current = { text, label, language, enabled, offsetSeconds };
    localAutomaticSubtitleRef.current = { sourceUrl, query, preference: subtitleLanguagePreference, apiKeyTag: keyTag };
  };

  const playLocalOnTv = async () => {
    if (!localSource?.file) { setTvPlaybackStatus("Choose the video file again before sending it to TV."); return; }
    const sourceUrl = localSource.url;
    const target = browserCompanion;
    if (!target?.capabilities.localMedia) { setTvPlaybackStatus("Pair this browser with a TV that supports local media in Settings."); return; }
    const server = companionOrigin();
    if (!isLanCompanionAddress(server)) { setTvPlaybackStatus("Set the companion service to a LAN address reachable by the TV in Settings."); return; }
    const controller = createAbortController();
    localUploadControllerRef.current = controller ?? null;
    setTvPlaybackStatus("Checking the paired TV…");
    let stagedSession: LocalMediaUploadStatus | null = null;
    try {
      const active = await getCompanionConnection(server, target.browserCredential);
      if (active.deviceId !== target.deviceId || !active.capabilities.localMedia) throw new Error("The paired TV is unavailable or does not support local media.");
      let uploaded = localUpload.session;
      if (!uploaded || uploaded.state !== "ready" || uploaded.expectedSize !== localSource.file.size) {
        setLocalUpload({ session: null, sentBytes: 0, totalBytes: localSource.file.size, state: "uploading" });
        setTvPlaybackStatus("Sending the video to the companion service…");
        uploaded = await stageLocalMedia(server, target.browserCredential, localSource.file, (sentBytes, totalBytes) => {
          const state = sentBytes >= totalBytes ? "preparing" : "uploading";
          setLocalUpload((current) => ({ ...current, sentBytes, totalBytes, state }));
          if (state === "preparing") setTvPlaybackStatus("Preparing a TV-compatible video…");
        }, controller?.signal);
        stagedSession = uploaded;
        setLocalUpload({ session: uploaded, sentBytes: uploaded.expectedSize, totalBytes: uploaded.expectedSize, state: "preparing" });
      }
      stagedSession = uploaded;
      setLocalUpload({ session: uploaded, sentBytes: uploaded.expectedSize, totalBytes: uploaded.expectedSize, state: "preparing" });
      await ensureLocalSubtitlePrepared(controller?.signal);
      if (localSource?.url !== sourceUrl) throw new Error("Choose the video file again before sending it to TV.");
      if (controller?.signal.aborted) throw new DOMException("Local TV upload cancelled.", "AbortError");
      if (localSubtitleSnapshotRef.current) {
        await localSubtitlePublishQueueRef.current.catch(() => undefined);
        if (controller?.signal.aborted) throw new DOMException("Local TV upload cancelled.", "AbortError");
        await publishLocalMediaSubtitle(server, target.browserCredential, uploaded.sessionId, localSubtitleSnapshotRef.current);
      }
      if (controller?.signal.aborted) throw new DOMException("Local TV upload cancelled.", "AbortError");
      if (!detailsTitle) throw new Error("Local video details are unavailable.");
      await sendLocalCompanionPlayback(server, target.browserCredential, uploaded.sessionId, {
        title: detailsTitle.title,
        searchTitle: localDetailsSearchTitle || detailsTitle.searchTitle,
        year: detailsTitle.year,
        season: detailsTitle.season ?? null,
        episode: detailsTitle.episode ?? null,
        contentType: detailsTitle.contentType === "other" ? "unknown" : detailsTitle.contentType,
      });
      if (controller?.signal.aborted) throw new DOMException("Local TV upload cancelled.", "AbortError");
      setLocalUpload({ session: uploaded, sentBytes: uploaded.expectedSize, totalBytes: uploaded.expectedSize, state: "ready" });
      setTvPlaybackStatus("TV command accepted. Waiting for the TV to prepare playback…");
    } catch (cause) {
      // A cancellation can race the command acknowledgement; stop that session on the TV too.
      if (stagedSession && controller?.signal.aborted) await sendStopLocalCompanionPlayback(server, target.browserCredential, stagedSession.sessionId).catch(() => undefined);
      if (stagedSession) await stopLocalMedia(server, target.browserCredential, stagedSession.sessionId).catch(() => undefined);
      if (controller?.signal.aborted) setTvPlaybackStatus("Local TV upload cancelled.");
      else setTvPlaybackStatus(cause instanceof Error ? cause.message : "Local TV playback could not be started.");
      setLocalUpload((current) => current.state === "uploading" || current.state === "preparing" ? { session: null, sentBytes: 0, totalBytes: current.totalBytes, state: "idle" } : current);
    } finally {
      if (localUploadControllerRef.current === controller) localUploadControllerRef.current = null;
    }
  };

  const cancelLocalUpload = () => localUploadControllerRef.current?.abort();

  const stopLocalTvPlayback = async () => {
    const target = browserCompanion;
    const server = companionOrigin();
    const sessionId = localUpload.session?.sessionId;
    if (!target || !sessionId) return;
    setTvPlaybackStatus("Stopping local TV playback…");
    try {
      await sendStopLocalCompanionPlayback(server, target.browserCredential, sessionId);
      const deadline = Date.now() + 5_000;
      let stopped = false;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        try {
          const status = await getLocalMediaUploadStatus(server, target.browserCredential, sessionId);
          if (status.playbackState === "stopped") { stopped = true; break; }
        } catch { stopped = true; break; }
      }
      if (!stopped) await stopLocalMedia(server, target.browserCredential, sessionId);
      setLocalUpload({ session: null, sentBytes: 0, totalBytes: 0, state: "idle" });
      setTvPlaybackStatus("Local TV media session stopped.");
    } catch {
      setTvPlaybackStatus("Could not stop the local TV media session. Check the companion connection.");
    }
  };

  const saveWebTvRelay = () => {
    try {
      const previousOrigin = companionOrigin();
      const origin = saveCompanionServerUrl(companionServerDraft);
      if (origin !== previousOrigin) {
        setBrowserCompanions([]);
        setSelectedTvDeviceId("");
      }
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
    if (!browserCompanion) {
      setWebTvConnectionStatus("Pair this browser first using the one-time code shown in TV Settings.");
      return;
    }
    try {
      const active = await getCompanionConnection(server, browserCompanion.browserCredential);
      const provider = XtreamClient.fromPlaylistUrl(playlistUrl);
      if (active.expiresAt <= Date.now()) setWebTvConnectionStatus("TV connection has expired. Reconnect Substream on the TV.");
      else if (!active.sourceFingerprint && active.capabilities.localMedia) setWebTvConnectionStatus("TV is connected and ready for local file playback.");
      else if (!provider || active.sourceFingerprint !== provider.pairingFingerprint()) setWebTvConnectionStatus("TV is connected, but its provider does not match this browser playlist.");
      else setWebTvConnectionStatus("TV is connected and the provider matches.");
    } catch (error) {
      setWebTvConnectionStatus(error instanceof CompanionConnectionError && error.kind === "no-tv"
        ? "This browser pairing is no longer active. Use the latest code shown in TV Settings to pair again."
        : error instanceof CompanionConnectionError && error.kind === "unreachable"
          ? "TV relay is unreachable. Check the address and that the relay is running on your network."
          : "Relay returned an invalid TV connection response.");
    }
  };

  const pairBrowserWithTv = async () => {
    const server = companionOrigin();
    if (!server) {
      setWebTvConnectionStatus("Set the LAN relay address before entering the TV pairing code.");
      return;
    }
    try {
      const paired = await redeemCompanionCode(server, webTvPairingCode);
      const deviceName = webTvPairingName.trim().slice(0, 40) || companionDeviceLabel(paired.deviceId, paired.deviceName);
      const named = { ...paired, deviceName };
      saveCompanionDeviceLabel(named.deviceId, named.deviceName);
      setBrowserCompanions((current) => [...current.filter((connection) => connection.deviceId !== named.deviceId), named]);
      setSelectedTvDeviceId(named.deviceId);
      setWebTvPairingCode("");
      setWebTvPairingName("");
      setWebTvConnectionStatus(`Browser paired with ${named.deviceName}. You can choose it as the playback target.`);
    } catch {
      setWebTvConnectionStatus("Pairing code is invalid or expired. Read the latest code shown in TV Settings.");
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
    if (!browserCompanion) {
      setTvPlaybackStatus("Pair this browser with the TV in Settings using the one-time code shown on the TV.");
      return;
    }
    let active;
    try { active = await getCompanionConnection(server, browserCompanion.browserCredential); }
    catch (error) {
      setTvPlaybackStatus(error instanceof CompanionConnectionError && error.kind === "no-tv"
        ? "TV connection or browser pairing has expired. Pair again using the latest code shown on the TV."
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
    if (browserCompanion.deviceId !== active.deviceId || browserCompanion.sourceFingerprint !== active.sourceFingerprint) {
      setTvPlaybackStatus("Pair this browser with the TV in Settings using the one-time code shown on the TV.");
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
      await sendCompanionPlayback(server, browserCompanion.browserCredential, selection);
      setTvPlaybackStatus(`Sent “${title.title}” to TV.`);
    } catch {
      setTvPlaybackStatus("Could not send playback to the TV. Check the connection and try again.");
    }
  };

  const closeDetails = () => {
    detailsRequestRef.current += 1;
    setDetailsTitle(null);
    setTvPlaybackStatus("");
    if (detailsOrigin?.kind === "local") {
      onMainMenu();
      return;
    }
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

  const goToPreviousScreen = () => {
    if (episodePickerOpen) {
      const seasons = [...new Set(detailsEpisodes.map((episode) => episode.season).filter((season): season is number => season !== undefined))];
      if (episodePickerLevel === "episodes" && seasons.length > 1) {
        setEpisodePickerLevel("seasons");
        setEpisodePickerFocusIndex(Math.max(0, seasons.indexOf(episodePickerSeason ?? seasons[0] ?? 0)));
        window.requestAnimationFrame(() => episodePickerOptionRefs.current[Math.max(0, seasons.indexOf(episodePickerSeason ?? seasons[0] ?? 0))]?.focus());
      } else {
        setEpisodePickerOpen(false);
        window.requestAnimationFrame(() => detailsControlsRef.current[2]?.focus());
      }
      return;
    }
    if (showSettings) {
      setEditingCompanionServer(false);
      if (settingsOnOpen) onMainMenu();
      else setShowSettings(false);
      return;
    }
    if (detailsTitle) { closeDetails(); return; }
    if (selectedTitle) {
      browseRequestRef.current.invalidate();
      exitPlayerFullscreen();
      setShowFullscreenControls(false);
      if (selectedTitleSource === "local") setDetailsTitle(selectedTitle);
      setSelectedTitle(null);
      return;
    }
    if (activeGroup) {
      latestRequestRef.current += 1;
      browseRequestRef.current.invalidate();
      remoteBrowseRef.current = null;
      browseReturnFocusPendingRef.current = true;
      setBrowseMode("local");
      setBrowseCount(0);
      setActiveGroup(null);
      setTitles([]);
      setPage(0);
      setFocusIndex(browseReturnFocusIndexRef.current);
      setCatalogStatus("");
    }
  };

  const previousScreenLabel = showSettings
    ? settingsOnOpen ? undefined : "Back to library"
    : detailsTitle ? detailsOrigin?.kind === "search" ? "Back to search" : detailsOrigin?.kind === "local" ? "Back to home" : "Back to titles"
      : selectedTitle ? selectedTitleSource === "local" ? "Back to details" : "Back to titles"
        : activeGroup ? "Back to groups" : undefined;

  const refreshSearchCatalogue = async () => {
    if (!searchProviderFingerprint) {
      setSearchStatus("Full catalogue refresh requires an Xtream playlist. Your imported M3U titles are searchable here.");
      return;
    }
    searchRefreshControllerRef.current?.abort();
    const controller = createAbortController();
    searchRefreshControllerRef.current = controller ?? null;
    const request = ++searchRefreshRequestRef.current;
    setSearchRefreshLoading(true);
    setSearchStatus("Loading the provider catalogue…");
    try {
      const result = await createBrowserSearchClient({ playlistUrl }).refresh({
        ...(controller ? { signal: controller.signal } : {}),
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

  const followingEpisodeFor = (title: VodCatalogItem): VodCatalogItem | null => {
    if (title.season === undefined) return null;
    const episodesInSeason = detailsEpisodes.filter((episode) => episode.season === title.season);
    const index = episodesInSeason.findIndex((episode) => episode.id === title.id);
    return index >= 0 ? episodesInSeason[index + 1] ?? null : null;
  };

  const playFromDetails = (title: VodCatalogItem) => {
    if (detailsOrigin?.kind === "local" && localComputerStartPendingRef.current) return;
    detailsRequestRef.current += 1;
    const followingEpisode = followingEpisodeFor(title);
    if (detailsOrigin?.kind === "local") {
      localComputerStartPendingRef.current = true;
      const sourceUrl = localSource?.url;
      const request = detailsRequestRef.current;
      setTvPlaybackStatus(openSubtitlesApiKey.trim() ? "Loading preferred subtitles…" : "");
      void ensureLocalSubtitlePrepared().catch(() => undefined).then(() => {
        if (localSource?.url !== sourceUrl || detailsRequestRef.current !== request) return;
        setDetailsTitle(null);
        setTvPlaybackStatus("");
        startPlayback(title, 0, null, "local");
      }).finally(() => {
        localComputerStartPendingRef.current = false;
      });
      return;
    }
    setDetailsTitle(null);
    const saved = loadPlaybackHistory().find((item) => item.id === title.id);
    if (saved) { setResumeChoice({ title, history: saved, nextEpisode: followingEpisode }); return; }
    startPlayback(title, 0, followingEpisode);
  };

  const chooseSeriesEpisodes = async (title: VodCatalogItem) => {
    if (!title.providerSeriesId) { playFromDetails(title); return; }
    const client = XtreamClient.fromPlaylistUrl(playlistUrl);
    if (!client) {
      setEpisodeStatus("Episodes are unavailable. Re-import the playlist and try again.");
      return;
    }
    setEpisodeStatus("Loading episodes…");
    const result = await browseRequestRef.current.run(
      () => client.episodes(title.providerSeriesId!, title.title),
      "Episodes could not be loaded. Check the TV network and try again.",
    );
    if (result.kind === "stale") return;
    if (result.kind === "error") { setEpisodeStatus(result.message); return; }
    const episodes = result.value;
    setDetailsEpisodes(episodes);
    setDetailsEpisodeId(episodes[0]?.id ?? "");
    webEpisodeSelectionChangedRef.current = false;
    if (!episodes.length) setEpisodeStatus("No playable episodes were returned for this series.");
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
    } else {
      window.requestAnimationFrame(() => detailsEpisodeSelectRef.current?.focus());
    }
    setEpisodeStatus(translate("{{count}} episodes ready. Choose an episode, then Play.", language).replace("{{count}}", episodes.length.toLocaleString()));
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
    setPendingHistoryRemoval(history);
    window.requestAnimationFrame(() => historyCancelRef.current?.focus());
  };

  const confirmHistoryRemoval = () => {
    if (!pendingHistoryRemoval) return;
    const id = pendingHistoryRemoval.id;
    const nextFocus = Math.max(0, Math.min(focusIndex - 1, (continueHistory.length - 1) * 2 - 1));
    setPendingHistoryRemoval(null);
    setCatalogStatus(`${pendingHistoryRemoval.title} removed from Continue watching.`);
    setFocusIndex(nextFocus);
    removePlaybackProgress(id);
    setContinueHistory(loadPlaybackHistory());
    window.requestAnimationFrame(() => (tileRefs.current[nextFocus] ?? browseTabRefs.current[sectionOrder.indexOf("recent")])?.focus());
  };

  const toggleFavouriteForGroup = (group: VodGroup) => {
    if (isLatestVirtualGroup(group)) return;
    const nextFavourite = !favouriteGroupIds.includes(group.id);
    const nextIds = setFavouriteGroup(group.id, nextFavourite);
    setFavouriteGroupIds(nextIds);
    if (browseCollection !== "recent" && browseCollection !== "search") {
      setFocusIndex(favouriteToggleFocusIndex(groups, browseCollection, nextIds, group.id, focusIndex - (browseCollection === "movies" || browseCollection === "series" ? 1 : 0)) + (browseCollection === "movies" || browseCollection === "series" ? 1 : 0));
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
    if (resume) startPlayback(resumeChoice.title, resumeChoice.history.currentTimeSeconds, resumeChoice.nextEpisode);
    else {
      removePlaybackProgress(resumeChoice.history.id);
      setContinueHistory(loadPlaybackHistory());
      startPlayback(resumeChoice.title, 0, resumeChoice.nextEpisode);
    }
  };

  const changeBrowsePage = (targetPage: number, targetSort = sort, focusAtEnd = false) => {
    if (browseMode !== "local" && remoteBrowseRef.current) {
      browseRequestRef.current.invalidate();
      const pageItems = browseMode === "latest"
        ? remoteBrowseRef.current.items.slice(targetPage * PAGE_SIZE, (targetPage + 1) * PAGE_SIZE)
        : sortAndPageBrowseItems(remoteBrowseRef.current.items, targetPage, PAGE_SIZE, targetSort);
      setTitles(pageItems);
      setPage(targetPage);
      if (browseMode !== "latest") setSort(targetSort);
      setFocusIndex(focusAtEnd ? Math.max(0, pageItems.length - 1) : 0);
      return;
    }
    if (activeGroup) void openGroup(activeGroup, targetPage, targetSort, focusAtEnd);
  };

  const commitSortEdit = () => {
    const nextSort = sortDraft;
    setEditingSort(false);
    sortReloadFocusGuardRef.current = true;
    const finish = () => window.requestAnimationFrame(() => {
      const active = document.activeElement;
      const restoreTrigger = active === document.body || active === sortSelectRef.current || active === sortControlRef.current;
      sortReloadFocusGuardRef.current = false;
      if (restoreTrigger) sortControlRef.current?.focus();
    });
    if (nextSort === sort) { finish(); return; }
    setSort(nextSort);
    if (!activeGroup) { finish(); return; }
    if (browseMode !== "local" && remoteBrowseRef.current) {
      changeBrowsePage(0, nextSort);
      finish();
      return;
    }
    void openGroup(activeGroup, 0, nextSort).finally(finish);
  };

  useEffect(() => {
    const focusBrowseIndex = (index: number) => {
      setFocusIndex(index);
      const tile = tileRefs.current[index];
      if (activeGroup && isTizen) focusTitleListItem(tile ?? null, titleListViewportRef.current);
      else if (isTizen) focusPageItem(tile ?? null);
      else {
        tile?.focus();
        tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    };
    const navigateTizenTitleGrid = (key: string, allowEndpointExit = true) => {
      const itemCount = titles.length;
      if (!itemCount) return;
      const columns = 4;
      const targetIndex = gridNavigationTarget(key, focusIndex, itemCount, columns);
      if (targetIndex !== null) {
        focusBrowseIndex(targetIndex);
      } else if (allowEndpointExit && key === "ArrowUp" && focusIndex < columns) {
        if (browseMode === "latest") latestRefreshRef.current?.focus();
        else sortControlRef.current?.focus();
      } else if (allowEndpointExit && key === "ArrowDown" && focusIndex + columns >= itemCount) {
        if (page + 1 < browsePageCount(browseCount, PAGE_SIZE) && nextPageRef.current) nextPageRef.current.focus();
        else if (page > 0 && previousPageRef.current) previousPageRef.current.focus();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const key = normalizedRemoteKey(event);
      if (key !== "ArrowUp" && key !== "ArrowDown") heldTitleKeyRef.current = null;
      if (pendingHistoryRemoval) {
        if (key === "Back") { event.preventDefault(); setPendingHistoryRemoval(null); window.requestAnimationFrame(() => tileRefs.current[focusIndex]?.focus()); return; }
        if (key === "ArrowLeft" || key === "ArrowUp" || key === "ArrowRight" || key === "ArrowDown") {
          event.preventDefault();
          (key === "ArrowLeft" || key === "ArrowUp" ? historyCancelRef : historyConfirmRef).current?.focus();
          return;
        }
        if (key === "Enter") { event.preventDefault(); (document.activeElement === historyConfirmRef.current ? historyConfirmRef : historyCancelRef).current?.click(); return; }
        return;
      }
      if (isRedKey(event) && state === "ready" && !selectedTitle && !detailsTitle && !showSettings && !resumeChoice && !settingsConfirmation
        && !activeGroup && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLSelectElement)) {
        if (toggleFocusedFavourite()) {
          event.preventDefault();
          // The focused group remains the same; only its indicator/status
          // changes, so the next remote direction starts from the same tile.
        }
        return;
      }
      if (isBackKey(event)) {
        if (editingSort) {
          event.preventDefault();
          setSortDraft(sort);
          setEditingSort(false);
          sortReloadFocusGuardRef.current = false;
          window.requestAnimationFrame(() => sortControlRef.current?.focus());
          return;
        }
        if (showSettings && (showSettingsApiKeyEditor || editingCompanionServer || editingUiLanguage || editingSubtitleLanguage || editingTmdbToken || editingTmdbApiKey)) {
          event.preventDefault();
          const target = event.target;
          if (target === settingsApiKeyInputRef.current) {
            setShowSettingsApiKeyEditor(false);
            window.requestAnimationFrame(() => settingsControlsRef.current["api-key-edit"]?.focus());
          } else if (target === settingsControlsRef.current["companion-url"]) {
            setEditingCompanionServer(false);
            window.requestAnimationFrame(() => settingsControlsRef.current["companion-url"]?.focus());
          } else if (target === uiLanguageControlRef.current) {
            setEditingUiLanguage(false);
            window.requestAnimationFrame(() => uiLanguageControlRef.current?.focus());
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
            setEditingUiLanguage(false);
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
        if (selectedTitle && showPlayerTools) {
          event.preventDefault();
          setShowPlayerTools(false);
          setPlayerFocusIndex(infoFocusIndex);
          window.requestAnimationFrame(() => playerInfoButtonRef.current?.focus());
          return;
        }
        if (selectedTitle && playerFullscreen && showFullscreenControls) {
          const target = event.target;
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
        }
        if (episodePickerOpen) {
          event.preventDefault();
          goToPreviousScreen();
          return;
        }
        if (detailsTitle) {
          event.preventDefault();
          closeDetails();
          return;
        }
        const errorFormOpen = false;
        const action = resolveAppBackAction({
          settingsConfirmationOpen: Boolean(settingsConfirmation),
          resumeChoiceOpen: Boolean(resumeChoice),
          settingsOpen: showSettings,
          playlistFormOpen: false,
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
            if (settingsOnOpen) onMainMenu();
            else setShowSettings(false);
            break;
          case "close-playlist-form":
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
            latestRequestRef.current += 1;
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
            latestRequestRef.current += 1;
            setCatalogStatus("");
            break;
          case "stay":
            // At the VOD root, Back returns to the app's actual main menu.
            // The shell button used to sit outside this remote focus handler,
            // leaving Tizen users with no reachable exit from VOD.
            if (state === "ready") onMainMenu();
            break;
        }
        return;
      }
      if (state !== "ready") {
        const controls = [mainMenuButtonRef.current, retryPlaylistRef.current].filter((control): control is HTMLButtonElement => control !== null);
        if (controls.length === 0) return;
        const currentIndex = Math.max(0, controls.indexOf(document.activeElement as HTMLButtonElement));
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
      if (event.target === mainMenuButtonRef.current || event.target === previousButtonRef.current) {
        const hasPrevious = Boolean(previousButtonRef.current);
        if (key === "ArrowLeft" || key === "ArrowRight") {
          const current = event.target === previousButtonRef.current ? "previous" : "main-menu";
          const target = screenNavigationTarget(key, current, hasPrevious);
          if (target) {
            event.preventDefault();
            (target === "previous" ? previousButtonRef.current : mainMenuButtonRef.current)?.focus();
          }
          return;
        }
        if (key === "ArrowDown") {
          event.preventDefault();
          if (showSettings) settingsControlsRef.current["companion-url"]?.focus();
          else if (episodePickerOpen) episodePickerOptionRefs.current[episodePickerFocusIndex]?.focus();
          else if (detailsTitle) detailsControlsRef.current[2]?.focus();
          else if (selectedTitle) (playerFullscreen ? playerTogglePlaybackButtonRef : playerStageRef).current?.focus();
          else if (activeGroup) (browseMode === "latest" ? latestRefreshRef.current : sortControlRef.current)?.focus();
          else browseTabRefs.current[sectionOrder.indexOf(browseCollection)]?.focus();
          return;
        }
        if (key === "Enter") { event.preventDefault(); (event.target as HTMLButtonElement).click(); }
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
            if (key === "ArrowUp" && currentIndex === 0 && previousButtonRef.current) {
              event.preventDefault();
              previousButtonRef.current.focus();
              return;
            }
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
        // Keep details navigation in the same order as the other remote views:
        // header, Play here, Play on TV, then the episode selector.
        const controls = [detailsControlsRef.current[0], detailsControlsRef.current[2] ?? detailsControlsRef.current[1], detailsControlsRef.current[3], ...(detailsTitle.providerSeriesId && detailsEpisodes.length ? [detailsEpisodeControlRef.current] : []), ...(detailsOrigin?.kind === "local" ? [detailsControlsRef.current[4], detailsControlsRef.current[5]] : [])].filter((control): control is HTMLElement => Boolean(control) && !(control instanceof HTMLButtonElement && control.disabled));
        if (controls.length === 0) return;
        const activeIndex = controls.indexOf(document.activeElement as HTMLElement);
        const currentIndex = activeIndex >= 0 ? activeIndex : detailsFocusIndex;
        if (document.activeElement === detailsEpisodeSelectRef.current && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) {
          // Native selects need the first Up/Down press for changing the
          // selected episode. After that change, the next arrow leaves the
          // select so web users can reach Play using only arrow keys.
          if (!isTizen && (key === "ArrowUp" || key === "ArrowDown") && !webEpisodeSelectionChangedRef.current) return;
          if (isTizen && !editingDetailsEpisode) return;
          event.preventDefault();
          webEpisodeSelectionChangedRef.current = false;
          setEditingDetailsEpisode(false);
          const targetIndex = detailsControlNavigationTarget(key, currentIndex, controls.length) ?? currentIndex;
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
          if (nestedScreenSettingsTarget(key, currentIndex) && (previousButtonRef.current || mainMenuButtonRef.current)) {
            (previousButtonRef.current ?? mainMenuButtonRef.current)?.focus();
            return;
          }
          const targetIndex = detailsControlNavigationTarget(key, currentIndex, controls.length);
          if (targetIndex !== null) controls[targetIndex]?.focus();
          return;
        }
        if (key === "Enter") { event.preventDefault(); if (controls[currentIndex] instanceof HTMLButtonElement) controls[currentIndex].click(); }
        return;
      }
      if (settingsConfirmation || showSettings) {
        if (isTizen && event.target instanceof HTMLSelectElement) {
          // Once explicitly opened, a select owns its arrow keys so options
          // can change. OK commits and returns to its navigation trigger.
          if (key === "Enter") {
            event.preventDefault();
            if (event.target === uiLanguageControlRef.current) setEditingUiLanguage(false);
            if (event.target === subtitleLanguageControlRef.current) setEditingSubtitleLanguage(false);
          }
          return;
        }
        const settingsTextEntry = event.target instanceof HTMLTextAreaElement
          || event.target instanceof HTMLInputElement && event.target.type !== "checkbox";
        if (editingCompanionServer && event.target === settingsControlsRef.current["companion-url"] && (key === "ArrowUp" || key === "ArrowDown")) setEditingCompanionServer(false);
        if (editingTmdbToken && event.target === tmdbTokenControlRef.current && (key === "ArrowUp" || key === "ArrowDown")) setEditingTmdbToken(false);
        if (editingTmdbApiKey && event.target === tmdbApiKeyControlRef.current && (key === "ArrowUp" || key === "ArrowDown")) setEditingTmdbApiKey(false);
        if (settingsTextEntry && !["ArrowUp", "ArrowDown"].includes(key)) return;
        if (!settingsConfirmation && key === "ArrowUp" && (document.activeElement === settingsControlsRef.current["companion-url"] || settingsFocusKey === "companion-url")) {
          event.preventDefault();
          (previousButtonRef.current ?? mainMenuButtonRef.current)?.focus();
          return;
        }
        const order = settingsControlOrder({
          confirmationOpen: Boolean(settingsConfirmation),
          apiKeyEditorOpen: showSettingsApiKeyEditor,
          hasSubtitleKey,
          liveRelayControlsVisible: isTizen,
        });
        const visibleOrder = order.filter((controlKey) => {
          const control = settingsControlsRef.current[controlKey];
          return Boolean(control) && !(control instanceof HTMLButtonElement && control.disabled);
        });
        const controls = visibleOrder
          .map((controlKey) => settingsControlsRef.current[controlKey])
          .filter((control): control is HTMLElement => Boolean(control) && !(control instanceof HTMLButtonElement && control.disabled));
        if (controls.length === 0) return;
        const activeIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
        const focusIndex = visibleOrder.indexOf(settingsFocusKey);
        const currentIndex = activeIndex >= 0 ? activeIndex : Math.max(0, focusIndex);
        if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(key)) {
          event.preventDefault();
          const delta = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
          const targetIndex = Math.max(0, Math.min(controls.length - 1, currentIndex + delta));
          setSettingsFocusKey(visibleOrder[targetIndex] ?? settingsFocusKey);
          controls[targetIndex]?.focus();
          return;
        }
        if (key === "Enter") {
          event.preventDefault();
          const control = controls[currentIndex];
          if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement && control.type === "checkbox") control.click();
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
          if (key === "ArrowUp" && currentIndex === 0 && !playerFullscreen && previousButtonRef.current) {
            previousButtonRef.current.focus();
            return;
          }
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
        if (event.target === sortSelectRef.current && editingSort) {
          if (key === "Enter") {
            event.preventDefault();
            commitSortEdit();
          }
          // Leave directional keys to the native select while its explicit
          // editor is open so they change the draft option.
          return;
        }
        if (event.target === sortSelectRef.current && nestedScreenSettingsTarget(key, 0) && (previousButtonRef.current || mainMenuButtonRef.current)) {
          event.preventDefault();
          (previousButtonRef.current ?? mainMenuButtonRef.current)?.focus();
        } else if (activeGroup && isTizen && (key === "ArrowUp" || key === "ArrowDown")
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
      if (targetButton && (targetButton === sortControlRef.current || targetButton === latestRefreshRef.current)) {
        if (key === "ArrowDown") {
          event.preventDefault();
          focusBrowseIndex(focusIndex);
        } else if (key === "ArrowUp") {
          event.preventDefault();
          (previousButtonRef.current ?? mainMenuButtonRef.current)?.focus();
        } else if (key === "ArrowLeft") {
          event.preventDefault();
          (previousButtonRef.current ?? mainMenuButtonRef.current)?.focus();
        } else if (key === "ArrowRight") {
          event.preventDefault();
          mainMenuButtonRef.current?.focus();
        } else if (key === "Enter") {
          event.preventDefault();
          targetButton.click();
        }
        return;
      }
      if (targetButton === mainMenuButtonRef.current) {
        if (key === "ArrowDown") {
          event.preventDefault();
          browseTabRefs.current[sectionOrder.indexOf(browseCollection)]?.focus();
        }
        return;
      }
      if (targetButton?.classList.contains("browse-tab")) {
        const tabs = browseTabRefs.current.filter((tab): tab is HTMLButtonElement => tab !== null);
        const currentTab = Math.max(0, tabs.indexOf(targetButton));
        if (key === "ArrowLeft" || key === "ArrowRight") {
          event.preventDefault();
          const nextTab = Math.max(0, Math.min(tabs.length - 1, currentTab + (key === "ArrowLeft" ? -1 : 1)));
          const nextCollection = sectionOrder;
          const nextSection = nextCollection[nextTab] ?? "recent";
          if (nextSection !== browseCollection) {
            latestRequestRef.current += 1;
            browseTabTransitionRef.current = "menu";
            setFocusIndex(0);
            setBrowseCollection(nextSection);
          }
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
          } else if (browseEmptyRecoveryRef.current) {
            event.preventDefault();
            browseEmptyRecoveryRef.current.focus();
          }
          return;
        }
        if (key === "ArrowUp" && mainMenuButtonRef.current) {
          event.preventDefault();
          mainMenuButtonRef.current.focus();
          return;
        }
      }
      if (targetButton && !targetButton.classList.contains("tile")) {
        const browseControls = [mainMenuButtonRef.current, sortSelectRef.current, latestRefreshRef.current, backToGroupsRef.current, previousPageRef.current, nextPageRef.current]
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
          const columns = isTizen ? 4 : browseGridColumnCount(true, window.innerWidth <= 800, window.innerWidth < 520);
          const lastTitleIndex = Math.floor(Math.max(0, titles.length - 1) / columns) * columns;
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
            navigateTizenTitleGrid(key, false);
          }
        } else {
          if (verticalKey) heldTitleKeyRef.current = { key, lastHandledAt: Date.now() };
          else heldTitleKeyRef.current = null;
          navigateTizenTitleGrid(key);
        }
        return;
      }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) {
        event.preventDefault();
        const compactViewport = window.innerWidth <= 800;
        const narrowViewport = window.innerWidth < 520;
        const homeColumns = browseGridColumnCount(false, compactViewport, narrowViewport, isTizen && window.innerWidth <= 1400);
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
          if (browseMode === "latest") latestRefreshRef.current?.focus();
          else sortControlRef.current?.focus();
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
  }, [activeGroup, browseCollection, browseCount, catalogStatus, changeBrowsePage, continueHistory, detailsEpisodeId, detailsEpisodes, detailsFocusIndex, detailsTitle, editingCompanionServer, editingDetailsEpisode, editingSubtitleEpisode, editingSubtitleLanguage, editingSubtitleQuery, editingSubtitleSeason, editingSubtitleType, editingTmdbApiKey, editingTmdbToken, editingUiLanguage, episodePickerFocusIndex, episodePickerOpen, favouriteGroupIds, focusIndex, groups, isPlaybackPaused, isSubtitleAttached, isTizen, nextEpisode, page, pendingHistoryRemoval, playerFocusIndex, playerFullscreen, playlistUrl, resumeChoice, resumeChoiceFocusIndex, selectedTitle, settingsConfirmation, settingsFocusKey, showPlayerApiKeyEditor, showPlayerTools, showFullscreenControls, showSettings, sort, state, subtitleSearchType, titles, visibleGroups]);

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
    const transition = browseTabTransitionRef.current;
    browseTabTransitionRef.current = null;
    if (transition === "menu") {
      const tab = browseTabRefs.current[sectionOrder.indexOf(browseCollection)];
      if (tab) {
        if (isTizen) { window.scrollTo(0, 0); focusPageItem(tab); }
        else tab.focus();
      }
      return;
    }
    const itemCount = browseCollection === "recent" ? continueHistory.length * 2 : browseCollection === "search" ? visibleSearchRecords.length : visibleGroups.length;
    if (browseCollection === "search") {
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
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
        if (isTizen) { window.scrollTo(0, 0); focusPageItem(tile); }
        else { tile.focus(); tile.scrollIntoView({ block: "nearest", inline: "nearest" }); }
        return true;
      };
      if (focusFirstTile()) return;
      const frame = window.requestAnimationFrame(focusFirstTile);
      return () => window.cancelAnimationFrame(frame);
    }
    if (target === "recovery") {
      browseEmptyRecoveryRef.current?.focus();
    }
  }, [activeGroup, browseCollection, continueHistory.length, detailsTitle, isTizen, resumeChoice, selectedTitle, settingsConfirmation, showSettings, visibleGroups.length]);

  useEffect(() => {
    if (selectedTitle || detailsTitle || resumeChoice || showSettings || settingsConfirmation) return;
    // List updates must preserve an explicit move to the header or browse
    // controls; default tile focus is only appropriate while browsing items.
    if (activeGroup && (editingSort || sortReloadFocusGuardRef.current
      || document.activeElement === sortControlRef.current || document.activeElement === sortSelectRef.current
      || document.activeElement === latestRefreshRef.current || document.activeElement === previousButtonRef.current
      || document.activeElement === mainMenuButtonRef.current)) return;
    if (!activeGroup) {
      if (browseReturnFocusPendingRef.current) {
        browseReturnFocusPendingRef.current = false;
        const frame = window.requestAnimationFrame(() => {
          const tile = tileRefs.current[browseReturnFocusIndexRef.current];
          if (isTizen) focusPageItem(tile ?? null);
          else { tile?.focus(); tile?.scrollIntoView({ block: "nearest", inline: "nearest" }); }
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
        if (isTizen) focusPageItem(tile);
        else { tile.focus(); tile.scrollIntoView({ block: "nearest", inline: "nearest" }); }
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
    const firstKey = settingsConfirmation ? "confirm-cancel" : "companion-url";
    setSettingsFocusKey(firstKey);
    window.requestAnimationFrame(() => settingsControlsRef.current[firstKey]?.focus());
  }, [settingsConfirmation, showSettings]);

  const settingsApiKeyEditorWasOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = settingsApiKeyEditorWasOpenRef.current;
    settingsApiKeyEditorWasOpenRef.current = showSettingsApiKeyEditor;
    if (!showSettings || (!showSettingsApiKeyEditor && !wasOpen)) return;
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
  }, [editingSubtitleEpisode, editingSubtitleQuery, editingSubtitleSeason, editingSubtitleType, openSubtitlesApiKey, isSubtitleAttached, nextEpisode, playerFocusIndex, playerFullscreen, selectedTitle, showFullscreenControls, showPlayerApiKeyEditor, showPlayerTools, subtitleResults.length, subtitleSearchType]);

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
    const initialSubtitleOffset = selectedTitleSource === "local" ? 0 : loadSubtitleTimingOffset(selectedTitle.id);
    setSubtitleTimingOffsetSeconds(initialSubtitleOffset);
    const player = isTizenAvPlayAvailable() && avPlayContainerRef.current
      ? new TizenAvPlayPlayer(avPlayContainerRef.current, setVisibleSubtitle)
      : videoRef.current ? new HtmlVideoPlayer(videoRef.current) : null;
    if (!player) return;
    playerRef.current = player;
    player.setSubtitleTimingOffset?.(initialSubtitleOffset);
    const persistCurrentProgress = (value: PlaybackProgress | null) => {
      if (selectedTitleSource === "local" || !value || value.currentTimeSeconds <= 0 || value.durationSeconds <= 0) return;
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
          error: selectedTitleSource === "local" ? LOCAL_PLAYBACK_ERROR_MESSAGE : PLAYBACK_UNAVAILABLE_MESSAGE,
        };
        setPlaybackStatus(status[playbackState]);
        const remoteMedia = remoteLocalMediaRef.current;
        if (remoteMedia && selectedTitle.id === `companion-local-${remoteMedia.media.sessionId}`) {
          const remoteState = playbackState === "playing" ? "playing"
            : playbackState === "paused" ? "paused"
              : playbackState === "ended" ? "ended"
                : playbackState === "error" ? "failed" : "preparing";
          const nextRemote = { ...remoteMedia, playbackState: remoteState as ActiveLocalTvSession["playbackState"] };
          remoteLocalMediaRef.current = nextRemote;
          setActiveRemoteLocalMedia(nextRemote);
          void reportLocalMediaState(remoteMedia.server, remoteMedia.tvCredential, remoteMedia.media.sessionId, remoteState).catch(() => undefined);
        }
        if (playbackState === "playing") setAudioTracks(player.getAudioTracks?.() ?? []);
        setIsPlaybackBuffering(playbackState === "buffering");
        setIsPlaybackPaused(playbackState === "paused" || playbackState === "ended" || playbackState === "error");
        if (playbackState === "error") setShowFullscreenControls(true);
        if (playbackState === "paused") persistCurrentProgress(playbackProgressRef.current);
        if (playbackState === "ended") {
          if (selectedTitleSource !== "local") {
            removePlaybackProgress(selectedTitle.id);
            setContinueHistory(loadPlaybackHistory());
          }
          if (nextEpisode) startPlayback(nextEpisode, 0, followingEpisodeFor(nextEpisode));
        }
      },
      onProgress: (value) => {
        playbackProgressRef.current = value;
        setPlaybackProgress(value);
        if (value.durationSeconds > 0 && Date.now() - lastPersistedAtRef.current >= 10_000) {
          persistCurrentProgress(value);
        }
      },
    });
    // Persist the latest known playhead when the app is backgrounded or the
    // player screen is torn down. Progress callbacks are throttled, so relying
    // on the periodic save alone loses the final interval on quick exits.
    const persistOnPageHide = () => persistCurrentProgress(playbackProgressRef.current);
    window.addEventListener("pagehide", persistOnPageHide);
    player.load(selectedTitle.streamUrl);
    if (selectedTitleSource === "local" && localSubtitleSnapshotRef.current) {
      const snapshot = localSubtitleSnapshotRef.current;
      void player.setSubtitle(snapshot.text, snapshot.label, snapshot.language).then((attachment) => {
        if (playerRef.current !== player || selectedTitleSource !== "local") return;
        if (!attachment.enabled) {
          setSubtitleStatus("The preferred subtitle could not be attached. " + (attachment.reason ?? "Try another subtitle file."));
          return;
        }
        player.setSubtitleTimingOffset?.(snapshot.offsetSeconds);
        player.setSubtitleEnabled(snapshot.enabled);
        setIsSubtitleAttached(true);
        setIsSubtitleEnabled(snapshot.enabled);
        setSubtitleStatus("Subtitle enabled: " + snapshot.language.toUpperCase());
      }).catch(() => setSubtitleStatus("The preferred subtitle could not be attached. Try another subtitle file."));
    }
    if (resumeStartSecondsRef.current > 0) player.seekTo?.(resumeStartSecondsRef.current);
    resumeStartSecondsRef.current = 0;
    if (selectedTitleSource === "local") setSubtitleStatus("Search subtitles when you choose, or open an SRT/WebVTT subtitle file.");
    else if (openSubtitlesApiKey.trim()) void findSubtitles(true);
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
      persistCurrentProgress(playbackProgressRef.current);
      window.removeEventListener("pagehide", persistOnPageHide);
      playerRef.current = null;
      player.setEventHandlers(null);
      player.destroy();
      if (selectedTitleSource === "local" && selectedTitle.id.startsWith("companion-local-")) {
        const sessionId = selectedTitle.id.slice("companion-local-".length);
        const previous = pendingRemoteLocalStopsRef.current.get(sessionId)
          ?? (remoteLocalMediaRef.current?.media.sessionId === sessionId ? remoteLocalMediaRef.current : null);
        if (previous) {
          void reportLocalMediaState(previous.server, previous.tvCredential, sessionId, "stopped").catch(() => undefined);
          pendingRemoteLocalStopsRef.current.delete(sessionId);
          if (remoteLocalMediaRef.current?.media.sessionId === sessionId) {
            remoteLocalMediaRef.current = null;
            setActiveRemoteLocalMedia(null);
          }
        }
      }
    };
  }, [selectedTitle, selectedTitleSource, nextEpisode]);

  // Delayed release survives React StrictMode's development-only effect replay.
  // The player lifecycle effect above detaches media before this reference is released.
  useEffect(() => localSource?.retain(), [localSource]);

  useEffect(() => {
    if (!activeRemoteLocalMedia || selectedTitleSource !== "local" || ["ended", "failed", "stopped"].includes(activeRemoteLocalMedia.playbackState)) return;
    let cancelled = false;
    const renew = () => {
      void renewLocalMediaLease(activeRemoteLocalMedia.server, activeRemoteLocalMedia.tvCredential, activeRemoteLocalMedia.media.sessionId)
        .catch(() => { if (!cancelled) setPlaybackStatus("Local TV stream lease expired. Return to the browser preview and send it again."); });
    };
    renew();
    const timer = window.setInterval(renew, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeRemoteLocalMedia, selectedTitleSource]);

  useEffect(() => {
    if (!activeRemoteLocalMedia || selectedTitleSource !== "local") return;
    let cancelled = false;
    let refreshing = false;
    const refreshSubtitle = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const subtitle = await getLocalMediaSubtitle(activeRemoteLocalMedia.server, activeRemoteLocalMedia.media);
        const existing = remoteSubtitleVersionRef.current;
        if (cancelled || remoteLocalMediaRef.current?.media.sessionId !== activeRemoteLocalMedia.media.sessionId
          || (existing?.sessionId === activeRemoteLocalMedia.media.sessionId && subtitle.version <= existing.version)) return;
        const player = playerRef.current;
        if (!player) return;
        if (subtitle.text) {
          const attachment = await player.setSubtitle(subtitle.text, subtitle.label, subtitle.language);
          if (cancelled || playerRef.current !== player || remoteLocalMediaRef.current?.media.sessionId !== activeRemoteLocalMedia.media.sessionId || !attachment.enabled) return;
          player.setSubtitleTimingOffset?.(subtitle.offsetSeconds);
          player.setSubtitleEnabled(subtitle.enabled);
          setIsSubtitleAttached(true);
          setIsSubtitleEnabled(subtitle.enabled);
        } else {
          player.setSubtitleEnabled(false);
          setIsSubtitleAttached(false);
          setIsSubtitleEnabled(false);
        }
        remoteSubtitleVersionRef.current = { sessionId: activeRemoteLocalMedia.media.sessionId, version: subtitle.version };
      } catch { /* A missing subtitle snapshot should not interrupt TV playback. */ }
      finally { refreshing = false; }
    };
    void refreshSubtitle();
    const timer = window.setInterval(() => { void refreshSubtitle(); }, 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeRemoteLocalMedia, selectedTitleSource]);

  useEffect(() => {
    if (!localSource || !localUpload.session || localUpload.state !== "ready" || !browserCompanion) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await getLocalMediaUploadStatus(companionOrigin(), browserCompanion.browserCredential, localUpload.session!.sessionId);
        if (cancelled) return;
        const messages: Record<string, string> = {
          accepted: "TV command accepted. Waiting for the TV to prepare playback…",
          preparing: "TV is preparing local playback…",
          playing: "Local video is playing on TV.",
          paused: "Local video is paused on TV.",
          ended: "Local TV playback ended. The video remains available to restart.",
          failed: "The TV could not play this file. Check the TV codec support and try again.",
          stopped: "Local TV playback stopped.",
        };
        setLocalUpload((current) => ({ ...current, session: status }));
        setTvPlaybackStatus(messages[status.playbackState ?? "accepted"] || "Local TV session is active.");
      } catch {
        if (!cancelled) setTvPlaybackStatus("TV playback status is unavailable. The companion service may have restarted.");
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [browserCompanion, localSource, localUpload.session, localUpload.state]);

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
      if (attachment.enabled && selectedTitleSource === "local") publishLocalSubtitleSnapshot({ text, label: subtitle.language.toUpperCase(), language: subtitle.language, enabled: true, offsetSeconds: subtitleTimingOffsetSeconds });
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

  const attachLocalSubtitle = async (event: FormEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file || selectedTitleSource !== "local") return;
    const player = playerRef.current;
    if (!player) { setSubtitleStatus("Start local playback before opening a subtitle file."); return; }
    const requestId = ++subtitleRequestRef.current;
    setSubtitleStatus("Reading subtitle file…");
    try {
      const subtitle = await readLocalSubtitleFile(file);
      if (requestId !== subtitleRequestRef.current || playerRef.current !== player) return;
      const attachment = await player.setSubtitle(subtitle.text, subtitle.label, subtitle.language);
      if (requestId !== subtitleRequestRef.current || playerRef.current !== player) return;
      if (!attachment.enabled) {
        setSubtitleStatus("The subtitle could not be attached. The current subtitle was kept. " + (attachment.reason ?? "Try another file."));
        return;
      }
      setIsSubtitleAttached(true);
      setIsSubtitleEnabled(true);
      publishLocalSubtitleSnapshot({ text: subtitle.text, label: subtitle.label, language: subtitle.language, enabled: true, offsetSeconds: subtitleTimingOffsetSeconds });
      setSubtitleStatus("Subtitle enabled: " + subtitle.label);
    } catch (cause) {
      if (requestId !== subtitleRequestRef.current || playerRef.current !== player) return;
      setSubtitleStatus(cause instanceof Error ? cause.message : "Subtitle file could not be read.");
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
    const subtitle = localSubtitleSnapshotRef.current;
    if (selectedTitleSource === "local" && subtitle) publishLocalSubtitleSnapshot({ ...subtitle, enabled });
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
    if (selectedTitle && selectedTitleSource !== "local") {
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
    const nextOffset = adjustSubtitleOffsetSeconds(subtitleTimingOffsetSeconds, deltaSeconds);
    const offset = selectedTitleSource === "local" ? nextOffset : saveSubtitleTimingOffset(selectedTitle.id, nextOffset);
    setSubtitleTimingOffsetSeconds(offset);
    showSubtitleOffset();
    playerRef.current?.setSubtitleTimingOffset?.(offset);
    const subtitle = localSubtitleSnapshotRef.current;
    if (selectedTitleSource === "local" && subtitle) publishLocalSubtitleSnapshot({ ...subtitle, offsetSeconds: offset });
  };

  const adjustSubtitleFontSize = (delta: number) => {
    setSubtitleFontSize((current) => saveSubtitleFontSize(current + delta));
  };

  const cycleVideoDisplayMode = () => {
    const next: Record<VideoDisplayMode, VideoDisplayMode> = { auto: "fit", fit: "fill", fill: "auto" };
    setVideoDisplayMode((current) => next[current]);
  };

  const selectNextAudioTrack = () => {
    const tracks = playerRef.current?.getAudioTracks?.() ?? [];
    if (tracks.length === 0) {
      setAudioTracks([]);
      setPlaybackStatus("Audio tracks are not exposed by this playback engine.");
      return;
    }
    const selectedIndex = Math.max(0, tracks.findIndex((track) => track.selected));
    const next = tracks[(selectedIndex + 1) % tracks.length];
    if (!next || !playerRef.current?.selectAudioTrack?.(next.id)) {
      setPlaybackStatus("The selected audio track could not be changed.");
      return;
    }
    setAudioTracks(tracks.map((track) => ({ ...track, selected: track.id === next.id })));
    setPlaybackStatus(`Audio: ${next.label}`);
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
    setShowSettings(false);
    onPlaylistSetup();
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
        clearLiveRelayConfig();
        setLiveRelayConfig(null);
        clearSavedOpenSubtitlesSettings();
        clearSavedTmdbCredentials();
        setTmdbCredentials({ readAccessToken: "", apiKey: "" });
        clearPlaybackProgress();
        clearSubtitleTimingOffsets();
        clearSubtitlePreferences();
        setSubtitleLanguagePreference("fi");
        clearFavouriteGroups();
        clearCatalogClearedMarker();
        setLanguage("fi");
        setPlaylistUrl("");
        setOpenSubtitlesApiKey("");
        setContinueHistory([]);
        setFavouriteGroupIds([]);
        setCatalogStatus("");
        setSettingsStatus("");
        setShowSettings(false);
        onPlaylistSetup();
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
            setState("ready");
            return;
          }
        } catch {
          updateImportStage("Provider catalogue unavailable. Falling back to M3U import…");
        }
      }
      const response = await fetchProviderPlaylist(url);
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

  const hasSubtitleKey = Boolean(openSubtitlesApiKey.trim());
  const registerSettingsControl = (key: SettingsControlKey, element: HTMLElement | null) => {
    if (element) {
      settingsControlsRef.current[key] = element;
      element.dataset.settingsFocus = key;
    }
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
  const playerNextEpisodeFocusIndex = 4;
  const playerControlOffset = nextEpisode ? 1 : 0;
  const fullscreenFocusIndex = 4 + playerControlOffset;
  const subtitleToggleFocusIndex = 5 + playerControlOffset;
  const infoFocusIndex = 6 + playerControlOffset;
  const aspectFocusIndex = 7 + playerControlOffset;
  const audioTrackFocusIndex = 9 + playerControlOffset;
  const subtitleSmallerFocusIndex = 10 + playerControlOffset;
  const subtitleLargerFocusIndex = 11 + playerControlOffset;
  const subtitleFocus = subtitleFocusLayout({
    subtitleAttached: isSubtitleAttached,
    timingAvailable: subtitleTimingAvailable,
    apiKeyConfigured: hasSubtitleKey,
    apiKeyEditorOpen: showPlayerApiKeyEditor,
    seriesSearch: subtitleSearchType === "series",
    controlOffset: playerControlOffset,
    localSubtitleAvailable: selectedTitleSource === "local",
  });
  const subtitleTimingStartFocusIndex = subtitleFocus.timingStart;
  const subtitleSettingsFocusIndex = subtitleFocus.setupKey ?? subtitleFocus.keyInput ?? subtitleFocus.search;
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

  const isTvTitleBrowse = state === "ready" && isTizen && Boolean(activeGroup) && !selectedTitle && !detailsTitle && !showSettings && !resumeChoice;
  const isTvCategoryBrowse = state === "ready" && isTizen && !activeGroup && !selectedTitle && !detailsTitle && !showSettings && !resumeChoice && (browseCollection === "movies" || browseCollection === "series" || browseCollection === "favourites");
  const categoryRowStyle = useFixedListRowHeight(titleListViewportRef, Math.ceil(visibleGroups.length / browseGridColumnCount(false, window.innerWidth <= 800, window.innerWidth < 520, isTizen && window.innerWidth <= 1400)), { minHeight: 90, maxHeight: 160, spacing: 28 }, isTvCategoryBrowse);

  const screenHeader = <header className="app-header" onFocusCapture={() => { if (detailsTitle) setDetailsFocusIndex(0); if (selectedTitle) setPlayerFocusIndex(0); }}><div><p className="eyebrow">{settingsOnOpen ? "SUBSTREAM · SETTINGS" : "SUBSTREAM · VIDEO-ON-DEMAND"}</p><h1>{settingsOnOpen ? "Settings" : state === "ready" ? "Your VOD library" : "Connect your IPTV playlist"}</h1></div>
      {!episodePickerOpen && !(selectedTitle && playerFullscreen) && <ScreenNavigation
        onPrevious={previousScreenLabel ? goToPreviousScreen : undefined}
        previousLabel={previousScreenLabel}
        onMainMenu={onMainMenu}
        previousRef={(element) => { previousButtonRef.current = element; detailsControlsRef.current[0] = detailsTitle ? element : null; playerBackButtonRef.current = selectedTitle ? element : null; backToGroupsRef.current = activeGroup && !detailsTitle && !selectedTitle && !showSettings ? element : null; }}
        mainMenuRef={mainMenuButtonRef}
      />}
    </header>;

  if (state === "loading") return <Localized language={language}><main className="screen">{screenHeader}<p role="status" aria-live="polite">{startupStatus}</p><div className="groups skeleton-grid" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <div className="skeleton-tile" key={index} />)}</div></main></Localized>;
  if (state === "storage-error" && !settingsOnOpen) return <Localized language={language}><main className="screen">
    {screenHeader}<h2>Catalogue unavailable</h2>
    <p role="alert">{error}</p>
    <button type="button" ref={retryPlaylistRef} autoFocus onClick={() => void refreshCatalog()}>Try again</button>
  </main></Localized>;
  if (state === "importing" || state === "auto-import") return <Localized language={language}><main className="screen">{screenHeader}<h2>Importing library</h2><p role="status" aria-live="polite">{progress}</p></main></Localized>;

  const openCompanionTitle = (title: VodCatalogItem, source: "catalogue" | "local" = "catalogue") => {
    // A paired companion is a global input source. Its selection must win over
    // whatever transient TV screen is open, including the player.
    setSettingsConfirmation(null);
    setShowSettings(false);
    setResumeChoice(null);
    setSelectedTitle(null);
    setPlayerFullscreen(false);
    setShowFullscreenControls(false);
    setDetailsTitle(null);
    setDetailsSearchRecord(null);
    setDetailsOrigin(null);
    startPlayback(title, 0, null, source);
  };
  const openCompanionLocalMedia = (media: CompanionLocalPlayback, server: string, tvCredential: string) => {
    let streamUrl = "";
    try { streamUrl = companionLocalMediaUrl(server, media); }
    catch { setTvPlaybackStatus("The TV received an invalid local media session. Update the app and try again."); return; }
    const normalized = normalizeTitle(media.title);
    const title: VodCatalogItem = {
      id: `companion-local-${media.sessionId}`,
      title: media.title,
      searchTitle: media.searchTitle || normalized.searchTitle,
      searchTerms: [],
      year: media.year,
      ...(media.season ? { season: media.season } : {}),
      ...(media.episode ? { episode: media.episode } : {}),
      group: "Local companion media",
      contentType: media.contentType === "series" ? "series" : media.contentType === "movie" ? "movie" : "other",
      addedAt: Date.now(),
      streamUrl,
      sourceLine: 0,
    };
    const previous = remoteLocalMediaRef.current;
    if (previous && previous.media.sessionId !== media.sessionId) pendingRemoteLocalStopsRef.current.set(previous.media.sessionId, previous);
    const active: ActiveLocalTvSession = { media, server, tvCredential, playbackState: "preparing" };
    remoteLocalMediaRef.current = active;
    setActiveRemoteLocalMedia(active);
    void reportLocalMediaState(server, tvCredential, media.sessionId, "preparing").catch(() => undefined);
    openCompanionTitle(title, "local");
  };
  const stopCompanionLocalMedia = (sessionId: string) => {
    if (remoteLocalMediaRef.current?.media.sessionId !== sessionId) return;
    setSelectedTitle(null);
    setPlayerFullscreen(false);
    setShowFullscreenControls(false);
    setPlaybackStatus("");
  };
  return <Localized language={language}><main className={"screen" + (isTizen ? " tv-ui" : "") + (isTvTitleBrowse ? " tv-title-screen tv-fixed-list-screen" : isTvCategoryBrowse ? " tv-fixed-list-screen" : "")}>
    {screenHeader}
    {state !== "ready" && state === "error" && <section className="setup-recovery">
      <p className="error" role="alert">{error || "The saved playlist could not be imported."}</p>
      <div className="settings-actions">
        {playlistUrl.trim() && <button type="button" ref={retryPlaylistRef} onClick={() => void importPlaylistUrl(playlistUrl)}>Retry saved playlist</button>}
        <button type="button" onClick={onPlaylistSetup}>Change playlist</button>
      </div>
    </section>}
    {(state === "ready" || settingsOnOpen) && <section>
      <section className="settings-screen settings-panel" hidden={!showSettings} onFocusCapture={handleSettingsFocusCapture}>
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
          {isTizen && <CompanionPanel playlistUrl={playlistUrl} onPlay={openCompanionTitle} onLocalPlay={openCompanionLocalMedia} onLocalStop={stopCompanionLocalMedia} editingServer={editingCompanionServer} onEditingServerChange={setEditingCompanionServer} remoteMode={isTizen} registerControl={registerSettingsControl} focusClass={settingsFocusClass} />}
          {isTizen && <LiveRelaySettings config={liveRelayConfig} language={language} onSave={(config) => { const saved = saveLiveRelayConfig(config); setLiveRelayConfig(saved); setSettingsStatus("Live subtitle relay settings saved."); }} onRemove={() => { clearLiveRelayConfig(); setLiveRelayConfig(null); setSettingsStatus("Saved live subtitle relay settings removed."); }} registerControl={registerSettingsControl} focusClass={settingsFocusClass} />}
          <section className="settings-section">
            <h3>{language === "fi" ? "Käyttöliittymän kieli" : "Interface language"}</h3>
            <RemoteEditable label={language === "fi" ? "Kieli" : "Language"} value={language === "fi" ? "Suomi" : "English"} editing={editingUiLanguage} remoteMode={isTizen} className={settingsFocusClass("ui-language")} controlRef={(element) => { uiLanguageControlRef.current = element; registerSettingsControl("ui-language", element); }} onBeginEdit={() => { setEditingUiLanguage(true); window.requestAnimationFrame(() => uiLanguageControlRef.current?.focus()); }} renderEditor={(controlRef) => <label htmlFor="ui-language">{language === "fi" ? "Kieli" : "Language"}<select className={settingsFocusClass("ui-language")} data-settings-focus="ui-language" id="ui-language" value={language} ref={(element) => { uiLanguageControlRef.current = element; registerSettingsControl("ui-language", element); controlRef(element); }} onChange={(event) => setLanguage(event.target.value as UiLanguage)}><option value="fi">Suomi</option><option value="en">English</option></select></label>} />
          </section>
          <section className="settings-section">
            <h3>Navigation and playlist</h3>
            <p className="hint">Your playlist URL is stored locally and remains masked.</p>
            <button className={settingsFocusClass("playlist")} data-settings-focus="playlist" type="button" ref={(element) => registerSettingsControl("playlist", element)} onClick={changePlaylist}>Change playlist URL</button>
          </section>
          {!isTizen && <section className="settings-section">
            <h3>TV connection</h3>
            <p className="hint">Pair each TV once, then choose the named target before sending playback. On Vite development, an empty relay address uses the local /api proxy.</p>
            <label htmlFor="web-tv-relay-url">LAN relay address</label>
            <input id="web-tv-relay-url" data-settings-focus="companion-url" className={settingsFocusClass("companion-url")} type="url" value={companionServerDraft} placeholder="http://192.168.1.50:8787" autoComplete="url" onChange={(event) => setCompanionServerDraft(event.target.value)} ref={(element) => registerSettingsControl("companion-url", element)} />
            <div className="settings-actions">
              <button className={settingsFocusClass("companion-start")} data-settings-focus="companion-start" type="button" ref={(element) => registerSettingsControl("companion-start", element)} onClick={saveWebTvRelay}>Save relay address</button>
              <button type="button" onClick={() => void checkWebTvConnection()}>Check TV connection</button>
            </div>
            <label htmlFor="web-tv-pairing-name">Name this TV in the browser</label>
            <input id="web-tv-pairing-name" type="text" maxLength={40} value={webTvPairingName} onChange={(event) => setWebTvPairingName(event.target.value.slice(0, 40))} placeholder="Living room" autoComplete="off" />
            <label htmlFor="web-tv-pairing-code">One-time code shown on the TV</label>
            <div className="settings-actions">
              <input id="web-tv-pairing-code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={webTvPairingCode} onChange={(event) => setWebTvPairingCode(event.target.value.replace(/\D/g, ""))} placeholder="8-digit code" />
              <button type="button" onClick={() => void pairBrowserWithTv()} disabled={webTvPairingCode.length !== 8}>Pair browser</button>
            </div>
            {browserCompanions.length > 0 && <>
              <label htmlFor="web-tv-target">Playback target</label>
              <select id="web-tv-target" value={selectedTvDeviceId} onChange={(event) => setSelectedTvDeviceId(event.target.value)}>
                {browserCompanions.map((connection) => <option key={connection.deviceId} value={connection.deviceId}>{connection.deviceName}</option>)}
              </select>
            </>}
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
            <div className="settings-key-fields">
              <RemoteEditable label="TMDb Read Access Token" value={tmdbCredentials.readAccessToken ? "Configured (hidden)" : "Not configured"} editing={editingTmdbToken} remoteMode={isTizen} className={settingsFocusClass("tmdb-token-input")} controlRef={(element) => { tmdbTokenControlRef.current = element; registerSettingsControl("tmdb-token-input", element); }} onBeginEdit={() => { setEditingTmdbToken(true); window.requestAnimationFrame(() => settingsControlsRef.current["tmdb-token-input"]?.focus()); }} renderEditor={(controlRef) => <label htmlFor="tmdb-read-token">TMDb Read Access Token<input className={settingsFocusClass("tmdb-token-input")} data-settings-focus="tmdb-token-input" id="tmdb-read-token" type="password" placeholder="New Read Access Token" value={tmdbTokenDraft} onChange={(event) => setTmdbTokenDraft(event.target.value)} autoComplete="off" ref={(element) => { tmdbTokenControlRef.current = element; registerSettingsControl("tmdb-token-input", element); controlRef(element); }} /></label>} />
              <RemoteEditable label="TMDb API key fallback" value={tmdbCredentials.apiKey ? "Configured (hidden)" : "Not configured"} editing={editingTmdbApiKey} remoteMode={isTizen} className={settingsFocusClass("tmdb-key-input")} controlRef={(element) => { tmdbApiKeyControlRef.current = element; registerSettingsControl("tmdb-key-input", element); }} onBeginEdit={() => { setEditingTmdbApiKey(true); window.requestAnimationFrame(() => settingsControlsRef.current["tmdb-key-input"]?.focus()); }} renderEditor={(controlRef) => <label htmlFor="tmdb-api-key">TMDb API key fallback<input className={settingsFocusClass("tmdb-key-input")} data-settings-focus="tmdb-key-input" id="tmdb-api-key" type="password" placeholder="Optional API key fallback" value={tmdbApiKeyDraft} onChange={(event) => setTmdbApiKeyDraft(event.target.value)} autoComplete="off" ref={(element) => { tmdbApiKeyControlRef.current = element; registerSettingsControl("tmdb-key-input", element); controlRef(element); }} /></label>} />
            </div>
            <div className="settings-actions settings-key-actions">
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
      </section>
      {!showSettings && (detailsTitle && details ? <section className="title-details" aria-labelledby="title-details-heading">
        <div className="details-actions">
          <button className={detailsFocusIndex === (detailsTitle.providerSeriesId && detailsEpisodes.length ? 2 : 1) ? "remote-focused" : ""} type="button" ref={(element) => { detailsControlsRef.current[2] = element; detailsControlsRef.current[1] = element; }} onFocus={() => setDetailsFocusIndex(detailsTitle.providerSeriesId && detailsEpisodes.length ? 2 : 1)} disabled={Boolean(detailsTitle.providerSeriesId && detailsEpisodes.length && !detailsEpisodeId)} onClick={() => void (detailsTitle.providerSeriesId ? (detailsEpisodes.length ? playSelectedSeriesEpisode() : chooseSeriesEpisodes(detailsTitle)) : playFromDetails(detailsTitle))}>{detailsOrigin?.kind === "local" ? "Play on this computer" : detailsTitle.providerSeriesId ? (detailsEpisodes.length ? "Play selected episode" : "Choose season and episode") : "Play here"}</button>
          {detailsOrigin?.kind === "local" && !isTizen && <button className={detailsFocusIndex === 2 ? "remote-focused" : ""} type="button" ref={(element) => { detailsControlsRef.current[3] = element; }} onFocus={() => setDetailsFocusIndex(2)} onClick={() => {
            if (localUpload.state === "uploading" || localUpload.state === "preparing") cancelLocalUpload();
            else if (localUpload.session && ["playing", "paused", "preparing", "accepted"].includes(localUpload.session.playbackState ?? "")) void stopLocalTvPlayback();
            else void playLocalOnTv();
          }}>{localUpload.state === "preparing" ? "Cancel TV preparation" : localUpload.state === "uploading" ? `Cancel upload (${Math.floor(localUpload.sentBytes * 100 / Math.max(1, localUpload.totalBytes))}%)` : localUpload.session && ["playing", "paused", "preparing", "accepted"].includes(localUpload.session.playbackState ?? "") ? "Stop TV playback" : "Play on TV"}</button>}
          {detailsOrigin?.kind === "local" && !isTizen && <button className={detailsFocusIndex === 3 ? "remote-focused" : ""} type="button" ref={(element) => { detailsControlsRef.current[4] = element; }} onFocus={() => setDetailsFocusIndex(3)} onClick={() => setShowSettings(true)}>TV settings and pairing</button>}
          {detailsOrigin?.kind === "local" && onChooseLocalFile && <button className={detailsFocusIndex === 4 ? "remote-focused" : ""} type="button" ref={(element) => { detailsControlsRef.current[5] = element; }} onFocus={() => setDetailsFocusIndex(4)} onClick={onChooseLocalFile}>Choose another file</button>}
          {!isTizen && detailsOrigin?.kind !== "local" && (detailsSearchRecord || /^xtream:(movie|series):\d{1,20}$/.test(detailsTitle.id)) && <button className={detailsFocusIndex === 3 ? "remote-focused" : ""} type="button" ref={(element) => { detailsControlsRef.current[3] = element; }} onFocus={() => setDetailsFocusIndex(3)} disabled={Boolean(detailsTitle.providerSeriesId && (!detailsEpisodes.length || !detailsEpisodeId))} onClick={() => void playSearchResultOnTv(detailsTitle.providerSeriesId ? (detailsEpisodes.find((episode) => episode.id === detailsEpisodeId) ?? detailsTitle) : detailsTitle)}>Play on TV</button>}
        </div>
        {tvPlaybackStatus && <p className="hint" role="status" aria-live="polite">{tvPlaybackStatus}</p>}
        {episodeStatus && <p className="hint" role="status" aria-live="polite">{episodeStatus}</p>}
        <div className="details-layout">
          <div className="details-poster" aria-label={detailsPosterUrl || details.posterUrl ? `Poster for ${detailsTitle.title}` : "Poster unavailable"}>
            {detailsPosterUrl || details.posterUrl ? <img src={detailsPosterUrl || details.posterUrl} alt="" loading="lazy" /> : <span>{detailsMetadataStatus === "Loading title details…" ? "Loading artwork…" : "Artwork unavailable"}</span>}
          </div>
          <div className="details-copy">
            <p className="eyebrow">{detailsTitle.contentType === "series" ? "SERIES" : detailsTitle.contentType === "other" ? "VIDEO · TYPE UNKNOWN" : "MOVIE"}</p>
            <h2 id="title-details-heading"><span translate="no">{detailsTitle.title}</span></h2>
            <p className="details-facts">{details.year ?? "Year unavailable"}{details.runtimeMinutes ? ` · ${formatRuntime(details.runtimeMinutes)}${detailsTitle.contentType === "series" ? ` / ${translate("episode", language)}` : ""}` : ""}{details.rating !== undefined ? ` · ★ ${details.rating.toFixed(1)}/10` : ""}{details.genres.length > 0 && <span translate="no"> · {details.genres.slice(0, 3).join(" · ")}</span>}</p>
            {detailsMetadata?.tagline && <p className="details-tagline" translate="no">{detailsMetadata.tagline}</p>}
            <h3 className="details-section-heading">Overview</h3>
            <p className="details-synopsis">{details.synopsis ? <span translate="no">{details.synopsis}</span> : detailsMetadataStatus === "Loading title details…" ? "Loading details…" : "Synopsis unavailable for this title."}</p>
            {detailsMetadata && <TitleMetadataExtras metadata={detailsMetadata} language={language} />}
            {detailsOrigin?.kind === "local" && <div className="details-metadata-search"><label htmlFor="local-details-search">Subtitle and artwork search title</label><input id="local-details-search" type="text" value={localDetailsSearchTitle} onChange={(event) => setLocalDetailsSearchTitle(event.target.value)} /></div>}
            {detailsMetadataStatus && detailsMetadataStatus !== "Loading title details…" && <p className="hint" role="status">{detailsMetadataStatus}</p>}
            {detailsOrigin?.kind === "local" && detailsTitle.contentType === "other" && <p className="hint">{detailsTitle.classification?.evidence.join(" ")}</p>}
            {detailsOrigin?.kind === "local" && (tmdbCredentials.readAccessToken || tmdbCredentials.apiKey) && <button type="button" onClick={() => void openTitle(detailsTitle, { kind: "local", focusIndex: detailsFocusIndex })}>Search details again</button>}
            {details.subtitleLanguages.length > 0 ? <p className="hint">Subtitles available: {details.subtitleLanguages.join(", ")}</p> : <p className="hint">Subtitle languages will appear after searching OpenSubtitles.</p>}
            {detailsHistory && <p className="details-resume" role="status">Resume available at {formatPlaybackTime(detailsHistory.currentTimeSeconds)} of {formatPlaybackTime(detailsHistory.durationSeconds)}</p>}
            {detailsTitle.providerSeriesId && detailsEpisodes.length > 0 && <RemoteEditable label="Season / episode" translateValue={false} value={(() => { const episode = detailsEpisodes.find((item) => item.id === detailsEpisodeId); return episode ? `${episode.season !== undefined ? `${translate("Season", language)} ${episode.season}, ` : ""}${episode.episode !== undefined ? `${translate("Episode", language)} ${episode.episode}` : episode.title}` : translate("Choose episode", language); })()} editing={editingDetailsEpisode} remoteMode={isTizen} className={detailsFocusIndex === 1 ? "remote-focused" : ""} controlRef={(element) => { detailsEpisodeControlRef.current = element; }} onBeginEdit={() => { setEditingDetailsEpisode(true); window.requestAnimationFrame(() => detailsEpisodeSelectRef.current?.focus()); }} renderEditor={(controlRef) => <label className="details-episode-picker" htmlFor="details-episode-picker">Season / episode<select className={detailsFocusIndex === 1 ? "remote-focused" : ""} id="details-episode-picker" ref={(element) => { detailsEpisodeSelectRef.current = element; controlRef(element); }} onFocus={() => { setDetailsFocusIndex(1); webEpisodeSelectionChangedRef.current = false; }} value={detailsEpisodeId} onChange={(event) => { webEpisodeSelectionChangedRef.current = true; setDetailsEpisodeId(event.target.value); setDetailsFocusIndex(2); window.requestAnimationFrame(() => { webEpisodeSelectionChangedRef.current = false; detailsControlsRef.current[2]?.focus(); }); }} aria-label="Choose season and episode">{detailsEpisodes.map((episode) => <option key={episode.id} value={episode.id} translate={episode.episode === undefined ? "no" : undefined}>{episode.season !== undefined ? `Season ${episode.season}, ` : ""}{episode.episode !== undefined ? `Episode ${episode.episode}` : episode.title}</option>)}</select></label>} />}
          </div>
        </div>
        {episodePickerOpen && isTizen && <div className="episode-picker-backdrop" role="presentation">
          <section className="episode-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="episode-picker-heading">
            <header className="app-header"><h3 id="episode-picker-heading">{episodePickerLevel === "seasons" ? "Choose a season" : translate("Choose an episode (Season {{season}})", language).replace("{{season}}", String(episodePickerSeason ?? "—"))}</h3><ScreenNavigation onPrevious={goToPreviousScreen} previousLabel={episodePickerLevel === "episodes" && pickerSeasons.length > 1 ? "Seasons" : "Back to details"} onMainMenu={onMainMenu} previousRef={previousButtonRef} mainMenuRef={mainMenuButtonRef} /></header>
            <p className="hint">{episodePickerLevel === "seasons" ? translate("Use arrows to move, Action to select, Back to close.", language) : translate("Use arrows to move, Action to select, Back to", language) + ` ${pickerSeasons.length > 1 ? translate("return to seasons", language) : translate("close", language)}.`}</p>
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
              >{typeof option === "number" ? `Season ${option}` : option.episode !== undefined ? `Episode ${option.episode}` : <span translate="no">{option.title}</span>}</button>)}
            </div>
          </section>
        </div>}
      </section> : resumeChoice ? <div className="modal-backdrop"><section className="resume-choice modal-panel" role="dialog" aria-modal="true" aria-labelledby="resume-title">
        <h2 id="resume-title">Continue “<span translate="no">{resumeChoice.title.title}</span>”?</h2>
        <p className="hint">Saved at {formatPlaybackTime(resumeChoice.history.currentTimeSeconds)} of {formatPlaybackTime(resumeChoice.history.durationSeconds)}.</p>
        <div className="resume-choice-actions">
          <button className={resumeChoiceFocusIndex === 0 ? "remote-focused" : ""} type="button" ref={(element) => { resumeChoiceControlsRef.current[0] = element; }} onFocus={() => setResumeChoiceFocusIndex(0)} onClick={() => chooseResumeAction(true)}>Resume</button>
          <button className={resumeChoiceFocusIndex === 1 ? "remote-focused" : ""} type="button" ref={(element) => { resumeChoiceControlsRef.current[1] = element; }} onFocus={() => setResumeChoiceFocusIndex(1)} onClick={() => chooseResumeAction(false)}>Start over</button>
          <button className={resumeChoiceFocusIndex === 2 ? "remote-focused" : ""} type="button" ref={(element) => { resumeChoiceControlsRef.current[2] = element; }} onFocus={() => setResumeChoiceFocusIndex(2)} onClick={() => setResumeChoice(null)}>Cancel</button>
        </div>
      </section></div> : pendingHistoryRemoval ? <div className="modal-backdrop"><section className="confirmation-panel modal-panel" role="dialog" aria-modal="true" aria-labelledby="history-remove-title">
        <h2 id="history-remove-title">Remove from Continue watching?</h2>
        <p className="hint"><span translate="no">{pendingHistoryRemoval.title}</span> will leave this list. Your playlist will stay intact.</p>
        <div className="settings-actions">
          <button ref={historyCancelRef} type="button" onClick={() => { setPendingHistoryRemoval(null); window.requestAnimationFrame(() => tileRefs.current[focusIndex]?.focus()); }}>Cancel</button>
          <button ref={historyConfirmRef} className="danger-button" type="button" onClick={confirmHistoryRemoval}>Remove</button>
        </div>
      </section></div> : selectedTitle ? <section className={"player-screen " + (playerFullscreen ? "is-fullscreen" : "") + (playerFullscreen && showFullscreenControls ? " has-visible-controls" : "") + (showPlayerTools ? " show-tools" : "")} onFocusCapture={(event) => {
        const target = event.target as HTMLElement;
        const controls = playerControls();
        const index = target === playerStageRef.current || playerStageRef.current?.contains(target)
          ? videoAreaFocusIndex
          : controls.indexOf(target);
        if (index >= 0) setPlayerFocusIndex(index);
      }}>
        <div className="player-heading">
          <div className="player-title"><h2 translate="no">{selectedTitle.title}</h2><p className="hint">{selectedTitle.year ?? selectedTitle.contentType}</p></div>
          {selectedTitleSource === "local" && onChooseLocalFile && <button type="button" onClick={onChooseLocalFile}>Choose another file</button>}
          {playerFullscreen && <ScreenNavigation onPrevious={goToPreviousScreen} previousLabel={selectedTitleSource === "local" ? "Back to details" : "Back to titles"} onMainMenu={onMainMenu} previousRef={(element) => { previousButtonRef.current = element; playerBackButtonRef.current = element; }} mainMenuRef={mainMenuButtonRef} />}
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
          {(playbackStatus === PLAYBACK_UNAVAILABLE_MESSAGE || playbackStatus === LOCAL_PLAYBACK_ERROR_MESSAGE) && <div className="playback-error-overlay" role="alert"><strong>Video unavailable</strong><span>{playbackStatus}</span></div>}
          {showVideoInfo && <aside className="video-info-overlay" role="status" aria-live="polite"><strong>Video information</strong><span>Resolution: {videoResolution}</span></aside>}
          {visibleSubtitle && <p className="subtitle-overlay" aria-live="off" style={{ fontSize: subtitleFontSize + "rem" }}><span translate="no">{visibleSubtitle}</span></p>}
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
          {nextEpisode && <button className={playerFocusIndex === playerNextEpisodeFocusIndex ? "remote-focused" : ""} type="button" onClick={() => startPlayback(nextEpisode, 0, followingEpisodeFor(nextEpisode))} ref={playerNextEpisodeButtonRef}>Play next episode</button>}
          <button className={playerFocusIndex === fullscreenFocusIndex ? "remote-focused" : ""} type="button" onClick={toggleFullscreen} ref={playerFullscreenButtonRef}>{playerFullscreen ? "Exit full screen" : "Full screen"}</button>
          <button className={playerFocusIndex === subtitleToggleFocusIndex ? "remote-focused" : ""} type="button" onClick={isSubtitleAttached ? toggleSubtitles : () => { setShowPlayerTools(true); setPlayerFocusIndex(infoFocusIndex); window.requestAnimationFrame(() => playerInfoButtonRef.current?.focus()); }} aria-label={isSubtitleAttached ? "Subtitles" : "Find subtitles"} aria-pressed={isSubtitleAttached ? isSubtitleEnabled : undefined} ref={subtitleToggleButtonRef}>{isSubtitleAttached ? `Subtitles: ${isSubtitleEnabled ? "On" : "Off"}` : "Find subtitles"}</button>
          <button className={playerFocusIndex === infoFocusIndex ? "remote-focused" : ""} type="button" onClick={() => setShowPlayerTools((visible) => !visible)} aria-expanded={showPlayerTools} ref={playerInfoButtonRef}>Subtitles &amp; more</button>
          {showPlayerTools && <>
            <button className={playerFocusIndex === aspectFocusIndex ? "remote-focused" : ""} type="button" onClick={cycleVideoDisplayMode} ref={playerAspectButtonRef}>Aspect: {videoDisplayMode === "auto" ? "Auto" : videoDisplayMode === "fit" ? "Fit" : "Fill"}</button>
            <button className={playerFocusIndex === 8 + playerControlOffset ? "remote-focused" : ""} type="button" onClick={() => setShowVideoInfo((visible) => !visible)} ref={playerTechnicalInfoButtonRef}>Info</button>
            <button className={playerFocusIndex === audioTrackFocusIndex ? "remote-focused" : ""} type="button" onClick={selectNextAudioTrack} ref={playerAudioTrackButtonRef}>{audioTracks.length === 0 ? "Audio: unavailable" : `Audio: ${(audioTracks.find((track) => track.selected) ?? audioTracks[0])?.label}`}</button>
            <button className={playerFocusIndex === subtitleSmallerFocusIndex ? "remote-focused" : ""} type="button" onClick={() => adjustSubtitleFontSize(-.2)} ref={subtitleSmallerButtonRef}>Subtitle A−</button>
            <button className={playerFocusIndex === subtitleLargerFocusIndex ? "remote-focused" : ""} type="button" onClick={() => adjustSubtitleFontSize(.2)} ref={subtitleLargerButtonRef}>Subtitle A+</button>
          </>}
          <span className={"playback-status " + ([PLAYBACK_UNAVAILABLE_MESSAGE, LOCAL_PLAYBACK_ERROR_MESSAGE].includes(playbackStatus) ? "error" : "")} role="status" aria-live="polite">{playbackStatus}</span>
        </div>
        {showPlayerTools && <section className="subtitles">
          <h3>Subtitles</h3>
          {selectedTitleSource === "local" && <div className="subtitle-actions">
            <input ref={localSubtitleInputRef} className="sr-only" type="file" accept=".srt,.vtt,application/x-subrip,text/vtt" onChange={attachLocalSubtitle} aria-label="Choose an SRT or WebVTT subtitle file" />
            <button className={playerFocusIndex === subtitleFocus.localSubtitle ? "remote-focused" : ""} type="button" ref={openLocalSubtitleButtonRef} onClick={() => localSubtitleInputRef.current?.click()}>Open subtitle file (SRT/WebVTT)</button>
            <p className="hint">Subtitle search uses the editable title only. Video bytes and file paths stay on this computer.</p>
          </div>}
          {subtitleTimingAvailable && <div className="subtitle-timing" aria-label="Subtitle timing controls">
            <p><strong>Current offset: {formatSubtitleTimingOffset(subtitleTimingOffsetSeconds)}</strong></p>
            <p className="hint">{selectedTitleSource === "local" ? "Positive values show subtitles later; negative values show them earlier. Kept in memory for this local session." : "Positive values show subtitles later; negative values show them earlier. Saved for this title on this device."}</p>
            <div className="subtitle-timing-actions">
              <button className={playerFocusIndex === subtitleTimingStartFocusIndex ? "remote-focused" : ""} type="button" onClick={() => adjustSubtitleTiming(-2)} ref={subtitleTimingMinusTwoButtonRef}>−2 s</button>
              <button className={playerFocusIndex === subtitleTimingStartFocusIndex + 1 ? "remote-focused" : ""} type="button" onClick={() => adjustSubtitleTiming(-0.5)} ref={subtitleTimingMinusHalfButtonRef}>−0.5 s</button>
              <button className={playerFocusIndex === subtitleTimingStartFocusIndex + 2 ? "remote-focused" : ""} type="button" onClick={() => adjustSubtitleTiming(0.5)} ref={subtitleTimingPlusHalfButtonRef}>+0.5 s</button>
              <button className={playerFocusIndex === subtitleTimingStartFocusIndex + 3 ? "remote-focused" : ""} type="button" onClick={() => adjustSubtitleTiming(2)} ref={subtitleTimingPlusTwoButtonRef}>+2 s</button>
            </div>
          </div>}
          {!hasSubtitleKey && <div className="subtitle-actions">
            <RemoteEditable label="OpenSubtitles API key" value="Not configured" editing={showPlayerApiKeyEditor} remoteMode={isTizen} className={playerFocusIndex === subtitleSettingsFocusIndex ? "remote-focused" : ""} controlRef={(element) => { subtitleKeyControlRef.current = element; }} onBeginEdit={showPlayerApiKeySetup} renderEditor={(controlRef) => <label htmlFor="opensubtitles-api-key">OpenSubtitles API key<input id="opensubtitles-api-key" type="password" value={openSubtitlesApiKey} onChange={(event) => setOpenSubtitlesApiKey(event.target.value)} autoComplete="off" ref={(element) => { openSubtitlesApiKeyRef.current = element; subtitleKeyInputRef.current = element; controlRef(element); }} /></label>} />
            {showPlayerApiKeyEditor && <button className={playerFocusIndex === subtitleFocus.saveKey ? "remote-focused" : ""} type="button" onClick={saveSubtitleSettings} ref={subtitleSaveButtonRef}>Save settings</button>}
          </div>}
          <p className="subtitle-search-heading">Subtitle search</p>
          <div className="subtitle-search-options">
            <RemoteEditable label="Title" value={subtitleSearchQuery} translateValue={false} editing={editingSubtitleQuery} remoteMode={isTizen} className={`subtitle-search-query ${playerFocusIndex === subtitleSearchFocusIndex ? "remote-focused" : ""}`} controlRef={(element) => { subtitleSearchControlRef.current = element; }} onBeginEdit={() => { setEditingSubtitleQuery(true); window.requestAnimationFrame(() => subtitleSearchInputRef.current?.focus()); }} renderEditor={(controlRef) => <label className="subtitle-search-query" htmlFor="subtitle-search-query">Title<input id="subtitle-search-query" type="search" value={subtitleSearchQuery} onChange={(event) => setSubtitleSearchQuery(event.target.value)} autoComplete="off" enterKeyHint="search" aria-label="Subtitle search term" ref={(element) => { subtitleSearchInputRef.current = element; controlRef(element); }} /></label>} />
            <RemoteEditable label="Type" value={subtitleSearchType === "movie" ? "Movie" : "Series"} editing={editingSubtitleType} remoteMode={isTizen} className={playerFocusIndex === subtitleSearchTypeFocusIndex ? "remote-focused" : ""} controlRef={(element) => { subtitleSearchTypeControlRef.current = element; }} onBeginEdit={() => { setEditingSubtitleType(true); window.requestAnimationFrame(() => subtitleSearchTypeRef.current?.focus()); }} renderEditor={(controlRef) => <label htmlFor="subtitle-search-type">Type<select id="subtitle-search-type" value={subtitleSearchType} onChange={(event) => setSubtitleSearchType(event.target.value as SubtitleSearchType)} ref={(element) => { subtitleSearchTypeRef.current = element; controlRef(element); }}><option value="movie">Movie</option><option value="series">Series</option></select></label>} />
            {subtitleSearchType === "series" && <>
              <RemoteEditable label="Season" value={subtitleSearchSeason} editing={editingSubtitleSeason} remoteMode={isTizen} className={`subtitle-search-number ${playerFocusIndex === subtitleSeasonFocusIndex ? "remote-focused" : ""}`} controlRef={(element) => { subtitleSearchSeasonControlRef.current = element; }} onBeginEdit={() => { setEditingSubtitleSeason(true); window.requestAnimationFrame(() => subtitleSearchSeasonRef.current?.focus()); }} renderEditor={(controlRef) => <label className="subtitle-search-number" htmlFor="subtitle-search-season">Season<input id="subtitle-search-season" type="number" min="1" step="1" inputMode="numeric" value={subtitleSearchSeason} onChange={(event) => setSubtitleSearchSeason(event.target.value)} ref={(element) => { subtitleSearchSeasonRef.current = element; controlRef(element); }} /></label>} />
              <RemoteEditable label="Episode" value={subtitleSearchEpisode} editing={editingSubtitleEpisode} remoteMode={isTizen} className={`subtitle-search-number ${playerFocusIndex === subtitleEpisodeFocusIndex ? "remote-focused" : ""}`} controlRef={(element) => { subtitleSearchEpisodeControlRef.current = element; }} onBeginEdit={() => { setEditingSubtitleEpisode(true); window.requestAnimationFrame(() => subtitleSearchEpisodeRef.current?.focus()); }} renderEditor={(controlRef) => <label className="subtitle-search-number" htmlFor="subtitle-search-episode">Episode<input id="subtitle-search-episode" type="number" min="1" step="1" inputMode="numeric" value={subtitleSearchEpisode} onChange={(event) => setSubtitleSearchEpisode(event.target.value)} ref={(element) => { subtitleSearchEpisodeRef.current = element; controlRef(element); }} /></label>} />
            </>}
            <button className={`subtitle-search-submit ${playerFocusIndex === findSubtitleFocusIndex ? "remote-focused" : ""}`} type="button" onClick={() => void findSubtitles()} ref={findSubtitlesButtonRef}>Find subtitles</button>
          </div>
          {subtitleStatus && <p className="hint">{subtitleStatus}</p>}
          <div className="subtitle-results">
            {subtitleResults.map((subtitle, index) => <article key={subtitle.id}>
              <strong translate="no">{subtitle.language.toUpperCase()} · {subtitle.releaseName}</strong>
              <span>{subtitle.downloads.toLocaleString()} downloads{subtitle.hearingImpaired ? " · HI" : ""}</span>
              <button className={playerFocusIndex === index + firstSubtitleFocusIndex ? "remote-focused" : ""} type="button" onClick={() => void loadSubtitle(subtitle)} ref={(element) => { subtitleButtonRefs.current[index] = element; }}>Use this subtitle</button>
            </article>)}
          </div>
        </section>}
      </section> : activeGroup ? <>
        <div className="catalogue-heading">
          <div><h2 translate="no" title={(isLatestVirtualGroup(activeGroup) ? translate("Latest", language) : formatGroupDisplayName(activeGroup.name, language))}>{(isLatestVirtualGroup(activeGroup) ? translate("Latest", language) : formatGroupDisplayName(activeGroup.name, language))}</h2><p className="hint">{browseCount.toLocaleString()} {browseMode === "episodes" ? "episodes" : "titles"} · page {page + 1} of {browsePageCount(browseCount, PAGE_SIZE)}</p></div>
          {browseMode !== "latest" && <RemoteEditable label="Sort" value={sortLabel(sort)} editing={editingSort} className="sort-control" controlRef={(element) => { sortControlRef.current = element; }} onBeginEdit={() => { setSortDraft(sort); setEditingSort(true); window.requestAnimationFrame(() => sortSelectRef.current?.focus()); }} renderEditor={(controlRef) => <label className="sort-control" htmlFor="vod-sort-select">Sort
            <select id="vod-sort-select" ref={(element) => { sortSelectRef.current = element; controlRef(element); }} value={sortDraft} onChange={(event) => {
              const nextSort = event.target.value as VodSort;
              setSortDraft(nextSort);
            }}>
              <option value="title">Title A–Z</option>
              <option value="playlist">Playlist order</option>
              <option value="year">Release year (newest)</option>
            </select>
          </label>} />}
          {browseMode === "latest" && <button className={browseControlFocus === "latest-refresh" ? "remote-focused" : ""} type="button" ref={latestRefreshRef} onFocus={() => setBrowseControlFocus("latest-refresh")} onBlur={() => setBrowseControlFocus(null)} onClick={() => void openLatest(activeGroup?.contentType === "series" ? "series" : "movie", true)}>Refresh Latest</button>}
        </div>
        {isTizen && <p className="remote-key-hint tv-title-list-hint">{browseMode === "latest" ? "Use the arrow keys to browse titles · Up from the first row returns to refresh" : "Use the arrow keys to browse titles · Up from the first row returns to sorting"}</p>}
        <div className={isTizen ? "tv-title-list-viewport fixed-list-viewport" : ""} ref={isTizen ? titleListViewportRef : undefined}>
        {catalogStatus && <p className="hint browse-status" role="status" aria-live="polite">{catalogStatus}</p>}
        <div className={"groups title-grid" + (isTizen ? " tv-title-list" : "")}>
          {titles.map((title, index) => <button className={"tile title-card " + (index === focusIndex ? "focused remote-focused" : "")} key={title.id} onClick={() => { setFocusIndex(index); void openTitle(title); }} ref={(element) => { tileRefs.current[index] = element; }} type="button">
            <BrowseArtwork title={title.title} image={browseArtwork[title.id]} /><span className="tile-copy"><strong><span translate="no">{title.title}</span></strong><span className="tile-meta">{title.season !== undefined && title.episode !== undefined ? "S" + String(title.season).padStart(2, "0") + "E" + String(title.episode).padStart(2, "0") : title.year ?? title.contentType}</span>{browseMode === "latest" && <span className="tile-meta" translate="no">{formatCategoryBadge(title.group, language)}</span>}</span>
          </button>)}
          {!titles.length && !catalogStatus.startsWith("Loading ") && <p className="empty-state">{browseMode === "latest" && !groups.some((group) => favouriteGroupIds.includes(group.id) && ((group.providerContentType ?? group.contentType) === activeGroup?.contentType || group.contentType === "mixed")) ? "Favourite categories to see Latest titles." : "No titles are available in this group yet."}</p>}
        </div>
        </div>
        <div className="pagination">
          <button aria-label={isTizen ? "Previous page (Left)" : "Previous page"} className={browseControlFocus === "previous-page" ? "remote-focused" : ""} disabled={page === 0} ref={previousPageRef} onFocus={() => setBrowseControlFocus("previous-page")} onBlur={() => setBrowseControlFocus(null)} onClick={() => changeBrowsePage(page - 1)} type="button">{isTizen ? "Previous page · ←" : "Previous"}</button>
          <button aria-label={isTizen ? "Next page (Right)" : "Next page"} className={browseControlFocus === "next-page" ? "remote-focused" : ""} disabled={page + 1 >= browsePageCount(browseCount, PAGE_SIZE)} ref={nextPageRef} onFocus={() => setBrowseControlFocus("next-page")} onBlur={() => setBrowseControlFocus(null)} onClick={() => changeBrowsePage(page + 1)} type="button">{isTizen ? "Next page · →" : "Next"}</button>
        </div>
      </> : <>
        <nav className="browse-tabs" role="tablist" aria-label="Browse your library">
          {sectionOrder.map((collection, index) => <button
            aria-selected={browseCollection === collection}
            className={"browse-tab " + (browseCollection === collection ? "selected" : "")}
            key={collection}
            onClick={() => { if (collection === browseCollection) return; latestRequestRef.current += 1; browseTabTransitionRef.current = "menu"; setFocusIndex(0); setBrowseCollection(collection); }}
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
              <button className={"tile title-card " + (index * 2 === focusIndex ? "focused remote-focused" : "")} onClick={() => { setFocusIndex(index * 2); void openHistoryEntry(entry); }} ref={(element) => { tileRefs.current[index * 2] = element; }} type="button">
                <BrowseArtwork title={entry.title} image={browseArtwork[entry.id]} /><span className="tile-copy"><strong><span translate="no">{entry.title}</span></strong><span>Resume · {formatPlaybackTime(entry.currentTimeSeconds)} of {formatPlaybackTime(entry.durationSeconds)}</span></span>
                <progress className="history-progress" max={Math.max(1, entry.durationSeconds)} value={Math.min(Math.max(0, entry.currentTimeSeconds), Math.max(1, entry.durationSeconds))} aria-label={`Watched ${formatPlaybackTime(entry.currentTimeSeconds)} of ${formatPlaybackTime(entry.durationSeconds)}`} />
              </button>
              <button className={"tile remove-history " + (index * 2 + 1 === focusIndex ? "focused remote-focused" : "")} onClick={() => { setFocusIndex(index * 2 + 1); removeHistoryEntry(entry); }} ref={(element) => { tileRefs.current[index * 2 + 1] = element; }} type="button" aria-label={`Remove ${entry.title} from Continue watching`}>
                <strong>Remove</strong>
              </button>
            </Fragment>)}
          </div>
        </>}
        {browseCollection === "recent" && continueHistory.length === 0 && <div className="empty-state"><h2>Nothing here yet</h2><p>Titles you start watching will appear here so you can pick up where you left off.</p><button className="empty-state-action" type="button" ref={browseEmptyRecoveryRef} onClick={() => { browseTabTransitionRef.current = "content"; setBrowseCollection("movies"); setFocusIndex(0); }}>Browse movies</button></div>}
        {browseCollection === "search" && <section className="catalog-search" aria-labelledby="catalog-search-heading">
          <div className="collection-heading"><h2 id="catalog-search-heading">Search your catalogue</h2><p className="hint">Search your imported M3U titles and the full catalogue from your Xtream playlist.</p></div>
          <div className="catalog-search-form">
            <label htmlFor="catalog-search-input">Title</label>
            <div className="catalog-search-controls"><input id="catalog-search-input" ref={searchInputRef} type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search movies and series" autoComplete="off" /><button type="button" disabled={!searchProviderFingerprint || searchRefreshLoading} onClick={() => void refreshSearchCatalogue()}>{searchProviderFingerprint ? searchRefreshLoading ? "Refreshing catalogue…" : "Refresh Xtream catalogue" : "M3U catalogue is local"}</button></div>
          </div>
          <p className="hint" role="status" aria-live="polite">{searchStatus || (searchProviderFingerprint ? "Search is available without a TV connection. Refresh the Xtream catalogue when needed." : "Searching titles saved on this device. Add an Xtream playlist to refresh a full provider catalogue.")}</p>
          <div className="groups search-results">
            {visibleSearchItems.map((result, index) => <button className={`tile title-card ${index === focusIndex ? "focused remote-focused" : ""}`} key={result.key} ref={(element) => { tileRefs.current[index] = element; }} type="button" onClick={() => result.record ? openSearchRecord(result.record, index) : openLocalSearchItem(result.item, index)}>
              <BrowseArtwork title={result.title} image={browseArtwork[result.item.id]} /><span className="tile-copy"><strong><span translate="no">{result.title}</span></strong><span className="tile-meta">{result.kind === "series" ? "Series" : result.kind === "movie" ? "Movie" : "Other"}{result.year ? ` · ${result.year}` : ""}{result.category ? <span translate="no">{` · ${formatCategoryBadge(result.category, language)}`}</span> : ""}</span></span>
            </button>)}
            {!visibleSearchItems.length && searchQuery.trim().length >= 2 && <p className="empty-state">No matching titles found.</p>}
            {!visibleSearchItems.length && searchQuery.trim().length < 2 && <p className="empty-state">Enter at least two characters to search.</p>}
          </div>
        </section>}
        {browseCollection !== "recent" && browseCollection !== "search" && <>
          <div className="collection-heading"><h2>{browseCollection === "favourites" ? "Favourite groups" : browseCollection === "movies" ? "Movies" : "Series"}</h2><p className="hint">{browseCollection === "favourites" ? "Your saved movie genres and series categories." : "Choose a group to browse its titles. Provider groups load when selected."}</p><p className="remote-key-hint">Press the red remote key to toggle the focused group as a favourite.</p>{favouriteStatus && <p className="hint" role="status" aria-live="polite">{favouriteStatus}</p>}</div>
          <div className={isTizen ? "groups group-grid fixed-list-viewport" : "groups group-grid"} ref={isTizen ? titleListViewportRef : undefined}>
          {visibleGroups.map((group, index) => <div className={"favourite-tile" + (isTizen ? " fixed-list-item" : "")} key={group.id}><button className={"tile " + (index === focusIndex ? "focused remote-focused" : "")} style={isTizen ? categoryRowStyle : undefined} onClick={() => { browseReturnFocusIndexRef.current = index; setFocusIndex(index); void openGroup(group, 0); }} ref={(element) => { tileRefs.current[index] = element; }} type="button">
            <strong translate="no" title={(isLatestVirtualGroup(group) ? translate("Latest", language) : formatGroupDisplayName(group.name, language))}>{(isLatestVirtualGroup(group) ? translate("Latest", language) : formatGroupDisplayName(group.name, language))}</strong><span>{isLatestVirtualGroup(group) ? (group.contentType === "series" ? "Recently updated shows" : "Recently added movies") : group.providerCategoryId ? "Select to load titles" : `${group.count.toLocaleString()} titles`}</span>{!isLatestVirtualGroup(group) && favouriteGroupIds.includes(group.id) && <span className="favourite-indicator">★ Favourite</span>}
          </button>{!isLatestVirtualGroup(group) && <button className="quiet-button favourite-toggle" type="button" tabIndex={isTizen ? -1 : undefined} aria-label={`${favouriteGroupIds.includes(group.id) ? "Remove" : "Add"} ${group.name} ${favouriteGroupIds.includes(group.id) ? "from" : "to"} favourites`} onFocus={() => { if (isTizen) { setFocusIndex(index); window.requestAnimationFrame(() => tileRefs.current[index]?.focus()); } }} onClick={() => toggleFavouriteForGroup(group)}>{favouriteGroupIds.includes(group.id) ? "★ Favourite" : "☆ Add favourite"}</button>}</div>)}
          {!visibleGroups.length && <div className="empty-state"><h2>{browseCollection === "favourites" ? "No favourite groups yet" : `No ${browseCollection === "movies" ? "movie" : "series"} groups found`}</h2><p>{browseCollection === "favourites" ? "Use the red remote key on a group, or the button on a card, to save it on this device." : `Import a library with ${browseCollection === "movies" ? "movies" : "series"} to browse titles here.`}</p><button className="empty-state-action" type="button" ref={browseEmptyRecoveryRef} onClick={() => { browseTabTransitionRef.current = "content"; setBrowseCollection("recent"); setFocusIndex(0); }}>Browse recent</button></div>}
          </div>
        </>}
      </>)}
    </section>}
  </main></Localized>;
}
