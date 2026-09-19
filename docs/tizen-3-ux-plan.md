# Tizen 3 navigation and UX improvement plan

Status: items 1–3 implemented; automated checks and synthetic browser smoke passed. Physical Tizen 3 validation remains pending. Items 4–5 remain proposed.

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
