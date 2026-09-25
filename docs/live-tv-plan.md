# Live TV and application home — implementation plan

Status: implemented for Xtream sources; automated browser and legacy builds pass. Physical-device playback verification remains an operator release check. September 25, 2026.

## Outcome and scope

Launch into a branded, interactive main menu with **Live TV** and **Video-On-Demand**. Live TV opens the configured provider's Finnish channels; selecting a channel starts playback. All existing catalogue features remain under Video-On-Demand. Both sections have a visible Main menu action and predictable Back navigation.

Phase one includes channel discovery, a fast channel list, playback, error recovery and navigation. EPG, catch-up, recording, time shifting, additional country categories, and live Play on TV relay commands are follow-ups. Finnish channels means channels in the provider's Finnish collections, including Swedish-language Finnish services; it does not mean only Finnish-language audio. Completeness is relative to the configured provider/account.

## Current implementation and implications

- `index.html` provides a static branded splash, replaced when React mounts. `App.tsx` then waits on catalogue initialization. Make the interactive home independent of VOD initialization so loading does not replace the menu.
- `App.tsx` owns browse, settings, details and player state. Introduce an explicit application navigation model instead of adding another set of overlapping booleans.
- `platform/xtream/client.ts` currently supports movies and series only. Add live endpoints behind that adapter and reuse its connection configuration and request handling.
- The M3U classifier recognizes live entries, but the catalogue builder/importer saves only VOD and unknown entries. Live support requires import and storage changes, not merely a UI filter.
- The media interface and UI assume VOD controls. Browser playback currently uses native HTML video; Tizen uses AVPlay. Share the session/UI and keep media transport decisions inside adapters.
- The existing navigation already has pure movement helpers, explicit focus and stale-request guards. Extend these mechanisms rather than creating a second navigation system.

## 1. Verify provider and playback feasibility first

Use the configured provider read-only, keeping credentials and media URLs out of logs and documentation. Extend the safe inspection tooling to report live category counts, Finnish matching results, classification reasons and format availability without exposing raw responses. Confirm `get_live_categories` and `get_live_streams` behavior, category identifiers, account availability, ordering, logos and usable HLS/TS variants. Do not assume an arbitrary `.m3u8` extension makes a valid stream.

Test representative authorized streams in the browser and on physical Tizen 3: startup, sustained playback, audio, channel switching and cleanup. Check browser CORS, HTTPS/mixed-content restrictions, playlist/segment/key access and codec compatibility. If direct playback fails, explicitly establish whether a narrowly scoped provider media proxy is required; the current development API proxy is not proof that media delivery works. A proxy cannot fix unsupported codecs without transcoding, which is outside this phase.

Deliverable: a credential-safe compatibility matrix and verified Finnish-category matching rules. This is a release dependency, not a reason to promise that every provider format plays everywhere.

## 2. Shared shell and beautiful launch menu

Build `AppHome` and an application shell, extracting the existing VOD flow into a focused feature boundary incrementally. Share Settings and the player host. Use typed routes such as home, VOD browse/details, live channels and player, with explicit return context. Keep each section's selection/page/scroll state when returning home.

Reuse the Substream splash artwork: dark cinematic background, subtle gradient for contrast, brand above two large cards, clear labels, short descriptions and a strong yellow focus border. Live TV appears first. Avoid background video, expensive blur and required animation. Wide layouts use two cards; narrow layouts stack them. Keyboard movement follows the visible arrangement. Use shared branding styles for the static launch placeholder and React home to avoid a visual flash or two competing designs. Static content must not pretend to be interactive before handlers are ready.

Render home immediately after application bootstrap; initialize storage asynchronously and load provider data only when needed. A VOD migration or provider outage should not prevent returning home. Setup, storage errors and retry actions retain an explicit return destination. On first launch focus Live TV; when returning focus the card last used. Do not autoplay on launch.

## 3. Live catalogue and persistence

Add pure types and selection rules in `src/core/live`: a live channel has stable source-scoped ID, provider stream/category IDs, display name, logo reference, provider order, optional EPG ID, and classification/country evidence. Keep country selection separate from live-versus-VOD classification. Do not apply movie/year normalization to channel names.

Add separate live category/channel methods to the Xtream adapter. Preserve provider IDs, validate responses and sanitize transport/parsing errors. Resolve playback URLs at the adapter boundary; never expose them in channel labels, diagnostic records or route IDs.

Match all verified Finnish categories using provider-scoped mappings and normalized metadata aliases, rather than the first matching group or a broad substring such as `fi`. Do not guess country from a bare channel name. Retain unmatched/ambiguous records for later classification. Deduplicate exact provider stream IDs across categories; preserve distinct HD/SD and other stream variants with readable labels.

Extend M3U import to classify each entry once and batch VOD, live and unknown records into their respective stores. Preserve existing VOD and unknown behavior and classification evidence. Retain non-Finnish live entries for future categories. Upgrade IndexedDB transactionally and use the existing generation promotion pattern so an interrupted refresh leaves the previous catalogue available. Existing imports require a refresh to recover live records previously discarded; do not pretend a schema migration can reconstruct them.

Scope live caches by provider/account, invalidate requests on source changes and keep live/VOD refresh lifecycles independent. Show cached channels immediately, refresh in the background and indicate stale/error states without clearing a usable list. Cache metadata; do not treat signed playback URLs as permanent identifiers.

## 4. Finnish channel list and navigation contract

Use the same single-column live list on browser and TV: header, Main menu, Finland label, channel count, compact logo/name/variant rows and optional local name filtering. Load logos lazily with a fallback. Use a bounded viewport and paged rendering, reusing focus/scroll helpers. Preserve provider order initially. Selecting a row starts playback directly, without a VOD-style details page. Merely moving focus must never tune a channel.

| Context | Shared behavior |
| --- | --- |
| Home | Arrows select cards; Enter/click opens; Back remains home. Tizen exit handling belongs only at this boundary. |
| Live list | Up/Down move one channel; Left/Right move pages when available; Enter tunes; Back returns home. |
| VOD | Existing internal Back hierarchy remains; Back at VOD root returns home. Main menu is directly available in the section header. |
| Live player | Up/Down reveal controls; Enter activates the focused action. Previous/Next channel are explicit shared controls. |
| Player Back | Close an open panel, then hide visible fullscreen controls, then return from playback to its originating list with focus restored. |
| Settings | Back returns to the route and control that opened Settings. |

Route browser keyboard, clicks and normalized Tizen keys into the same actions. Browser Escape and TV Return use the same Back resolver; browser history should also follow the route hierarchy without duplicate transitions. Keep text editing exceptions and held-key throttling. Do not repurpose hidden live-player Left/Right as VOD seeks. Register optional TV Channel Up/Down shortcuts only through the remote adapter; on-screen Previous/Next works everywhere. Channel navigation stops at list boundaries in phase one.

Switching sections stops playback. Going home preserves list context but releases the active player. Retain existing VOD player behavior unless a deliberate shared navigation change is covered by regression tests.

## 5. Shared playback with explicit live capabilities

Introduce a discriminated playback request (`vod` or `live`) and capabilities for seek, restart, pause and tracks. Reuse one player host, status overlay, audio/aspect controls, error UI and lifecycle. Keep VOD resume/history, TMDb and external subtitle search conditional on VOD; live viewing must never create Continue Watching records.

For phase-one live playback show channel name, LIVE indicator, Previous/Next, Stop/Back, fullscreen, supported audio options and Retry. Hide the duration bar, seek, restart and pause/time-shift actions on both platforms. Dedicated media keys must respect these capabilities too. A normal playing state returns after reconnecting; do not invent a movie completion event for a dropped live stream.

Browser adapter: native HLS where supported; otherwise a lazily loaded, pinned and tested HLS.js build when MSE/codecs are supported. Keep this dependency out of the AVPlay path. Verify the chosen dependency's generated syntax/runtime requirements against the legacy build; transpilation alone does not supply missing media APIs. Tizen adapter: use AVPlay with the verified provider format and clean stop/close/prepare transitions. Neither platform API belongs in `src/core`.

Channel changes cancel/invalidate the prior load and reconnect timer, release the previous media session and ignore stale callbacks. Allow only one active stream, including rapid switching and leaving during preparation. Use bounded retries with backoff for transient failures, followed by a clear Retry/Back state. Avoid retry loops for authentication or unsupported-format errors. Do not prebuffer adjacent channels because provider accounts may limit concurrent connections.

## 6. Compatibility, speed and validation

Use static colors and flexbox as the baseline, large TV-readable controls, explicit focus classes and minimal DOM updates. No essential CSS feature should depend on modern Grid, custom properties, backdrop filters or browser-native focus styling. Keep the existing Chrome 47 legacy build and verify new lazy chunks as well as the entry bundle.

Targets: home must not wait on the network; a cached section should open within 300 ms and visible focus should respond within 100 ms on the test TV. Record actual device measurements; measure provider-dependent time to first frame separately rather than claiming a guaranteed tune time.

Automated coverage uses synthetic fixtures only:

- Finnish matching, ambiguous records, multiple categories, duplicate IDs, variants, malformed metadata and evidence retention.
- Live provider requests, sanitized errors, account isolation, stale responses, migration and interrupted refresh recovery.
- Home and nested Back transitions, repeated keys, page boundaries, focus/scroll restoration and settings return context.
- Capability-driven controls, absence of live resume writes, switching races, retry cancellation, disposal and unchanged VOD playback.

Run `npm run check`, `npm run build` and `npm run build:tizen`. Smoke-test modern browsers with keyboard/mouse, the Chromium 47 preview at 1280×720 and 1920×1080, and physical Tizen 3 with its remote and AVPlay. The preview verifies legacy UI, not hardware playback. Exercise cold/warm start, offline startup, no Finnish channels, broken logos, unavailable streams, repeated Live/VOD round trips, held keys, rapid tuning and provider changes. Perform a sustained live playback and switching soak on the TV and check that resource use stays bounded.

Release acceptance: every verified Finnish provider entry is reachable; both sections return home reliably; returning from playback restores the channel/title; browser and TV share focus/action semantics; representative live streams pass on both platforms; all VOD regression checks pass. Document any unavailable provider variants accurately rather than marking unsupported playback successful.

## Delivery sequence

1. Provider/format feasibility and synthetic fixtures.
2. Application shell, branded home and VOD nesting, with navigation regression coverage.
3. Live model, provider adapter, Finnish selection, M3U import and cache migration.
4. Finnish channel view and complete shared focus/Back behavior.
5. Live playback capabilities, browser HLS support, AVPlay integration and recovery.
6. Legacy styling, browser/device verification, response measurements and updated navigation/status documentation.

Each step should remain independently reviewable. Extract only the shared shell, navigation, list and playback responsibilities needed for this feature; avoid a wholesale rewrite of the existing app.

## Compatibility references

- [Samsung web engine specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html): Tizen 3.0 uses Chromium M47.
- [HLS.js compatibility documentation](https://github.com/video-dev/hls.js#compatibility): MSE/native HLS support and media codecs determine browser playback feasibility.
