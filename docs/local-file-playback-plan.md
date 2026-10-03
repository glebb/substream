# Local file playback implementation plan

Status: implemented. This document records the approved behavior and validation criteria.

## Intended behavior

The web app gets an **Open local file** action on the home screen, including
when no IPTV playlist is configured. Selecting a video opens the same movie
preview/details view used for VOD, with title, available artwork/synopsis,
and **Play on this computer** and **Play on TV** actions. Selection does not
start playback. Either action uses the existing player on its target, with
the same play/pause, restart, skip, progress, fullscreen, aspect, information,
audio, and subtitle controls. TV playback streams the selected media from
the computer over the LAN. Back from computer playback returns to details;
Back from details returns to the entry screen and restores focus.

Initial scope is one selected video at a time, playable on the computer and/or
TV according to that target's codec support. Selecting an MKV does not imply
that its video, audio, or embedded subtitle codecs are supported. Native
audio/embedded track selection is available only where the browser exposes
those tracks. Unsupported files get a local-file-specific error and a way to
choose another file. Computer playback does not upload video. Choosing TV
playback stages the file with the companion service running on that computer,
then serves it to the paired TV. No cloud media hosting is involved. The
computer and companion service must remain running while the TV plays.
Tizen USB browsing, directory libraries, and automatic next-file
playback are separate features. A subsequent compatibility fix now prepares
incompatible local files as H.264 MP4 with supported audio preserved on the companion before TV dispatch;
see [companion behavior](companion-search.md).

## Existing code and implications

- `src/app/App.tsx`: `VodApp` owns playback UI, keyboard/focus behavior,
  fullscreen, subtitle search/download, subtitle settings, and history.
  `startPlayback` and the playback effect require `VodCatalogItem`.
- `App` initially shows playlist setup when no playlist is saved. The local
  action must remain reachable through that state; adding it only inside
  ready VOD browsing would miss the standalone use case.
- `src/platform/browser/html-video-player.ts`: `HtmlVideoPlayer.load` accepts
  a URL and already supports controls and external subtitle attachment.
  Its development-only MKV compatibility service takes a remote URL; local
  playback must use the direct browser path and never send a blob URL there.
- `src/platform/media-player.ts`: the adapter contract already covers player
  controls. `PlaybackRequest` currently distinguishes VOD/live, but `VodApp`
  loads a URL directly. Update that type only if the implementation actually
  adopts it, rather than adding an unused local variant.
- `src/core/catalog/normalize.ts` and `src/core/subtitles`: title normalization,
  subtitle ranking, SRT/WebVTT conversion, and timing logic are reusable.
- Existing history and timing persistence assume a catalogue title ID.
  Local sessions need an explicit policy rather than a fabricated catalogue
  record containing a temporary URL.
- The details screen and TMDB lookup also live in `VodApp`. Extract their
  presentation for reuse by local files, while keeping provider episode
  loading and catalogue actions outside the local flow.
- `scripts/companion-server.mjs`, `src/core/companion-protocol.mjs` (and its
  declaration file), `src/platform/companion/client.ts`, and
  `src/app/CompanionPanel.tsx` currently send provider selections and resolve
  their URLs on the TV. Pairing/commands require a matching provider
  fingerprint. Local media needs a distinct session source and capability;
  never fabricate a provider identity or pass a browser blob URL to the TV.

## Implementation sequence

The implementation reuses the existing `VodApp` details and player flows with
an explicit local source policy; it does not extract separate details/player
components because that would add churn without improving the local behavior.
The steps below remain the design rationale and acceptance checklist.

1. **Extract shared details and VOD playback.** Extract the existing movie
   preview into `src/app/TitleDetailsScreen.tsx` with common metadata and
   explicit target actions. Keep provider-specific details behavior in
   `VodApp`. Move the player screen, playback lifecycle,
   player keyboard/focus handling, fullscreen, and subtitle tools into
   `src/app/PlaybackScreen.tsx` with a focused playback-session model in
   `src/app/playback-session.ts`. Keep browse/provider resolution in `VodApp`.
   Use a discriminated source (`catalogue` or `local`) and common display/search
   metadata; a local session must not require group, source line, or provider
   fields. Catalogue sessions supply history/resume and next-episode callbacks;
   local sessions omit those policies. First verify existing details/VOD behavior after
   extraction, before adding the picker.

2. **Add a browser file source adapter.** Create
   `src/platform/browser/local-media-source.ts` to own the selected `File`,
   its object URL, and idempotent disposal. Pass the URL to `HtmlVideoPlayer`;
   leave `File`, DOM, and object-URL APIs outside `src/core`. Do not read the
   whole video into an ArrayBuffer or data URL. Keep ownership at the local
   session level so returning from playback to preview or restarting a player
   effect retains the file. On replacement/closing the local title, destroy
   and detach the computer player first, then revoke the URL and release the
   file reference. TV-hosted media has a separate lifecycle, described below.
   Also cover unmount and failed starts.
   Object URLs require explicit release when finished, per the
   [URL API documentation](https://developer.mozilla.org/en-US/docs/Web/API/URL/revokeObjectURL_static).

3. **Expose the local entry flow.** Add a web-only home action and a local route
   that opens `TitleDetailsScreen` without catalogue loading or IndexedDB setup.
   Keep the action visible alongside initial playlist setup. Use a native
   single-file input with video MIME types and common video extensions as
   picker hints; tolerate absent/unreliable MIME types and let actual decoding
   determine support. Cancel leaves the current screen/playback unchanged.
   Reset the input so the same file can be selected again. Use the filename
   as display text, strip its extension and normalize separators for an
   editable subtitle-search suggestion. Infer episode/year metadata only
   from explicit patterns; preserve unknown classification with evidence.
   Resolve artwork/synopsis through the existing TMDB confidence rules; keep
   a filename-based preview with fallback artwork when credentials, network,
   or a confident match are unavailable. Let users correct the search title,
   including ambiguous movie/episode names. Keep the selected file attached
   to the session while metadata requests run; ignore stale results after
   replacement. The computer action enters `PlaybackScreen`; the TV action
   prepares LAN streaming and then dispatches playback. Neither local action
   requires provider credentials. Support choosing a replacement from details
   and the local player. Generalize the
   home screen's currently fixed three-card focus handling for the web action
   while preserving the TV menu.

4. **Reuse subtitle behavior and add offline subtitle selection.** Keep
   OpenSubtitles search, movie/series fields, language preference, download,
   on/off, size, and timing controls in the shared player. Local playback
   defaults to user-triggered online search, with the filename-derived query
   visible and editable; video bytes and file paths are never submitted.
   Add **Open subtitle file** for SRT/WebVTT in the browser player's existing
   subtitle panel, available without an API key. Read bounded subtitle text
   using a legacy-compatible FileReader adapter, validate the format/cues,
   and attach through `MediaPlayer.setSubtitle`. Start with UTF-8 and report
   unreadable/unsupported files clearly. Share attachment state and error
   handling with downloaded subtitles. Invalidate pending subtitle operations
   when users attach another subtitle, change video, or leave; an earlier
   search/download must not replace a newer local subtitle. Preserve playback
   and the existing subtitle on attachment failure.

5. **Host selected media on the computer for TV playback.** Extend the companion
   service with a browser-authenticated local-media session API: create,
   upload bounded sequential file chunks, finalize, inspect status, and stop.
   The browser cannot hand a filesystem path to the service; stage the
   selected `File` into a private temporary file on the same computer using
   slices and streaming writes, without buffering the complete movie in RAM.
   Show transfer progress and cancellation in details; enable dispatch only
   once finalization verifies the expected size. Set configurable disk/size
   quotas suitable for large movies, bounded concurrent uploads, retryable
   chunk offsets, and cleanup for abandoned/partial sessions. Require a
   computer-hosted companion address reachable by the TV; never send localhost
   or a blob URL as the playback address.

   Serve finalized media through GET/HEAD endpoints with correct media type,
   Content-Length, single byte-range support (206/416 and Content-Range),
   bounded streaming/backpressure, and disconnect handling, so AVPlay can
   seek and restart. Use opaque session IDs, fixed server-managed paths, and
   short-lived media authorization scoped to the paired TV. Because AVPlay
   cannot be assumed to attach browser authorization headers, validate a
   temporary playback ticket mechanism on both target TVs. Do not expose
   arbitrary filesystem paths, enumerate directories, or log tickets/URLs.
   Validate the existing HTTP/HTTPS LAN setup on Tizen 3 and 6, including
   certificate trust, browser origin permissions, and mixed-content behavior.

6. **Extend pairing and dispatch for a local source.** Version/negotiate the
   companion protocol with an explicit local-media playback command containing
   an opaque media-session ID and display/search metadata. Separate device
   pairing from provider matching: authenticated local playback must work
   without IPTV setup on either device, while provider commands retain their
   current fingerprint checks. Update protocol parsers/types, client helpers,
   server authorization, the TV event receiver, and TV setup availability.
   Resolve an authorized LAN playback address from the companion service and
   enter the shared TV VOD player through `TizenAvPlayPlayer`. Report accepted,
   preparing, playing, failed, and stopped states to the originating preview;
   an accepted command is not confirmation that the TV is playing. Preserve
   event replay/acknowledgement semantics and reject unsupported protocol
   versions with an actionable update message.

   Carry subtitle search metadata to the TV so its existing OpenSubtitles
   tools work. When an external subtitle has been selected on the computer,
   host bounded validated subtitle text under the same media session and let
   the TV attach it through `setSubtitle`; transfer language, enabled state,
   and timing offset. Keep font-size preferences device-specific. Subsequent
   subtitle replacements must invalidate earlier downloads and apply to the
   active TV session. TV remote controls remain the existing player controls;
   browser transport remote-control UI is a separate follow-up.

   Retain staged media while TV playback is active, even when the browser
   returns home or closes; use TV heartbeats/leases rather than tying cleanup
   to browser unmount. Provide **Stop TV playback** on the preview, revoke
   playback tickets and clean media on explicit stop, release an ended session
   after a restart grace period, and expire disconnected/abandoned sessions.
   TV replacement releases the prior session only after its player detaches.
   Companion shutdown/restart and computer sleep must produce safe actionable
   errors; do not delete a file while an active reader still needs it.

7. **Define session and capability behavior.** Keep local progress and timing
   offsets in memory for the first version; retain existing global language
   and font-size preferences. Do not add unusable local items to Continue
   watching or persist blob URLs/files. Reload requires selecting the file
   again. Keep ended media attached so Restart still works. Explicitly gate
   catalogue history, provider URL resolution, and next episode by source kind;
   use the local hosting path for TV sending. A failed browser decode must not
   disable Play on TV if the TV can support the file. Handle denied
   autoplay/fullscreen with usable Play and
   Full screen actions. Show a safe local decoding/read error, rather than
   the current provider/network error. Reuse available audio/embedded track
   APIs without promising extraction of tracks the browser cannot expose;
   [native audio-track support varies by browser](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/audioTracks).

8. **Validate and document.** Add synthetic tests for object-URL lifetime,
   replacement/cancellation/reselection, source policies, unknown filename
   metadata, subtitle validation and stale operations, and adapter controls
   on a blob source. Cover details-first behavior, stale metadata, action
   routing, and Back/focus restoration. Assert computer playback makes no
   media-upload/provider/compatibility request and stores no local history or
   blob URL. Test companion upload limits, cancellation, retry offsets,
   finalization, range/HEAD responses, authentication, ticket expiry, path
   isolation, active-session leases, and cleanup using generated media only.
   Test local protocol negotiation/dispatch/acknowledgement, pairing without
   a provider, subtitle transfer, and rejection of unauthorized or stale
   sessions. Run `npm run check`,
   `npm run build`, and `npm run build:tizen`. Manually verify Chrome, Firefox,
   and Safari with generated short video/subtitle fixtures: empty setup,
   offline playback/subtitles, every existing control, online search,
   seek/restart with subtitle offset, ended/restart, unsupported media,
   large-file selection, replacement, and exit cleanup. On physical Tizen 3
   and 6 TVs, verify preview-to-TV playback from the computer, remote pause,
   seek/restart, subtitles/offset/audio controls, browser closure, explicit
   stop, LAN interruption/reconnect, computer sleep, and expired sessions.
   Include at least one file supported by TV but unsupported by the browser
   and sustained large-file playback. Recheck catalogue
   VOD/resume/next episode and Tizen playback after the shared-player change.
   Any CSS changes must use flex/margins and pass the Chromium-47 preview;
   update English/Finnish text and README support limitations.

## Acceptance criteria

## Implementation and verification record

The local source is a browser-platform adapter and an explicit `local` session
policy in the existing `VodApp`. It reuses the details view, player controls,
subtitle panel, and TV companion receiver. Pairing state is held by root `App`
memory so it survives route changes and local file replacement; changing the
relay origin clears that state. The relay has a dedicated local-media API with
chunked private staging, scoped media/subtitle tickets, byte-range support,
TV playback-state reports, and cleanup on stop or expiry. Protocol v4 separates
local playback capability from the provider fingerprint checks.

Synthetic checks cover object-URL lifetime, unknown filename classification,
SRT/WebVTT validation, upload resume after a lost acknowledgement, provider-
free pairing, chunk concurrency, finalization, range/HEAD/416 behavior,
ticket authorization/expiry, subtitle snapshots, stop dispatch, and cleanup.
`npm run check`, browser/Tizen builds, and the Chromium 47 layout preview are
the validation commands for this change. Physical Tizen 3/6 codec, TLS trust,
and sustained playback testing remains unverified without devices; local
playback capability is still subject to the target's supported container,
video, and audio codecs.

- Selecting a local file opens the movie preview/details screen before playback.
- The preview offers computer playback and computer-hosted playback on a paired
  TV, without requiring IPTV setup on either device.
- Local and catalogue VOD use one player UI and the same control/subtitle logic.
- External SRT/WebVTT works offline; OpenSubtitles works through existing setup.
- Cancelling, replacing, leaving, and restarting are safe and deterministic.
- Computer playback keeps video in the browser; TV playback sends media only
  through the computer-hosted LAN companion service to the paired TV.
- TV seek/restart and subtitle options work through the existing TV player.
- No filesystem path, blob URL, or playback ticket enters catalogue/history
  storage or logs; TV requests use authorized LAN media endpoints.
- Active TV playback survives browser navigation/closure while the computer
  service remains running, and hosted files are cleaned up after release/expiry.
- Browser limitations have clear messages, and existing VOD/Tizen flows pass
  regression checks.

## Deferred follow-ups

Persistent resume can later save metadata/progress with an explicit reselect
flow and collision handling. Wider MKV/codec support would require a separate
local demux/transcode design. Direct filesystem registration could later avoid
the temporary staging copy through a native computer file-selection flow.
Browser transport controls for TV and directory libraries can follow later.
Computer-hosted TV streaming is part of this implementation, not deferred.
