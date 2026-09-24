# Tizen 3 navigation and UX improvement plan

Status: items 1–4 implemented. The Tizen presentation and Chromium 47 preview in item 5 are implemented; physical Tizen 3 validation and response measurements remain pending.

This plan is based on a review of the navigation implementation, not responsiveness measurements on a physical TV. Prioritise predictable remote interactions before a larger visual redesign.

## 1. Match list navigation to the layout

Before this update, the TV displayed a vertical title list, but Left/Right moved one title and Up/Down jumped eight titles.

- Make Up/Down move to the adjacent title.
- Use Left/Right for clearly labelled page jumps.
- Support holding Up/Down for faster browsing, with controlled repetition and no queued movement after release.
- Preserve focus at page transitions and keep top/bottom navigation predictable.

Primary implementation: `src/app/remote-navigation.ts` and browse key handling in `src/app/App.tsx`.

This deliberately replaces the current TV movement contract documented in `docs/navigation.md`; update that document and its synthetic tests together with implementation.

## 2. Keep the screen steady while browsing

- Keep the header fixed and show roughly 8–10 readable title rows, adjusted for the available screen area.
- Scroll the list only when focus approaches the visible edge.
- Consolidate focus and scrolling into one operation. Before this update, both the key handler and a subsequent React effect called focus and `scrollIntoView()`.
- Keep the selected item, DOM focus and rendered collection synchronized, including after loading and Back navigation.

Primary implementation: `src/app/App.tsx` and `src/app/app.css`.

## 3. Make fullscreen controls predictable

Before this update, Enter toggled playback even when a fullscreen button was focused, and Left/Right sought instead of navigating visible controls.

Use two explicit interaction states:

| State | Arrows | Enter | Back |
| --- | --- | --- | --- |
| Controls hidden | Left/Right seek; Up/Down reveal controls | Toggle playback | Follow the existing fullscreen exit hierarchy |
| Controls visible | Navigate the visible controls | Activate the highlighted control | Hide controls |

Keep dedicated media keys available in both states. Ensure text-entry controls retain their editing behaviour.

Primary implementation: player key handling in `src/app/App.tsx` and shortcut helpers in `src/app/remote-navigation.ts`.

## 4. Simplify the main player controls

- Keep Play/Pause, Seek, Subtitles and More immediately accessible.
- Move subtitle size, subtitle timing, aspect ratio and technical information into focused panels.
- Restore focus to the panel's opening control when closing it.
- Avoid making users traverse a long linear sequence of advanced controls for common actions.

## 5. Add a lightweight Tizen 3 presentation

- Prefer an immediate solid focus highlight and minimal animation.
- Keep the number of rendered rows bounded.
- Verify scrolling and focus behaviour on a physical Tizen 3 TV; do not assume modern browser behaviour.
- Measure remote responsiveness before and after changes to distinguish interaction improvements from rendering improvements.

Tizen 3 uses Chromium M47, according to Samsung's web engine specifications.

## Delivery order

Implement items 1–3 first: natural list movement, one reliable focus/scroll path, and consistent fullscreen controls. Follow with the player control simplification and lightweight presentation.

Keep platform-independent navigation decisions separate from browser and Tizen adapters. Code in `src/core` must remain independent of browser, React, Node and Tizen globals.

## Validation

- Add synthetic navigation cases for adjacent movement, page boundaries, incomplete pages, held-key behaviour and focus restoration.
- Cover fullscreen hidden/visible controls, activation, Back, dedicated media keys and text entry.
- Run `npm run check`.
- Smoke-test browser keyboard navigation and a physical Tizen 3 remote with a synthetic catalogue.
- Check that focus stays visible, list scrolling is stable, Back restores the expected context, and releasing a held key stops movement promptly.
- Keep credentials, private playlist URLs and signed media URLs out of fixtures, logs and documentation.

## References

- [Samsung design principles](https://developer.samsung.com/smarttv/design/design-principles.html): predictable four-direction navigation and distinguishable focus and selection states.
- [Samsung web engine specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html): Tizen 3 engine version.
- Existing project navigation contract: `docs/navigation.md`.

## Running-app review — 2026-09-24

I reviewed Favourites, Recent, Movies, Series, search, title details, episode selection, player/subtitles, and Settings in the running web app. Arrows and Enter reached titles and search results; Escape returned from player and details to the prior list. I also reviewed group, list, details, and Settings rendering in the Chromium 47/noVNC preview. That preview lacks `window.tizen`, so `isTizenRuntime()` takes the web branch: its two-column, long-page title list is **not** a test of the Tizen-only one-column bounded list. Physical TV verification remains required.

| View | Observed issue | Proposed change |
| --- | --- | --- |
| Favourites, Movies, Series | Unloaded groups claim `0 titles`; status labels repeat prefixes such as `Movies: Movies: Action`; each favourite has a separate small control below the card. | Show an unknown count until loaded, normalize display names, and use one focusable card with favourite state and red-key action. |
| Recent | Resume and Remove occupy two large cards for each title, repeating its name and using much of the screen. | Use one compact title row with progress and Resume; put Remove in a contextual action with confirmation or undo. |
| Title lists | The web/Chromium 47 branch shows 100 titles per page across a long two-column page. The heading, sort, and page context scroll away. | Validate the existing bounded Tizen list in a representative preview; keep section and page controls visible and preserve focus and scroll on return. |
| Details | Back, Play/Choose episode, and Play on TV are spread across the width. An empty poster and fallback text appear before metadata loads. The Chromium 47 layout leaves much of the screen unused. | Group the actions, show a stable loading state, enlarge readable content, and make the primary action obvious. |
| Episode picker | On the sampled series, episode options appeared while `Play selected episode` stayed disabled. | Diagnose readiness and show loading, playable, or a specific unavailable reason. |
| Player | The video area is small relative to the control row and long subtitle form/results below it. One sampled browser stream reported `Unable to play media`; this alone is not evidence of a UI bug. | Keep Play/Pause, Seek, Subtitles, and More at the top level; move size, timing, aspect, information, and subtitle search into focused panels. |
| Search | Results contain repeated category prefixes and provider codes. They are keyboard reachable, but represented as generic containers in the accessibility tree. | Use button semantics and concise title, year, language, and source; combine editions only when identity is confident. |
| Settings | A long narrow form holds routine connection choices, credentials, cache clearing, and reset. | Use TV-sized sections with routine choices first and destructive actions behind an explicit confirmation view. |

### Updated priority and acceptance

1. **P0 — Representative TV preview and misleading states.** Add a development-only switch for Tizen layout/navigation in Chromium 47 without simulating unavailable media APIs. Fix unknown group counts and duplicated labels. Diagnose the disabled episode action. Pass when the preview visibly uses the one-column TV list, unloaded groups do not claim zero titles, and episode readiness is explained.
2. **P1 — Daily remote browsing.** Compact Favourites and Recent; keep list context visible and scroll only the bounded title list; distinguish selected tab from focused control. Pass when a remote-only user can browse, resume, and return to the same position without losing the focus highlight or page context.
3. **P2 — Details, playback, search, Settings.** Apply the view changes above, completing player-control simplification from item 4. Pass when common player actions take only a few presses, advanced panels return focus to their opener, and search/settings have clear remote focus order.
4. **P3 — Legacy rendering and physical device.** Use flex and static-color fallbacks for Chromium 47. Verify at 1280×720 and 1920×1080, then on the physical TV. Measure key response and check focus, Back, page edges, loading, and test-media playback. This completes the presentation and validation work from item 5.

Keep navigation decisions in `src/app/remote-navigation.ts` and integrations in browser/Tizen adapters; keep `src/core` platform independent. Update `docs/navigation.md` and synthetic tests with behavioral changes, run `npm run check`, and keep private URLs, credentials, and signed media URLs out of fixtures, logs, and documentation.

### Implementation and validation — 2026-09-24

- The Chromium 47 preview now enables TV layout and remote navigation through a build-time flag while retaining browser video playback. Its loaded TV view uses a bounded one-column list with the header and page controls visible.
- Unloaded provider groups say “Select to load titles,” and repeated group prefixes are removed. TV favourites use one focusable card and the red key. Recent uses a compact Resume row, a small Remove action, and a confirmation dialog.
- Series episode selection shows a loading, ready, empty, or error state and preselects an available episode. Details show artwork and metadata loading states.
- The player puts advanced subtitles and information behind “Subtitles & more,” with Back returning focus to the opener. Search results retain button semantics and use shorter category labels. TV Settings uses wider sections.
- In the Chromium 47 preview, tab changes retained the header, Up/Down moved between adjacent list titles, Right changed pages, and returning from details restored the page and title focus. Physical TV remote timing, AVPlay, and playback remain to be validated on device.
- Subtitle access is now in the main player row, while Aspect sits in the advanced panel. Restart and fullscreen remain direct controls for remote use; seeking is available through Left/Right when fullscreen controls are hidden.
