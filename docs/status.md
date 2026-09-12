# Project status

## Current implementation

The project is a standalone-oriented Samsung Tizen IPTV VOD player with a TypeScript core and browser/Tizen platform adapters.

- Private M3U URL and OpenSubtitles API key are ignored by Git and are never printed by project scripts.
- `npm run dev:personal`, `npm run build:personal`, and `npm run build:tizen:personal` are opt-in local development variants that embed those `.env` values; their output must never be committed or distributed.
- The M3U importer reads incrementally, batches IndexedDB writes, keeps unknown entries, and records classifier evidence.
- Xtream-compatible playlists use an on-demand provider catalogue: categories load first, then only the opened movie/series category (and selected series episodes) are requested. M3U import remains the compatibility fallback.
- Playlist imports show sanitized connection, storage, reader-mode, parser, and saved-item progress so TV failures can be diagnosed without revealing the playlist URL.
- VOD entries are classified into movies and series. Provider markers such as 'NC - ' are removed from normalized titles.
- The catalogue is persisted in IndexedDB and supports TV-remote focus for setup/import and paged group browsing, arrow/Enter/Back navigation, focus scrolling, and sorting by title, original playlist order, and release year.
- The Tizen import path writes 2,000 VODs per transaction and retains only the three indexes used by catalogue sorting, avoiding the previous multi-entry full-text index cost during large imports.
- Existing IndexedDB catalogues are migrated when metadata normalization changes.
- Browser playback uses a native video adapter. The Tizen package targets Tizen 3.0 / Chromium 47 for the 2017 UE75MU8005 family and uses AVPlay's hardware video plane when available. Because this TV rejects AVPlay external-subtitle paths, downloaded SRT is parsed locally and rendered as timed app overlay text from AVPlay playback-time callbacks.
- The Tizen UI uses legacy remote-key normalization, high-contrast focus tiles, explicit player-screen button focus, and a fixed-height AVPlay container because the TV browser lacks modern CSS `aspect-ratio` support. Player full screen is a video-only AVPlay surface; Back exits it. The player offers Auto/Fit/Fill aspect modes, Play/Pause/Restart controls, ±60-second skips on Left/Right, physical Samsung media-key support, a distinct playback-state pill, and adjustable subtitle-overlay size.
- AVPlay uses Samsung's required `application/avplayer` display object and scales its media rectangle to AVPlay's fixed 1920×1080 coordinate space before asynchronous preparation.
- OpenSubtitles search supports movies and series. Series requests resolve a canonical TV-show feature, then request the exact parent feature, season, and episode, which prevents unrelated movie matches.
- Anonymous subtitle download requests use the API key. Browser playback converts SRT to WebVTT; Tizen playback uses parsed timed SRT cues in an app-rendered overlay. The parser removes ASS/SSA override syntax and inline HTML formatting tags before displaying cue text. Selecting a subtitle returns focus and scroll position to the video controls.
- During local development, Vite proxies OpenSubtitles requests so the key remains in .env and the provider-facing request has an app User-Agent. The standalone Tizen build currently calls the provider directly.
- A browser development build needs its Vite server running (`npm run dev:personal`) for the local OpenSubtitles proxy; the UI identifies that missing server explicitly.

## Verification completed

- The check command passes: 35 synthetic-fixture tests.
- Browser and Tizen production builds pass.
- Live Chrome checks confirmed:
  - OpenSubtitles API key and local proxy return HTTP 200.
  - Movie search returns subtitle candidates.
  - Silo (2023) S03 E01 resolves to the canonical TV-show record and returns 10 correct S03E01 candidates.

## Next phases

The implementation-ready feature backlog is maintained in [roadmap.md](roadmap.md). The next priority is playback progress/resume, followed by seamless bundled/stored configuration and automatic subtitle selection.

## Known constraints

- The M3U source does not provide a reliable catalogue-added timestamp. Playlist order preserves the source order instead.
- An API key bundled into a standalone client can be extracted. Development avoids that exposure via the local proxy; a production proxy would be required to protect the key fully.
- OpenSubtitles may omit episode metadata. The app does not show broad, unverified series matches in that case.
