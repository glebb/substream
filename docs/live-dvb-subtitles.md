# Embedded live subtitles

## Release behavior

Live TV enables embedded subtitles in normal browser and Tizen builds. The
browser HLS adapter scans MPEG-TS media in a dedicated worker and draws DVB
bitmap cues on a canvas over the video. Tizen uses AVPlay's native `TEXT`
tracks. Both prefer Finnish, then English; other languages remain off by
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
| Source fragment | At most one retained MPEG-TS fragment, up to 10 MiB; another arrival while busy or a larger fragment is skipped |
| Worker transfer | Consecutive, TS-packet-aligned windows of at most 512 KiB, advanced after acknowledgement |
| Worker backpressure | At most two unacknowledged fragment messages; the current player normally sends one at a time |
| Watchdog | Eight seconds without completing worker work disposes only subtitle resources |
| PES reconstruction | 128 KiB maximum; malformed or unrelated private PES is rejected before the decoder |
| Decoder | At most 256 retained cues; bitmap rendering is limited to one frame per 500 ms |
| Canvas frame | At most 4 MiB RGBA with dimensions and bounds checked before painting |

Only capped RGBA bitmap data crosses from the worker to the UI. The worker owns TS
scanning and the `libbitsub` WebAssembly parser. The overlay reuses its canvas
and clears the previous cue bounds. Worker, HLS listeners, overlay, and retained
fragment are released on a channel change or player teardown. The older
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

## Remaining release checks

- Run a sustained modern-browser smoke test on a stream with active DVB
  packets, including channel changes, subtitle selection, and worker failure.
- Verify AVPlay Finnish and English track selection on the target physical TV.
- Recheck standard Yle TV2's active DVB PID and any future Yle provider feed
  whose subtitle packets become available.

If a provider feed omits subtitle packets, the player cannot reconstruct them
from another provider's broadcast. The feed must carry a usable subtitle
track for the browser worker or AVPlay to display it.
