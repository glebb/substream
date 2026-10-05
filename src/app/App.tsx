import { Component, lazy, Suspense, useContext, useEffect, useRef, useState, type ErrorInfo, type FormEvent, type ReactNode } from "react";
import { isBackKey, normalizedRemoteKey } from "../contracts/input.ts";
import { useRuntime } from "./runtime.tsx";
import { createDeviceSettings } from "../bootstrap/settings.ts";
import { LocalMediaSource } from "../platform/browser/local-media-source.ts";
import { LanguageContext, Localized, type UiLanguage } from "./language.tsx";
import "./app.css";
import { useCompanion } from "./companion.tsx";
import { LoadingStatus } from "./LoadingStatus.tsx";

const LiveTv = lazy(() => import("./LiveTv.tsx").then((module) => ({ default: module.LiveTv })));
const loadVodApp = () => import("./VodApp.tsx").then((module) => ({ default: module.VodApp }));
const VodApp = lazy(loadVodApp);

type AppRoute = "home" | "live" | "vod" | "settings" | "local";

function RouteLoading({ onBack }: { onBack(): void }) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [showControls, setShowControls] = useState(false);
  const { language } = useContext(LanguageContext);
  // Show progress immediately, but avoid flashing temporary navigation on fast loads.
  // Keep the remote Back key available even before the button appears.
  useEffect(() => {
    const timeout = window.setTimeout(() => setShowControls(true), 300);
    return () => window.clearTimeout(timeout);
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isBackKey(event)) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack]);
  useEffect(() => {
    if (!showControls) return;
    const frame = window.requestAnimationFrame(() => buttonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [showControls]);
  return <Localized language={language}><main className="app-home route-transition" aria-busy="true"><section className="route-transition-content" aria-live="polite">
    <LoadingStatus>Opening catalogue…</LoadingStatus>
    {showControls && <>
      <button type="button" ref={buttonRef} onClick={onBack}>Back to main menu</button>
    </>}
  </section></main></Localized>;
}

function RouteFailure({ onBack }: { onBack(): void }) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const { language } = useContext(LanguageContext);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isBackKey(event)) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", onKeyDown);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack]);
  return <Localized language={language}><main className="app-home route-transition"><section className="route-transition-content" role="alert">
    <p>Could not open this screen. Please try again.</p>
    <button type="button" ref={buttonRef} onClick={onBack}>Back to main menu</button>
  </section></main></Localized>;
}

class RouteErrorBoundary extends Component<{ onBack(): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo): void { /* Error details may contain private URLs; keep them out of the UI. */ }
  render() { return this.state.failed ? <RouteFailure onBack={this.props.onBack} /> : this.props.children; }
}

export function App() {
  const companion = useCompanion();
  const runtime = useRuntime();
  const isTouchProfile = runtime.interactionProfile === "touch";
  const remoteFocusClass = isTouchProfile ? "" : "remote-focused";
  const { loadPlaylistUrl, savePlaylistUrl, loadUiLanguage, saveUiLanguage } = createDeviceSettings(runtime.preferences);
  const [language, setLanguageState] = useState<UiLanguage>(loadUiLanguage);
  const setLanguage = (next: UiLanguage) => { setLanguageState(next); saveUiLanguage(next); };
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const [route, setRoute] = useState<AppRoute>("home");
  // Configuration can change on any screen; only changed values restart the service.
  useEffect(() => { companion.refreshConfiguration(); });
  useEffect(() => {
    if (companion.commands.some((item) => item.command.kind !== "stop-local")) setRoute("vod");
    else if (companion.commands.length && route !== "vod" && route !== "settings" && route !== "local") {
      companion.consumeCommands(companion.commands[companion.commands.length - 1]!.id);
    }
  }, [companion.commands, companion.consumeCommands, route]);
  const routeBackFocusRef = useRef(0);
  const [homeFocus, setHomeFocus] = useState(0);
  const [localSource, setLocalSource] = useState<LocalMediaSource | null>(null);
  const [browserCompanions, setBrowserCompanions] = useState<import("../platform/companion/client.ts").BrowserCompanionConnection[]>([]);
  const [selectedTvDeviceId, setSelectedTvDeviceId] = useState("");
  const [playlistSetupOpen, setPlaylistSetupOpen] = useState(() => !loadPlaylistUrl());
  useEffect(() => {
    if (route !== "home" || playlistSetupOpen) return;
    // Let Home paint before parsing the larger VOD bundle on slower TVs.
    // Module caching also helps Settings and local-file entry points.
    const timer = window.setTimeout(() => { void loadVodApp().catch(() => undefined); }, 750);
    return () => window.clearTimeout(timer);
  }, [route, playlistSetupOpen]);
  const [playlistDraft, setPlaylistDraft] = useState(loadPlaylistUrl);
  const [playlistError, setPlaylistError] = useState("");
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const playlistInputRef = useRef<HTMLInputElement | null>(null);
  const playlistSaveRef = useRef<HTMLButtonElement | null>(null);
  const localFileInputRef = useRef<HTMLInputElement | null>(null);
  const localHomeActionRef = useRef<HTMLButtonElement | null>(null);
  const setupSettingsRef = useRef<HTMLButtonElement | null>(null);
  const supportsLocalMediaPicker = runtime.capabilities.supportsLocalMediaPicker;
  const localHomeIndex = 2;
  const settingsHomeIndex = supportsLocalMediaPicker ? 3 : 2;
  const openRoute = (next: AppRoute, backFocus: number) => {
    routeBackFocusRef.current = backFocus;
    setRoute(next);
  };
  const leaveWhileLoading = () => {
    if (route === "local") {
      localSource?.dispose();
      setLocalSource(null);
    }
    backToHome(routeBackFocusRef.current);
  };
  const openLocalPicker = () => localFileInputRef.current?.click();
  const acceptLocalFile = (event: FormEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const next = new LocalMediaSource(file);
    setLocalSource(next);
    setHomeFocus(localHomeIndex);
    openRoute("local", localHomeIndex);
    // VodApp owns URL cleanup after it has destroyed the current player.
  };
  const leaveLocal = () => {
    setLocalSource(null);
    setRoute("home");
    setHomeFocus(localHomeIndex);
  };
  const openPlaylistSetup = () => {
    setPlaylistDraft(loadPlaylistUrl());
    setPlaylistError("");
    setPlaylistSetupOpen(true);
    setRoute("home");
  };
  const saveHomePlaylist = (event: FormEvent) => {
    event.preventDefault();
    const url = playlistDraft.trim();
    if (!url) {
      setPlaylistError("Enter your M3U playlist URL to continue.");
      playlistInputRef.current?.focus();
      return;
    }
    savePlaylistUrl(url);
    setPlaylistDraft(url);
    setPlaylistError("");
    setPlaylistSetupOpen(false);
  };
  useEffect(() => {
    if (route !== "home") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (playlistSetupOpen) {
        if (isBackKey(event)) event.preventDefault();
        const key = normalizedRemoteKey(event);
        if (key === "ArrowDown" && document.activeElement === localHomeActionRef.current) {
          event.preventDefault();
          playlistInputRef.current?.focus();
        } else if (key === "ArrowDown" && document.activeElement === playlistInputRef.current) {
          event.preventDefault();
          playlistSaveRef.current?.focus();
        } else if (key === "ArrowDown" && document.activeElement === playlistSaveRef.current) {
          event.preventDefault();
          setupSettingsRef.current?.focus();
        } else if (key === "ArrowUp" && document.activeElement === setupSettingsRef.current) {
          event.preventDefault();
          playlistSaveRef.current?.focus();
        } else if (key === "ArrowUp" && document.activeElement === playlistSaveRef.current) {
          event.preventDefault();
          playlistInputRef.current?.focus();
        } else if (key === "ArrowUp" && document.activeElement === playlistInputRef.current) {
          event.preventDefault();
          localHomeActionRef.current?.focus();
        } else if (key === "Enter" && document.activeElement === localHomeActionRef.current) {
          event.preventDefault();
          openLocalPicker();
        }
        return;
      }
      const key = normalizedRemoteKey(event);
      if (key === "ArrowLeft" || key === "ArrowUp" || key === "ArrowRight" || key === "ArrowDown") {
        event.preventDefault();
        const current = homeFocus;
        const lastIndex = supportsLocalMediaPicker ? 3 : 2;
        const nextIndex = key === "ArrowLeft" ? Math.max(0, current - 1)
          : key === "ArrowRight" ? Math.min(lastIndex, current + 1)
            : key === "ArrowUp" ? 0 : lastIndex;
        setHomeFocus(nextIndex); cardRefs.current[nextIndex]?.focus();
      }
      if (isBackKey(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    if (!isTouchProfile) window.requestAnimationFrame(() => (playlistSetupOpen ? (localHomeActionRef.current ?? playlistInputRef.current) : cardRefs.current[homeFocus])?.focus());
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [homeFocus, playlistSetupOpen, route, supportsLocalMediaPicker]);
  const backToHome = (focus: number) => { setHomeFocus(focus); setRoute("home"); };
  const loading = <RouteLoading onBack={leaveWhileLoading} />;
  const lazyScreen = (children: ReactNode) => <RouteErrorBoundary onBack={leaveWhileLoading}><Suspense fallback={loading}>{children}</Suspense></RouteErrorBoundary>;
  if (route === "live") return <LanguageContext.Provider value={{ language, setLanguage }}><Localized language={language}>{lazyScreen(<LiveTv onMainMenu={() => backToHome(0)} />)}</Localized></LanguageContext.Provider>;
  if (route === "vod") return <LanguageContext.Provider value={{ language, setLanguage }}><Localized language={language}>{lazyScreen(<div className="vod-route"><VodApp browserCompanions={browserCompanions} setBrowserCompanions={setBrowserCompanions} selectedTvDeviceId={selectedTvDeviceId} setSelectedTvDeviceId={setSelectedTvDeviceId} onMainMenu={() => backToHome(1)} onPlaylistSetup={openPlaylistSetup} /></div>)}</Localized></LanguageContext.Provider>;
  if (route === "settings") return <LanguageContext.Provider value={{ language, setLanguage }}><Localized language={language}>{lazyScreen(<div className="vod-route"><VodApp browserCompanions={browserCompanions} setBrowserCompanions={setBrowserCompanions} selectedTvDeviceId={selectedTvDeviceId} setSelectedTvDeviceId={setSelectedTvDeviceId} settingsOnOpen onMainMenu={() => backToHome(settingsHomeIndex)} onPlaylistSetup={openPlaylistSetup} /></div>)}</Localized></LanguageContext.Provider>;
  if (route === "local" && localSource) return <LanguageContext.Provider value={{ language, setLanguage }}><Localized language={language}>{lazyScreen(<div className="vod-route"><VodApp key={localSource.url} localSource={localSource} browserCompanions={browserCompanions} setBrowserCompanions={setBrowserCompanions} selectedTvDeviceId={selectedTvDeviceId} setSelectedTvDeviceId={setSelectedTvDeviceId} onChooseLocalFile={openLocalPicker} onMainMenu={leaveLocal} onPlaylistSetup={openPlaylistSetup} />{supportsLocalMediaPicker && <input ref={localFileInputRef} className="sr-only" type="file" accept="video/*,.mkv,.mp4,.m4v,.mov,.webm,.avi,.ts,.m2ts,.mpg,.mpeg" onChange={acceptLocalFile} aria-label="Choose a local video file" />}</div>)}</Localized></LanguageContext.Provider>;
  return <LanguageContext.Provider value={{ language, setLanguage }}><Localized language={language}><main className="app-home">
    <div className="home-brand" aria-hidden="true"><img src="./branding/substream-icon.png" alt="" /><strong>Substream</strong></div>
    <section className="home-content" aria-label={playlistSetupOpen ? "Set up your playlist" : "Choose what to watch"}>
      {playlistSetupOpen ? <form className="home-playlist-setup" onSubmit={saveHomePlaylist}>
        <h1>Connect your IPTV playlist</h1>
        <p>Enter your M3U playlist URL to use Live TV and Video-On-Demand.</p>
        <label htmlFor="home-playlist-url">M3U playlist URL</label>
        <input id="home-playlist-url" type="password" value={playlistDraft} onChange={(event) => setPlaylistDraft(event.target.value)} autoComplete="off" ref={playlistInputRef} />
        {supportsLocalMediaPicker && <button type="button" onClick={openLocalPicker} ref={localHomeActionRef}>Open local video file</button>}
        <button type="submit" ref={playlistSaveRef}>Save playlist</button>
        <button type="button" ref={setupSettingsRef} onClick={() => { openRoute("settings", settingsHomeIndex); setHomeFocus(settingsHomeIndex); }}>Settings and TV pairing</button>
        {playlistError && <p className="error" role="alert">{playlistError}</p>}
      </form> : <div className="home-cards">
        <button className={`home-card ${homeFocus === 0 ? remoteFocusClass : ""}`} type="button" ref={(element) => { cardRefs.current[0] = element; }} onFocus={() => setHomeFocus(0)} onClick={() => openRoute("live", 0)}><strong>Live TV</strong></button>
        <button className={`home-card ${homeFocus === 1 ? remoteFocusClass : ""}`} type="button" ref={(element) => { cardRefs.current[1] = element; }} onFocus={() => setHomeFocus(1)} onClick={() => openRoute("vod", 1)}><strong>Video-On-Demand</strong></button>
        {supportsLocalMediaPicker && <button className={`home-card ${homeFocus === localHomeIndex ? remoteFocusClass : ""}`} type="button" ref={(element) => { cardRefs.current[localHomeIndex] = element; }} onFocus={() => setHomeFocus(localHomeIndex)} onClick={openLocalPicker}><strong>Open local video file</strong></button>}
        <button className={`home-card ${homeFocus === settingsHomeIndex ? remoteFocusClass : ""}`} type="button" ref={(element) => { cardRefs.current[settingsHomeIndex] = element; }} onFocus={() => setHomeFocus(settingsHomeIndex)} onClick={() => openRoute("settings", settingsHomeIndex)}><strong>Settings</strong></button>
      </div>}
      {supportsLocalMediaPicker && <input ref={localFileInputRef} className="sr-only" type="file" accept="video/*,.mkv,.mp4,.m4v,.mov,.webm,.avi,.ts,.m2ts,.mpg,.mpeg" onChange={acceptLocalFile} aria-label="Choose a local video file" />}
    </section>
  </main></Localized></LanguageContext.Provider>;
}
