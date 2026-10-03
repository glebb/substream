# Live subtitle relay

The implementation includes a standalone relay service, a Tizen AVPlay adapter with a PNG overlay, and a platform-independent cue scheduler. Personal Tizen builds automatically route channels whose titles contain `Multi-Sub` through the relay; standard/public builds leave it disabled unless configured. Other channels retain direct playback. This service is separate from the trusted-LAN VOD/local-file companion.

## Current status — 2026-10-03

The user tested Sky Showtime 1 and 2 on a real TV and accepted the local result as good enough for now. Showtime 1 was more stable; Showtime 2 had delivery gaps and upstream closures, with pauses also observed in direct playback. This is practical acceptance of the local implementation, not a measured timing or long-running stability certification. Diagnostics still correctly report `clock=unverified`.

Implemented fixes include a three-segment startup reserve, an eight-second AVPlay buffer, forwarding live progress when duration is zero, retried playback acknowledgement, separate connection/body timeouts, and two automatic relay reconnect attempts before direct fallback. The initial relay killed an idle upstream after 20 seconds; this was fixed. A subsequent failure was logged as `upstream-ended`, confirming that the incoming response ended rather than reaching the new 90-second idle limit. Reconnects prepare a new session and include a playback pause; no seamless recovery is claimed.

The latest code passed `npm run check` (504 tests) and `npm run build:tizen:personal`. Synthetic packaging and full local-pipeline checks also passed during implementation. No dedicated UI lifecycle test covers the new reconnect flow; it was reviewed and typechecked, and the user's final local assessment was positive. Public deployment has **not** happened. Continue with the [deployment handoff](live-subtitle-relay-deployment.md) in a fresh session.

## Test locally on this computer

Use the project's Node runtime (22.18+ native TypeScript support; the deployment image uses Node 24) and FFmpeg with libx264. No provider configuration or Docker is needed for the synthetic tests.

```sh
npm run relay:test
npm run relay:smoke
npm run relay:local
```

`relay:test` covers the protocol, session API, safety boundaries, decoder and scheduler using synthetic fixtures. `relay:smoke` generates a 12-second test-pattern video with audio and DVB pages, pipes it through the exact FFmpeg packaging arguments used by the service, then checks PNG output and display/clear times at 2/4/6/8 seconds.

`relay:local` runs the complete pipeline on loopback ports: a looping synthetic HTTP source, the real relay/FFmpeg worker, and the actual client adapter. It checks authentication, single upstream connection, the pinned three-segment startup playlist, playback acknowledgement and rolling handoff, segment delivery, subtitle images and cues, track off, heartbeat, and teardown. Preparation can take tens of seconds; the smoke check allows up to 35 seconds for ready state and cues. It stops both servers and removes temporary files automatically. Random access credentials stay in memory and are never printed. Loopback ingestion is injected only in this test; production destination restrictions remain enabled.

In environments that prohibit listening sockets, `relay:local` requires permission to bind loopback ports. Ordinary unit tests do not bind ports. Nothing in these commands downloads the private playlist, contacts the provider, or deploys a service.

## Implementation

- `services/live-subtitle-relay/`: private configuration, authenticated HTTP session API, a single upstream connection piped to FFmpeg stdin, finalized MPEG-TS segment processing, timed DVB images, bounded storage and lease cleanup.
- `src/core/live-relay/`: versioned protocol and cue scheduling against an explicitly supplied playback anchor. No arrival-time or wall-clock synchronization guesses.
- `src/core/subtitles/live-dvb-ts-scanner.ts`: reusable transport scanner. The browser module re-exports it to preserve existing integrations.
- `src/platform/live-relay/`: saved endpoint/device configuration, session requests, status/track/heartbeat APIs, capability image URLs, and serial polling. Chromium 47 uses abortable finite XHR requests when AbortController is unavailable.
- `src/platform/tizen/live-relay-player.ts`: relay session lifecycle, AVPlay playback, language selection, bounded image preloading/cache, and a body-mounted subtitle overlay above the native video plane.
- Tizen Settings: endpoint, hidden device credential, provider-stream-to-relay-channel mappings, explicit local HTTP opt-in, provisional timing offset, and diagnostics.

FFmpeg's HLS muxer tried to send copied DVB captions to a WebVTT muxer and rejected them in the local experiment. The service instead uses its MPEG-TS segment muxer with an M3U8 segment list, which preserved the synthetic DVB stream. Video and audio are copied without encoding in the relay. Only the synthetic test-pattern generator encodes video.

Cue times are relative to the first output video PTS in each epoch. The relay prepares the first three completed segments (at least eight seconds total), then pins that initial live playlist until the app acknowledges AVPlay's first progress event. The relay AVPlay adapter requests an eight-second play/resume buffer. An unacknowledged startup expires after 60 seconds; stream preparation retains its separate 30-second limit. This prevents a late initial request from silently choosing a later sliding-window segment and provides headroom for live segment publication. Positive timing offsets display captions later. A discontinuity hides captions until a fresh session rather than guessing a new clock mapping.

Upstream response headers have a separate 20-second deadline. Once connected, the live stream has a 90-second socket inactivity timeout; the connection deadline must not terminate an already-playing stream during a provider delivery gap. Relay status logs include `inputIdleMs` (time since upstream bytes arrived) and a fixed `reason` on worker failure, distinguishing upstream idle timeout, upstream errors/end, FFmpeg failure, and storage limits. These diagnostics never contain provider URLs or raw network errors. Longer source gaps can still exhaust the TV buffer even when the relay connection remains alive.

After relay playback has begun, a relay failure triggers up to two automatic reconnect attempts for the selected channel before direct fallback. The app closes the old session before opening a fresh relay and resets its playback/subtitle clock; the TV shows `Subtitle relay · Reconnecting…` during recovery. Changing channel or pressing Retry starts a new attempt budget. A teardown failure stops recovery rather than opening overlapping connections. Initial setup failures still fall back directly. Direct fallback skips the extra TS audio-language probe to avoid a second provider connection. This recovery needs an updated TV build and still includes a pause while the new relay prepares; it cannot repair an unavailable upstream channel.

FFmpeg's output interleave queue is capped at one second to reduce waiting for sparse DVB subtitle packets; its default limit is ten seconds. See the [FFmpeg `max_interleave_delta` documentation](https://ffmpeg.org/ffmpeg-formats.html). Video, audio, and DVB streams remain copied. This setting does not prevent upstream delivery gaps or prove that all chunk delays are gone. Startup takes longer to establish the reserve; buffering diagnostics expose `bufferEvents` to assess recurring stalls on the TV.

## Run with private channel configuration

For a later manual provider check, create a private JSON configuration outside the checkout. Its fields are:

| Field | Value |
| --- | --- |
| `apiToken` | A random 32-byte credential encoded as 64 hexadecimal characters |
| `channels` | Object mapping stable channel IDs to private direct MPEG-TS URLs |
| `sessionRoot` | Dedicated absolute temporary-session directory; default under `/tmp/live-subtitle-relay/` |
| `maxSessions` | Default 2 |
| `sessionLeaseMs` | Default 60000 |
| `prepareTimeoutMs` | Default 30000 |
| `allowedOrigins` | Explicit browser origins allowed to use the API; `"null"` only when explicitly needed for an opaque widget origin |
| `allowedRedirectHosts` | Explicit provider/CDN hosts permitted during redirects; defaults to configured channel hosts |
| `allowPublicRedirects` | Default false; true permits rotating public CDN hosts without a hostname list, with public-DNS validation and pinning on every hop |
| `maxBodyBytes` | Maximum API request body; default 8192 bytes |

Keep the file private and never include it in source control, logs, screenshots, or public build assets. API calls use the device credential as bearer authorization; AVPlay media and image URLs use short-lived session capabilities. Production ingestion rejects nonpublic destinations and pins vetted DNS addresses. The service accepts channel IDs, not arbitrary client-supplied URLs.

```sh
RELAY_CONFIG_FILE=/absolute/path/to/private/config.json npm run relay:dev
```

It binds `127.0.0.1:8790` by default. `RELAY_HOST` and `RELAY_PORT` override that binding. Use HTTPS when exposing it beyond local development. A live source connection exists only while a session is active; callers must renew the lease, and close sessions when leaving playback. Logs contain fixed status messages and safe errors only.

## Deployment preparation

`deploy/live-subtitle-relay/` contains a Dockerfile, an allowlisted build context, Compose configuration, and Caddy HTTPS proxy. It is preparation for the later hosted deployment, not an already deployed service. It uses a separate secret-mounted JSON file, an unprivileged relay process, a bounded temporary filesystem, private internal networking, resource limits, and no request access logging.

Provide `RELAY_DOMAIN`, `RELAY_CONFIG_PATH`, and a versioned `RELAY_IMAGE_TAG` through the deployment environment. Compose must run from `deploy/live-subtitle-relay/`, with the private configuration stored outside the checkout. Reuse an existing ingress proxy rather than starting a competing Caddy if the host already serves ports 80/443. Resolve and pin the Node/Caddy image digests and FFmpeg package version for the actual release; the checked-in defaults use major-version development tags.

The container expects session data under `/tmp`, which is a 256 MiB temporary filesystem. The server config must use that location with the supplied Compose file. The secret file must be readable by container UID 1000, while remaining private on the host; verify its ownership or ACL rather than making it publicly readable. Certificate state is persisted in dedicated Caddy volumes. Container image build and physical-TV certificate trust remain release checks.

## Test the Tizen integration against this Mac

### Automatic personal setup

Your existing `.env` provides the IPTV account. Run:

```sh
npm run relay:personal
```

This creates a gitignored, owner-readable `.env.live-relay` with this Mac's LAN address and a persistent random device token, discovers **all** provider live channels whose titles contain `Multi-Sub`, and starts the server on port 8790. It regenerates the private channel allowlist at `.live-subtitle-relay/config.json` each time it starts. Discovery requests metadata only; live streams open when the TV starts a playback session. Keep this command running and the Mac awake while testing. Ctrl+C stops it.

Personal mode follows provider redirects to rotating public CDN hosts automatically. Every destination is DNS-checked and pinned; private/internal destinations are still rejected. There is no CDN hostname whitelist to maintain. An explicit `LIVE_SUBTITLE_RELAY_REDIRECT_HOSTS` override opts back into a fixed host policy. The foreground server prints credential-free lifecycle events to distinguish TV connectivity/authentication, stream preparation, and playback acknowledgement.

On the TV, diagnostics show `progress=local` and `ack=confirmed` when the native live playhead has been received and the relay has released its startup playlist. Live AVPlay may report duration zero; the adapter still forwards its playhead. A changing `playheadMs` is the playback clock used for captions; `clock=unverified` remains until hardware subtitle synchronization has been measured.

Build the TV app with:

```sh
npm run build:tizen:personal
```

The same settings are also embedded by `prepare:tizen3:personal`, `prepare:tizen6:personal`, and personal packaging commands. Install/sign using the existing Tizen workflow. Matching channels automatically select relay playback; you do not enter an address, credential, or mappings on the TV. The `stream-<provider ID>` naming rule is shared with server discovery. Unmarked channels retain direct playback. The settings screen still permits explicit overrides or disabling the relay.

`.env.live-relay.example` documents optional overrides. The real `.env.live-relay` and generated JSON contain private credentials and stay out of Git and public builds. Personal TV bundles contain the device credential by design, just like the other personal defaults. Stored relay settings on a TV override build defaults, including an explicit opt-out; a previous manual override therefore remains effective.

The following steps apply to manually configured or hosted installations instead of the automatic personal setup.

1. Put one permitted direct MPEG-TS channel in the private server configuration under a stable ID such as `sky-fi`. Set `allowedOrigins` to the TV widget's actual origin; add `"null"` only if that widget sends an opaque origin. Keep the private configuration outside the checkout.
2. Run `RELAY_HOST=0.0.0.0 RELAY_CONFIG_FILE=/absolute/path/to/private/config.json npm run relay:dev`. Keep the Mac awake and permit the TV to reach port 8790 on the trusted local network. This foreground process stops when you stop the command.
3. Build/install the app with the existing Tizen workflow. In Settings, enter `http://<Mac-private-IPv4>:8790`, explicitly allow local HTTP, enter the server's device credential, and map the provider's stream ID to `sky-fi`, for example `{ "123": "sky-fi" }`. The numeric provider ID must be the actual channel ID from the app's catalogue; the example is synthetic.
4. Enable hosted live subtitles, save, and open that channel. Mapped channels use the relay regardless of the direct HLS/TS source toggle. The playback label shows `Subtitle relay · Timing test`. Unmapped channels retain direct playback. Initial setup failure closes the session before direct fallback; failure after playback begins uses the bounded reconnect flow above.
5. Check Finnish/English switching and Off, PNG placement in normal/fullscreen display, lip-sync over several minutes, buffering, channel changes, and Retry. Compare visible captions with dialogue and use the provisional offset only for a stable measured difference. Diagnostics contain numeric timing/cache information and no media URL or credential.

HTTP is for this explicit local test. The public deployment uses HTTPS. The Mac test still ingests the provider's public MPEG-TS URL; production ingestion restrictions are preserved. Real-TV tests have demonstrated playback and subtitle display, but the automated synthetic test does not establish AVPlay timing, caption placement on every device, long-running stability, or public HTTPS certificate trust.

The [implementation plan](live-subtitle-relay-plan.md) records completed work and remaining rollout checks. The [deployment handoff](live-subtitle-relay-deployment.md) is the starting point for the next session.
