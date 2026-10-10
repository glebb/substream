# Verification

## Automated checks

Run from the repository root:

```sh
npm run check
npm run build
npm run build:tizen
npm run build:tizen:6
npm run build:webos
npm run package:webos
```

`check` typechecks the app/configuration and runs unit tests. Fixtures must be synthetic; never put private playlists, credentials, signed media URLs, or provider payloads in tests or logs. Successful builds do not establish physical-TV compatibility. Test totals are intentionally not recorded here because they change with the suite.

For documentation-only changes, check links, script names, and claims against source; no personal playlist or TV session is needed.

Changes to settings, credential storage, transport, API clients, helper services,
logging or deployment must preserve the [mandatory client credential
policy](client-credential-policy.md). For credential-routing changes, verify
destinations and payloads with synthetic values, including error/retry paths;
Substream and helper endpoints must not receive client provider/API credentials.

LG clean packages intentionally ignore `.env` defaults and development proxy
settings. The explicit `build:webos:personal` and `package:webos:personal`
commands embed the configured client defaults and write to ignored private
directories. Keep that personal `.ipk` private. In either build, provider,
OpenSubtitles, and TMDb requests must remain direct from the TV to their intended
services; do not route those credentials through companion or relay services.
See [LG packaging](../webos/README.md) for the command and output paths.

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
| HTML-video recovery | Native/HLS/remux transient failures get at most three retries with 1/2/4-second backoff; VOD/remux retain position; time advancement ends recovery and startup deadlines bound stale ready-state flags; intentional pause cancels startup/buffering deadlines and retries, and resume arms a fresh startup deadline; replacement/disposal cancel retries; permanent format/decode failures stay terminal |
| Navigation | [Navigation contract](navigation.md), held keys, page edges, Resume/Remove pairs, red-key favourites, editing and conditional Settings controls |
| Search | Browser and TV M3U local search and Xtream refresh/cache work without companion pairing; account caches stay isolated; results open details and Back restores Search |
| Companion | Disabled connection starts no network/timers; enabled connection receives commands from Home/Live/VOD; outage leaves normal browsing/playback usable; disable clears pending commands |
| LAN companion | Multiple named TVs remain isolated; browser target selection reaches only the selected TV; reconnect preserves pairing; pairing reset and re-pair work; matching movie/episode commands work; TLS/self-signed trust succeeds on target hardware; stopping `dev:personal` stops both services |
| Live TV | Cached categories/channels, missing EPG, current/next programme changes, rapid tuning, endpoint behavior, retry, live buffer when available, and return focus |
| SkyShowtime guide | Replacement is authoritative even when empty/failed; no provider EPG or DNA fallback; old caches without replacement provenance are ignored; TV requests are direct and hosted browser requests use `/public/nordic-epg` without a companion; deadline, retry and twelve-minute feed refresh work |
| Live subtitle relay | Dynamic DVB detection for Finnish live channels in relay-enabled TV builds; credential-free public output; pinned startup and acknowledgement; captions/languages/off; two bounded reconnects; old-session teardown before replacement or direct fallback |

Use alternate ports for relay tests when an existing development/TV session is active.

Pairing-reset tests must cover an in-flight old poll, sequence-1 delivery after
reset, a failed reset retaining the existing sequence, and disabling or changing
the connection while reset is pending. LG credential-boundary fixtures cover
service-scoped pairing auth, locally resolved provider streams and rejected
foreign selections; helper requests must contain no provider/API credentials.

Run `npm run test:web-integration` on Linux with Nginx/OpenSSL for host-route
changes. Its synthetic public-guide upstream checks both HTTP and HTTPS routes,
fixed destination, caller-header stripping, query/method rejection and upstream
cookie suppression. The fixture does not contact the publisher or establish
production TLS/feed availability. Static packaging does not install the Nginx
template; check host configuration separately when releasing this route.

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

For a local personal TV check, start `npm run relay:personal` with matching local defaults and install a freshly prepared/signed personal package. For a hosted check, preserve the hosted HTTPS defaults and use the deployment guide; the Mac relay is unnecessary. Refresh the private relay allowlist to include all Finnish IDs. Confirm unmarked MTV Viihde and Sky Showtime feeds use the relay, and usable DVB tracks appear dynamically from that same upstream. Verify no provider-media preflight occurs, channels without usable subtitles retain relay video, relay opt-out stays direct, and session requests contain IDs rather than provider URLs. Test saved override/opt-out precedence separately. Never expose personal credentials in screenshots or public builds.

Check `progress=local`, `ack=confirmed`, advancing `playheadMs`, `bufferEvents`, captions/language/off, audio selection and normal/fullscreen placement. Induce a source or service interruption: after established playback, the app should show `Subtitle relay · Reconnecting…`, close the old session, open a fresh session and reset subtitle timing. It permits two reconnect attempts per selected channel before direct fallback; changing channel or Retry resets the budget. Initial setup failure falls back after cleanup, and a failed close must prevent replacement playback. Rapid channel changes/exit during recovery must not leave an obsolete session or native player active. Fallback must not start an extra provider TS audio-language probe.

Mac logs report `inputIdleMs` and fixed failure reasons such as `upstream-ended` or `upstream-idle-timeout`. Record sanitized outcomes without URLs, tokens, capability paths or transport payloads. Avoid a second real provider stream while testing an active TV session unless account capacity is known.

Historical local and hosted Tizen playback was accepted on 2026-10-03. It establishes basic HTTPS trust/playback for those installed builds. A fresh personal package was subsequently reported installed after the architecture refactor, but physical-TV playback acceptance remains pending. Measured cue accuracy/drift, detailed recovery/control checks and a sustained soak remain outstanding; keep `clock=unverified` until measured. See [deployment](live-subtitle-relay-deployment.md) for generic host setup; actual deployment records stay in ignored local notes. A successful process healthcheck does not prove upstream channel availability.

## Physical-TV release check

Prepare, sign, collect and install the correct target using [the Tizen guide](../tizen/README.md). Previous targets were UE75MU8005 (Tizen 3) and QE65Q70AATXXH (Tizen 6); record the actual model, firmware, build and results for each run.

1. Confirm startup, migration/retry, offline Home, and repeated Live/VOD round trips with companion and subtitle relay disabled. Enable each integration separately and repeat outage/recovery checks.
2. Navigate Search, lists, sorting, pages, series episodes, Settings and confirmations using only the remote. Check red-key registration, held-key release, focus restoration and response time.
3. Verify VOD AVPlay sizing, loading/buffering/error states, play/pause, seek, aspect, resume and subtitle overlays. Check hidden/visible fullscreen controls separately.
4. Tune representative live streams, switch rapidly and leave during loading. Run a sustained playback/switching soak. Check EPG failure does not block tuning and live playback writes no Continue Watching entry.
5. Verify AVPlay Finnish/English embedded track selection on streams carrying them. Browser subtitle results do not establish TV support.
6. Confirm Tizen 3's dark colors, flex layouts, bounded list, spacing and yellow focus at native resolution.

Hardware playback, long-running stability and measured remote responsiveness remain release checks until recorded on the target device.

## LG webOS physical-TV check

The initial device check on 2026-10-10 showed webOS 25 / Chromium 120,
18 live categories loaded from personal defaults, and 1080p live video. The
user confirmed picture, sound and basic operation. A later companion smoke
check on 2026-10-10 deployed and launched the personal app, observed automatic
connection to the Mac companion, paired a temporary browser, and played one
browser-staged synthetic 60-second H.264/AAC MP4 on the TV. The TV video element
reached `readyState` 4 at 320×180 and advanced to about 7.8 seconds while
playing without an error. A stop command was accepted and removed the TV video
element and synthetic title without an error. Pairing reset then produced a
fresh code while the receiver remained connected and unpaired. Re-pairing
accepted a new sequence-1 local-play command; the second synthetic file played
without error, and a second reset left a fresh code visible. This confirms a
narrow pairing-reset/re-pair path; it does not establish provider-command
resolution, subtitle transfer, seek, broad codec support, or general
network/standby and full remote/lifecycle acceptance.

Build clean and personal packages separately. Configure the official LG CLI
using a synthetic example device name in documentation and keep actual device
records and keys in ignored local files:

```sh
npm run build:webos
npm run package:webos
npm run install:webos -- --device examplewebos webos/packages/<generated-file>.ipk
npm run launch:webos -- --device examplewebos
npm run build:webos:personal
npm run package:webos:personal
npm run install:webos -- --device examplewebos webos/personal-packages/<generated-file>.ipk
npm run launch:webos -- --device examplewebos
```

On the TV, verify:

1. Clean and personal packages install and launch, and catalogue/settings
   persistence survives app close and relaunch. Confirm clean builds contain no
   personal defaults or local proxy settings.
2. Live category/channel browsing, first-channel playback, rapid channel
   changes, buffering/retry, and exit during startup. Record HLS, MP4, and
   provider MPEG-TS outcomes separately; do not infer support from the current
   successful channel.
3. VOD pause, seek, resume, end-of-media, next episode, audio selection, and
   embedded/external subtitle selection. Record which tracks and formats the
   TV actually exposes.
4. Magic Remote D-pad, pointer clicks and wheel scrolling, text entry, and
   transitions between pointer and focus navigation. Check Back (461) through
   overlays, player, lists, Home and the system keyboard. With the keyboard
   open, the first Back should dismiss it without navigating or closing the app.
5. Background/standby while playing, then return. Confirm playback resources
   are released while hidden, a previously playing session restores once, and
   a paused session remains paused until Play. After a full app relaunch, check
   for safe startup without duplicate players; do not assume a live session is
   restored across process termination. Repeat with network loss and return.
6. Pair the LG receiver with a browser and confirm reconnect and provider
   command delivery from Home/Live/VOD. Pairing and one browser-staged MP4
   playback and stop passed on 2026-10-10; provider identifiers resolving
   against the TV's saved playlist remain to be checked. Stage a local subtitle
   and check seek. Pairing reset/re-pair passed on 2026-10-10; repeat only if
   another reset implementation changes. Confirm the TV has no local-file
   picker and the Samsung live subtitle relay remains unavailable. Check that
   provider credentials go only to the provider, OpenSubtitles credentials only
   to OpenSubtitles, and TMDb credentials only to TMDb, with synthetic values
   when inspecting request destinations and retry paths.

Re-run `npm run check`, browser and Samsung builds after shared code changes.
LG engine support is model/firmware specific; a successful desktop build or
first-channel playback does not establish broad codec or embedded-track
support.
