import { FormEvent, useEffect, useRef, useState } from "react";
import { importM3uChunks, normalizeTitle, type VodCatalogItem } from "../core/catalog/index.ts";
import { srtToWebVtt } from "../core/subtitles/srt-to-vtt.ts";
import { responseTextChunks } from "../platform/browser/fetch-chunks.ts";
import { loadPlaylistUrl, savePlaylistUrl } from "../platform/browser/playlist-config.ts";
import { isBackKey, registerTizenPlaybackKeys } from "../platform/tizen/remote.ts";
import { IndexedDbCatalogStore, type VodGroup, type VodSort } from "../platform/web/indexed-db-catalog.ts";
import { HtmlVideoPlayer } from "../platform/browser/html-video-player.ts";
import { loadOpenSubtitlesApiKey, saveOpenSubtitlesApiKey } from "../platform/browser/opensubtitles-config.ts";
import { OpenSubtitlesClient, OpenSubtitlesRequestError, type SubtitleResult } from "../platform/opensubtitles/client.ts";
import "./app.css";

type ScreenState = "loading" | "setup" | "ready" | "importing" | "error";
const PAGE_SIZE = 100;
const OPEN_SUBTITLES_BASE_URL = import.meta.env.DEV ? "/opensubtitles-api/api/v1" : undefined;

export function App() {
  const [state, setState] = useState<ScreenState>("loading");
  const [playlistUrl, setPlaylistUrl] = useState(loadPlaylistUrl);
  const [groups, setGroups] = useState<VodGroup[]>([]);
  const [activeGroup, setActiveGroup] = useState<VodGroup | null>(null);
  const [titles, setTitles] = useState<VodCatalogItem[]>([]);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<VodSort>("title");
  const [focusIndex, setFocusIndex] = useState(0);
  const [selectedTitle, setSelectedTitle] = useState<VodCatalogItem | null>(null);
  const [openSubtitlesApiKey, setOpenSubtitlesApiKey] = useState(loadOpenSubtitlesApiKey);
  const [subtitleResults, setSubtitleResults] = useState<SubtitleResult[]>([]);
  const [subtitleStatus, setSubtitleStatus] = useState("");
  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<HtmlVideoPlayer | null>(null);
  const openSubtitlesApiKeyRef = useRef<HTMLInputElement | null>(null);
  const [progress, setProgress] = useState("Preparing import…");
  const [error, setError] = useState("");

  const refreshCatalog = async () => {
    const store = await IndexedDbCatalogStore.open();
    const metadata = await store.metadata();
    if (metadata.status === "ready") {
      setGroups(await store.groups());
      setState("ready");
    } else {
      setState("setup");
    }
    store.close();
  };

  useEffect(() => {
    registerTizenPlaybackKeys();
    void refreshCatalog();
  }, []);

  const openGroup = async (group: VodGroup, targetPage: number, targetSort = sort) => {
    const store = await IndexedDbCatalogStore.open();
    const items = await store.byGroupPage(group.name, targetPage * PAGE_SIZE, PAGE_SIZE, targetSort);
    store.close();
    setActiveGroup(group);
    setTitles(items);
    setPage(targetPage);
    setFocusIndex(0);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || state !== "ready") return;
      if (isBackKey(event)) {
        if (selectedTitle) {
          event.preventDefault();
          setSelectedTitle(null);
          return;
        }
        if (activeGroup) {
          event.preventDefault();
          setActiveGroup(null);
          setTitles([]);
          setPage(0);
          setFocusIndex(0);
        }
        return;
      }
      if (selectedTitle) return;
      const itemCount = activeGroup ? titles.length : groups.length;
      if (itemCount === 0) return;
      const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 };
      const move = moves[event.key];
      if (move !== undefined) {
        event.preventDefault();
        setFocusIndex((current) => Math.max(0, Math.min(itemCount - 1, current + move)));
        return;
      }
      if (event.key === "Enter") {
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
        setSelectedTitle(title);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeGroup, focusIndex, groups, selectedTitle, state, titles]);

  useEffect(() => {
    tileRefs.current[focusIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeGroup, focusIndex, page]);

  useEffect(() => {
    if (!selectedTitle || !videoRef.current) return;
    const player = new HtmlVideoPlayer(videoRef.current);
    playerRef.current = player;
    player.load(selectedTitle.streamUrl);
    return () => {
      playerRef.current = null;
      player.destroy();
    };
  }, [selectedTitle]);

  const findSubtitles = async () => {
    const apiKey = openSubtitlesApiKeyRef.current?.value.trim() || openSubtitlesApiKey.trim();
    if (!selectedTitle || !apiKey) {
      setSubtitleStatus("Enter an OpenSubtitles API key before searching.");
      return;
    }
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
          year: titleForSearch.year,
        });
      }
      setSubtitleResults(results);
      setSubtitleStatus(results.length
        ? results.length.toLocaleString() + " subtitle matches found"
        : usedSeriesFallback ? "No exact series record was found on OpenSubtitles." : "No subtitle matches found");
    } catch (cause) {
      setSubtitleResults([]);
      const detail = cause instanceof OpenSubtitlesRequestError && cause.status ? " (HTTP " + cause.status + ")" : "";
      setSubtitleStatus("Subtitle search is unavailable" + detail + ". Check the API key and network connection.");
    }
  };

  const loadSubtitle = async (subtitle: SubtitleResult) => {
    const apiKey = openSubtitlesApiKeyRef.current?.value.trim() || openSubtitlesApiKey.trim();
    if (!apiKey || !playerRef.current) {
      setSubtitleStatus("Enter an OpenSubtitles API key to download a subtitle.");
      return;
    }
    setSubtitleStatus("Downloading subtitle…");
    try {
      const client = new OpenSubtitlesClient(apiKey, undefined, OPEN_SUBTITLES_BASE_URL);
      const download = await client.download(subtitle.fileId);
      const text = await client.fetchSubtitleText(download.link);
      playerRef.current.setSubtitle(srtToWebVtt(text), subtitle.language.toUpperCase(), subtitle.language);
      setSubtitleStatus("Subtitle enabled: " + subtitle.language.toUpperCase());
    } catch {
      setSubtitleStatus("Subtitle download is unavailable. Check the session token and try again.");
    }
  };

  const importPlaylist = async (event: FormEvent) => {
    event.preventDefault();
    if (!playlistUrl.trim()) return;
    setError("");
    setState("importing");
    try {
      savePlaylistUrl(playlistUrl);
      const response = await fetch(playlistUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("Playlist request failed");
      const store = await IndexedDbCatalogStore.open();
      const result = await importM3uChunks(responseTextChunks(response), store, {
        onProgress: ({ processedEntries, importedItems }) => {
          setProgress(processedEntries.toLocaleString() + " entries scanned · " + importedItems.toLocaleString() + " VOD items saved");
        },
      });
      setGroups(await store.groups());
      store.close();
      setProgress(result.importedItems.toLocaleString() + " VOD items imported");
      setState("ready");
    } catch {
      setError("Import failed. Check the playlist URL and network connection, then try again.");
      setState("error");
    }
  };

  if (state === "loading") return <main className="screen"><p>Opening catalog…</p></main>;
  if (state === "importing") return <main className="screen"><h1>Importing library</h1><p>{progress}</p></main>;

  return <main className="screen">
    <header><p className="eyebrow">MY M3U</p><h1>{state === "ready" ? "Your VOD library" : "Connect your IPTV playlist"}</h1></header>
    {state !== "ready" && <form onSubmit={importPlaylist}>
      <label htmlFor="playlist-url">M3U playlist URL</label>
      <input id="playlist-url" type="password" value={playlistUrl} onChange={(event) => setPlaylistUrl(event.target.value)} autoComplete="off" />
      <p className="hint">Stored only in this app’s private local data. Do not use a VITE environment variable for this URL.</p>
      <button type="submit">Import VOD library</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>}
    {state === "ready" && <section>
      {selectedTitle ? <>
        <div className="catalogue-heading">
          <div><h2>{selectedTitle.title}</h2><p className="hint">{selectedTitle.year ?? selectedTitle.contentType}</p></div>
          <button type="button" onClick={() => setSelectedTitle(null)}>Back to titles</button>
        </div>
        <video className="player" controls autoPlay ref={videoRef} />
        <section className="subtitles">
          <h3>Subtitles</h3>
          <label htmlFor="opensubtitles-api-key">OpenSubtitles API key</label>
          <div className="subtitle-actions">
            <input id="opensubtitles-api-key" type="password" defaultValue={openSubtitlesApiKey} onChange={(event) => setOpenSubtitlesApiKey(event.target.value)} autoComplete="off" ref={openSubtitlesApiKeyRef} />
            <button type="button" onClick={() => void findSubtitles()}>Find subtitles</button>
          </div>
          <p className="hint">An API key permits anonymous subtitle downloads within OpenSubtitles’ daily allowance.</p>
          {subtitleStatus && <p className="hint">{subtitleStatus}</p>}
          <div className="subtitle-results">
            {subtitleResults.map((subtitle) => <article key={subtitle.id}>
              <strong>{subtitle.language.toUpperCase()} · {subtitle.releaseName}</strong>
              <span>{subtitle.downloads.toLocaleString()} downloads{subtitle.hearingImpaired ? " · HI" : ""}</span>
              <button type="button" onClick={() => void loadSubtitle(subtitle)}>Use this subtitle</button>
            </article>)}
          </div>
        </section>
      </> : activeGroup ? <>
        <div className="catalogue-heading">
          <div><h2>{activeGroup.name}</h2><p className="hint">{activeGroup.count.toLocaleString()} titles · page {page + 1}</p></div>
          <label className="sort-control">Sort
            <select value={sort} onChange={(event) => {
              const nextSort = event.target.value as VodSort;
              setSort(nextSort);
              void openGroup(activeGroup, 0, nextSort);
            }}>
              <option value="title">Title A–Z</option>
              <option value="playlist">Playlist order</option>
              <option value="year">Release year (newest)</option>
            </select>
          </label>
          <button type="button" onClick={() => { setActiveGroup(null); setFocusIndex(0); }}>Back to groups</button>
        </div>
        <div className="groups title-grid">
          {titles.map((title, index) => <button className={"tile " + (index === focusIndex ? "focused" : "")} key={title.id} onClick={() => { setFocusIndex(index); setSelectedTitle(title); }} ref={(element) => { tileRefs.current[index] = element; }} type="button">
            <strong>{title.title}</strong><span>{title.season !== undefined && title.episode !== undefined ? "S" + String(title.season).padStart(2, "0") + "E" + String(title.episode).padStart(2, "0") : title.year ?? title.contentType}</span>
          </button>)}
        </div>
        <div className="pagination">
          <button disabled={page === 0} onClick={() => void openGroup(activeGroup, page - 1)} type="button">Previous</button>
          <button disabled={titles.length < PAGE_SIZE} onClick={() => void openGroup(activeGroup, page + 1)} type="button">Next</button>
        </div>
      </> : <>
        <p className="hint">{progress || "Select a category"}</p>
        <p className="hint">Use arrow keys and Enter on a TV remote, or click a group.</p>
        <div className="groups">
          {groups.map((group, index) => <button className={"tile " + (index === focusIndex ? "focused" : "")} key={group.name} onClick={() => void openGroup(group, 0)} ref={(element) => { tileRefs.current[index] = element; }} type="button">
            <strong>{group.name}</strong><span>{group.count.toLocaleString()} titles</span>
          </button>)}
        </div>
      </>}
    </section>}
  </main>;
}
