# Verification

## Automated checks

Run from the repository root:

```sh
npm run check
npm run build
npm run build:tizen
npm run build:tizen:6
```

`check` typechecks the app/configuration and runs unit tests. Fixtures must be synthetic; never put private playlists, credentials, signed media URLs, or provider payloads in tests or logs. Successful builds do not establish physical-TV compatibility. Test totals are intentionally not recorded here because they change with the suite.

For documentation-only changes, check links, script names, and claims against source; no personal playlist or TV session is needed.

## Legacy UI preview

Start Docker Desktop, then use `npm run preview:chromium47` for a standard preview or `npm run preview:chromium47:personal` for the established local flow with private `.env` defaults. The preview enables TV layout/navigation while retaining browser video playback; it does not emulate AVPlay or Samsung APIs.

1. Give the noVNC canvas keyboard focus once, then use only arrows, Enter and Escape/Back for the app.
2. Open VOD from Home. Visit Recent, Movies, Series, Search and Settings; test a populated list, page changes, details, episode selection and Back.
   On the web app, pair a TV from Settings, return Home, open a local video,
   and verify the in-memory TV selection survives route changes and file
   replacement. Local details must appear before playback; test computer
   playback, subtitle replacement/on-off/offset, TV staging/preparation progress and cancellation,
   automatic preferred-language subtitles for a release-style episode filename,
   seek/restart, remote stop, and ended-session restart with generated media.
3. Check visible focus, poster/fallback alignment, loading/empty/error states, and focus restoration. The TV title list should be one bounded column with fixed surrounding controls.
4. Check 1280×720 and 1920×1080. Chromium 47 needs static-color/flexbox fallbacks and margin/padding spacing; flex `gap` cannot be the only spacing rule.
5. Exercise the changed behavior, then stop and remove the temporary build with `npm run preview:chromium47 -- stop`.

Keep personal previews local and their embedded credentials out of screenshots/logs. Use the personal preview for user-visible catalogue/artwork work when configured; synthetic checks remain independent of it. Also check modern browser layouts at 1440×900, 390×844 and 320×568 for overflow and readable controls.

## Regression checklist

Choose the rows affected by a change; automated fixtures cover many of these boundaries.

| Area | What to verify |
| --- | --- |
| Import/storage | Unknown entries and evidence survive reopen; year sorting includes unknown years; interrupted staged imports preserve the ready generation; blocked upgrades offer retry |
| Legacy fetch | Missing, compressed or oversized whole-response lengths fail before buffering; permitted small responses work; streamed readers cancel on early termination |
| Provider requests | Duplicate category names retain distinct IDs; reverse-order responses cannot replace the active selection; Back during loading does not reopen a view |
| Configuration | Denied local storage falls back safely; reset and confirmations behave deliberately; errors never expose URLs or credentials |
| VOD playback | Loading/buffering/pause/end/error, resume, subtitle timing/size, fullscreen shortcuts and replacement-session cleanup |
| Navigation | [Navigation contract](navigation.md), held keys, page edges, Resume/Remove pairs, red-key favourites, editing and conditional Settings controls |
| Search | M3U local search and Xtream refresh/cache work without a TV; account caches stay isolated; results open details and Back restores Search |
| LAN relay | Multiple named TVs remain isolated; browser target selection reaches only the selected TV; reconnect preserves pairing; pairing reset and re-pair work; matching movie/episode commands work; TLS/self-signed trust succeeds on target hardware; stopping `dev:personal` stops both services |
| Live TV | Cached categories/channels, missing EPG, current/next programme changes, rapid tuning, endpoint behavior, retry, live buffer when available, and return focus |
| Live subtitle relay | Automatic Multi-Sub routing in personal TV builds; credential-free public output; pinned startup and acknowledgement; captions/languages/off; two bounded reconnects; old-session teardown before replacement or direct fallback |

Use alternate ports for relay tests when an existing development/TV session is active.

## Browser live subtitles

Use an authorized MPEG-TS feed known to contain DVB subtitle packets. Run sustained playback with an advancing video clock, Finnish/English automatic selection, channel changes, and teardown. An advertised PID or a “Multi-Sub” label alone does not establish packet availability.

Test no track, advertised-but-inactive PID, and worker failure: video and controls must remain usable, and no worker, HLS listener, canvas or retained fragment should remain after leaving playback. Record only numeric counts/timing and sanitized outcomes. See [decoder limits and historical observations](live-dvb-subtitles.md).

## Hosted live subtitle relay

Use [local setup](live-subtitle-relay.md) or the [deployment handoff](live-subtitle-relay-deployment.md), depending on the environment. This is separate from the trusted-LAN companion.

```sh
npm run relay:test
npm run relay:smoke
npm run relay:local
```

The synthetic pipeline checks a single source connection, three-chunk pinned startup, authenticated playback acknowledgement, rolling handoff, cue/PNG timing, language/off, heartbeat and teardown. Request tests simulate a pause longer than 20 seconds, idle-window reset and the 90-second body timeout. They do not verify AVPlay or the new UI reconnect lifecycle on hardware.

For the personal TV check, run `npm run relay:personal` and install a freshly prepared/signed personal package. Confirm marked Multi-Sub channels automatically use the relay, other channels remain direct, and no manual credential/mapping entry is needed. Test saved override/opt-out precedence separately. Never expose personal credentials in screenshots or public builds.

Check `progress=local`, `ack=confirmed`, advancing `playheadMs`, `bufferEvents`, captions/language/off, audio selection and normal/fullscreen placement. Induce a source or service interruption: after established playback, the app should show `Subtitle relay · Reconnecting…`, close the old session, open a fresh session and reset subtitle timing. It permits two reconnect attempts per selected channel before direct fallback; changing channel or Retry resets the budget. Initial setup failure falls back after cleanup, and a failed close must prevent replacement playback. Rapid channel changes/exit during recovery must not leave an obsolete session or native player active. Fallback must not start an extra provider TS audio-language probe.

Mac logs report `inputIdleMs` and fixed failure reasons such as `upstream-ended` or `upstream-idle-timeout`. Record sanitized outcomes without URLs, tokens, capability paths or transport payloads. Avoid a second real provider stream while testing an active TV session unless account capacity is known.

Local real-TV playback was accepted as good enough on 2026-10-03, with Sky Showtime 1 more stable than 2. Measured cue accuracy/drift and a sustained soak remain outstanding; keep `clock=unverified` until measured. On 2026-10-03 the signed personal Tizen 3 package was installed and the user confirmed hosted playback works on Tizen, establishing basic HTTPS trust/playback with the Mac relay stopped. Server session cleanup and restart/dependency checks passed; detailed TV controls/recovery, sustained capacity and soak results remain unrecorded. A successful container healthcheck does not prove upstream channel availability.

## Physical-TV release check

Prepare, sign, collect and install the correct target using [the Tizen guide](../tizen/README.md). Previous targets were UE75MU8005 (Tizen 3) and QE65Q70AATXXH (Tizen 6); record the actual model, firmware, build and results for each run.

1. Confirm startup, migration/retry, offline Home, and repeated Live/VOD round trips.
2. Navigate lists, sorting, pages, series episodes, Settings and confirmations using only the remote. Check red-key registration, held-key release, focus restoration and response time.
3. Verify VOD AVPlay sizing, loading/buffering/error states, play/pause, seek, aspect, resume and subtitle overlays. Check hidden/visible fullscreen controls separately.
4. Tune representative live streams, switch rapidly and leave during loading. Run a sustained playback/switching soak. Check EPG failure does not block tuning and live playback writes no Continue Watching entry.
5. Verify AVPlay Finnish/English embedded track selection on streams carrying them. Browser subtitle results do not establish TV support.
6. Confirm Tizen 3's dark colors, flex layouts, bounded list, spacing and yellow focus at native resolution.

Hardware playback, long-running stability and measured remote responsiveness remain release checks until recorded on the target device.
