# Embedded live subtitles

Embedded subtitles are optional to live playback. The app supports browser-side DVB bitmap decoding from HLS fragments and uses native AVPlay text tracks on Tizen when the device exposes them. A separate live subtitle relay is available for configured channels, including personal-build routing for channels marked `Multi-Sub`. Setup and relay behavior are described in the [live subtitle relay guide](live-subtitle-relay.md); validation steps are in the [verification guide](verification.md).

## Current behavior

In browsers using hls.js, MPEG-TS fragments are scanned in a worker. DVB subtitle PES is decoded to bounded RGBA frames and drawn in an overlay. A DVB track becomes selectable only after packets are observed on the advertised PID; a PMT descriptor without subtitle packets is not a usable track. When hls.js is unavailable but native HLS playback exists, video may still play, though fragment-based DVB discovery is unavailable.

Tizen uses AVPlay tracks when available. The separate continuous TV-side TS scanner remains disabled. The optional live subtitle relay provides an alternate single-upstream route for configured channels; it keeps video and subtitle timing on the same relayed stream and displays decoded images above AVPlay. Both direct embedded-track selection and the relay prefer Finnish and then English when available. Availability depends on provider packets and device support.

Browser subtitle processing is isolated from video playback. Worker startup, parsing, rendering, or acknowledgement failures release subtitle resources while video continues. Browser HLS disables WebVTT, IMSC1, and CEA-708 hls.js decoders because they made an affected provider stream unresponsive. Native browser `TextTrack` support is not assumed for DVB bitmap subtitles.

## Why continuous TV-side scanning stays disabled

The historical Tizen 3 investigation established that AVPlay does not expose its MPEG-TS bytes to JavaScript and did not expose DVB PIDs as native `TEXT` tracks on the tested TV. A second direct-TS request was therefore needed for JavaScript decoding alongside AVPlay's HLS request. On that Chromium 47 device, the progressive XHR retained response text, and starting, ending, or reconnecting the side request interfered with video playback. The sustained test stopped playback after roughly 35 seconds and showed a large subtitle-to-playhead offset. Caption display proved that scanning and decoding could work, but not that this two-source design was safe or synchronized.

The relay route was chosen to avoid the second high-bitrate TV request: one server-side upstream connection supplies both AVPlay media and subtitle extraction. This is a separate optional service with its own availability, network, and upstream limits. Do not re-enable the retired scanner as a fallback.

## Browser resource limits

| Boundary | Limit or behavior |
| --- | --- |
| Source fragments | One active MPEG-TS fragment and two pending fragments, up to 20 MiB each; the oldest pending fragment is replaced when full |
| Worker transfer | Packet-aligned windows up to 512 KiB, advanced after acknowledgement |
| Worker backpressure | At most two unacknowledged fragment messages |
| Watchdog | Eight seconds without completing worker work disposes subtitle resources |
| PES reconstruction | 128 KiB maximum; malformed or unrelated private PES is rejected |
| Decoder | At most 256 retained cues; bitmap rendering at most once per 200 ms |
| Canvas frame | At most 4 MiB RGBA with dimensions and bounds checked before painting |

Only validated, capped RGBA data crosses from the worker to the UI. The worker owns TS scanning and the `libbitsub` WebAssembly parser. HLS listeners, worker, overlay, and retained fragments are released on channel change or player teardown. Cue timestamps use the first video PES timestamp in the fragment when available, preserving the cue's relative position within that fragment.

## Verification and observations

Synthetic tests cover descriptor discovery, packet activity, selected-page PES filtering, bounded fragment capture, oversized fragments, worker backpressure, invalid frame rejection, cleanup, and playback-failure isolation. Run `npm run check`; run the browser and Tizen builds before packaging. These checks do not replace sustained browser or physical-TV playback.

Historical provider observations are time-limited and are not guarantees about current feeds. Local Chrome checks displayed Finnish DVB captions on TV5 FHD. Sampled Yle TV1, TV2, and Teema Fem variants lacked active packets or decoded bitmaps. The V Film Premiere FHD Multi-Sub feed produced HLS fragments around 12.8 MB; this prompted raising the old 10 MiB fragment limit to 20 MiB. Development diagnostics report numeric sizes and backlog information only.

When captions are missing, distinguish an advertised PID from observed packet activity and decoder output. If the provider feed has no usable subtitle packets, the app cannot reconstruct captions from another broadcast. Keep media URLs, credentials, transport payloads, and caption text out of diagnostics.
