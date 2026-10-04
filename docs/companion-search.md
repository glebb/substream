# Search and optional TV companion

Search belongs to the app and works without a TV, relay, or companion service. It searches the imported M3U catalogue on this device and, for an Xtream-compatible playlist, can refresh and search the provider's movie and series catalogue. Choosing a result opens the same details and playback flow used by browsing.

On TV layouts, Search is a browse tab and all essential controls have a D-pad route. Focus the Search title control and press Enter to edit; Back leaves the editor. From the editor, Down reaches refresh, then the first result. Up returns toward the Search tab. The red Samsung key is an optional shortcut elsewhere in the app and is not needed to use Search.

## Catalogue search

- **Imported M3U:** Search queries titles already stored in the app's local catalogue. Import or replace the playlist through the normal app flow to update it. Search does not fetch or upload the playlist itself.
- **Xtream:** Search can refresh categories and title metadata using the playlist configured in this app. Results and cached records are scoped to an account-aware provider fingerprint.
- Cached Xtream records contain safe display metadata and provider identifiers. They omit credentials and playable stream URLs. A cached search works offline; refresh and playback need access to the configured provider.
- Search begins after two characters. Series results require choosing an episode before playback.
- **Play here** resolves the provider stream using this app's own playlist and player. The provider must be reachable from this device.

The VOD app uses runtime contracts for catalogue, preferences, transport, and playback. Platform code supplies the actual storage and network implementations, and the current playback factory still has browser DOM surface requirements. These boundaries let another platform reuse application behavior while keeping device-specific APIs in adapters.

## Optional companion service

Ordinary browsing, Search, and direct playback are independent of the companion. The service is an optional LAN helper for pairing a browser with a TV, sending identifier-based TV playback commands, staging a browser-selected local file for TV playback, and a development-only browser MKV audio fallback. It is not the app's catalogue or a required backend. Search always uses the app's own provider connection.

The TV companion listener is app-scoped, so connection state and incoming commands survive navigation between screens. On a TV, enable or disable it under **Settings → TV connection**. Without the companion, direct provider playback remains available; browser-to-TV commands and computer-hosted local-file playback require the paired TV and service. Local files can still play in the browser without it.

The browser, TV, and service must support companion protocol v4 for local-file sessions. Provider commands include identifiers and display metadata; the TV verifies the provider fingerprint and constructs its own stream URL from its saved playlist. Local playback uses an authenticated file session and short-lived media ticket instead. The service does not receive provider stream URLs for normal TV provider playback.

## Set up pairing for Play on TV

For personal web development, start the app and LAN companion together:

```sh
npm run dev:personal
```

This opts into LAN binding. Without TLS certificate/key settings, the command warns that credentials travel over plain HTTP. For a standalone companion service, `npm run companion:dev` binds to `127.0.0.1`; pass `--lan` or set `COMPANION_LAN=1` to allow other LAN devices to connect. `COMPANION_PORT` changes the default port 8787, and `COMPANION_HOST` selects the LAN bind address. `COMPANION_ALLOWED_ORIGINS` is a comma-separated exact-origin allow-list; development defaults are Vite's localhost origins.

To use HTTPS for a LAN test, create a local certificate with `npm run companion:cert -- <LAN-IP-or-hostname>`, configure `COMPANION_TLS_CERT` and `COMPANION_TLS_KEY` to the generated local files, and set the matching `https://` companion address for the TV build. The TV/browser must trust the certificate; the app does not bypass certificate errors. Private certificate and key files stay local and are ignored by Git.

On the TV, open **Settings → TV connection**, enable the companion, and connect to the computer's service address. The TV displays a one-time code. In the browser app, enter the same service address and code under **Settings → TV connection**, choose **Pair browser**, then select a named device under **Playback target**. Pair each TV separately. Browser credentials are held in page memory; TV identity and its scoped renewal credential are stored locally. A companion restart loses in-memory sessions, so reconnect or pair again if the session was not restored.

For Vite development, an empty service address uses the `/api` proxy. `COMPANION_SERVER_URL` can target a different LAN service. Configure the TV build's companion address before packaging if the TV should connect automatically; rebuild and install the TV app after changing bundled defaults. The browser/TV companion described here is a trusted-LAN helper; this project does not document it as a public hosted service. Without TLS, another device on the LAN may observe credentials. Hosted HTTPS operation in the [live subtitle relay guide](live-subtitle-relay.md) applies to that separate relay service, not to companion pairing.

## Browser MKV audio

During local browser development only, the companion can prepare a remote H.264 MKV for browser playback when AC-3/E-AC-3 audio support is missing. Run `npm run dev:personal` with `ffmpeg` and `ffprobe` available. Unsupported AC-3/E-AC-3 audio becomes stereo AAC while video is copied when compatible. DTS and TrueHD are not converted by this fallback. Production builds and Tizen AVPlay do not use this browser compatibility path; local-file TV preparation is a separate flow.

For local-file ownership, quotas, supported media preparation, and troubleshooting, see [local file playback](local-file-playback.md). For relay setup and protocol verification, see the [live subtitle relay guide](live-subtitle-relay.md) and [verification guide](verification.md).

## Troubleshooting

- **Search has no M3U results:** import the playlist in this app and confirm that the local catalogue contains VOD titles.
- **Xtream Search is empty or stale:** confirm an Xtream-compatible playlist is saved, refresh the provider catalogue, and verify that this device can reach the provider.
- **Play here fails:** confirm provider access from this device and that the title belongs to its configured provider.
- **The TV connection is unavailable:** confirm the companion service is running, the TV and computer can reach one another on the LAN, and the TV has enabled the companion setting. Client isolation or a firewall may block LAN traffic.
- **TV playback rejects a provider title:** confirm the TV and browser use the same Xtream account/source and that the TV listener has reconnected. Browser and TV provider streams are resolved independently.
