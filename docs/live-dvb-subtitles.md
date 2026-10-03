# Embedded live subtitles

The [historical Tizen 3 experiment](live-dvb-subtitles-plan.md) records why continuous TV-side direct-TS scanning was ruled out. The implemented replacement is the [live subtitle relay](live-subtitle-relay.md), accepted locally on a real TV on 2026-10-03. Public deployment is the next task; see the [deployment handoff](live-subtitle-relay-deployment.md).

## Release behavior

Live TV enables embedded subtitles in normal browser and Tizen builds. The
browser HLS adapter scans MPEG-TS media in a dedicated worker and draws DVB
bitmap cues on a canvas over the video. Tizen uses AVPlay's native `TEXT`
tracks when available. The separate continuous TV-side TS subtitle feed is
disabled after it disrupted playback; personal Tizen builds instead route
`Multi-Sub` channels through a server that relays media and decodes PNG captions
from the same upstream connection. Both prefer Finnish, then English; other languages remain off by
default. The browser offers a DVB track only after packets appear on its
advertised transport PID. A PMT descriptor alone does not make an empty track
selectable.

The subtitle path is optional to playback. If worker creation, parsing,
rendering, or acknowledgement fails, the browser removes its worker and canvas
while video continues. Browser HLS keeps WebVTT, IMSC1, and CEA-708 decoding
disabled because enabling those hls.js decoders made an affected provider
stream unresponsive. Browser-native `TextTrack` support is not assumed for DVB
bitmap subtitles.
When hls.js is unavailable but the browser supports native HLS, live video
falls back to native playback. Native tracks may still be exposed by that
browser; fragment-based DVB worker discovery requires hls.js.

## Browser safety boundaries

| Boundary | Limit or behavior |
| --- | --- |
| Source fragment | One active MPEG-TS fragment and two pending fragments, each up to 20 MiB; when full, the oldest pending fragment is replaced |
| Worker transfer | Consecutive, TS-packet-aligned windows of at most 512 KiB, advanced after acknowledgement |
| Worker backpressure | At most two unacknowledged fragment messages; the current player normally sends one at a time |
| Watchdog | Eight seconds without completing worker work disposes only subtitle resources |
| PES reconstruction | 128 KiB maximum; malformed or unrelated private PES is rejected before the decoder |
| Decoder | At most 256 retained cues; bitmap rendering is limited to one frame per 200 ms |
| Canvas frame | At most 4 MiB RGBA with dimensions and bounds checked before painting |

Only capped RGBA bitmap data crosses from the worker to the UI. The worker owns TS
scanning and the `libbitsub` WebAssembly parser. The overlay reuses its canvas
and clears the previous cue bounds. Worker, HLS listeners, overlay, and retained
fragments are released on a channel change or player teardown. DVB cue times
are referenced to the first video PES timestamp in the media fragment when
available, preserving the cue's offset within that fragment. The older
main-thread transport parser has been removed.

The worker and WebAssembly are separate build assets. The browser path requires
worker and media capabilities available in its runtime. If they are missing,
the subtitle path fails locally and playback remains available.

## Verification

Synthetic tests cover descriptor discovery, packet-activity gating, selected
page PES filtering, complete bounded-fragment capture, oversized fragments,
worker backpressure, invalid frame rejection, subtitle cleanup, and playback
failure isolation. Run `npm run check`, `npm run build`, and
`npm run build:tizen` before packaging. Production activation does not replace
a long-running browser or physical-TV smoke test.

## Historical provider observations

Earlier local Chrome checks displayed Finnish DVB captions on TV5 FHD. Sampled Yle TV1, TV2 and Teema Fem variants either lacked active subtitle packets or did not produce decoded bitmaps; an active standard TV2 PID still needs a recheck after the PES header fix. These were time-limited observations, not guarantees about current provider feeds. Video remained responsive in the later Teema Fem check and the canvas was removed on exit.

A track advertised in the PMT may carry no packets. Record packet activity and decoder output separately when diagnosing missing captions; do not infer subtitle support from a channel name. Keep media URLs, credentials and transport payloads out of diagnostics.

In September 2026, the V Film Premiere FHD multi-sub feed produced HLS
fragments around 12.8 MB. The earlier 10 MiB source-fragment limit skipped
most of them, causing intermittent missing captions. The limit is now 20 MiB;
`?mediaDebug` in a development build logs only numeric fragment sizes, backlog
counts, and whether a fragment exceeded the limit.

## Remaining release checks

- Run a sustained modern-browser smoke test on a stream with active DVB
  packets, including channel changes, subtitle selection, and worker failure.
- Verify AVPlay native Finnish/English track selection where available. For Multi-Sub channels, use the [relay verification checklist](verification.md#hosted-live-subtitle-relay); do not resume the retired continuous TV-side scanner experiment.
- Recheck standard Yle TV2's active DVB PID and any future Yle provider feed
  whose subtitle packets become available.

If a provider feed omits subtitle packets, the player cannot reconstruct them
from another provider's broadcast. The feed must carry a usable subtitle
track for the browser worker or AVPlay to display it.
