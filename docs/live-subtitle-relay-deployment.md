# Live subtitle relay deployment handoff

Updated 2026-10-03. The service is deployed at `https://subtitles.displayofpatience.com` using native systemd, Node 24.21.0, FFmpeg and the existing Nginx on Ubuntu 24.04.3. **Hosted media/subtitles now pass through cloud-only Mullvad egress:** Finnish Showtime 1 produced four subtitle tracks and PNG captions, and the production HTTPS session/media/authentication/acknowledgement/off/deletion check passed. Direct server egress still receives HTTP 456 despite verified credentials; the Finnish `fi-hel-wg-101` route resolves it. Only the relay UID uses WireGuard; IPv4/IPv6 direct fallback is blocked, and root/deploy/HTTPS routes stay on the original server connection. Account capacity is one provider connection. See [current operations, private config refresh and rollback](../deploy/live-subtitle-relay/OPERATIONS.md). The personal Tizen 3 HTTPS package is signed and collected at `tizen/Debug/tizen3.wgt`; both signature files and every fresh bundled asset were verified. The package was installed successfully on the configured Tizen 3 TV after explicit approval to clear saved data. Remote launch was rejected; open Substream from the TV Apps screen. On 2026-10-03 the user confirmed that the hosted relay works on Tizen, establishing basic HTTPS trust and playback on the installed TV. The Mac relay was stopped and verified to have no processes or listener on port 8790. A sustained soak and measured subtitle timing remain unrecorded. The server now runs the `20261003-demand-guardrails` release: a 60-second segment-demand deadline prevents control heartbeats from keeping unused ingest alive, and teardown reserves provider capacity until the worker stops. All 509 tests and synthetic FFmpeg lifecycle checks on Mac/server passed; the previous release is retained.

The following is the original deployment preparation context, retained for the remaining TV rollout. The user has a server, permits deployment preparation, confirms provider permission, and accepted local real-TV behavior as good enough for now. The next session should continue with server deployment rather than restart the TV-side subtitle investigation.

## Start here

Read [current implementation/local setup](live-subtitle-relay.md), [implementation status and plan](live-subtitle-relay-plan.md), [Tizen packaging](../tizen/README.md), and [verification](verification.md#hosted-live-subtitle-relay). Inspect applicable `AGENTS.md` instructions and current Git changes before editing. The working tree contains the implementation and other uncommitted work; preserve it. Earlier implementation used Luna subagents at the user's request.

The user wanted automatic personal builds: all titles marked `Multi-Sub` use the relay, with no TV address/token/mapping entry. Preserve that behavior for the hosted endpoint. A VPS should be available continuously, but ingest occurs only during active viewing sessions. Do not deploy the trusted-LAN VOD companion as this public service.

## Local state to carry forward

- `npm run relay:personal` runs the Mac subtitle server on port 8790. It uses existing private `.env` IPTV configuration, persistent `.env.live-relay` defaults, and regenerates `.live-subtitle-relay/config.json` from provider metadata. The last discovery found 86 Multi-Sub entries; this count is an observation, not a constant.
- `.env.live-relay` and generated JSON are ignored and private. Never print their contents, URLs, tokens or capabilities. Personal TV bundles embed the device token by design; standard/public bundles must not.
- `npm run build:tizen:personal` produced the latest Tizen payload. Signing/installing uses the existing Tizen workflow; a web build alone is not an installable signed package. Do not claim a TV installation from a successful build.
- Latest check: 504 tests passed, typechecking passed, personal Tizen build passed. Synthetic packaging and full local-pipeline smoke checks passed during implementation. Re-run affected checks after deployment changes.
- Real-TV captions/playback worked; Showtime 1 was more stable than 2. Source delivery gaps and an `upstream-ended` response caused failures on 2, and direct playback also stopped. The 20-second live body timeout bug was fixed to a separate 20-second header deadline and 90-second socket idle timeout.
- Three-chunk startup reserve, eight-second TV buffer and two automatic relay reconnect attempts are implemented. Each reconnect resets the media/subtitle session, so it includes a preparation pause. The final user assessment was “works good enough for now.” Measured synchronization and a long soak remain unrecorded; `clock=unverified` is intentional.
- Host inventory, DNS, certificate provisioning and native deployment are now complete; see the operations guide. Docker is absent and was not needed. Hosted provider playback passed through Mullvad and the user confirmed hosted playback on Tizen. A sustained soak and measured timing remain outstanding.

## Existing artifacts

| File | Current role |
| --- | --- |
| `services/live-subtitle-relay/main.ts` | Standalone Node entry point, sanitized lifecycle logging and shutdown |
| `services/live-subtitle-relay/config.ts` | Private JSON validation; default two sessions and 60-second lease |
| `scripts/live-relay-personal.ts` | Provider metadata discovery, private local server configuration and startup |
| `scripts/live-relay-personal-config.ts` | Personal endpoint/token defaults shared by launcher and TV build |
| `.env.live-relay.example` | Non-secret names for endpoint, token, bind and origin overrides |
| `deploy/live-subtitle-relay/Dockerfile` | Node 24 development base, FFmpeg, non-root UID 1000; no npm runtime dependencies |
| `deploy/live-subtitle-relay/Dockerfile.dockerignore` | Allowlisted service/core build context excluding private JSON, env and playlists |
| `deploy/live-subtitle-relay/compose.yaml` | Relay plus optional Caddy, runtime config secret, no exposed relay port, limits and healthcheck |
| `deploy/live-subtitle-relay/Caddyfile` | Domain HTTPS reverse proxy with request access logging absent |

The default images are development tags (`node:24-bookworm-slim`, `caddy:2`); FFmpeg is installed without a version pin. Pin images/package versions for the actual release. The relay image copies only server code and shared core, not personal client bundles or the private channel config.

## Original preparation checklist (host information now obtained)

Obtain server OS and CPU architecture, available CPU/RAM/disk, Docker/Compose or other runtime, existing HTTPS reverse proxy/ports, desired hostname and DNS control, intended simultaneous TVs, and the user's authorized deployment access method. Credentials remain outside chat. Reuse an existing ingress proxy rather than taking its ports 80/443 with a second Caddy.

## Original deployment sequence (use native operations for the deployed host)

1. Inspect the host and choose a dedicated HTTPS hostname. Confirm DNS and server egress to the provider/CDN. Determine whether the existing proxy or supplied Caddy will terminate TLS; test Tizen trust early.
2. Build and tag a release image, with pinned dependencies and architecture matching the server. Verify the allowlisted context and run synthetic tests. Keep a previous known release for rollback; for the first deployment, retain the accepted local setup as the fallback.
3. Generate/update a private hosted configuration outside the checkout using `stream-<provider ID>` IDs matching personal discovery. Preserve all current Multi-Sub channels. Do not assume the local Mac launcher is already a hosted discovery/update service: metadata refresh and secret provisioning on the host need an explicit procedure. Transfer secrets separately and without logging their contents.
4. Set `sessionRoot` under `/tmp` for the supplied Compose tmpfs. Ensure the JSON secret is readable by container UID 1000 without making it public on the host. Size memory/temp space for the selected session limit and actual stream bitrate; current Compose limits are 768 MiB RAM, two CPUs, 64 processes and 256 MiB `/tmp`, with default per-worker disk limit 128 MiB. These defaults need capacity verification, especially for two simultaneous sessions.
5. Set deployment variables `RELAY_DOMAIN`, `RELAY_CONFIG_PATH` and versioned `RELAY_IMAGE_TAG` privately. Compose runs from `deploy/live-subtitle-relay/`. Adapt the stack if using existing ingress, preserve Caddy certificate volumes if used, and expose only HTTPS/proxy ports. Keep the relay port internal. Access/request logs must not record capability-bearing URLs.
6. Verify start/restart/health and unauthorized API rejection, then an authorized session with real subtitle packets. Confirm one upstream connection per active session, source timeout/reconnect behavior and cleanup on delete/lease expiry. Avoid opening a diagnostic provider stream while the TV is already viewing unless account capacity has been confirmed.
7. Update private personal TV defaults: hosted `LIVE_SUBTITLE_RELAY_URL=https://<relay-hostname>` and `LIVE_SUBTITLE_RELAY_ALLOW_LAN_HTTP=0`; use a matching server/device token. Preserve automatic channel IDs. Saved TV overrides win over bundled defaults, so handle existing overrides deliberately. Do not display the token or put it into public output.
8. Build, sign and install the correct personal Tizen package. `npm run prepare:tizen3:personal` or `npm run prepare:tizen6:personal` uses the existing signing workflow. Verify the hosted endpoint is reachable and trusted on the TV, with no manual address/token/mapping entry needed for a fresh personal install.
9. Run hosted playback, language/off, fullscreen, channel-change, reconnect, teardown and service-restart checks. Confirm `progress=local`, `ack=confirmed`, advancing playhead and safe diagnostics. Record remaining upstream interruptions and provisional timing honestly. Confirm public/standard build output excludes personal credentials.
10. Document the actual hostname (no secrets), host/runtime, deployed versions/digests, config refresh process, certificate renewal, restart/health operation, resource measurements and rollback. Update this handoff after deployment rather than leave it describing a future service.

## Verification commands

Run from the repository root; these checks use synthetic fixtures:

```sh
npm run check
npm run relay:smoke
npm run relay:local
npm run build:public
npm run build:tizen
npm run build:tizen:personal
```

Socket-restricted environments may need permission for the synthetic local server. Container build and Compose validation still need to run on a suitable host. Do not print rendered Compose secrets or private environment/configuration in verification output. Keep personally configured builds local.

## Operations and rollback to finish during deployment

`restart: unless-stopped` handles process exits; Docker health status alone does not restart a stuck running process. `/healthz` checks process availability, not whether a provider channel is live. Start with safe process/health monitoring and bounded log retention; no automatic external notification or recurring job has been configured.

Rollback selects the previous compatible image and configuration, preserving certificate volumes and private channel/device config. Restore compatible personal TV defaults/package if endpoint or protocol changes require it. Rotating the single API token requires updating affected personal TV packages or saved configuration. Stopping the Mac relay is a separate step once hosted playback is accepted; do not leave unnecessary active upstream sessions.

## Original suggested opening prompt

> Continue the live subtitle relay deployment from docs/live-subtitle-relay-deployment.md. The local Tizen implementation is accepted as good enough for now. Inspect the current code and host setup, preserve automatic Multi-Sub routing and private personal-build defaults, and deploy the separate service with trusted HTTPS. Keep credentials and provider URLs out of chat/logs. Use Luna subagents where useful. Obtain the missing host/hostname/access details before dependent deployment actions.


## Latest TV package

On 2026-10-04 the startup and EPG responsiveness update was built as a personal Tizen 3 package, signed using the existing Samsung VS Code certificate profile, verified and installed on the configured Tizen 3 TV. Both signature files are present and all 20 current `dist` assets match the archive byte-for-byte. The private package is `tizen/Debug/tizen3.wgt`, SHA-256 `39efa1beaf73dbe6100c56b14d5c36d675e25e9e4c827a40d04025503b709c62`. The user explicitly approved uninstalling and clearing saved TV data. Uninstall and installation both returned `cmd_ret:0`; remote launch was rejected, so open Substream from the TV Apps screen.

The update loads Live TV and VOD on demand, processes Nordic EPG decompression/XML in classic workers with yielding fallbacks, prioritizes guide requests near remote focus, batches guide updates/cache writes, and preserves channel focus during refresh. Typechecking and all 524 tests passed; Tizen 3 and Tizen 6 builds succeeded. Chromium 47 synthetic checks verified lazy routes, the actual parser-worker response, guide display and focus preservation without uncaught exceptions. Hosted HTTPS relay defaults remain enabled with a credential present and LAN HTTP disabled. No server deployment was performed. Startup responsiveness, EPG navigation and playback on this newly installed package await actual-TV acceptance; earlier playback acceptance applies to the previous package. Subtitle timing remains `clock=unverified`.
