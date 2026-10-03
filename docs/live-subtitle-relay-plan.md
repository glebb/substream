# Live subtitle relay: implementation status and deployment plan

Updated 2026-10-03. This replaces the original proposed milestones with the implemented behavior. See [implementation and local setup](live-subtitle-relay.md) and the [fresh-session deployment handoff](live-subtitle-relay-deployment.md).

## Objective and accepted scope

Serve usable live DVB bitmap subtitles to Tizen, starting with Sky Showtime. The user has a server, confirms provider permission, and confirms usable subtitle packets in the existing web implementation. The user accepted local real-TV playback as good enough for now and requested public deployment in a fresh session. Further local tuning is deferred; do not treat the original proposed 30/60-minute soaks as completed or as a new permission requirement before preparing deployment.

The service is continuously available, but opens one provider stream only for an active viewing session. Video/audio and DVB streams are copied into MPEG-TS segments; the server extracts captions from finalized output segments and serves cue metadata and PNG images. No OCR, burn-in, recording, catch-up, database, general URL proxy or public redistribution is part of this release. The service is separate from the trusted-LAN companion.

## Implemented architecture

```text
Tizen API request ──HTTP locally / HTTPS when hosted──> session manager
                                                           |
Provider TS ──one validated, DNS-pinned connection──────────+
                                                           |
                                                  FFmpeg stream copy
                                                           |
                                                finalized MPEG-TS chunks
                                                    /             \
                                         M3U8 to AVPlay       DVB extraction
                                                                  |
                                                         timed cues + PNGs
                                                                  |
                                                       Tizen image overlay
```

Shared protocol, TS scanning and cue scheduling live in platform-independent core modules. Node ingest/decoding/API and Tizen playback/network/rendering sit behind adapters. The overlay uses PNG images mounted above the native video plane, not the old continuous TV-side scanner. That experiment disrupted playback and remains disabled; see its [historical findings](live-dvb-subtitles-plan.md).

FFmpeg uses its MPEG-TS segment muxer with an M3U8 list, because the HLS muxer rejected copied DVB packets. Segment target is four seconds; actual boundaries follow source keyframes. Fifteen segments are retained, with bounded per-session disk use. A one-second interleave cap reduces buffering of sparse subtitle streams. There is no media transcoding in the relay.

## Completed work

- Authenticated, versioned session API; allowed channel IDs only; capability-scoped media/images; leases, concurrency/rate/body limits and cleanup. Public DNS validation and pinning apply on every redirect. Personal mode permits rotating public CDN hosts rather than requiring a hostname whitelist.
- API routes: `POST /v1/sessions`, `GET /v1/sessions/:id/status`, HLS playlist/segments, `GET /v1/sessions/:id/cues?afterSequence=N`, images, `PUT /v1/sessions/:id/subtitle-track`, `POST /v1/sessions/:id/playback-started`, heartbeat, delete, and `/healthz`. Status advertises subtitle tracks and timing origins; it does not supply a separate audio-language metadata API.
- Server DVB selection/decoding, PNG generation, bounded cue/image retention, and explicit clears. Track activity is established from actual packets.
- Tizen AVPlay adapter, bounded image preloading/cache, overlay geometry, Finnish/English preference and Off, epoch invalidation and teardown. The TV schedules against AVPlay progress, including live streams whose reported duration is zero.
- Three completed, processed startup chunks totaling at least eight seconds; initial three-row playlist pinned until playback acknowledgement. ACK has four client attempts and a 60-second server deadline; stream preparation has a separate 30-second limit. Relay AVPlay requests eight-second play/resume buffering.
- Cue polling starts at 500 ms, status at two seconds, heartbeat at 20 seconds, with a default 60-second session lease. Requests are finite and cancellation-aware on Chromium 47.
- Connection/header deadline of 20 seconds separated from the 90-second live socket inactivity limit. Safe diagnostics include upstream idle time and fixed failure reasons.
- Two fresh relay reconnect attempts after playback begins, before direct fallback. No overlapping provider/native playback sessions; teardown failure stops recovery. New sessions reset caption timing. Initial setup failure goes directly to fallback. Fallback omits the extra TS audio-language probe.
- Automatic personal configuration: `.env.live-relay`, shared `stream-<provider ID>` identity and discovery of every title marked `Multi-Sub`. Public builds omit personal credentials; TV-saved settings override bundled defaults.
- Dockerfile, allowlisted Docker build context, Compose and Caddy configuration prepared under `deploy/live-subtitle-relay/`. They have not been deployed or release-validated.

## Observed local results

On 2026-10-03 the user tested Sky Showtime 1 and 2 on a physical TV. Showtime 1 was more stable. Showtime 2 exhibited uneven delivery, pauses, and response termination; direct playback also stopped. Earlier probes observed chunk publication gaps of roughly 12–21 seconds. The original 20-second body timeout could kill those sessions and was fixed. A later failure explicitly reported `upstream-ended`, rather than the new idle limit. These observations do not establish why the upstream server ended the response or prove that all pauses are resolved.

The latest code passed `npm run check` (504 tests) and `npm run build:tizen:personal`. Synthetic FFmpeg packaging and full local-pipeline smoke checks passed during implementation. The reconnect UI lifecycle has no dedicated automated harness; it was reviewed and typechecked. The user's final assessment was that the result works well enough for now. Precise clock mapping remains unmeasured (`clock=unverified`); no quantitative drift or 60-minute soak result is recorded.

## Hosted deployment and physical-TV acceptance

The native systemd relay is deployed at `https://subtitles.displayofpatience.com` using pinned Node 24.21.0, Ubuntu FFmpeg and existing Nginx. DNS, Let's Encrypt certificate, loopback binding, private config permissions, restart and synthetic pipeline checks passed. Docker was not needed. See [operations](../deploy/live-subtitle-relay/OPERATIONS.md) for refresh, release identity and rollback.

Direct source requests returned 456, despite correct credentials. A dedicated Mullvad device and Finnish `fi-hel-wg-101` egress now work: isolated media/DVB decoding and the production HTTPS lifecycle passed with four tracks and PNGs. Only the relay UID uses the VPN; IPv4/IPv6 direct fallback is blocked. Provider concurrency is one connection. Personal defaults now select hosted HTTPS and preserve automatic Multi-Sub routing; the personal Tizen 3 package has been signed and installed. On 2026-10-03 the user confirmed the hosted relay works on Tizen, establishing basic HTTPS trust/playback. The Mac relay was stopped and verified inactive. Public/standard builds were checked for playlist/device/API credentials.

Basic hosted TV playback is user-confirmed. Detailed language/off/fullscreen, channel-change, reconnect, teardown, service-restart-during-viewing and sustained resource checks are not separately recorded. Saved settings still override defaults.

## Remaining rollout checks and limitations

- Basic public HTTPS trust/playback on the installed Tizen 3 device is user-confirmed; sustained real-stream resource capacity remains unverified. Certificate persistence/renewal is configured; direct provider egress receives 456, while relay-only Mullvad egress passed media/subtitle checks.
- Startup reserve and reconnect preparation add delay. Two attempts are a per-channel budget, reset by changing channel or Retry; there is no seamless server-side ingest reconnection or endless retry loop.
- Quantify AVPlay-to-output PTS mapping, cue display/clear error and drift when convenient; offsets are provisional, not proof of synchronization.
- Exercise sustained playback, rapid channel switching, language/off, audio selection, normal/fullscreen geometry, interruptions, service restart and app exit/reopen. Record only safe counts, durations and outcomes.
- Docker restart policy restarts an exited process, not an unhealthy-but-running one. `/healthz` indicates process health, not provider availability. A single VPS is persistent hosting, not high availability.
- Rollback needs a previous compatible image, private server config and personal TV package/defaults. Keep the ability to disable relay playback and use direct playback, while recognizing direct playback may also fail on an interrupted source.
