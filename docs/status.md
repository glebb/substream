# Current behavior and architecture

This describes the current source implementation. See [shared architecture](cross-platform-architecture.md) for runtime wiring and ownership, and [verification](verification.md) for release checks. The architecture refactor passed automated/Chromium 47 checks. Initial LG webOS playback was also confirmed on hardware; broader LG acceptance remains pending.

## Catalogue and title details

Xtream-compatible `get.php` sources load movie/series categories first, titles when a category opens, and episodes when a series opens. Category IDs identify groups even when names repeat. M3U import is the fallback; confidently classified VOD entries retain their evidence, and unknown entries remain stored separately rather than being discarded or shown as VOD.

The local IndexedDB catalogue uses schema version 7. Imports write a staged generation and promote it only after all batches succeed, keeping the last ready catalogue on failure. Startup reports migration progress and offers retry if another tab blocks an upgrade. Streaming import is preferred; whole-response fallback requires an exposed, uncompressed Content-Length of at most 8 MiB before reading the body.

Browsing supports title, playlist-order, and release-year sorting; unknown years sort last. Playlist order is not a reliable date-added timestamp. Search is available in desktop and TV profiles and uses the imported M3U catalogue or an account-scoped Xtream cache without companion pairing. TV text entry uses deliberate Enter-to-edit and Back-to-navigation behavior. See [Search and Play on TV](companion-search.md).

TMDb provides cached artwork and details when matching is sufficiently confident, with Finnish lookup and English fallback. Series details load episodes on demand and require an episode selection before playback. Favourites store movie genres and series provider categories locally. Continue Watching stores VOD progress with Resume and Remove actions.

## Live TV

Home opens independently of VOD catalogue initialization. Live TV fetches matching Finnish provider categories and then the chosen category's channels, preserving provider order and stream variants. Selection rules recognize normalized Finland/Finnish/Suomi aliases; they do not infer country from channel names. Account-scoped category/channel metadata is cached without playback URLs and refreshed in the background.

Channel rows show the current programme, progress, remaining minutes, and the next programme for the focused row when the provider supplies short EPG data. Requests fetch up to ten programmes per channel with four concurrent requests; cached guides expire after twelve minutes or the current programme ends. Missing guide data does not prevent tuning.

Finnish SkyShowtime 1 and 2 use only the public EPGShare Swedish (`SE1`) XMLTV replacement, never provider EPG or DNA fallback. Packaged Tizen and LG webOS fetch that public feed directly; hosted browsers use the fixed same-origin `/public/nordic-epg` bridge without requiring a companion. The bridge strips caller headers and bodies, rejects query strings, and requests only the public feed. Guide requests omit credentials/referrers, time out, recover after failure and refresh after twelve minutes. Older SkyShowtime cache entries without replacement-source provenance are ignored. Other channels retain provider EPG and verified DNA enrichment. Guide failures never prevent browsing or tuning.

The trusted-LAN companion service is not required by the TV. Its explicit Settings enable switch controls an app-level connection across Home, Live TV and VOD; disabled connections start no polling. LG webOS supports pairing and receiving provider commands and staged local-media sessions; the LG TV still has no file picker for its own storage or USB. Provider commands carry credential-safe identifiers and metadata, which the TV resolves against its saved playlist to construct the provider stream URL locally. Local media uses a separate capability, short-lived ticket, range streaming, and TV playback-state lease. Release-style episode filenames trigger preferred-language OpenSubtitles matching. External local subtitles, enabled state, and timing offset follow that session. Incompatible local files are prepared on the computer as bounded-bitrate H.264 MP4 with supported audio preserved before TV playback; this requires ffmpeg/ffprobe and can delay startup. On 2026-10-10, LG pairing, playback of one browser-staged synthetic H.264/AAC MP4, and stopping that session were confirmed on the physical TV. The video reached readyState 4 and was playing; after stop, the TV video element and synthetic title were removed without error. Pairing reset produced a fresh code while the receiver remained connected and unpaired; re-pairing with that code accepted a new sequence-1 local-play command, which played without error. Provider-command resolution, subtitle staging, seek, broader media support, and general network/standby recovery remain unverified. A companion outage cannot affect TV startup or provider browsing. A failed or empty Nordic replacement leaves SkyShowtime guide data unavailable; provider EPG and DNA are not requested for those channels.

Playback uses browser HLS/native video or Tizen AVPlay. Direct Tizen playback defaults to provider HLS, with a direct-TS toggle. Configured relay channels use relay-generated MPEG-TS HLS independently of that toggle. Playback starts fullscreen. Up/Down changes channels without wrapping; Back returns to the list. Browser adapters expose Rewind 30 seconds and Go live when a usable live buffer exists. This is limited to the available buffer, not recording or provider catch-up. Live playback does not create VOD resume records. Browser hls.js playback targets four segments behind the live edge to absorb brief delivery delays; Go live uses the engine's safety position, or a ten-second margin for native playback. This adds live delay and cannot compensate for sustained provider throughput below the channel bitrate. Audio-track metadata processing copies a segment only when its track ordering needs to change.

LG webOS uses a platform adapter around HTML video and the existing direct client transport. Provider requests and media URLs go from the TV to their intended providers. LG advertises companion pairing and receiver support, but not Samsung AVPlay/live subtitle relay or TV-side local-file picking. HLS, MPEG-TS, audio, and embedded-track support depends on the webOS engine and provider stream; the adapter does not promise that a format or track is available. On 2026-10-10, the physical device check confirmed webOS 25 / Chromium 120, 18 live categories from personal defaults, 1080p live video, companion pairing, and playback of a browser-staged synthetic H.264/AAC MP4. Provider commands, subtitles, VOD seek/resume, track selection, broader codec coverage, and standby recovery remain pending physical acceptance. See the [LG packaging guide](../webos/README.md).

Embedded subtitles prefer Finnish, then English. The browser's DVB worker requires actual subtitle packets; Tizen uses AVPlay text tracks when present. Continuous TV-side TS subtitle scanning remains disabled after it disrupted playback on Tizen 3. The supported Multi-Sub solution is the separate [live subtitle relay](live-subtitle-relay.md): one provider connection supplies relayed video/audio and server-decoded PNG captions, scheduled by the TV's AVPlay playhead.

Relay-enabled personal Tizen builds route Finnish channels through one upstream for video and dynamic DVB subtitle discovery, independently of `Multi-Sub` naming. Explicit mappings take precedence, and legacy marked channels remain eligible. `npm run relay:personal` allowlists Finnish and legacy marked channel IDs and runs the Mac service using gitignored `.env.live-relay`. Standard/public builds do not embed its device credential. Saved TV settings override bundled defaults. The relay prepares three completed chunks, requests eight-second TV buffering, and tries two fresh relay sessions after a playback failure before direct fallback. It closes the old session first; fallback omits the separate TS audio-language probe.

Hosted relay setup and playback acceptance records are kept in ignored local deployment notes. The repository provides generic [deployment](live-subtitle-relay-deployment.md) and [operations](../deploy/live-subtitle-relay/OPERATIONS.md) guides. Subtitle timing remains `clock=unverified`; sustained resource use, recovery controls and a soak remain unrecorded.

## VOD playback and configuration

Browser playback uses HTML video; Tizen uses AVPlay when available. Both report playback/loading/error states and guard against stale playback callbacks. Live and VOD share a runtime-owned release barrier: failed cleanup blocks a new session and offers explicit Retry. VOD supports resume, ±60-second skips, fullscreen, Auto/Fit/Fill aspect modes, and subtitle size/timing controls.

The LG HTML-video adapter releases its active source when the app is backgrounded and restores a session that was playing when the app becomes visible. A previously paused session remains paused until the user presses Play. This lifecycle behavior is implemented and covered synthetically; TV standby/relaunch behavior remains a physical-device check.

OpenSubtitles searches use series/season/episode identifiers where possible. Browser playback converts SRT to WebVTT; Tizen renders parsed SRT cues over AVPlay rather than relying on external-subtitle paths rejected by the previously tested firmware. Formatting tags are normalized. Preferred language, size, and per-title timing offsets are saved locally.

Settings holds playlist and API configuration. If local storage is denied, configuration falls back to bundled defaults or in-session values. Personal build defaults remain extractable from the package even after a saved override is removed. See the [README](../README.md#personal-development) for credential handling.

## Code map

| Location | Responsibility |
| --- | --- |
| `src/core/m3u`, `src/core/catalog` | Parsing, classification evidence, normalization, import orchestration |
| `src/core/live`, `src/core/subtitles` | Live selection/EPG and subtitle rules |
| `src/platform/xtream`, `tmdb`, `opensubtitles` | External service adapters |
| `src/platform/browser`, `web`, `tizen`, `webos` | Playback, device storage, network, lifecycle and remote integration |
| `src/contracts`, `src/bootstrap` | Runtime ports, platform capabilities, adapter wiring and migration-compatible settings |
| `src/application` | Live playback routing/recovery, cross-route release, optional companion lifecycle, caches and shared provider search |
| `src/platform/companion` | Optional web-to-TV transport client and local media staging/streaming |
| `src/core/live-relay`, `src/platform/live-relay`, `src/platform/tizen/live-relay-player.ts` | Relay protocol, cue scheduling, device configuration, authenticated client and Tizen PNG overlay |
| `services/live-subtitle-relay`, `deploy/live-subtitle-relay` | Single-stream ingest/packaging, server subtitle decoding, bounded session API, and native hosted deployment/operations |
| `src/app/App.tsx`, `LiveTv.tsx`, `VodApp.tsx` | Application shell and shared live/VOD screens |
| `src/app/remote-navigation.ts`, `remote-editable.tsx` | Focus decisions and deliberate TV text editing |
| `scripts/`, `vite.config.ts`, `tizen/`, `webos/` | Development services, build targets, packaging and deployment |

`src/core` must remain independent of browser, React, Node, Tizen, and webOS globals. Keep integrations behind adapters, sanitize network errors, and use only synthetic fixtures in tests. Navigation belongs in the app layer; see [the navigation contract](navigation.md).

## Limits and remaining work

- Live discovery requires Xtream; M3U-only live import/browsing is not implemented.
- Recording, provider catch-up, non-Finnish live browsing, and live Play on TV commands are not implemented.
- Large non-streaming M3U responses need a future file-backed import path.
- Browser playback depends on provider access, CORS, and codec support. The development MKV fallback is described in [the browser/relay guide](companion-search.md#browser-mkv-audio).
- Physical Tizen playback, embedded subtitles, remote responsiveness, and sustained browser live playback require device checks. Builds and unit tests do not establish hardware compatibility.
- Hosted relay playback has historical device acceptance, but sustained resource use, measured subtitle timing and post-refactor recovery still need verification. Reconnects include preparation pauses.
- LG webOS has a user-confirmed first-channel picture/audio check. VOD seek/resume, subtitle/audio tracks, codec and stream-format support, pointer/D-pad transitions, Back behavior, and standby/relaunch recovery remain to be checked on the target TV. See [LG verification](verification.md#lg-webos-physical-tv-check).
- VOD orchestration remains partly screen-owned; dynamic engine capabilities, catalogue indexing/performance work and native lifecycle ports remain open.
- Android/Mi Box support is deferred. No Android adapter, shell or APK build target exists.

Feature references: [navigation](navigation.md), [search/companion](companion-search.md), [local files](local-file-playback.md), [embedded subtitles](live-dvb-subtitles.md), and [subtitle relay](live-subtitle-relay.md).
