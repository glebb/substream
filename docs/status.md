# Project status

## Current implementation

The project is a standalone-oriented Samsung Tizen IPTV VOD player with a TypeScript core and browser/Tizen platform adapters.

- Private M3U URL and OpenSubtitles API key are ignored by Git and are never printed by project scripts.
- The M3U importer reads incrementally, batches IndexedDB writes, keeps unknown entries, and records classifier evidence.
- VOD entries are classified into movies and series. Provider markers such as 'NC - ' are removed from normalized titles.
- The catalogue is persisted in IndexedDB and supports paged groups, remote arrow/Enter/Back navigation, focus scrolling, and sorting by title, original playlist order, and release year.
- Existing IndexedDB catalogues are migrated when metadata normalization changes.
- Browser playback uses a native video adapter. Tizen playback is intentionally still behind an adapter boundary.
- OpenSubtitles search supports movies and series. Series requests resolve a canonical TV-show feature, then request the exact parent feature, season, and episode, which prevents unrelated movie matches.
- Anonymous subtitle download requests use the API key. Downloaded SRT text is converted to WebVTT and added as a native video track.
- During local development, Vite proxies OpenSubtitles requests so the key remains in .env and the provider-facing request has an app User-Agent. The standalone Tizen build currently calls the provider directly.

## Verification completed

- The check command passes: 26 synthetic-fixture tests.
- Browser and Tizen production builds pass.
- Live Chrome checks confirmed:
  - OpenSubtitles API key and local proxy return HTTP 200.
  - Movie search returns subtitle candidates.
  - Silo (2023) S03 E01 resolves to the canonical TV-show record and returns 10 correct S03E01 candidates.

## Next phases

1. Implement a Tizen AVPlay adapter and player state machine for IPTV-compatible playback, remote media controls, errors, and resume position.
2. Add full-text catalogue search and filters for groups, movies/series, language, and year.
3. Cache downloaded subtitle files in app storage; add language preference, release scoring, and automatic subtitle selection.
4. Implement TV-native M3U download-to-storage and chunked import using Tizen download/filesystem APIs, including refresh and delete flows.
5. Package, sign, deploy, and test on a Samsung TV or Tizen emulator.

## Known constraints

- The M3U source does not provide a reliable catalogue-added timestamp. Playlist order preserves the source order instead.
- An API key bundled into a standalone client can be extracted. Development avoids that exposure via the local proxy; a production proxy would be required to protect the key fully.
- OpenSubtitles may omit episode metadata. The app does not show broad, unverified series matches in that case.
