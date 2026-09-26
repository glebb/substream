# Current behavior and architecture

This is the implementation reference, not a record of completed plans. Hardware-dependent behavior must still pass the [verification checklist](verification.md).

## Catalogue and title details

Xtream-compatible `get.php` sources load movie/series categories first, titles when a category opens, and episodes when a series opens. Category IDs identify groups even when names repeat. M3U import is the fallback; confidently classified VOD entries retain their evidence, and unknown entries remain stored separately rather than being discarded or shown as VOD.

The local IndexedDB catalogue uses schema version 7. Imports write a staged generation and promote it only after all batches succeed, keeping the last ready catalogue on failure. Startup reports migration progress and offers retry if another tab blocks an upgrade. Streaming import is preferred; whole-response fallback requires an exposed, uncompressed Content-Length of at most 8 MiB before reading the body.

Browsing supports title, playlist-order, and release-year sorting; unknown years sort last. Playlist order is not a reliable date-added timestamp. Search uses the imported M3U catalogue or an account-scoped Xtream cache. See [Search and Play on TV](companion-search.md).

TMDb provides cached artwork and details when matching is sufficiently confident, with Finnish lookup and English fallback. Series details load episodes on demand and require an episode selection before playback. Favourites store movie genres and series provider categories locally. Continue Watching stores VOD progress with Resume and Remove actions.

## Live TV

Home opens independently of VOD catalogue initialization. Live TV fetches matching Finnish provider categories and then the chosen category's channels, preserving provider order and stream variants. Selection rules recognize normalized Finland/Finnish/Suomi aliases; they do not infer country from channel names. Account-scoped category/channel metadata is cached without playback URLs and refreshed in the background.

Channel rows show the current programme, progress, remaining minutes, and the next programme for the focused row when the provider supplies short EPG data. Requests fetch up to ten programmes per channel with four concurrent requests; cached guides expire after twelve minutes or the current programme ends. Missing guide data does not prevent tuning.

Playback uses browser HLS/native video or Tizen AVPlay with provider TS output. It starts fullscreen. Up/Down changes channels without wrapping; Back returns to the list. Browser adapters expose Rewind 30 seconds and Go live when a usable live buffer exists. This is limited to the available buffer, not recording or provider catch-up. Live playback does not create VOD resume records.

Embedded subtitles prefer Finnish, then English. The browser's DVB worker requires actual subtitle packets; Tizen uses AVPlay text tracks. See [embedded live subtitles](live-dvb-subtitles.md) for transport limits and diagnostic guidance.

## VOD playback and configuration

Browser playback uses HTML video; Tizen uses AVPlay when available. Both report playback/loading/error states and guard against stale playback callbacks. VOD supports resume, ±60-second skips, fullscreen, Auto/Fit/Fill aspect modes, and subtitle size/timing controls.

OpenSubtitles searches use series/season/episode identifiers where possible. Browser playback converts SRT to WebVTT; Tizen renders parsed SRT cues over AVPlay rather than relying on external-subtitle paths rejected by the previously tested firmware. Formatting tags are normalized. Preferred language, size, and per-title timing offsets are saved locally.

Settings holds playlist and API configuration. If local storage is denied, configuration falls back to bundled defaults or in-session values. Personal build defaults remain extractable from the package even after a saved override is removed. See the [README](../README.md#personal-development) for credential handling.

## Code map

| Location | Responsibility |
| --- | --- |
| `src/core/m3u`, `src/core/catalog` | Parsing, classification evidence, normalization, import orchestration |
| `src/core/live`, `src/core/subtitles` | Live selection/EPG and subtitle rules |
| `src/platform/xtream`, `tmdb`, `opensubtitles` | External service adapters |
| `src/platform/browser`, `web`, `tizen` | Playback, device storage, network and remote integration |
| `src/platform/companion` | Search cache and LAN client |
| `src/app/App.tsx`, `LiveTv.tsx` | VOD/application shell and live UI |
| `src/app/remote-navigation.ts`, `remote-editable.tsx` | Focus decisions and deliberate TV text editing |
| `scripts/`, `vite.config.ts`, `tizen/` | Development services, build targets, packaging and deployment |

`src/core` must remain independent of browser, React, Node, and Tizen globals. Keep integrations behind adapters, sanitize network errors, and use only synthetic fixtures in tests. Navigation belongs in the app layer; see [the navigation contract](navigation.md).

## Limits and remaining work

- Live discovery requires Xtream; M3U-only live import/browsing is not implemented.
- Recording, provider catch-up, non-Finnish live browsing, and live Play on TV commands are not implemented.
- Large non-streaming M3U responses need a future file-backed import path.
- Browser playback depends on provider access, CORS, and codec support. The development MKV fallback is described in [the browser/relay guide](companion-search.md#browser-mkv-audio).
- Physical Tizen playback, embedded subtitles, remote responsiveness, and sustained browser live playback require device checks. Builds and unit tests do not establish hardware compatibility.

Completed live-TV and Tizen UX plans have been consolidated here and in the navigation/verification guides. New work should be scoped against the implementation above rather than the retired plans.
