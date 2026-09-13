import { FormEvent, useEffect, useRef, useState } from "react";
import { importM3uChunks, normalizeTitle, type VodCatalogItem } from "../core/catalog/index.ts";
import { DEFAULT_MAX_WHOLE_RESPONSE_BYTES, responseTextChunks, validateWholeResponseFallback, WholeResponseFallbackError } from "../platform/browser/fetch-chunks.ts";
import { loadPlaylistUrl, savePlaylistUrl } from "../platform/browser/playlist-config.ts";
import { isBackKey, normalizedRemoteKey, registerTizenPlaybackKeys } from "../platform/tizen/remote.ts";
import { IndexedDbCatalogOpenError, IndexedDbCatalogStore, type VodGroup, type VodSort } from "../platform/web/indexed-db-catalog.ts";
import { HtmlVideoPlayer } from "../platform/browser/html-video-player.ts";
import type { MediaPlayer, VideoDisplayMode } from "../platform/media-player.ts";
import { isTizenAvPlayAvailable, TizenAvPlayPlayer } from "../platform/tizen/avplay-player.ts";
import { loadOpenSubtitlesApiKey, saveOpenSubtitlesApiKey } from "../platform/browser/opensubtitles-config.ts";
import { OpenSubtitlesClient, OpenSubtitlesRequestError, type SubtitleResult } from "../platform/opensubtitles/client.ts";
import { XtreamClient } from "../platform/xtream/client.ts";
import { BrowseRequestGate, browsePageCount, sortAndPageBrowseItems } from "./browse.ts";
import "./app.css";

type ScreenState = "loading" | "setup" | "ready" | "importing" | "error" | "storage-error";
const PAGE_SIZE = 100;
const OPEN_SUBTITLES_BASE_URL = import.meta.env.DEV ? "/opensubtitles-api/api/v1" : undefined;
type BrowseMode = "local" | "provider" | "episodes";

export function App() {
  const [state, setState] = useState<ScreenState>("loading");
  const [startupStatus, setStartupStatus] = useState("Opening catalogue…");
  const [playlistUrl, setPlaylistUrl] = useState(loadPlaylistUrl);
  const [groups, setGroups] = useState<VodGroup[]>([]);
  const [activeGroup, setActiveGroup] = useState<VodGroup | null>(null);
  const [titles, setTitles] = useState<VodCatalogItem[]>([]);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<VodSort>("title");
  const [browseMode, setBrowseMode] = useState<BrowseMode>("local");
  const [browseCount, setBrowseCount] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const [playerFocusIndex, setPlayerFocusIndex] = useState(0);
  const [playerFullscreen, setPlayerFullscreen] = useState(false);
  const [videoDisplayMode, setVideoDisplayMode] = useState<VideoDisplayMode>("auto");
  const [playbackStatus, setPlaybackStatus] = useState("Loading…");
  const [isPlaybackPaused, setIsPlaybackPaused] = useState(false);
  const [selectedTitle, setSelectedTitle] = useState<VodCatalogItem | null>(null);
  const [openSubtitlesApiKey, setOpenSubtitlesApiKey] = useState(loadOpenSubtitlesApiKey);
  const [subtitleResults, setSubtitleResults] = useState<SubtitleResult[]>([]);
  const [subtitleStatus, setSubtitleStatus] = useState("");
  const [visibleSubtitle, setVisibleSubtitle] = useState("");
  const [subtitleFontSize, setSubtitleFontSize] = useState(2.3);
  const [catalogStatus, setCatalogStatus] = useState("");
  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const playlistUrlRef = useRef<HTMLInputElement | null>(null);
  const importButtonRef = useRef<HTMLButtonElement | null>(null);
  const sortSelectRef = useRef<HTMLSelectElement | null>(null);
  const backToGroupsRef = useRef<HTMLButtonElement | null>(null);
  const previousPageRef = useRef<HTMLButtonElement | null>(null);
  const nextPageRef = useRef<HTMLButtonElement | null>(null);
  const playerBackButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerPlayButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerPauseButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerRestartButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerFullscreenButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerAspectButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleSmallerButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleLargerButtonRef = useRef<HTMLButtonElement | null>(null);
  const findSubtitlesButtonRef = useRef<HTMLButtonElement | null>(null);
  const subtitleButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const subtitleRequestRef = useRef(0);
  const browseRequestRef = useRef(new BrowseRequestGate());
  const remoteBrowseRef = useRef<{ key: string; items: VodCatalogItem[] } | null>(null);
  const playerRef = useRef<MediaPlayer | null>(null);
  const avPlayContainerRef = useRef<HTMLObjectElement | null>(null);
  const playerStageRef = useRef<HTMLDivElement | null>(null);
  const openSubtitlesApiKeyRef = useRef<HTMLInputElement | null>(null);
  const importStageRef = useRef("Preparing import");
  const [progress, setProgress] = useState("Preparing import…");
  const [error, setError] = useState("");

  const updateImportStage = (message: string) => {
    importStageRef.current = message;
    setProgress(message);
  };

  const playerControls = () => [
    playerBackButtonRef.current,
    playerPlayButtonRef.current,
    playerPauseButtonRef.current,
    playerRestartButtonRef.current,
    playerFullscreenButtonRef.current,
    playerAspectButtonRef.current,
    subtitleSmallerButtonRef.current,
    subtitleLargerButtonRef.current,
    findSubtitlesButtonRef.current,
    ...subtitleButtonRefs.current,
  ].filter((control): control is HTMLButtonElement => control !== null);

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
      } else {
        setState("setup");
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
    if (state === "setup" || state === "error") playlistUrlRef.current?.focus();
  }, [state]);

  const openGroup = async (group: VodGroup, targetPage: number, targetSort = sort) => {
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
      setTitles(sortAndPageBrowseItems(items, targetPage, PAGE_SIZE, targetSort));
      setPage(targetPage);
      setSort(targetSort);
      setFocusIndex(0);
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
    setFocusIndex(0);
    setCatalogStatus("");
  };

  const openTitle = async (title: VodCatalogItem) => {
    if (!title.providerSeriesId) {
      browseRequestRef.current.invalidate();
      setPlayerFocusIndex(0);
      setPlayerFullscreen(false);
      setVideoDisplayMode("auto");
      setPlaybackStatus("Loading…");
      setIsPlaybackPaused(false);
      setVisibleSubtitle("");
      setSubtitleFontSize(2.3);
      setSelectedTitle(title);
      return;
    }
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
    remoteBrowseRef.current = { key: "episodes:" + title.providerSeriesId, items: episodes };
    setBrowseMode("episodes");
    setBrowseCount(episodes.length);
    setActiveGroup({ id: "episodes:" + title.providerSeriesId, name: title.title, count: episodes.length, contentType: "series" });
    setTitles(sortAndPageBrowseItems(episodes, 0, PAGE_SIZE, sort));
    setPage(0);
    setFocusIndex(0);
    setCatalogStatus(episodes.length.toLocaleString() + " episodes ready");
  };

  const changeBrowsePage = (targetPage: number, targetSort = sort) => {
    if (browseMode !== "local" && remoteBrowseRef.current) {
      browseRequestRef.current.invalidate();
      setTitles(sortAndPageBrowseItems(remoteBrowseRef.current.items, targetPage, PAGE_SIZE, targetSort));
      setPage(targetPage);
      setSort(targetSort);
      setFocusIndex(0);
      return;
    }
    if (activeGroup) void openGroup(activeGroup, targetPage, targetSort);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = normalizedRemoteKey(event);
      if (state !== "ready") {
        const controls = ([playlistUrlRef.current, importButtonRef.current] as Array<HTMLElement | null>).filter((control): control is HTMLElement => control !== null);
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
        if (key === "Enter" && document.activeElement === importButtonRef.current) {
          event.preventDefault();
          importButtonRef.current?.click();
        }
        return;
      }
      if (isBackKey(event)) {
        const browseIsLoading = catalogStatus.startsWith("Loading ");
        browseRequestRef.current.invalidate();
        if (selectedTitle) {
          event.preventDefault();
          if (playerFullscreen) setPlayerFullscreen(false);
          else setSelectedTitle(null);
          return;
        }
        if (activeGroup) {
          event.preventDefault();
          remoteBrowseRef.current = null;
          setBrowseMode("local");
          setBrowseCount(0);
          setActiveGroup(null);
          setTitles([]);
          setPage(0);
          setFocusIndex(0);
          setCatalogStatus("");
        } else if (browseIsLoading) {
          event.preventDefault();
          setCatalogStatus("");
        }
        return;
      }
      if (selectedTitle) {
        const controls = playerControls();
        if (controls.length === 0) return;
        const currentIndex = Math.max(0, Math.min(controls.length - 1, playerFocusIndex));
        if (key === "MediaPlayPause") {
          event.preventDefault();
          if (isPlaybackPaused) playVideo(); else pauseVideo();
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
        if (key === "ArrowLeft" || key === "MediaRewind") {
          event.preventDefault();
          skipVideo(-60);
          return;
        }
        if (key === "ArrowRight" || key === "MediaFastForward") {
          event.preventDefault();
          skipVideo(60);
          return;
        }
        if (key === "ArrowDown") {
          event.preventDefault();
          setPlayerFocusIndex(Math.min(controls.length - 1, currentIndex + 1));
          return;
        }
        if (key === "ArrowUp") {
          event.preventDefault();
          setPlayerFocusIndex(Math.max(0, currentIndex - 1));
          return;
        }
        if (key === "Enter") {
          event.preventDefault();
          controls[currentIndex]?.click();
        }
        return;
      }
      if (event.target instanceof HTMLInputElement) return;
      if (event.target instanceof HTMLSelectElement) {
        if (key === "ArrowRight") {
          event.preventDefault();
          backToGroupsRef.current?.focus();
        } else if (key === "Enter") {
          window.requestAnimationFrame(() => tileRefs.current[focusIndex]?.focus());
        }
        return;
      }
      const targetButton = event.target instanceof HTMLButtonElement ? event.target : null;
      if (targetButton && !targetButton.classList.contains("tile")) {
        const browseControls = [sortSelectRef.current, backToGroupsRef.current, previousPageRef.current, nextPageRef.current]
          .filter((control): control is HTMLSelectElement | HTMLButtonElement => control !== null && !(control instanceof HTMLButtonElement && control.disabled));
        const index = browseControls.indexOf(targetButton);
        if (key === "Enter") return;
        if (key === "ArrowLeft" || key === "ArrowRight") {
          event.preventDefault();
          browseControls[Math.max(0, Math.min(browseControls.length - 1, index + (key === "ArrowLeft" ? -1 : 1)))]?.focus();
          return;
        }
        if (key === "ArrowDown" && index <= 1) {
          event.preventDefault();
          setFocusIndex(0);
          tileRefs.current[0]?.focus();
          return;
        }
        if (key === "ArrowUp" && (targetButton === previousPageRef.current || targetButton === nextPageRef.current)) {
          event.preventDefault();
          const lastRowStart = Math.floor(Math.max(0, titles.length - 1) / 4) * 4;
          setFocusIndex(lastRowStart);
          tileRefs.current[lastRowStart]?.focus();
          return;
        }
        return;
      }
      if (targetButton && key === "Enter") return;
      const itemCount = activeGroup ? titles.length : groups.length;
      if (itemCount === 0) return;
      const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 };
      const move = moves[key];
      if (move !== undefined) {
        event.preventDefault();
        if (activeGroup && key === "ArrowUp" && focusIndex < 4) {
          sortSelectRef.current?.focus();
          return;
        }
        if (activeGroup && key === "ArrowDown" && focusIndex + 4 >= itemCount) {
          if (page + 1 < browsePageCount(browseCount, PAGE_SIZE) && nextPageRef.current) {
            nextPageRef.current.focus();
            return;
          }
          if (page > 0 && previousPageRef.current) {
            previousPageRef.current.focus();
            return;
          }
        }
        setFocusIndex((current) => Math.max(0, Math.min(itemCount - 1, current + move)));
        return;
      }
      if (key === "Enter") {
        if (!activeGroup) {
          const group = groups[focusIndex];
          if (!group) return;
          event.preventDefault();
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
  }, [activeGroup, browseCount, catalogStatus, focusIndex, groups, isPlaybackPaused, page, playerFocusIndex, playerFullscreen, playlistUrl, selectedTitle, state, titles]);

  useEffect(() => {
    const tile = tileRefs.current[focusIndex];
    tile?.focus();
    tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeGroup, focusIndex, groups.length, page, titles.length]);

  useEffect(() => {
    if (!selectedTitle) return;
    const controls = playerControls();
    const control = controls[Math.min(playerFocusIndex, Math.max(0, controls.length - 1))];
    control?.focus();
  }, [playerFocusIndex, selectedTitle, subtitleResults.length]);

  useEffect(() => {
    if (selectedTitle) window.scrollTo(0, 0);
  }, [selectedTitle]);

  useEffect(() => {
    if (!selectedTitle) return;
    const frame = window.requestAnimationFrame(() => playerRef.current?.resize());
    return () => window.cancelAnimationFrame(frame);
  }, [playerFullscreen, selectedTitle]);

  useEffect(() => {
    playerRef.current?.setDisplayMode(videoDisplayMode);
  }, [videoDisplayMode, selectedTitle]);

  useEffect(() => {
    subtitleRequestRef.current += 1;
    setSubtitleResults([]);
    setSubtitleStatus("");
    if (!selectedTitle) return;
    const player = isTizenAvPlayAvailable() && avPlayContainerRef.current
      ? new TizenAvPlayPlayer(avPlayContainerRef.current, setVisibleSubtitle)
      : videoRef.current ? new HtmlVideoPlayer(videoRef.current) : null;
    if (!player) return;
    playerRef.current = player;
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
        setIsPlaybackPaused(playbackState === "paused" || playbackState === "ended" || playbackState === "error");
      },
    });
    player.load(selectedTitle.streamUrl);
    return () => {
      subtitleRequestRef.current += 1;
      playerRef.current = null;
      player.setEventHandlers(null);
      player.destroy();
    };
  }, [selectedTitle]);

  const findSubtitles = async () => {
    const apiKey = openSubtitlesApiKeyRef.current?.value.trim() || openSubtitlesApiKey.trim();
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
      const languages = ["en", "fi", "sv"];
      let results: SubtitleResult[];
      let usedSeriesFallback = false;
      if (selectedTitle.contentType === "series" && titleForSearch.season !== undefined && titleForSearch.episode !== undefined) {
        const feature = await client.findSeriesFeature(titleForSearch.searchTitle, titleForSearch.year);
        if (feature) {
          results = await client.search({
            languages,
            parentFeatureId: feature.id,
            season: titleForSearch.season,
            episode: titleForSearch.episode,
            type: "episode",
          });
        } else {
          usedSeriesFallback = true;
          results = [];
        }
      } else {
        results = await client.search({
          languages: ["en", "fi", "sv"],
          query: titleForSearch.searchTitle,
          type: selectedTitle.contentType === "movie" ? "movie" : "episode",
          ...(titleForSearch.year !== null ? { year: titleForSearch.year } : {}),
        });
      }
      if (requestId !== subtitleRequestRef.current) return;
      setSubtitleResults(results);
      setSubtitleStatus(results.length
        ? results.length.toLocaleString() + " subtitle matches found"
        : usedSeriesFallback ? "No exact series record was found on OpenSubtitles." : "No subtitle matches found");
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

  const loadSubtitle = async (subtitle: SubtitleResult) => {
    const apiKey = openSubtitlesApiKeyRef.current?.value.trim() || openSubtitlesApiKey.trim();
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
      if (attachment.enabled) {
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

  const restartVideo = () => {
    playerRef.current?.restart();
  };

  const skipVideo = (seconds: number) => {
    playerRef.current?.skip(seconds);
  };

  const cycleVideoDisplayMode = () => {
    const next: Record<VideoDisplayMode, VideoDisplayMode> = { auto: "fit", fit: "fill", fill: "auto" };
    setVideoDisplayMode((current) => next[current]);
  };

  const importPlaylist = async (event: FormEvent) => {
    event.preventDefault();
    if (!playlistUrl.trim()) return;
    setError("");
    updateImportStage("Connecting to the playlist…");
    setState("importing");
    try {
      savePlaylistUrl(playlistUrl);
      const provider = XtreamClient.fromPlaylistUrl(playlistUrl);
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
      const response = await fetch(playlistUrl, { cache: "no-store" });
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
  };

  if (state === "loading") return <main className="screen"><p role="status" aria-live="polite">{startupStatus}</p></main>;
  if (state === "storage-error") return <main className="screen">
    <h1>Catalogue unavailable</h1>
    <p role="alert">{error}</p>
    <button type="button" autoFocus onClick={() => void refreshCatalog()}>Try again</button>
  </main>;
  if (state === "importing") return <main className="screen"><h1>Importing library</h1><p>{progress}</p></main>;

  return <main className="screen">
    <header><p className="eyebrow">MY M3U</p><h1>{state === "ready" ? "Your VOD library" : "Connect your IPTV playlist"}</h1></header>
    {state !== "ready" && <form onSubmit={importPlaylist}>
      <label htmlFor="playlist-url">M3U playlist URL</label>
      <input id="playlist-url" type="password" value={playlistUrl} onChange={(event) => setPlaylistUrl(event.target.value)} autoComplete="off" ref={playlistUrlRef} />
      <p className="hint">Stored only in this app’s private local data. Do not use a VITE environment variable for this URL.</p>
      <button type="submit" ref={importButtonRef}>Import VOD library</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>}
    {state === "ready" && <section>
      {selectedTitle ? <section className={"player-screen " + (playerFullscreen ? "is-fullscreen" : "")}>
        <div className="player-heading">
          <div className="player-title"><h2>{selectedTitle.title}</h2><p className="hint">{selectedTitle.year ?? selectedTitle.contentType}</p></div>
          <button className={playerFocusIndex === 0 ? "remote-focused" : ""} type="button" onClick={() => { browseRequestRef.current.invalidate(); setPlayerFullscreen(false); setSelectedTitle(null); }} ref={playerBackButtonRef}>Back to titles</button>
        </div>
        <div className="player-stage" ref={playerStageRef}>
          {isTizenAvPlayAvailable()
            ? <object className="player tizen-player" ref={avPlayContainerRef} type="application/avplayer" aria-label="Video player" />
            : <video className="player" autoPlay ref={videoRef} />}
          {visibleSubtitle && <p className="subtitle-overlay" aria-live="off" style={{ fontSize: subtitleFontSize + "rem" }}>{visibleSubtitle}</p>}
        </div>
        <div className="player-controls" aria-label="Playback controls">
          <button className={playerFocusIndex === 1 ? "remote-focused" : ""} type="button" onClick={playVideo} ref={playerPlayButtonRef}>Play</button>
          <button className={playerFocusIndex === 2 ? "remote-focused" : ""} type="button" onClick={pauseVideo} ref={playerPauseButtonRef}>Pause</button>
          <button className={playerFocusIndex === 3 ? "remote-focused" : ""} type="button" onClick={restartVideo} ref={playerRestartButtonRef}>Restart</button>
          <button className={playerFocusIndex === 4 ? "remote-focused" : ""} type="button" onClick={() => setPlayerFullscreen((current) => !current)} ref={playerFullscreenButtonRef}>{playerFullscreen ? "Exit full screen" : "Full screen"}</button>
          <button className={playerFocusIndex === 5 ? "remote-focused" : ""} type="button" onClick={cycleVideoDisplayMode} ref={playerAspectButtonRef}>Aspect: {videoDisplayMode === "auto" ? "Auto" : videoDisplayMode === "fit" ? "Fit" : "Fill"}</button>
          <button className={playerFocusIndex === 6 ? "remote-focused" : ""} type="button" onClick={() => setSubtitleFontSize((current) => Math.max(1, current - .2))} ref={subtitleSmallerButtonRef}>Subtitle A−</button>
          <button className={playerFocusIndex === 7 ? "remote-focused" : ""} type="button" onClick={() => setSubtitleFontSize((current) => Math.min(3.5, current + .2))} ref={subtitleLargerButtonRef}>Subtitle A+</button>
          <span className={"playback-status " + (playbackStatus.startsWith("Playback failed") ? "error" : "")} role="status" aria-live="polite">{playbackStatus}</span>
        </div>
        <section className="subtitles">
          <h3>Subtitles</h3>
          <label htmlFor="opensubtitles-api-key">OpenSubtitles API key</label>
          <div className="subtitle-actions">
            <input id="opensubtitles-api-key" type="password" defaultValue={openSubtitlesApiKey} onChange={(event) => setOpenSubtitlesApiKey(event.target.value)} autoComplete="off" ref={openSubtitlesApiKeyRef} />
            <button className={playerFocusIndex === 8 ? "remote-focused" : ""} type="button" onClick={() => void findSubtitles()} ref={findSubtitlesButtonRef}>Find subtitles</button>
          </div>
          <p className="hint">An API key permits anonymous subtitle downloads within OpenSubtitles’ daily allowance.</p>
          {subtitleStatus && <p className="hint">{subtitleStatus}</p>}
          <div className="subtitle-results">
            {subtitleResults.map((subtitle, index) => <article key={subtitle.id}>
              <strong>{subtitle.language.toUpperCase()} · {subtitle.releaseName}</strong>
              <span>{subtitle.downloads.toLocaleString()} downloads{subtitle.hearingImpaired ? " · HI" : ""}</span>
              <button className={playerFocusIndex === index + 9 ? "remote-focused" : ""} type="button" onClick={() => void loadSubtitle(subtitle)} ref={(element) => { subtitleButtonRefs.current[index] = element; }}>Use this subtitle</button>
            </article>)}
          </div>
        </section>
      </section> : activeGroup ? <>
        <div className="catalogue-heading">
          <div><h2>{activeGroup.name}</h2><p className="hint">{browseCount.toLocaleString()} {browseMode === "episodes" ? "episodes" : "titles"} · page {page + 1} of {browsePageCount(browseCount, PAGE_SIZE)}</p></div>
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
          <button type="button" ref={backToGroupsRef} onClick={() => { browseRequestRef.current.invalidate(); remoteBrowseRef.current = null; setBrowseMode("local"); setBrowseCount(0); setActiveGroup(null); setTitles([]); setPage(0); setFocusIndex(0); setCatalogStatus(""); }}>Back to groups</button>
        </div>
        <div className="groups title-grid">
          {catalogStatus && <p className="hint">{catalogStatus}</p>}
          {titles.map((title, index) => <button className={"tile " + (index === focusIndex ? "focused remote-focused" : "")} key={title.id} onClick={() => { setFocusIndex(index); void openTitle(title); }} ref={(element) => { tileRefs.current[index] = element; }} type="button">
            <strong>{title.title}</strong><span>{title.season !== undefined && title.episode !== undefined ? "S" + String(title.season).padStart(2, "0") + "E" + String(title.episode).padStart(2, "0") : title.year ?? title.contentType}</span>
          </button>)}
        </div>
        <div className="pagination">
          <button disabled={page === 0} ref={previousPageRef} onClick={() => changeBrowsePage(page - 1)} type="button">Previous</button>
          <button disabled={page + 1 >= browsePageCount(browseCount, PAGE_SIZE)} ref={nextPageRef} onClick={() => changeBrowsePage(page + 1)} type="button">Next</button>
        </div>
      </> : <>
        <p className="hint">{catalogStatus || progress || "Select a category"}</p>
        <p className="hint">Use arrow keys and Enter on a TV remote, or click a group.</p>
        <div className="groups">
          {groups.map((group, index) => <button className={"tile " + (index === focusIndex ? "focused remote-focused" : "")} key={group.id} onClick={() => void openGroup(group, 0)} ref={(element) => { tileRefs.current[index] = element; }} type="button">
            <strong>{group.name}</strong><span>{group.providerCategoryId ? "Open on demand" : group.count.toLocaleString() + " titles"}</span>
          </button>)}
        </div>
      </>}
    </section>}
  </main>;
}
