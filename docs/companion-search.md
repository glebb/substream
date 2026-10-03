# Web Search and TV playback

Search is part of the normal Substream web app. It works without a TV or LAN relay. Search an imported M3U catalogue stored in the browser, or use an Xtream-compatible `get.php` playlist to refresh and search the provider's full movie and series catalogue. Choosing a result opens the regular title details view.

The normal app provides Search; there is no separate companion page. The optional LAN service handles on-demand TV playback commands, provider-free local-file staging/streaming with external subtitle transfer, a browser-only CORS bridge for the public Nordic guide, and the development-only browser MKV audio fallback. Provider browsing and normal IPTV playback remain local to each app. Packaged Tizen fetches the Nordic guide directly and falls back to provider guide data if it fails. It is intended for a trusted home LAN, not as an internet-facing service or production backend.

## Search

- For Xtream, configure the playlist in the web app. Search refreshes catalogue records directly from that browser's configured provider and stores safe metadata in IndexedDB, scoped by an account-aware provider fingerprint. TV registration and the relay are not involved.
- For M3U, Search uses the catalogue already imported into that browser. No TV connection or relay is needed. M3U catalogue refresh/import follows the app's normal playlist workflow.
- Xtream cache records contain safe title metadata and provider identifiers, not credentials or playable stream URLs. The browser can search the saved cache when offline; refresh requires the browser to reach the configured provider.
- Search needs at least two characters. Selecting a movie or series opens the shared details view. Series playback requires selecting a season and episode.
- **Play here** uses the browser's own configured provider. The browser must be able to reach that provider to resolve and play a stream.

## Optional setup for Play on TV

The relay serves the built web application at its root. It does not serve catalogue or search APIs: browser search connects directly to the provider configured in the web app. Relay APIs include paired TV commands, bounded local media upload/range streaming, ticket-scoped local subtitles, the public Nordic guide CORS bridge, and the development-only browser MKV audio fallback. You do not need to open the app through the relay to search or play in the browser. The browser, TV app, and relay must use the same companion protocol v4 for local-media capabilities.

1. Copy `.env.example` to the ignored `.env` file if needed. Set the relay's LAN address for the TV build. Use `http://` for the simple trusted-LAN setup, or `https://` when TLS is enabled:

   ```sh
   COMPANION_SERVER_URL=http://192.168.1.50:8787
   ```

   To create a self-signed certificate for a LAN IP or hostname, run `npm run companion:cert -- 192.168.1.50` (OpenSSL is required). Before starting the dev stack, set `COMPANION_TLS_CERT=.companion-certs/companion-cert.pem`, `COMPANION_TLS_KEY=.companion-certs/companion-key.pem`, and change `COMPANION_SERVER_URL` to the matching `https://` address. `NODE_EXTRA_CA_CERTS=.companion-certs/companion-cert.pem` lets Node-based Vite proxy requests trust that certificate. The certificate must also be trusted by the TV/browser; TLS errors are not bypassed by the app. The generated key is local-only and the `.companion-certs/` directory is ignored by Git.

2. For personal web development, start the web app and relay together:

   ```sh
   npm run dev:personal
   ```

   This development command opts into LAN mode. Without TLS certificate/key settings, it prints a warning because credentials travel over plain HTTP. The standalone `npm run companion:dev` binds to `127.0.0.1` by default; pass `--lan` (`node scripts/companion-server.mjs --lan`) or set `COMPANION_LAN=1` to expose it on LAN interfaces. `COMPANION_PORT` changes the default port `8787`, and `COMPANION_HOST` can select the LAN bind address when LAN mode is enabled. `COMPANION_ALLOWED_ORIGINS` is a comma-separated exact-origin allow-list; it defaults to Vite's `http://localhost:5173` and `http://127.0.0.1:5173` origins.

3. Rebuild and deploy the TV application after changing `COMPANION_SERVER_URL`. Ensure the TV and computer running the relay can reach each other on the LAN.

4. The TV registers its Xtream source under a stable random device identity when its playback listener starts and retries automatically if the relay is unavailable. Its renewal credential is stored locally per relay, so normal renewal preserves the current browser pairing. **Settings → TV connection** lets you name the TV, connect manually, or reset browser pairing to issue a fresh eight-digit one-time code. A TV without an IPTV playlist can connect with the local-media capability and receive local files. Codes expire in five minutes; TV sessions renew before their 30-minute idle expiry.

5. In the browser app, open **Settings → TV connection**, enter the relay's LAN address, enter a display name and the current TV code, then choose **Pair browser**. Repeat for each TV. The **Playback target** selector chooses which named TV receives commands. Pairing credentials stay in page memory; after a browser reload, reset pairing from the TV and pair again. During Vite development, leave the address empty to use the `/api` proxy to `localhost:8787`; setting `COMPANION_SERVER_URL` in `.env` makes the proxy target that address instead.

6. For provider titles, configure the same Xtream provider in the browser app and TV. Open a title's details and choose **Play on TV**. The paired browser checks the active TV session and that its provider matches. For local media, open a file from the browser home page, pair from **TV settings and pairing** on its details page, then choose **Play on TV**. The browser stages bounded chunks on the companion computer, prepares a TV-compatible copy when needed, and dispatches a short-lived ticket; the TV reports preparing/playing/paused/ended/failed/stopped states. Local-media pairing does not require a playlist on either device. Subtitle attachments, on/off state, and timing offset follow the active session. If unavailable, catalogue Search and **Play here** continue to work.

Provider TV playback requires a reachable relay, an active TV session, and a matching Xtream source. Movies can be sent directly. For series, select an episode first. The TV validates the source and derives the final stream URL from its own saved credentials; the browser does not send provider stream URLs to the relay. Local TV playback instead streams the selected file from the computer over the LAN; the companion uses ffprobe and ffmpeg to prepare an indexed MP4 before dispatch. Compatible 8-bit H.264 up to 1080p/30 fps, Level 4.1 and 20 Mbps aggregate bitrate is copied without re-encoding. The 5 Mbps ceiling applies only when encoding incompatible video. Compatible H.264 MP4 files with AAC stereo or E-AC-3 up to 5.1 channels are served directly; other containers are remuxed. Compatible video and audio are copied independently, preserving E-AC-3 surround and Atmos metadata. Atmos playback depends on the TV/audio system. Incompatible video (including 10-bit HEVC) becomes H.264 High Level 4.1, at most 1920×1080/30 fps with a 5 Mbps video ceiling; unsupported audio becomes stereo AAC. Aspect ratio is preserved. Mac computers try VideoToolbox hardware encoding with a software fallback. Preparation can take several minutes; it is cancellable, and the completed copy is reused during the session. The computer needs ffmpeg and ffprobe on PATH (or FFMPEG_PATH/FFPROBE_PATH). The TV buffers ten seconds before local playback and after rebuffering. This avoids encoding stalls during playback; actual TV smoothness still needs hardware verification.

## Data and security boundaries

Packaged TV `file://` and opaque `null` origins are accepted only for TV registration, event polling, acknowledgement, pairing reset, and ticket/credential-protected local playback routes. Browser pairing, commands, uploads, and conversion routes retain their configured browser origin allow-list. An origin identifies a request context, not a device; existing TV sessions still require their scoped TV credential.

| Location | Data held |
| --- | --- |
| TV app | Playlist URL/provider credentials, stable opaque TV identity, relay-scoped TV renewal credential, and final stream URLs; normal TV features remain local to the TV app |
| LAN relay memory | Up to 16 named TV identities, scoped session credentials, and per-TV pending identifier-only playback queues; sessions are not persisted across relay restarts |
| LAN relay temporary storage | Private per-process upload files for local TV sessions; default quota is two active sessions and 100 GiB total staged media and prepared copies, adjustable with `COMPANION_LOCAL_MEDIA_MAX_BYTES`; abandoned/idle/ended sessions expire and explicit stop deletes staged data |
| Web browser IndexedDB | Safe Xtream title metadata, content type, provider IDs, source fingerprint, extension/category metadata, and refresh timestamp; imported M3U catalogue data is held by the app's local catalogue store |
| Browser provider connection | The playlist configured in that browser, used to refresh Xtream Search and resolve **Play here** |

The TV derives an account-aware fingerprint locally from its Xtream playlist and registers only that fingerprint for provider commands. The relay retains no provider username, password, playlist URL, or stream URL. Provider browser commands contain provider identifiers and display metadata; the TV validates the fingerprint and derives its stream URL locally. Local-media commands use a separate paired capability and an opaque media session. Uploads are chunked to private temporary files and never place a path or blob URL in the browser command. Media and subtitle endpoints authorize the paired device with a short-lived ticket; range requests support seeking. Stop, TV lease expiry, and inactivity clean up staged data. Each TV has its own scoped credentials and command queue; pairing one TV does not replace another. TV identity and renewal credentials are held in app local storage, which is not encrypted at rest; browser display labels are also local, while browser bearer tokens remain in page memory. Pairing/session state is held in relay memory, so a relay restart creates fresh sessions and requires browser re-pairing. TLS is optional for this development service. When configured with a certificate/key, the relay supports self-signed certificates, but clients must trust them; without TLS, pairing codes and bearer credentials are visible on the LAN. Keep the service on a trusted network and do not expose it to the internet. Never print or commit `.env`, private keys, playlist URLs, OpenSubtitles credentials, tokens, or signed media URLs. Tests use synthetic fixtures only.

## Troubleshooting

- **Connect appears to do nothing:** manual Connect now shows progress even when automatic registration is pending. Registration and pairing reset have a ten-second deadline, including on Tizen 3 without AbortController; an unreachable relay produces a visible error and can be retried. Rebuild/sign/install the TV app to receive this client fix.
- **TV Connect shows a generic error:** restart `npm run dev:personal`, press Connect on the TV, and inspect the terminal's `[companion-connect]` line. It reports only protocol/capability flags, whether a saved credential was supplied, HTTP status, and a fixed outcome; it never logs credentials or provider details. `protocol-mismatch` means the TV app and relay need matching builds; `saved-pairing-rejected` means the running relay cannot authorize the TV's saved session; `origin-rejected` means the app origin is outside the configured allow-list. A `connected` result with a TV error points to client response validation or stale installed assets. No line means the POST did not reach this relay; check the address, network access, and preflight handling.
- **Xtream Search is empty:** confirm a valid Xtream playlist is configured in the browser app, then refresh the catalogue. Search does not use the TV's provider session or relay APIs.
- **M3U Search is empty:** import the playlist in that browser app and check that the local catalogue contains searchable entries.
- **Search works offline but looks stale:** reconnect the browser to its configured provider and refresh the Xtream catalogue.
- **Play here fails:** confirm the browser can reach its configured provider and that the selected title belongs to it.
- **Play on TV is unavailable or fails:** confirm the relay address is correct, the relay and TV are online, the TV listener has registered, and the browser and TV use the same Xtream account/source. Guest Wi-Fi, client isolation, or a firewall can block LAN traffic.

## Browser MKV audio

For local browser development, install `ffmpeg` and `ffprobe` on PATH and run `npm run dev:personal`. The browser can ask the relay to prepare H.264 MKVs when AC-3/E-AC-3 support is missing. Unsupported AC-3/E-AC-3 audio becomes stereo AAC in HLS output while video is copied; supported audio is copied. DTS and TrueHD are not converted by this fallback. Production builds and Tizen AVPlay do not use this development path.

This route receives a media URL and creates temporary media output, unlike the identifier-only Play on TV commands. The relay is therefore also required for this browser compatibility fallback, even without a connected TV.
