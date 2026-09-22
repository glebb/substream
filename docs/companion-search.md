# Web Search and TV playback

Search is part of the normal Substream web app. It works without a TV or LAN relay. Search an imported M3U catalogue stored in the browser, or use an Xtream-compatible `get.php` playlist to refresh and search the provider's full movie and series catalogue. Choosing a result opens the regular title details view.

The standalone companion page has been retired. The optional LAN service is used only to send playback commands from the browser to a TV. It is intended for a trusted home LAN, not as an internet-facing service or production backend.

## Search

- For Xtream, configure the playlist in the web app. Search refreshes catalogue records directly from that browser's configured provider and stores safe metadata in IndexedDB, scoped by an account-aware provider fingerprint. TV registration and the relay are not involved.
- For M3U, Search uses the catalogue already imported into that browser. No TV connection or relay is needed. M3U catalogue refresh/import follows the app's normal playlist workflow.
- Xtream cache records contain safe title metadata and provider identifiers, not credentials or playable stream URLs. The browser can search the saved cache when offline; refresh requires the browser to reach the configured provider.
- Search needs at least two characters. Selecting a movie or series opens the shared details view. Series playback requires selecting a season and episode.
- **Play here** uses the browser's own configured provider. The browser must be able to reach that provider to resolve and play a stream.

## Optional setup for Play on TV

The relay serves the built web application at its root and relay APIs under `/api/*`. You do not need to open the app through the relay to search or play in the browser.

1. Copy `.env.example` to the ignored `.env` file if needed. Set the relay's LAN address for the TV build:

   ```sh
   COMPANION_SERVER_URL=http://192.168.1.50:8787
   ```

2. For personal web development, start the web app and relay together:

   ```sh
   npm run dev:personal
   ```

   The default relay port is `8787`; `COMPANION_PORT` changes it. The service listens on LAN interfaces. `npm run companion:dev` remains available when you need to start the relay by itself.

3. Rebuild and deploy the TV application after changing `COMPANION_SERVER_URL`. Ensure the TV and computer running the relay can reach each other on the LAN.

4. The TV registers its active Xtream source when its playback listener starts and retries automatically if the relay is unavailable. **Settings → TV connection → Connect** remains available to connect manually. The TV renews its session shortly before the 30-minute expiry.

5. In the browser app, open **Settings → TV connection**, enter the relay's LAN address (for example `http://192.168.1.50:8787`), and save it. **Check TV connection** reports whether the relay is reachable, a TV is connected, and its provider matches the browser playlist. During Vite development, leave the address empty to use the `/api` proxy to `localhost:8787`; setting `COMPANION_SERVER_URL` in `.env` makes the proxy target that address instead.

6. Configure the same Xtream provider in the browser app and TV. Open a title's details and choose **Play on TV**. The browser contacts the relay and checks that the TV session is active and its provider matches. If unavailable, Search and **Play here** continue to work.

TV playback requires a reachable relay, an active TV session, and a matching Xtream source. Movies can be sent directly. For series, select an episode first. The TV validates the source and derives the final stream URL from its own saved credentials; the browser does not send stream URLs to the relay.

## Data and security boundaries

| Location | Data held |
| --- | --- |
| TV app | Playlist URL/provider credentials and final stream URLs |
| LAN relay memory | TV's active Xtream credentials and provider records, plus pending playback commands |
| Web browser IndexedDB | Safe Xtream title metadata, content type, provider IDs, source fingerprint, extension/category metadata, and refresh timestamp; imported M3U catalogue data is held by the app's local catalogue store |
| Browser provider connection | The playlist configured in that browser, used to refresh Xtream Search and resolve **Play here** |
| Search/API responses | Catalogue metadata and playback identifiers; no credentials or stream URLs |

When the TV registers, it sends its playlist URL and credentials to the relay, which keeps them in memory for the active session. The relay intentionally has no authentication gate and uses plain HTTP for local development. Keep it on a trusted LAN and do not expose it to the internet. A public service needs HTTPS/WSS, authentication and rate limiting, and secure server-side credential storage. Never print or commit `.env`, playlist URLs, OpenSubtitles credentials, tokens, or signed media URLs. Tests use synthetic catalogue fixtures only.

## Troubleshooting

- **Xtream Search is empty:** confirm a valid Xtream playlist is configured in the browser app, then refresh the catalogue. Search does not use the TV's provider session.
- **M3U Search is empty:** import the playlist in that browser app and check that the local catalogue contains searchable entries.
- **Search works offline but looks stale:** reconnect the browser to its configured provider and refresh the Xtream catalogue.
- **Play here fails:** confirm the browser can reach its configured provider and that the selected title belongs to it.
- **Play on TV is unavailable or fails:** confirm the relay address is correct, the relay and TV are online, the TV listener has registered, and the browser and TV use the same Xtream account/source. Guest Wi-Fi, client isolation, or a firewall can block LAN traffic.
