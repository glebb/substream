# Verification

## Automated checks

Run from the repository root:

```sh
npm run check
npm run build
npm run build:tizen
```

Use synthetic data only. The check command includes React TSX, Vite configuration, catalogue migrations, import limits, configuration-storage denial, playback adapters, and the credential-safe playlist-inspection helper. Standard builds do not inject personal configuration. Packaging and target-TV testing are separate from build verification.

## Default personal Chromium 47 verification

Use this as the main end-to-end verification after implementing any user-visible change. It exercises the actual personal catalogue, TMDb artwork, legacy JavaScript/CSS bundle, and remote-navigation path together. It complements—not replaces—`npm run check`, whose fixtures must remain synthetic.

1. Confirm Docker Desktop is running, then run `npm run check`.
2. Start the local personal preview with `npm run preview:chromium47:personal`. This creates a temporary local Chromium 47 container using the supported values in the ignored `.env` file.
3. In noVNC, navigate the app with keys only: use Arrow keys for movement, Enter/Return for the remote Action key, Back/Escape for Back, and the Red key where the scenario calls for it. Do not use the mouse, trackpad, or noVNC touch controls to choose tabs, categories, titles, settings, or player controls. A one-time click to give the noVNC canvas keyboard focus is outside the app and is acceptable.
4. From Recent, use keys to visit Movies and Series, open a populated category, move through several titles, change page with Left/Right, open title details, and return. Confirm the yellow focus treatment and focus restoration after Back.
5. On at least one populated movie or series list, confirm poster cards appear without blocking navigation. Confirm a title with no resolved artwork retains the same fixed artwork space and a letter fallback, so its row/card aligns with poster-backed entries. Revisit a details page and its browse list to confirm artwork remains available from cache.
6. Inspect every newly added visual separation in the Chromium 47 preview. Chromium 47 does not apply `gap` between flex items, even though modern browsers do. Use explicit margin or padding as the legacy baseline for space between cards, artwork, text, and controls; treat `gap` only as an optional modern enhancement.
7. Exercise the changed behaviour, then use `npm run preview:chromium47 -- stop` to stop the container and remove its temporary personal build.

Keep the personal preview local. Never print, paste into notes, capture in logs, or commit the playlist URL, API keys, tokens, signed media URLs, or the generated personal bundle. If the preview needs a new private network permission or provider action beyond the established local flow, obtain approval before running it.

## High-priority regression scenarios

- Import a synthetic playlist containing a movie, a live channel, and an unclassified URL. Close and reopen IndexedDB. Confirm the unknown record and its evidence survive separately from the VOD catalogue; verify the movie has classification evidence.
- Upgrade a version-5 synthetic database with known and unknown release years. Browse by descending year across page boundaries: every record appears exactly once and unknown years are last.
- Browse a provider category with more than 100 titles. Change sort and page without refetching or querying the local M3U catalogue. Repeat with a series containing more than 100 episodes.
- Delay two category requests and complete them in reverse order. Only the latest selection should display. Repeat with an episode request and Back while loading.
- Reject a local catalogue query. Confirm a sanitized, recoverable status appears and the database connection closes.
- Exercise legacy playlist responses without streaming: missing, oversized, or compressed size declarations must be refused before buffering. Small permitted responses must import; streamed responses must cancel their reader after early termination.
- Replace a ready catalogue, then force a staged write to fail. The old generation must remain browseable and metadata must not retain a pending generation. Repeat with provider categories that share a display name but have different IDs.
- Deny local-storage access and confirm bundled defaults remain usable. Drive browser and AVPlay adapters through loading, buffering, pause, completion, synchronous setup failure, and replacement-stream callbacks.
- Inspect a synthetic oversized response and a failing response whose error includes a signed-looking URL. The inspection diagnostic must contain neither URL nor provider-controlled metadata.
- With synthetic Xtream catalogue responses, test Search normalization, deterministic ordering, result limits, per-source IndexedDB cache isolation, offline-cache search, malformed record rejection, and refresh behavior. Confirm refresh uses the browser-configured Xtream source without consulting TV/relay state, and cached/API records contain no credentials or playable URLs.
- With a synthetic imported M3U playlist, search entries from the browser's local catalogue with the relay stopped and no TV configured. Confirm normal M3U import/refresh makes the updated entries searchable.
- With a synthetic Xtream source, use the integrated Search tab in the normal web app. Select a result and confirm it opens shared title details; Back returns to Search. Verify **Play here** uses the browser provider connection and **Play on TV** sends a movie command. For a series, select an episode and confirm the command includes the series and episode IDs. Reject stale sessions, mismatched source fingerprints, and episodes that do not belong to their series.
- With no TV configured and the relay stopped, verify web Search refreshes from a synthetic browser-configured Xtream source, searches its saved cache offline, and searches an imported M3U catalogue. Confirm Search status describes its provider/cache source without indicating that TV is required.
- Start the LAN relay and TV app, then confirm the TV registers and renews its session before the 30-minute expiry. Start the relay after the TV and confirm the TV reconnects. Confirm **Play on TV** is unavailable until relay and TV are reachable and that Search and **Play here** continue to work when they are unavailable. Confirm the relay serves the built web app at its root and API routes remain under `/api`.
- Run `npm run dev:personal` and confirm both Vite and the LAN relay start. In web Settings, check that the relay reports no TV until one connects, then reports a matching provider after the TV registers. Stop the command with Ctrl+C and confirm neither service remains listening. Use alternate test ports if the normal development ports are already in use; do not interrupt an active TV session for this check.

## Physical-TV smoke check

For browser live DVB subtitles, use a local release build and an authorized
MPEG-TS live feed known to carry subtitle packets. Confirm Finnish selection,
English fallback, Off, an advancing video clock, and captions after channel
changes. Repeat with no advertised track, an advertised but inactive PID, and
a subtitle worker failure; video and controls must remain responsive and no
worker, HLS listener, or canvas may remain after leaving playback. A channel
label such as `Multi-Sub` is not proof that its current media segments carry
subtitle packets. Record only numeric counts and timing, never provider URLs,
credentials, or transport data. Physical AVPlay subtitle selection needs its
own TV check.

Use a separate synthetic test playlist/provider where practical; do not print personal URLs or credentials in diagnostics.

Build and deploy with the verified VS Code flow in [`tizen/README.md`](../tizen/README.md): `prepare`, sign in VS Code, `collect`, then `launch` with the TV IP. For the QE65Q70AATXXH, test `tizen6.wgt`; it intentionally uses the legacy/SystemJS entry to avoid Tizen 6's modern-module splash-screen failure.

Browse-grid focus rules and the safe change checklist are documented in [navigation.md](navigation.md).

For the UI, include a visual/focus smoke pass at 1920x1080 and 1440x900, plus compact 390x844 and 320x568 sizes. Confirm the selected tab and yellow focus ring remain distinct, Search input/results and provider/cache status stay readable, and no-TV status does not block Search. Check that settings and confirmation panels stay centered and the player shows OpenSubtitles setup only when no key is configured. At widths below 520px, verify category CSS is one column and Up/Down/Left/Right follow the one-column helper without horizontal overflow.

On Continue Watching, verify Up/Down moves to the next or previous title while preserving Resume/Remove, and Left/Right changes only within its pair. In Settings, verify every action, API-key editor control, and confirmation action carries the persistent yellow focus highlight. On web, verify Space toggles playback only from the active video area or fullscreen; on Tizen, verify the Action/Enter key does the same.

On the UE75MU8005, confirm the Tizen 3 payload uses the static dark surface colors, visible yellow remote focus ring, and four-column flexbox category layout instead of native white button styling. Verify the bounded single-column title-list viewport, adjacent Up/Down movement, throttled held-key repeat, Left/Right page jumps, AVPlay display sizing, focus, and Back behavior.

On a synthetic title, verify fullscreen controls hidden: Left/Right seek, Up/Down reveal controls with Play/Pause focused, Enter toggles playback, and Back exits fullscreen. With controls visible, verify arrows move through visible controls, Enter activates the highlighted button, Back hides controls and returns focus to video, and dedicated media keys still work. Confirm editable subtitle fields keep their text cursor and editing behavior.

1. Install a freshly packaged build on the UE75MU8005 and confirm startup and the IndexedDB version-7 migration complete.
2. Navigate categories, sorting, Previous/Next, series episodes, and Back using only the TV remote.
3. Trigger Back while a category is loading; confirm delayed data does not reopen it.
4. Verify year sorting includes a title with no year and the last page has correct navigation controls.
5. Check a small legacy M3U import and an import refused by the fallback limit. The refusal should explain the limitation rather than freezing the app.
6. Play a synthetic/sample title, confirm loading/buffering/playing/paused/completed/error states are accurate, then change titles during subtitle activity and verify playback/subtitle state belongs to the current title.

Record the device/build and actual results when performing this checklist. Automated tests and successful builds alone do not establish target-TV compatibility.

## Catalogue startup recovery

A version upgrade can take time for a large saved M3U catalogue. The startup screen reports migrated row counts; allow it to finish. If another open connection blocks the upgrade, the app shows an actionable error with **Try again**, rather than leaving an indefinite loading screen. Existing adapter connections close on version change, and late connections from rejected opens are closed automatically. No catalogue reset is needed for this recovery.
