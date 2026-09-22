# Project guide

Substream is a Samsung Tizen IPTV VOD player with OpenSubtitles-powered subtitle discovery. The shared TypeScript catalogue and subtitle logic lives in `src/core`; browser and Tizen behavior is implemented by platform adapters.

## Everyday commands

```sh
npm run check       # typecheck and synthetic tests
npm run build       # standard browser build
npm run build:tizen # standard Tizen web payload
npm run prepare:tizen6:personal # prepare the verified Tizen 6+ package for VS Code signing
npm run launch:tizen6 -- TV_IP # deploy a signed Tizen 6+ WGT by IP
npm run inspect:m3u # credential-safe summary of the private playlist in .env
```

`npm run dev:personal`, `npm run build:personal`, and `npm run build:tizen:personal` are explicitly opt-in development commands. They embed `.env` values in the resulting client bundle, so their output must never be committed, shared, or distributed. See [the Tizen deployment guide](../tizen/README.md) for packaging details.

## Catalogue and configuration

- Small configuration values are read from local storage when available; denied storage safely falls back to bundled personal-build defaults or an in-session value.
- Xtream-compatible `get.php` playlists use the provider catalogue first: movie and series categories are saved locally, while opened categories and episodes are fetched on demand. Provider category IDs—not display names—identify categories. M3U import remains the fallback.
- M3U responses stream into the parser where supported. Legacy whole-response imports require an exposed, uncompressed `Content-Length` of at most 8 MiB before any body is read.
- IndexedDB version 7 stages each replacement in a new generation and promotes it only after every batch succeeds. A failed import leaves the last ready catalogue visible. Confident VOD entries retain classifier evidence; unclassified entries are retained separately and never shown as VOD.
- Local browsing is paged and sorted by normalized title, playlist order, or release year. Unknown years sort last. The internal search API returns bounded results in global normalized-title order; search is not yet exposed in the UI.
- Startup reports migration progress, closes connections on version changes, and offers a retry action if another tab blocks an upgrade.

## Playback and subtitles

- Browser playback uses the native video element. Tizen 3.0 / Chromium 47 builds use AVPlay's hardware surface when available, including its fixed 1920×1080 display coordinate system.
- Both adapters report loading, buffering, playing, paused, ended, and error states. AVPlay preparation and stale callbacks are generation-guarded.
- The remote UI supports arrow/Enter/Back navigation, media keys, ±60-second skips, Auto/Fit/Fill display modes, full-screen video, and subtitle-size controls. Web Space toggles playback from the video area or while fullscreen; Tizen Enter toggles playback while fullscreen controls are hidden and activates the focused control when visible.
- OpenSubtitles queries exact series/season/episode records where possible. Browser playback converts SRT to WebVTT; the TV renders parsed SRT cues as an app overlay because this firmware rejects AVPlay external-subtitle paths.
- Subtitle preferences retain the preferred language order (Finnish/English by default), the last selected language, font size, and per-title timing offsets. Provider formatting such as ASS/SSA overrides and inline HTML is normalized before rendering.

## Metadata, favourites, and title details

- TMDb supplies cached title metadata and artwork when a confident match is available. Finnish search is preferred with English fallback; ambiguous matches do not attach potentially incorrect metadata.
- Movie and series details are shown before playback. Series details load episodes on demand and expose a compact Season → Episode picker, avoiding a long combined list for multi-season shows.
- On Tizen, title-details controls use explicit yellow remote focus. Arrow keys move Back → Season/Episode → Play selected episode; Action/Enter opens or confirms the picker and starts playback only from the Play control. Back returns from episodes to seasons and then to details.
- Movie genres and series provider categories can be marked as favourites and are available through the dedicated Favourites browse view.

## LAN companion search

- The optional LAN companion service searches a full Xtream provider catalogue for a paired phone or computer. The TV keeps provider credentials and final stream URL derivation; the browser caches only safe catalogue metadata in IndexedDB.
- A pairing listener remains active after Settings closes, so companion selections always move the TV to title details. This remains a trusted-LAN development feature: six-digit sessions expire after 30 minutes, M3U-only sources are unsupported, and selection relay requires the local service to be online.
- See [companion-search.md](companion-search.md) for operation and security constraints.

## UI and remote focus

- Continue Watching keeps Resume and Remove as a visual and navigation pair: Up/Down change titles and Left/Right changes the action for that title.
- Settings has state-driven yellow remote focus for all actions, conditional API-key controls, and confirmations. Configured API keys are managed only from Settings; the player exposes setup only when a key is absent.
- Tizen 3 receives a complete static-color and flexbox baseline before modern CSS enhancements. This preserves the dark UI, visible focus state, four-column category layout, and a bounded single-column title list on Chromium 47.

## Constraints and next work

- Large non-streaming playlist responses remain unsupported; a file-backed Tizen import path is future work.
- Playlist order is the only reliable source-order signal; the source does not provide a trustworthy catalogue-added timestamp.
- A key embedded in a client package can be extracted. The local development proxy avoids that exposure; a production proxy is required to protect a production key.
- Full browser integration coverage and physical-TV validation are still required. Follow [verification.md](verification.md) for the automated and TV smoke checks.

The product backlog is maintained in [roadmap.md](roadmap.md).
