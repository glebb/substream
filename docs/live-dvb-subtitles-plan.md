# Tizen 3 live DVB subtitles: sync and flicker plan

## Current result

On the physical Tizen 3 TV, live DVB subtitles now appear. The observed defects are that captions are out of sync with video and the same lines flicker or reappear multiple times. This confirms that discovery, decoding, and display work on at least the tested stream; it does not establish correct timing or stable presentation.

The sustained device test ruled out this TV-only sideband design: playback
stopped after about 35 seconds while the scanner was active. Its diagnostic
reported one reconnect and a subtitle mapping about 25 seconds ahead of
AVPlay, consistent with the observed early captions. A direct-TS AVPlay probe
also exposed no native subtitle track.

## Transport finding and deferred architecture

DVB bitmap captions are packets inside the MPEG-TS multiplex alongside video
and audio. HLS is the delivery playlist and its media segments; the direct
`.ts` endpoint is a continuous transport stream. The direct TS source is
confirmed to carry usable DVB packets because the scanner decoded captions
from it.

AVPlay does not expose its downloaded transport bytes to JavaScript. It also
does not expose the DVB PID as a native `TEXT` track on this Tizen 3 device,
for either HLS or direct TS playback. A browser-side decoder therefore needs a
second, full-rate TS request. That request competes with AVPlay, and Chromium
47 retains progressive XHR response text; ending or reconnecting it stopped
playback in the device test. Live TV must keep that scanner disabled.

The deferred reliable design is a companion relay: one upstream provider TS
connection, video/audio relayed to AVPlay, server-side DVB demultiplexing, and
only compact subtitle frames or cue metadata sent to the TV overlay. This
gives captions and video a shared clock without a second high-bitrate TV
request. It is documented only, not implemented: protocol, backpressure,
teardown, credential handling, and device validation still need design.

## Implemented path

- Tizen live playback now uses the provider HLS URL. The earlier playback buffer change uses a five-second threshold for both initial playback and resume; the quick TV test did not reproduce the playhead jump, but sustained playback has not been verified.
- A bounded, plain GET probe of the direct TS stream reads audio language metadata missing from AVPlay's track list. The player maps those languages to AVPlay's audio tracks and prefers Finnish, then English, then the first track. Audio selection and the chosen default still need confirmation on the TV.
- The Tizen AVPlay adapter plays the HLS URL; the direct TS URL is fetched separately for audio metadata and the explicitly opted-in DVB sideband feed. AVPlay does not hand TS bytes to the decoder. Opening TS directly in AVPlay has not been verified on the target device and could change playback behavior; compare direct-TS track inventory and playback on-device before considering it.
- `TizenLiveDvbSubtitleFeed` reads bounded chunks from the TS response, scans for DVB subtitle tracks, feeds selected PES packets to `DvbSubtitleDecoder`, and limits Chromium 47 response growth with a 64 MiB or 10 minute session cap (whichever comes first). The former 4 MiB/60 second cap caused a forced XHR abort/reconnect near the reported playback stop.
- The feed maps subtitle PES timestamps to AVPlay playhead seconds using one video PTS and playhead sample as an anchor. Numeric-only on-screen diagnostics now report playhead, last video/subtitle PTS, mapped subtitle time, current playhead delta, reconnects, presentation calls, and clear calls. Values have not yet been collected from the TV, so the source of timing offset remains unknown.
- The feed ignores recently repeated exact PES payloads using a bounded 32-entry numeric fingerprint cache, retained across reconnects to avoid immediately replaying duplicate display sets.
- `TizenLiveDvbOverlay` draws the decoded bitmap on a canvas over the AVPlay rectangle. The feed polls rendering at a minimum interval of 150 ms, and the overlay skips canvas writes when the exact bitmap and geometry are unchanged.
- Video PTS decoding now uses arithmetic for all fields of the unsigned 33-bit timestamp; signed 32-bit JavaScript shifts had corrupted timestamps with the high bit set. A synthetic scanner test covers a large timestamp. The clock still uses one anchor per feed connection, so measured TS/HLS delay and drift remain unverified.
- The overlay now preserves an unchanged bitmap without clearing and repainting it. This addresses redundant canvas work from repeated sets, but device testing is still needed to tell whether duplicate sets or short cue gaps cause visible flicker.
- Track selection, enable/disable, channel changes, and player teardown are wired through the AVPlay adapter. Synthetic tests cover TS track discovery, selection, timeout, decoder behavior, and AVPlay integration. The physical TV observation above is the first confirmation that this path can display subtitles.
- The live channel row layout was adjusted so the next EPG programme fits; the user confirmed that result on the TV. Before this TV report, `npm run check` passed 273 tests and `npm run build:tizen` succeeded. Those checks do not verify subtitle sync or stable rendering on hardware.
- The Tizen canvas now detects an identical frame by its dimensions, position, and exact RGBA bytes. It skips clearing and redrawing that bitmap on subsequent render ticks, while changed frames replace the prior rectangle and explicit clears remain effective. A synthetic test covers repeated and changed frames plus idempotent clearing.

## Next steps

The earlier TV-only scanner steps below are superseded by the device result.
Keep normal Tizen 3 playback on one AVPlay source; do not re-enable continuous
sideband DVB scanning. The remaining work, if resumed, is to design and
validate the companion relay described above.

1. **Measure the two clocks.** Read the numeric diagnostics on the TV: AVPlay playhead, TS video PTS, subtitle PTS, mapped subtitle time, current playhead delta, reconnect count, and present/clear calls. Log no URL, response text, packet bytes, or caption content. Measure several consecutive captions and a reconnect on the same channel.
2. **Fix the timing model.** Determine whether the separate TS request is ahead of or behind AVPlay's HLS playback, and whether that gap changes. Account for HLS latency and reconnects when mapping TS PTS to the AVPlay clock. Handle PTS wrap and playhead discontinuities. A single anchor captured when the first TS video packet arrives may be insufficient for independently started streams.
3. **Stop repeated presentation.** The overlay no longer clears and repaints an unchanged bitmap; exact RGBA equality is covered by a synthetic test. Still check on device whether reconnects or repeated DVB display sets create duplicate cues, and whether a brief clear occurs between equivalent or adjacent cues. Preserve or deduplicate a stable display set across reconnects where appropriate. Keep an explicit clear when the page really ends or subtitles are disabled.
4. **Add synthetic regression tests.** The overlay now has synthetic coverage for repeated identical pixels, changed pixels, and repeated clears. Still cover a stream with a known TS/HLS delay, reconnects, PTS wrap, and page timeout. Assert cue timing and canvas present/clear counts; never use the private playlist or media in fixtures.
5. **Verify on the target TV.** Test several minutes on the affected channel, including a reconnect, channel switch, subtitle toggle, and return from playback. Confirm captions appear once, remain visible for their intended duration, and track speech without increasing drift. Also confirm Finnish audio is selected by default and can be chosen manually, and watch for the earlier playhead jump. Then run `npm run check` and the Tizen build/package checks.

The clock relationship and cause of flicker are hypotheses until measured on device. Preserve the current working display path while changing timing and presentation separately so each result can be checked.
