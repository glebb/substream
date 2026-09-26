# Substream

Substream is an IPTV live TV and video-on-demand player for Samsung Tizen TVs and browsers. It supports M3U libraries, on-demand Xtream catalogues, TMDb details, OpenSubtitles downloads, local favourites, and playback resume.

Live TV currently requires an Xtream-compatible `get.php` source. It browses Finnish provider categories, shows available programme information, and plays embedded subtitles when the stream and device support them.

## Start in a browser

Use Node.js 22.18+ (or a newer supported LTS) and npm. The inspection command needs Node's built-in TypeScript support.

```sh
npm install
npm run dev
```

Open the URL printed by Vite, add a playlist, and choose Live TV or Video-On-Demand. Add OpenSubtitles and TMDb credentials in Settings if needed. TMDb accepts a read access token (preferred) or API key.

Search works without a TV: import an M3U catalogue or refresh the full Xtream catalogue from Search. Cached titles remain searchable offline; playback still needs access to the provider.

## Personal development

Copy [`.env.example`](.env.example) to the ignored `.env`. Personal commands require `IPTV_M3U_URL`, `OPENSUBTITLES_API_KEY`, and either `TMDB_API_READ_ACCESS_TOKEN` or `TMDB_API_KEY`.

```sh
npm run dev:personal
```

This starts Vite with personal defaults and the LAN relay; Ctrl+C stops both. Personal builds embed credentials in the client bundle. Anyone with the bundle can recover them: never share or commit personal builds, `.env`, playlist URLs, tokens, or signed media URLs. UI-entered configuration is stored locally on the device; it is not a secret vault.

Standard builds do not embed those credentials. The optional `COMPANION_SERVER_URL` address is embedded even in standard builds. Development proxies do not make client-supplied credentials secret; a distributed service needs a server-side design to protect them.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run check` | Typecheck and run synthetic unit tests |
| `npm run build` | Browser output in `dist/` |
| `npm run build:tizen` | Tizen 3 web payload in `tizen/dist/` |
| `npm run build:tizen:6` | Tizen 6+ payload in the same directory |
| `npm run preview:chromium47` | Docker-based legacy UI preview; append `-- stop` to clean up |
| `npm run preview:chromium47:personal` | Preview with private `.env` defaults |
| `npm run inspect:m3u` | Fetch the configured private playlist and print a credential-safe summary |

Build commands also have `:personal` variants. See [package.json](package.json) for the complete script list. Tizen web builds are not signed installable packages.

## Guides

- [Current behavior and architecture](docs/status.md): supported features, source map, and remaining limitations.
- [Tizen setup and deployment](tizen/README.md): certificates, signing, installation, and troubleshooting.
- [Search and Play on TV](docs/companion-search.md): optional LAN relay and browser media compatibility.
- [Remote navigation](docs/navigation.md): keyboard/remote behavior and focus rules.
- [Verification](docs/verification.md): automated checks, legacy preview, and device smoke tests.
- [Embedded live subtitles](docs/live-dvb-subtitles.md): decoder limits and provider diagnostics.

TMDb supplies metadata and artwork; Substream is not endorsed or certified by TMDb. Keep the required TMDb attribution visible when distributing the app. OpenSubtitles is an external service; Substream is not affiliated with or endorsed by it.
