# Web Search and TV playback

Search is part of the normal Substream web app. It works without a TV or LAN relay. Search an imported M3U catalogue stored in the browser, or use an Xtream-compatible `get.php` playlist to refresh and search the provider's full movie and series catalogue. Choosing a result opens the regular title details view.

The normal app provides Search; there is no separate companion page. The optional LAN service handles on-demand TV playback commands, a browser-only CORS bridge for the public Nordic guide, and the development-only browser MKV audio fallback. It is not used by TV startup, VOD/live browsing, subtitles, or normal TV playback. Packaged Tizen fetches the Nordic guide directly and falls back to provider guide data if it fails. It is intended for a trusted home LAN, not as an internet-facing service or production backend.

## Search

- For Xtream, configure the playlist in the web app. Search refreshes catalogue records directly from that browser's configured provider and stores safe metadata in IndexedDB, scoped by an account-aware provider fingerprint. TV registration and the relay are not involved.
- For M3U, Search uses the catalogue already imported into that browser. No TV connection or relay is needed. M3U catalogue refresh/import follows the app's normal playlist workflow.
- Xtream cache records contain safe title metadata and provider identifiers, not credentials or playable stream URLs. The browser can search the saved cache when offline; refresh requires the browser to reach the configured provider.
- Search needs at least two characters. Selecting a movie or series opens the shared details view. Series playback requires selecting a season and episode.
- **Play here** uses the browser's own configured provider. The browser must be able to reach that provider to resolve and play a stream.

## Optional setup for Play on TV

The relay serves the built web application at its root. It does not serve catalogue or search APIs: browser search connects directly to the provider configured in the web app. Relay APIs are limited to paired TV playback commands, the public Nordic guide CORS bridge, and the development-only browser MKV audio fallback. You do not need to open the app through the relay to search or play in the browser.

1. Copy `.env.example` to the ignored `.env` file if needed. Set the relay's LAN address for the TV build:

   ```sh
   COMPANION_SERVER_URL=http://192.168.1.50:8787
   ```

2. For personal web development, start the web app and relay together:

   ```sh
   npm run dev:personal
   ```

   This development command opts into LAN mode and prints a warning because the relay uses plain HTTP. The standalone `npm run companion:dev` binds to `127.0.0.1` by default; pass `--lan` (`node scripts/companion-server.mjs --lan`) or set `COMPANION_LAN=1` to expose it on LAN interfaces. `COMPANION_PORT` changes the default port `8787`, and `COMPANION_HOST` can select the LAN bind address when LAN mode is enabled. `COMPANION_ALLOWED_ORIGINS` is a comma-separated exact-origin allow-list; it defaults to Vite's `http://localhost:5173` and `http://127.0.0.1:5173` origins.

3. Rebuild and deploy the TV application after changing `COMPANION_SERVER_URL`. Ensure the TV and computer running the relay can reach each other on the LAN.

4. The TV registers its active Xtream source when its playback listener starts and retries automatically if the relay is unavailable. **Settings → TV connection → Connect** remains available to connect manually. The TV shows an eight-digit one-time code that expires in five minutes; its current session credential is required to renew the session shortly before the 30-minute expiry or replace that TV's session.

5. In the browser app, open **Settings → TV connection**, enter the relay's LAN address (for example `http://192.168.1.50:8787`), save it, then enter the current code shown on the TV and choose **Pair browser**. The code can be redeemed once by one browser. **Check TV connection** then reports whether the paired TV is connected and its provider matches the browser playlist. During Vite development, leave the address empty to use the `/api` proxy to `localhost:8787`; setting `COMPANION_SERVER_URL` in `.env` makes the proxy target that address instead.

6. Configure the same Xtream provider in the browser app and TV. Open a title's details and choose **Play on TV**. The paired browser checks the active TV session and that its provider matches. If unavailable, Search and **Play here** continue to work.

TV playback requires a reachable relay, an active TV session, and a matching Xtream source. Movies can be sent directly. For series, select an episode first. The TV validates the source and derives the final stream URL from its own saved credentials; the browser does not send stream URLs to the relay.

## Data and security boundaries

| Location | Data held |
| --- | --- |
| TV app | Playlist URL/provider credentials and final stream URLs; normal TV features remain local to the TV app |
| LAN relay memory | TV's active Xtream credentials and pending playback commands |
| Web browser IndexedDB | Safe Xtream title metadata, content type, provider IDs, source fingerprint, extension/category metadata, and refresh timestamp; imported M3U catalogue data is held by the app's local catalogue store |
| Browser provider connection | The playlist configured in that browser, used to refresh Xtream Search and resolve **Play here** |

When the TV registers, it sends its playlist URL and credentials to the relay, which keeps them in memory for the active session. A one-time pairing code grants one browser a separate scoped credential; the TV credential can renew or replace only its own active session. These credentials are held in app memory. If the TV app reloads while the relay remains running, it loses its TV credential and cannot replace the still-live session; restart the relay to clear its in-memory session, or wait for the 30-minute session expiry. Restarting the relay also clears all sessions. This registration is only needed for the opt-in **Play on TV** feature; an unreachable or unconfigured relay does not affect normal TV use. The relay defaults to loopback and has an exact-origin CORS allow-list, but LAN mode still uses plain HTTP, so playlist credentials, pairing codes, and bearer credentials are unencrypted in transit. Keep LAN mode on a trusted network and do not expose it to the internet. Never print or commit `.env`, playlist URLs, OpenSubtitles credentials, tokens, or signed media URLs. Tests use synthetic catalogue fixtures only.

## Troubleshooting

- **Xtream Search is empty:** confirm a valid Xtream playlist is configured in the browser app, then refresh the catalogue. Search does not use the TV's provider session or relay APIs.
- **M3U Search is empty:** import the playlist in that browser app and check that the local catalogue contains searchable entries.
- **Search works offline but looks stale:** reconnect the browser to its configured provider and refresh the Xtream catalogue.
- **Play here fails:** confirm the browser can reach its configured provider and that the selected title belongs to it.
- **Play on TV is unavailable or fails:** confirm the relay address is correct, the relay and TV are online, the TV listener has registered, and the browser and TV use the same Xtream account/source. Guest Wi-Fi, client isolation, or a firewall can block LAN traffic.

## Browser MKV audio

For local browser development, install `ffmpeg` and `ffprobe` on PATH and run `npm run dev:personal`. The browser can ask the relay to prepare H.264 MKVs when AC-3/E-AC-3 support is missing. Unsupported AC-3/E-AC-3 audio becomes stereo AAC in HLS output while video is copied; supported audio is copied. DTS and TrueHD are not converted by this fallback. Production builds and Tizen AVPlay do not use this development path.

This route receives a media URL and creates temporary media output, unlike the identifier-only Play on TV commands. The relay is therefore also required for this browser compatibility fallback, even without a connected TV.
