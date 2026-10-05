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

Changes to settings, credential storage, transport, API clients, helper services,
logging or deployment must preserve the [mandatory client credential
policy](client-credential-policy.md). For credential-routing changes, verify
destinations and payloads with synthetic values, including error/retry paths;
Substream and helper endpoints must not receive client provider/API credentials.

## Legacy UI preview

Start Docker Desktop, then use `npm run preview:chromium47` for a standard preview or `npm run preview:chromium47:personal` for the established local flow with private `.env` defaults. The preview enables TV layout/navigation while retaining browser video playback; it does not emulate AVPlay or Samsung APIs.

1. Give the noVNC canvas keyboard focus once, then use only arrows, Enter and Escape/Back for the app.
2. Open VOD from Home. Visit Favourites, Recent, Movies, Series, Search and Settings; test a populated list, page changes, details, episode selection and Back.
   On the web app, pair a TV from Settings, return Home, open a local video,
   and verify the in-memory TV selection survives route changes and file
   replacement. Local details must appear before playback; test computer
   playback, subtitle replacement/on-off/offset, TV staging/preparation progress and cancellation,
   automatic preferred-language subtitles for a release-style episode filename,
   seek/restart, remote stop, and ended-session restart with generated media.
3. Check visible focus, poster/fallback alignment, loading/empty/error states, and focus restoration. TV category and title lists should fill a bounded viewport with fixed surrounding controls. Check larger short-list rows, four-column title cards, and three-column category cards at 1280px. Settings must start on TV connection; arrows focus editor triggers and OK opens the editor. In Search, Down enters the editor trigger, Enter begins editing, Back restores the trigger, and Down reaches Refresh then results.
   In both TV preview and ordinary browser mode, navigate title → Sort/Refresh → previous action → Main menu using Up/Right, then return with Down. Confirm Sort opens only on OK, Back cancels, and refreshing Latest preserves header focus. Test two fresh Up presses without an intervening keyup.
4. Check 1280×720 and 1920×1080. Chromium 47 needs static-color/flexbox fallbacks and margin/padding spacing; flex `gap` cannot be the only spacing rule.
5. Exercise the changed behavior, then stop and remove the temporary build with `npm run preview:chromium47 -- stop`.

Keep personal previews local and their embedded credentials out of screenshots/logs. Use the personal preview for user-visible catalogue/artwork work when configured; synthetic checks remain independent of it. Also check modern browser layouts at 1440×900, 390×844 and 320×568 for overflow and readable controls.

## Regression checklist

Choose the rows affected by a change; automated fixtures cover many of these boundaries.

| Area | What to verify |
| --- | --- |
| Runtime/adapters | TV profile works without Samsung globals; denied or injected storage/transport remain isolated; screens use factory-selected players |
| Import/storage | Independent catalogue sessions can open/close concurrently; unknown entries and evidence survive reopen; year sorting includes unknown years; interrupted staged imports preserve the ready generation; blocked upgrades offer retry |
| Legacy fetch | Missing, compressed or oversized whole-response lengths fail before buffering; permitted small responses work; streamed readers cancel on early termination |
| Provider requests | Duplicate category names retain distinct IDs; reverse-order responses cannot replace the active selection; Back during loading does not reopen a view |
| Configuration | Denied local storage falls back safely; reset and confirmations behave deliberately; errors never expose URLs or credentials |
| Playback lifecycle | Live/VOD round trips; late callbacks ignored; failed cleanup blocks acquisition until explicit Retry succeeds; no overlapping player/provider sessions |
| VOD playback | Loading/buffering/pause/end/error, resume, subtitle timing/size, fullscreen shortcuts and replacement-session cleanup |
| Navigation | [Navigation contract](navigation.md), held keys, page edges, Resume/Remove pairs, red-key favourites, editing and conditional Settings controls |
| Search | Browser and TV M3U local search and Xtream refresh/cache work without companion pairing; account caches stay isolated; results open details and Back restores Search |
| Companion | Disabled connection starts no network/timers; enabled connection receives commands from Home/Live/VOD; outage leaves normal browsing/playback usable; disable clears pending commands |
| LAN companion | Multiple named TVs remain isolated; browser target selection reaches only the selected TV; reconnect preserves pairing; pairing reset and re-pair work; matching movie/episode commands work; TLS/self-signed trust succeeds on target hardware; stopping `dev:personal` stops both services |
| Live TV | Cached categories/channels, missing EPG, current/next programme changes, rapid tuning, endpoint behavior, retry, live buffer when available, and return focus |
| Live subtitle relay | Automatic Multi-Sub routing in personal TV builds; credential-free public output; pinned startup and acknowledgement; captions/languages/off; two bounded reconnects; old-session teardown before replacement or direct fallback |

Use alternate ports for relay tests when an existing development/TV session is active.

## Browser live subtitles

Use an authorized MPEG-TS feed known to contain DVB subtitle packets. Run sustained playback with an advancing video clock, Finnish/English automatic selection, channel changes, and teardown. An advertised PID or a “Multi-Sub” label alone does not establish packet availability.

Test no track, advertised-but-inactive PID, and worker failure: video and controls must remain usable, and no worker, HLS listener, canvas or retained fragment should remain after leaving playback. Record only numeric counts/timing and sanitized outcomes. See [decoder limits and historical observations](live-dvb-subtitles.md).

## Hosted live subtitle relay

Use [local setup](live-subtitle-relay.md) or the [deployment guide](live-subtitle-relay-deployment.md), depending on the environment. This is separate from the trusted-LAN companion.

```sh
npm run relay:test
npm run relay:smoke
npm run relay:local
```

The synthetic pipeline checks a single source connection, three-chunk pinned startup, authenticated playback acknowledgement, rolling handoff, cue/PNG timing, language/off, heartbeat and teardown. Request tests simulate a pause longer than 20 seconds, idle-window reset and the 90-second body timeout. Controller tests cover retry/fallback, stale events and cleanup ordering. These checks do not verify AVPlay or UI recovery on hardware.

For a local personal TV check, start `npm run relay:personal` with matching local defaults and install a freshly prepared/signed personal package. For a hosted check, preserve the hosted HTTPS defaults and use the deployment guide; the Mac relay is unnecessary. Confirm marked Multi-Sub channels automatically use the relay, other channels remain direct, and no manual credential/mapping entry is needed. Test saved override/opt-out precedence separately. Never expose personal credentials in screenshots or public builds.

Check `progress=local`, `ack=confirmed`, advancing `playheadMs`, `bufferEvents`, captions/language/off, audio selection and normal/fullscreen placement. Induce a source or service interruption: after established playback, the app should show `Subtitle relay · Reconnecting…`, close the old session, open a fresh session and reset subtitle timing. It permits two reconnect attempts per selected channel before direct fallback; changing channel or Retry resets the budget. Initial setup failure falls back after cleanup, and a failed close must prevent replacement playback. Rapid channel changes/exit during recovery must not leave an obsolete session or native player active. Fallback must not start an extra provider TS audio-language probe.

Mac logs report `inputIdleMs` and fixed failure reasons such as `upstream-ended` or `upstream-idle-timeout`. Record sanitized outcomes without URLs, tokens, capability paths or transport payloads. Avoid a second real provider stream while testing an active TV session unless account capacity is known.

Historical local and hosted Tizen playback was accepted on 2026-10-03. It establishes basic HTTPS trust/playback for those installed builds. A fresh personal package was subsequently reported installed after the architecture refactor, but physical-TV playback acceptance remains pending. Measured cue accuracy/drift, detailed recovery/control checks and a sustained soak remain outstanding; keep `clock=unverified` until measured. See [deployment](live-subtitle-relay-deployment.md) for the recorded hosted state. A successful process healthcheck does not prove upstream channel availability.

## Physical-TV release check

Prepare, sign, collect and install the correct target using [the Tizen guide](../tizen/README.md). Previous targets were UE75MU8005 (Tizen 3) and QE65Q70AATXXH (Tizen 6); record the actual model, firmware, build and results for each run.

1. Confirm startup, migration/retry, offline Home, and repeated Live/VOD round trips with companion and subtitle relay disabled. Enable each integration separately and repeat outage/recovery checks.
2. Navigate Search, lists, sorting, pages, series episodes, Settings and confirmations using only the remote. Check red-key registration, held-key release, focus restoration and response time.
3. Verify VOD AVPlay sizing, loading/buffering/error states, play/pause, seek, aspect, resume and subtitle overlays. Check hidden/visible fullscreen controls separately.
4. Tune representative live streams, switch rapidly and leave during loading. Run a sustained playback/switching soak. Check EPG failure does not block tuning and live playback writes no Continue Watching entry.
5. Verify AVPlay Finnish/English embedded track selection on streams carrying them. Browser subtitle results do not establish TV support.
6. Confirm Tizen 3's dark colors, flex layouts, bounded list, spacing and yellow focus at native resolution.

Hardware playback, long-running stability and measured remote responsiveness remain release checks until recorded on the target device.
