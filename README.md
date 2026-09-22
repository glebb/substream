# Substream

![Substream launch screen](public/branding/substream-splash.png)

**Substream** is a subtitle-first IPTV VOD player for Samsung Tizen TVs. It turns an M3U or Xtream-compatible provider into a browsable on-demand library, then helps viewers find, select, size, and time subtitles during playback.

> OpenSubtitles is an external service. Substream uses its API when you provide a key; it is not affiliated with or endorsed by OpenSubtitles.
>
> Movie and series metadata is provided by [TMDb](https://www.themoviedb.org/). Substream uses the TMDb API but is not endorsed or certified by TMDb.

## Highlights

- Browse movies and series from M3U playlists, preserving entries whose type cannot be confidently identified.
- Use Xtream-compatible `get.php` sources efficiently: load categories first, then fetch titles and episodes only when needed.
- Search and download subtitle choices through the OpenSubtitles API, with TV subtitle overlays and browser-native subtitle tracks.
- Adjust subtitle size and timing, and retain per-title timing offsets on the device.
- Resume playback, sort and page through a local catalogue, and use a TV-remote-friendly interface with visible focus states.
- Browse and manage local favourites for movie genres and series provider categories.
- View TMDb title details before playback, including artwork, synopsis, rating, genres, runtime, subtitle availability, and series episode selection.
- Play through the browser's native video element or Samsung AVPlay on Tizen 3.0-compatible TVs.

## Quick start

Prerequisites: a current Node.js LTS release and npm.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite and add your playlist from the app's setup screen. Configure an OpenSubtitles API key and optional TMDb credentials from **Settings**; TMDb's read access token is preferred, with its API key accepted as a fallback.

### Search in the web app

Search is part of the normal Substream web app and does not require a TV or LAN relay. Add an Xtream `get.php` playlist in the browser app and refresh the full movie and series catalogue from Search. Search also works against an imported M3U catalogue already stored in that browser. Xtream search results are cached in IndexedDB and remain searchable offline; selecting a result opens the regular details view. In a browser, details offer **Play here** and **Play on TV**. Only **Play on TV** requires the optional LAN relay and an active TV connection.

### Optional TV playback over the LAN

To use Play on TV during personal web development, start both the web app and relay with one command:

```sh
npm run dev:personal
```

The web app opens at Vite's local URL, and the relay listens on port `8787` (`COMPANION_PORT` can change it). Set `COMPANION_SERVER_URL` to its LAN address in `.env` and rebuild the TV app. The TV registers its active provider session at startup and retries automatically if the relay is unavailable; **Settings → TV connection → Connect** remains available for manual connection. In the browser, open **Settings → TV connection**, enter and save the relay's LAN address, then use **Check TV connection** to see whether the relay is reachable, a TV is connected, and its provider matches. During Vite development, an empty address sends `/api` requests through the dev proxy to `localhost:8787` (or `COMPANION_SERVER_URL` when configured). The browser's Search and catalogue refresh use the playlist configured in that browser app directly. The relay and TV are needed only when choosing **Play on TV**. TV playback supports Xtream `get.php` sources; M3U titles can be searched and played locally in the web app.

See [the Search and TV connection guide](docs/companion-search.md) for setup, connection behavior, caching, security boundaries, and troubleshooting.

For personal builds, copy the variable names from `.env.example` into a local, ignored `.env` file. `dev:personal`, `build:personal`, and the personal Tizen build commands require the playlist URL, OpenSubtitles API key, and either `TMDB_API_READ_ACCESS_TOKEN` or `TMDB_API_KEY`. The commands read these values at build startup; they do not load credentials from the app at runtime.

TMDb credentials are used for metadata and artwork only. The app uses the TMDb API with a development proxy in local Vite development and the configured credentials in a personal build. Keep the required [TMDb attribution](https://www.themoviedb.org/documentation/api/terms-of-use) visible in any distributed product.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run check` | Typecheck and run the synthetic unit tests. |
| `npm run build` | Produce a standard browser build in `dist/`. |
| `npm run build:tizen` | Produce the Tizen web payload in `tizen/dist/`. |
| `npm run build:tizen:6` | Produce a Chromium 76-compatible Tizen 6+ web payload in `tizen/dist/`. |
| `npm run package:tizen` | Build and sign `tizen3.wgt` and `tizen6.wgt` with the configured Tizen CLI. |
| `npm run prepare:tizen3:personal` / `prepare:tizen6:personal` | Prepare a signed-package payload for the VS Code Tizen extension. |
| `npm run collect:tizen3` / `collect:tizen6` | Rename the extension-produced package to its compatibility-specific name. |
| `npm run launch:tizen3 -- TV_IP` / `launch:tizen6 -- TV_IP` | Install and launch a signed package on a TV without changing VS Code settings. |
| `npm run inspect:m3u` | Print a credential-safe summary of the private playlist configured in `.env`. |
| `npm run companion:dev` | Start the optional LAN development relay for sending playback to a TV on port `8787`. |
| `npm run dev:personal` | Start the personal Vite web app and LAN relay together. Ctrl+C stops both. |

## Tizen TV build and deployment

The Tizen application has its own manifest and launcher icon at [`tizen/config.xml`](tizen/config.xml) and [`tizen/icon.png`](tizen/icon.png). The preferred workflow uses the working VS Code Tizen extension for signing, then deploys by IP without changing VS Code settings.

```sh
npm run check
npm run prepare:tizen6:personal
# Sign the generated package with the VS Code Tizen extension.
npm run collect:tizen6
npm run launch:tizen6 -- TV_IP
```

Use `tizen3` for Samsung Tizen 3.0 / Chromium 47 TVs. It includes the legacy JavaScript entry and static-color/flexbox UI fallback required by those browsers. Follow the complete [Tizen setup, packaging, and deployment guide](tizen/README.md) for certificates, device connection, packaging, and installation.

To avoid exporting the local Tizen SDK path for every package build, copy `.tizen-cli.local.example` to `.tizen-cli.local` and set its `TIZEN_CLI` value. The local file is ignored by Git.

The app's Tizen ID is `Substream0.Substream`; it installs separately from the prior My M3U development build.

## Personal configuration and security

Substream keeps playlist URLs and provider credentials in local device storage when entered through the UI. Do not commit `.env`, playlist URLs, API keys, read access tokens, signed media URLs, or packaged personal builds.

The `dev:personal`, `build:personal`, and `build:tizen:personal` commands deliberately embed values from `.env` into a client bundle for personal development. Anyone able to inspect that bundle can recover those values, so never share or distribute its output. This applies equally to the TMDb read access token/API key and the OpenSubtitles key. A production deployment needs a server-side proxy to protect provider credentials.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/core/` | Platform-independent M3U parsing, catalogue import, classification, and subtitle logic. |
| `src/platform/` | Browser, Tizen AVPlay, storage, provider, and OpenSubtitles adapters. |
| `src/app/` | React application and remote-navigation UI. |
| `tizen/` | Tizen manifest, launcher icon, build configuration, and deployment notes. |

The core deliberately has no browser, React, Node.js, or Tizen global dependencies.

## Verification

Automated tests use synthetic data only. Run `npm run check` before making changes, then see [docs/verification.md](docs/verification.md) for regression scenarios and the physical-TV smoke checklist.

## Status and roadmap

For the current implementation details, constraints, planned work, and remote-navigation contract, see [docs/status.md](docs/status.md), [docs/roadmap.md](docs/roadmap.md), and [docs/navigation.md](docs/navigation.md).
