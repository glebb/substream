# Verification

## Automated checks

Run from the repository root:

```sh
npm run check
npm run build
npm run build:tizen
```

Use synthetic data only. The check command includes React TSX, Vite configuration, catalogue migrations, import limits, configuration-storage denial, playback adapters, and the credential-safe playlist-inspection helper. Standard builds do not inject personal configuration. Packaging and target-TV testing are separate from build verification.

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

## Physical-TV smoke check

Use a separate synthetic test playlist/provider where practical; do not print personal URLs or credentials in diagnostics.

Build and deploy with the verified VS Code flow in [`tizen/README.md`](../tizen/README.md): `prepare`, sign in VS Code, `collect`, then `launch` with the TV IP. For the QE65Q70AATXXH, test `tizen6.wgt`; it intentionally uses the legacy/SystemJS entry to avoid Tizen 6's modern-module splash-screen failure.

Browse-grid focus rules and the safe change checklist are documented in [navigation.md](navigation.md).

1. Install a freshly packaged build on the UE75MU8005 and confirm startup and the IndexedDB version-7 migration complete.
2. Navigate categories, sorting, Previous/Next, series episodes, and Back using only the TV remote.
3. Trigger Back while a category is loading; confirm delayed data does not reopen it.
4. Verify year sorting includes a title with no year and the last page has correct navigation controls.
5. Check a small legacy M3U import and an import refused by the fallback limit. The refusal should explain the limitation rather than freezing the app.
6. Play a synthetic/sample title, confirm loading/buffering/playing/paused/completed/error states are accurate, then change titles during subtitle activity and verify playback/subtitle state belongs to the current title.

Record the device/build and actual results when performing this checklist. Automated tests and successful builds alone do not establish target-TV compatibility.

## Catalogue startup recovery

A version upgrade can take time for a large saved M3U catalogue. The startup screen reports migrated row counts; allow it to finish. If another open connection blocks the upgrade, the app shows an actionable error with **Try again**, rather than leaving an indefinite loading screen. Existing adapter connections close on version change, and late connections from rejected opens are closed automatically. No catalogue reset is needed for this recovery.
