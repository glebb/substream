# Live DVB subtitles: investigation and implementation status

## Scope

This document records the work on embedded subtitles for Finnish live TV in
Substream. It deliberately contains no playlist URLs, provider credentials,
signed media URLs, or captured stream payloads.

The goal is browser and Tizen support for embedded live subtitles without
allowing malformed provider subtitle data to interrupt, delay, or freeze video
playback.

## What was observed

- A Finnish entertainment channel played normally in Chrome when browser-side
  embedded subtitle handling was disabled.
- Chrome exposed no native `TextTrack` entries for the same stream. This is
  consistent with DVB bitmap subtitles carried in MPEG-TS rather than browser
  WebVTT tracks.
- The old browser capability gate depended on a provider channel-name marker
  (`multi sub`). That metadata did not describe every channel that carried
  embedded subtitles and therefore was not a reliable discovery mechanism.
- Enabling hls.js subtitle decoders in Chrome caused the affected live stream
  to stop responding. The same happened after an initial custom DVB path was
  enabled, including in fresh browser tabs.

## What works today

### Tizen

Tizen uses AVPlay's native embedded `TEXT` tracks. It enumerates and selects
tracks through the Tizen adapter, with Finnish preferred over English. This
does not require browser-side transport parsing.

### Browser playback safety

Browser live playback keeps hls.js WebVTT, IMSC1, and CEA-708 decoders
disabled. This is intentional: it restores responsive playback for the
affected stream.

The app enables embedded live subtitle mode only for Tizen at present. Browser
video playback must remain independent of every subtitle component.

### Safe DVB implementation foundation

The browser now contains an isolated DVB worker pipeline, but it is dormant by
default:

1. `live-dvb-ts-scanner.ts` scans MPEG-TS PAT/PMT/PES data in a Worker and
   identifies DVB descriptor (`0x59`) tracks.
2. `live-dvb-subtitle.worker.ts` owns the DOM-free `libbitsub` `DvbParser`,
   rebases PES timestamps, and emits only capped RGBA bitmap frames.
3. `live-dvb-worker-protocol.ts` limits main-thread input/output, validates
   frames, applies backpressure, and terminates cleanly.
4. `live-dvb-overlay.ts` is a narrow canvas host for validated frames. It has
   no access to transport data.
5. `HtmlVideoPlayer` contains lifecycle wiring for this path, including
   listener, worker, and overlay cleanup. It is not activated by `LiveTv` in
   browser playback until real-stream validation passes.

The production build emits the worker and WebAssembly as separate chunks.

## Safety limits

| Boundary | Limit / behavior |
| --- | --- |
| Discovery fragment | First 64 KiB only |
| Active worker fragment | First 512 KiB only |
| Worker backpressure | At most two unacknowledged fragments |
| Worker frame | At most 4 MiB RGBA, validated dimensions and byte count |
| Legacy scanner slice | 32 MPEG-TS packets per timer slice |
| PES reconstruction | 128 KiB maximum |
| Error handling | Subtitle worker/overlay is disposed; video player remains active |

Malformed or unrelated private PES data is filtered before it reaches the DVB
WASM parser. This is important because a transport PID advertised as private or
DVB is not, by itself, proof that every payload is valid DVB subtitle data.

## Approaches tried

### 1. Channel-name opt-in

The browser previously enabled its embedded subtitle path only for channel
names marked `multi sub`.

**Result:** insufficient. Provider naming is metadata, not a capability
contract. It missed streams that carried embedded subtitles.

### 2. Enable hls.js subtitle decoders for every live stream

WebVTT, IMSC1, and CEA-708 were enabled to discover stream subtitles without
channel-specific rules.

**Result:** failed. The affected provider stream froze Chrome. The decoders are
therefore disabled again for browser playback.

### 3. Parse DVB transport fragments on the browser main thread

An initial `LiveDvbSubtitles` implementation inspected hls.js fragment events
and created a `libbitsub` renderer associated with the HTML video element.

**Result:** failed the real-stream responsiveness test. Bounded copies and
smaller parsing slices reduced the risk but did not make it safe enough to
activate.

### 4. Worker-owned scanner, decoder, and bitmap-frame protocol

Transport scanning and low-level DVB decoding were moved behind a Web Worker;
only bounded fragments enter and only validated bitmap frames leave.

**Result:** implementation and synthetic tests work. However, activating the
full browser path against the affected real stream still made the browser
automation unresponsive. The route remains dormant until the activation cost
is profiled and eliminated.

## Verification completed

- `npm run check` passes: 44 test files and 210 tests at the time of this
  document.
- `npm run build` succeeds and produces separate worker/WASM assets.
- Synthetic tests cover TS descriptor discovery, selected-page PES filtering,
  oversized fragments, bounded active fragments, worker backpressure, invalid
  frame rejection, overlay lifecycle, and player cleanup/error isolation.
- A fresh Chrome smoke test confirms the affected live channel plays normally
  with browser DVB worker activation disabled.

## Known issues

1. Browser DVB subtitles are not user-visible yet. The worker/overlay path is
   intentionally dormant.
2. The exact activation failure has not been profiled at the browser task or
   worker-message level. The observed symptom is a non-responsive browser
   renderer after the path is enabled for the affected provider stream.
3. Native browser `TextTrack` support is unavailable for this stream, so
   generic WebVTT selection is not a fallback for its DVB bitmap subtitles.
4. Tizen behavior still requires physical-TV verification for the target
   firmware and provider stream.

## Next steps

1. Add local, credential-free performance instrumentation around worker
   creation, first fragment transfer, WASM initialization, parser feed, frame
   generation, and overlay paint. Record durations and byte counts only; never
   log stream URLs or payloads.
2. Reproduce against a synthetic TS fixture containing a valid DVB PMT/PES
   sequence and progressively increase fragment size/rate to locate the costly
   stage.
3. In Chrome DevTools, profile the real stream only on a personal machine and
   inspect main-thread long tasks and worker CPU. Do not export provider
   requests, URLs, or media data.
4. Gate browser activation behind a short watchdog. If startup does not remain
   responsive, terminate the worker and remove the overlay without touching
   hls.js or the video element.
5. Enable the worker path first behind an explicit development-only flag, then
   run the live smoke test. Promote it to normal browser playback only after it
   plays continuously, selects a Finnish track, renders frames, and survives
   channel changes without long tasks.
6. Run the physical Tizen smoke test separately, confirming that AVPlay track
   selection still works with Finnish and English preference.

## Acceptance criteria for browser activation

- Video begins and remains responsive when no DVB track exists.
- Video begins and remains responsive when a DVB track exists but decoding or
  rendering fails.
- Worker creation, worker termination, and channel changes leave no canvas,
  hls.js listener, or worker behind.
- No raw transport data crosses from the worker to the UI; only bounded bitmap
  frames do.
- A Finnish track is preferred, English is the fallback, and unrelated
  languages remain off by default.
- A subtitle failure never changes the video playback state.
