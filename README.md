# Substream

![Substream launch screen](public/branding/substream-splash.png)

**Substream** is a subtitle-first IPTV VOD player for Samsung Tizen TVs. It turns an M3U or Xtream-compatible provider into a browsable on-demand library, then helps viewers find, select, size, and time subtitles during playback.

> OpenSubtitles is an external service. Substream uses its API when you provide a key; it is not affiliated with or endorsed by OpenSubtitles.

## Highlights

- Browse movies and series from M3U playlists, preserving entries whose type cannot be confidently identified.
- Use Xtream-compatible `get.php` sources efficiently: load categories first, then fetch titles and episodes only when needed.
- Search and download subtitle choices through the OpenSubtitles API, with TV subtitle overlays and browser-native subtitle tracks.
- Adjust subtitle size and timing, and retain per-title timing offsets on the device.
- Resume playback, sort and page through a local catalogue, and use a TV-remote-friendly interface.
- Play through the browser's native video element or Samsung AVPlay on Tizen 3.0-compatible TVs.

## Quick start

Prerequisites: a current Node.js LTS release and npm.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite, add your playlist from the app's setup screen, and enter an OpenSubtitles API key in the player when you want subtitle discovery.

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

## Tizen TV build and deployment

The Tizen application has its own manifest and launcher icon at [`tizen/config.xml`](tizen/config.xml) and [`tizen/icon.png`](tizen/icon.png). The preferred workflow uses the working VS Code Tizen extension for signing, then deploys by IP without changing VS Code settings.

```sh
npm run check
npm run prepare:tizen6:personal
# Sign the generated package with the VS Code Tizen extension.
npm run collect:tizen6
npm run launch:tizen6 -- TV_IP
```

Use `tizen3` instead of `tizen6` when you specifically need the unchanged legacy-compatible package. Follow the complete [Tizen setup, packaging, and deployment guide](tizen/README.md) for certificates, device connection, packaging, and installation.

To avoid exporting the local Tizen SDK path for every package build, copy `.tizen-cli.local.example` to `.tizen-cli.local` and set its `TIZEN_CLI` value. The local file is ignored by Git.

The app's Tizen ID is `Substream0.Substream`; it installs separately from the prior My M3U development build.

## Personal configuration and security

Substream keeps playlist URLs and API keys in local device storage when entered through the UI. Do not commit `.env`, playlist URLs, API keys, signed media URLs, or packaged personal builds.

The `dev:personal`, `build:personal`, and `build:tizen:personal` commands deliberately embed values from `.env` into a client bundle for personal development. Anyone able to inspect that bundle can recover those values, so never share or distribute its output. A production deployment needs a server-side proxy to protect an OpenSubtitles API key.

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

For the current implementation details, constraints, and planned work, see [docs/status.md](docs/status.md) and [docs/roadmap.md](docs/roadmap.md).
