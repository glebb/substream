# Product roadmap: TV UX refinement — completed

The TV UX refinement delivery is complete in code and automated verification. This record replaces the active roadmap so completed work is not mistaken for remaining scope.

## Delivered

- [x] Added shared, Tizen-safe layout rules for page spacing, cards, action rows, forms, and focus-ring clearance. Settings credential rows now wrap safely instead of overlapping or clipping.
- [x] Simplified group cards: provider guidance appears once at the collection level and the repeated **Open on demand** tile text is removed.
- [x] Implemented red-key favourites. The registered Samsung red key toggles the focused group without moving focus; browser/touch users retain an accessible favourite button.
- [x] Unified browse focus behavior. Initial and tab-transition focus now lands on the first actual content control, including Recent; empty views use their recovery action, and returning from a group restores its invoking tile.
- [x] Added a shared `RemoteEditable` pattern. On TV, directional navigation passes through text, numeric, and select-like controls without opening the on-screen keyboard; **OK/Enter** deliberately enters editing, while Back and directional exit paths restore navigation.
- [x] Applied remote editing to playlist setup, Settings credentials and subtitle preference, player subtitle search, player API-key setup, and title episode selection. Browser users retain native direct editing.
- [x] Replaced fragile positional Settings refs with a keyed visible-control order. The TV remote can traverse Back, playlist, subtitle preference, OpenSubtitles actions, all TMDb controls, local catalogue actions, reset, and confirmations in a predictable sequence.
- [x] Kept Tizen key registration/normalization in `src/platform/tizen`; shared focus decisions stay outside `src/core`.
- [x] Added synthetic tests for focus targets, Settings control order, red-key normalization, and remote editing behavior.

## Verification

- [x] `npm run check` passes with 147 tests.
- [x] `npm run build:tizen` succeeds.
- [ ] Validate the release build on the UE75MU8005 with the physical remote. Check red-key support, Settings traversal, initial focus in Recent/Movies/Series, edit activation, and 1280×720 plus native-TV layouts.

## Release safeguards

- Do not log or display playlist URLs, API keys, tokens, signed media URLs, or typed credential values.
- Keep tests synthetic; never use the private playlist or credentials.
- Keep platform-specific integration behind adapters and preserve the Tizen 3-compatible CSS fallback.
