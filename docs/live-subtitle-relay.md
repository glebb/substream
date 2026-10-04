# Live subtitle relay

The live subtitle relay is an optional service for live channels whose video and DVB subtitles need to share one upstream connection. Tizen AVPlay receives the relayed MPEG-TS media while the service decodes timed DVB subtitle images. Direct browser playback and native AVPlay subtitle tracks remain available independently. The relay is separate from the LAN companion used for browser-to-TV commands and local-file streaming. A relay can run locally for personal testing or as a separately operated hosted HTTPS service; the relay implementation itself does not provision or monitor a hosted service.

The service is implemented under `services/live-subtitle-relay/`; the TV client, settings, and player adapter live under `src/platform/live-relay/` and `src/platform/tizen/`. A platform-independent controller owns bounded retries and fallback. Its tests exercise retry limits, cleanup, and failed teardown; physical AVPlay timing and provider uptime still require device observation.

## Current status

On 2026-10-03, the user accepted a real-TV playback check as good enough for now. The recorded check used a hosted HTTPS relay with the signed personal Tizen 3 app. Sky Showtime 1 was more stable than Sky Showtime 2; delivery gaps and upstream closure affected the latter, with pauses also observed in direct playback. This is a dated acceptance record, not a current service health check, timing measurement, sustained soak, or capacity test. Diagnostics intentionally retain `clock=unverified` until subtitle synchronization is measured.

The implementation includes a three-segment startup reserve, an eight-second AVPlay buffer, acknowledgement of initial playback progress, and up to two automatic relay reconnect attempts before direct fallback. Reconnection opens a new media/subtitle session and causes a visible preparation pause. Initial relay setup failure falls back after cleanup. Failed teardown prevents overlapping replacement playback and requires the viewer to retry after the lease window.

Treat the dated acceptance above as historical evidence only. No current server checks are recorded here. Check the separately maintained [deployment guide](live-subtitle-relay-deployment.md) and confirm its target state before hosted operation; a successful code test or build is not a server health check. A hosted installation should use authenticated HTTPS and the documented host controls. The local LAN instructions below are not a production hosting recipe.

## Local synthetic verification

The tests use generated media and synthetic responses; they do not read `.env`, fetch the private playlist, contact a real provider, or deploy a service.

```sh
npm run relay:test
npm run relay:smoke
npm run relay:local
```

`relay:test` covers the relay service, platform client, protocol, safety limits, decoder, and scheduler using synthetic fixtures. The retry controller and player lifecycle tests are included in `npm run check`. `relay:smoke` sends a generated test pattern through the service's FFmpeg packaging path and checks generated captions. `relay:local` connects a synthetic looping transport stream to the relay and client, checking startup reserve, acknowledgement, segment delivery, subtitle images/cues, Off, heartbeat, and teardown. It binds loopback ports and may require socket access in restricted environments. It removes generated temporary files on completion.

Run `npm run check` and `npm run build:tizen` for the shared code and standard TV bundle. Personal builds use `npm run build:tizen:personal`; the personal launcher reads private settings and credentials from ignored local files. Never display or commit those files, URLs, tokens, or capability-bearing media URLs.

## How the service works

- One authenticated session opens one configured upstream MPEG-TS stream. Browsing channels does not start ingestion.
- FFmpeg copies video/audio and DVB streams into finalized segments. The service decoder extracts subtitle images and publishes caption metadata against the common stream clock.
- The TV acknowledges its initial playhead before the relay releases the pinned startup playlist. This prevents a late initial request from selecting a later segment in the sliding window.
- After playback starts, successful video segment requests renew the video-demand deadline. Status, cue/image polling, playlists, and control heartbeats alone do not keep unused ingestion alive.
- Session close stops FFmpeg, disconnects upstream, and removes temporary files. A lease handles client loss. The service reserves provider capacity until teardown completes.
- Diagnostics contain bounded numeric timing/cache details and fixed error reasons. They must not contain provider URLs, tokens, response text, or media payloads.

Startup reserves the first three completed segments, at least eight seconds total, and uses a separate 30-second preparation deadline. The client must acknowledge startup within 60 seconds. The upstream response-header deadline is 20 seconds; after connection, socket inactivity is limited to 90 seconds. A long provider gap can still exhaust the TV's buffer. Relay retries cannot fix an unavailable or stalled provider feed.

The server has configurable limits for sessions, leases, request sizes, temporary storage, and allowed channels/origins. Channel IDs map to server-owned URLs; clients cannot submit arbitrary source URLs. Production configuration rejects private/internal destination addresses and vets redirect destinations. Keep configuration and credentials outside the checkout. The companion and live subtitle relay are different services with different protocols and data paths.

## Personal Tizen setup

### Automatic personal setup

Existing `.env.live-relay` endpoint/token values are reused. If they select the hosted HTTPS service, building a personal package preserves that endpoint; starting the Mac launcher does not move TV playback to the Mac. For an explicit local test, privately set matching LAN defaults with LAN HTTP opt-in before building.

For a personal build, `npm run relay:personal` starts the local relay and derives channel mappings from provider metadata using private local configuration. The launcher creates/refreshes ignored local files; keep them private and do not print their contents. It does not contact streams during discovery. A provider stream opens only when an active TV session requests a mapped channel.

Build and install with the existing Tizen workflow, then check a channel marked `Multi-Sub`. Personal defaults can route marked channels automatically; stored TV settings take precedence over build defaults, including an explicit opt-out. Unmarked channels retain direct playback unless settings map them. The relay must be reachable from the TV, and the computer must remain awake while it runs.

If manually configuring a local relay, create a private JSON config outside the checkout. The `channels` map assigns stable IDs to direct MPEG-TS URLs owned by the server. The service accepts IDs, not arbitrary client-supplied URLs.

| Field | Meaning and default |
| --- | --- |
| `apiToken` | Required random 32-byte token as 64 lowercase hexadecimal characters |
| `channels` | Required object mapping allowed stable IDs to private source URLs |
| `sessionRoot` | Absolute private temporary directory; default `/tmp/live-subtitle-relay/sessions` |
| `maxSessions` | Concurrent sessions; default 2 |
| `sessionLeaseMs` | Client lease; default 60,000 ms |
| `prepareTimeoutMs` | Stream preparation deadline; default 30,000 ms |
| `maxBodyBytes` | API request body cap; default 8 KiB |
| `allowedOrigins` | Exact permitted origins; default empty. Add `null` only for a widget that actually sends an opaque origin |
| `allowedRedirectHosts` | Redirect hostname allow-list; defaults to configured channel hosts |
| `allowPublicRedirects` | Optional boolean. When enabled, public redirect destinations are still DNS-validated and pinned at every hop |

Run a local server on loopback with `RELAY_CONFIG_FILE=/absolute/path/to/private/config.json npm run relay:dev`. `RELAY_HOST` and `RELAY_PORT` override the default `127.0.0.1:8790`. For a controlled LAN test, bind only where required and permit the TV to reach that host. HTTP requires explicit TV opt-in and exposes credentials to other devices on that network. TLS needs to be trusted by the TV; the app does not bypass certificate errors. Public hosting is supported only as a deliberately configured HTTPS deployment with authentication, restricted channel/origin policy, safe redirects, resource bounds, access-log controls, and operational monitoring; follow the [deployment guide](live-subtitle-relay-deployment.md), not the local command as a production recipe.

For a manually configured TV, open the live-subtitle Settings section, enable it, enter the matching endpoint and device credential, and map provider stream IDs to the server's channel IDs. HTTP needs the explicit LAN opt-in. Save settings before tuning; saved settings override bundled defaults. Mapped channels use relay media independently of the direct HLS/TS toggle.

## Troubleshooting

- **No relay route:** confirm the channel is mapped or automatically marked in this build, relay is enabled, and TV settings have not overridden the build defaults.
- **Authentication/connection failure:** verify the local endpoint and device credential without displaying them, and ensure TV-to-computer connectivity.
- **Initial setup fails:** the client closes the partial session and tries direct playback. Direct fallback may not provide DVB subtitles.
- **The relay fails after playback began:** the TV shows reconnecting, closes the old session, and tries up to twice to establish a fresh one before direct fallback. The change resets the subtitle clock and pauses while preparing.
- **Retry says the previous stream could not stop:** do not start a replacement session yet. Retry cleanup after the server lease expires; this protects a one-connection provider account from overlapping streams.
- **Captions are missing:** verify the selected feed carries active subtitle packets. A channel label or PMT descriptor alone does not show that packets are present.
- **Captions drift or repeat:** `clock=unverified` means the device timing relationship has not been measured. Keep the stream/session diagnostics sanitized and compare several consecutive cues over a sustained physical-TV check.

For general test scenarios, see the [verification guide](verification.md). DVB worker limits and the retired Tizen sideband-scanner rationale are in [embedded live subtitles](live-dvb-subtitles.md).
