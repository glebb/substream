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

After activation without a query flag, a local Chrome Teema Fem FHD smoke test
reached `readyState` 4 with an advancing media clock. The subtitle canvas was
removed after leaving playback, and no browser errors were reported. Captions
were unavailable on that sampled provider feed.

A local Chrome test previously displayed Finnish DVB bitmap captions on TV5
FHD. Later Chrome checks of Yle TV1, TV2, and Teema Fem variants kept video
responsive but did not establish captions on those provider renditions:

| Provider entry | Observed subtitle transport data |
| --- | --- |
| Yle TV1 FHD | Four advertised DVB PIDs, zero packets across complete HLS fragments and a separate 10 MiB direct TS sample |
| Yle TV1 HD | One advertised DVB PID, zero packets across complete sampled HLS fragments |
| Yle TV1 standard | No private DVB or teletext stream in sampled PMT data |
| Yle Teema Fem FHD | Four advertised DVB PIDs, zero packets across complete HLS fragments and a separate approximately 10 MiB direct TS sample |
| Yle Teema Fem HD | No private DVB or teletext stream in sampled PMT data |
| Yle TV2 FHD and HD | Advertised DVB PIDs had zero packets in earlier rotating-window samples |
| Yle TV2 standard | A later run had one active DVB PID but emitted no decoded bitmap; recheck after the PES header fix |

A different provider was reported to show switchable Finnish subtitles on Yle
TV1 and Teema Fem. That is compatible with the observations above: the sampled
Substream provider renditions either did not carry packets on their advertised
subtitle PIDs or did not advertise a subtitle stream. These checks describe
sampled time intervals, not a permanent property of either provider.

All real-stream checks kept URLs, credentials, signed media links, and payloads
out of logs and documentation. Tests use synthetic transport fixtures only.

## Remaining release checks

- Run a sustained modern-browser smoke test on a stream with active DVB
  packets, including channel changes, subtitle selection, and worker failure.
- Verify AVPlay Finnish and English track selection on the target physical TV.
- Recheck standard Yle TV2's active DVB PID and any future Yle provider feed
  whose subtitle packets become available.

If a provider feed omits subtitle packets, the player cannot reconstruct them
from another provider's broadcast. The feed must carry a usable subtitle
track for the browser worker or AVPlay to display it.
