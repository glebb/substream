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
| LAN relay | TV auto-registers/reconnects and renews sessions; matching movie/episode commands work; mismatches/stale sessions fail; stopping `dev:personal` stops both services |
| Live TV | Cached categories/channels, missing EPG, current/next programme changes, rapid tuning, endpoint behavior, retry, live buffer when available, and return focus |

Use alternate ports for relay tests when an existing development/TV session is active.

## Browser live subtitles

Use an authorized MPEG-TS feed known to contain DVB subtitle packets. Run sustained playback with an advancing video clock, Finnish/English automatic selection, channel changes, and teardown. An advertised PID or a “Multi-Sub” label alone does not establish packet availability.

Test no track, advertised-but-inactive PID, and worker failure: video and controls must remain usable, and no worker, HLS listener, canvas or retained fragment should remain after leaving playback. Record only numeric counts/timing and sanitized outcomes. See [decoder limits and historical observations](live-dvb-subtitles.md).

## Physical-TV release check

Prepare, sign, collect and install the correct target using [the Tizen guide](../tizen/README.md). Previous targets were UE75MU8005 (Tizen 3) and QE65Q70AATXXH (Tizen 6); record the actual model, firmware, build and results for each run.

1. Confirm startup, migration/retry, offline Home, and repeated Live/VOD round trips.
2. Navigate lists, sorting, pages, series episodes, Settings and confirmations using only the remote. Check red-key registration, held-key release, focus restoration and response time.
3. Verify VOD AVPlay sizing, loading/buffering/error states, play/pause, seek, aspect, resume and subtitle overlays. Check hidden/visible fullscreen controls separately.
4. Tune representative live streams, switch rapidly and leave during loading. Run a sustained playback/switching soak. Check EPG failure does not block tuning and live playback writes no Continue Watching entry.
5. Verify AVPlay Finnish/English embedded track selection on streams carrying them. Browser subtitle results do not establish TV support.
6. Confirm Tizen 3's dark colors, flex layouts, bounded list, spacing and yellow focus at native resolution.

Hardware playback, long-running stability and measured remote responsiveness remain release checks until recorded on the target device.
