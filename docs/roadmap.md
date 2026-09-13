# Product roadmap

This roadmap describes the next user-facing improvements for the Samsung Tizen VOD player. It is ordered to improve everyday TV use first, then expand catalogue discovery and metadata.

## Phase 1: Playback and setup

- [x] Show video progress: elapsed time, duration, and a seek/progress bar when AVPlay provides duration and current-time events.
- [x] Show buffering state and a visible buffer indicator when the adapter reports it.
- [x] Persist playback progress per title and offer **Resume** or **Start over**.
- [x] Add a **Continue watching** section, ordered by most recently played unfinished titles, with an explicit option to remove an item from history.
- [x] Prepopulate the M3U URL whenever it is bundled in a personal build or already stored locally. Do not show the setup form until the user explicitly chooses **Change playlist**.
- [x] Add a safe settings/reset screen: change playlist URL, clear the local VOD catalogue, clear saved OpenSubtitles settings, and reset all local app data. Reset actions must require confirmation and never reveal stored secrets.
- [x] Prepopulate the OpenSubtitles API key when it is bundled or stored locally. Do not request it on the player screen unless it is missing or the user chooses **Change subtitle settings**.
- [x] Automatically search for subtitles when playback begins, using the title, year, season, and episode already resolved by the catalogue.
- [x] Automatically choose the best subtitle when the confidence is high; otherwise show a compact selection list without interrupting playback.
- [x] Add possibility to disable/enable subtitles.
- [x] Combine play/pause button.
- [x] Change the behavior on the playback screen. Only skip past/forward, if the video area is "selected". Otherwise left right buttons should move the selection just like up and down. In full screen the skipping should work always with left right.
- [x] Pressing the key i or info button from remote should display basic information about the video (like resolution). Another press hides the info.

## Phase 2: Subtitle experience

- [ ] Add a subtitle-language preference in settings. Default search/ranking order: Finnish, then English.
- [x] Filter subtitle results to Finnish and English and rank by exact episode/movie match, language preference, release-name similarity, and download count.
- [ ] Remember the last chosen subtitle language and font size per device.
- [x] Add subtitle timing controls for the app-rendered Tizen overlay: quick ±0.5 s and ±2 s adjustments, an on-screen current-offset indicator, and a per-title remembered offset.
- [ ] Keep normalizing provider formatting tags such as ASS/SSA overrides and inline HTML before rendering text.

## Phase 3: Catalogue discovery and browsing

- [ ] Add VOD search across titles, normalized names, release year, and series/episode identifiers.
- [ ] Add browse filters for content type, group, language/region, release year, and favourites/history.
- [ ] Improve TV browsing layout with clearer group/title hierarchy, compact rows or poster grids, loading placeholders, empty states, and remote-friendly focus transitions.
- [ ] Add favourites, recently watched, and continue-watching sections.
- [ ] Preserve efficient on-demand Xtream category loading and keep M3U import as a fallback.

## Phase 4: Movie and series metadata

- [ ] Resolve basic movie/series metadata from a suitable metadata provider: poster/thumbnail, description, release year, genres, runtime, and rating where available.
- [ ] Add a title-details screen before playback with poster, synopsis, episode/season selector, available subtitle languages, and resume state.
- [ ] Cache metadata and image thumbnails locally with expiry and size limits appropriate for the TV.
- [ ] Handle ambiguous title matches safely: show candidates or omit metadata rather than attaching incorrect artwork/descriptions.

## Delivery principles

- Keep private playlist URLs, API keys, tokens, and signed media URLs out of logs, UI diagnostics, Git, and distributable builds.
- Keep platform-independent logic in `src/core`; browser and Tizen integrations stay behind adapters.
- Test catalogue and subtitle logic using synthetic fixtures only.
- Validate every Tizen feature on the UE75MU8005 after packaging a personal build.
