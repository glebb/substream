# Browse navigation

Browse focus has one invariant: the selected item index, the DOM-focused control, and the rendered collection must refer to the same item. Directional movement calculates a destination from the current index and item count; it then updates the index and focuses and scrolls that control in the same interaction. Navigation must not infer layout by parsing computed CSS values, which differ across browser engines.

Recent and category grids use four columns on wide screens, two on compact screens, and one below the narrow `520px` breakpoint. These values are paired with the breakpoints in `src/app/app.css` through `browseGridColumnCount` in `src/app/remote-navigation.ts`. The narrow mode applies to home/category cards only; title browsing remains a one-column list on compact web and Tizen.

## Continue Watching pairs

Continue Watching is a paired control list in the DOM: Resume, Remove, then the next title's Resume and Remove. It intentionally does not use generic grid movement. Up and Down move to the adjacent title while preserving Resume or Remove; Left and Right move only within that title's pair. Up from either control in the first pair returns to the selected browse tab. This behavior is shared by web arrow keys and the Tizen remote.

## TV compact title-list rules

On Tizen, title browsing is a single-column list inside a bounded scroll viewport. The catalogue header, sort and group controls, and pagination remain in place while the list scrolls; the viewport uses the available screen height up to 650px, which shows roughly 8–10 title rows on common TV resolutions. Up and Down move to the adjacent title. Held Up/Down follows the TV's native repeat events at a throttled rate; keyup stops movement immediately, and repeated presses at the top or bottom stay in the list. A fresh Up at the first title focuses Sort; a fresh Down at the final title focuses pagination.

Left and Right jump to the previous or next page from any title. The new page focuses its last title when moving left and its first title when moving right. The on-screen hint and page buttons label these directions. Page loads and Back restore the selected index, DOM focus, and list scroll together. The focus helper preserves page and ancestor scroll positions around `.focus()` and then scrolls only the list viewport, leaving room for the yellow focus ring on Chromium 47.

Web retains its responsive two-column title grid on wide screens and one-column list on compact screens, with matching grid navigation. Recent and Movies/Series category cards remain responsive grids.

At the top edge, Up returns from a home grid to the selected Recent / Movies / Series tab. In the narrow one-column home grid, Down advances exactly one item and Left/Right stop at each row edge; the final item remains vertically reachable and is scrolled into view. Settings remains above the tab row; Back continues to follow the active screen hierarchy.

## Settings and player controls

Settings uses the same persistent yellow remote-focus treatment as browse tiles and player controls. Focus follows the current control through conditional API-key setup and confirmation dialogs; do not rely on the older Tizen browser's native `:focus` rendering. Settings keeps Back to library first in focus order.

On web, Space toggles playback when the video area is active or while fullscreen. On Tizen, Enter toggles playback in fullscreen only while controls are hidden; when controls are visible, Enter activates the highlighted control. Hidden controls use Left/Right to seek and Up/Down to show the controls with Play/Pause highlighted. Visible controls use arrows to move through the controls shown in the bar, including subtitle size and toggle buttons, while skipping the video surface. Back hides visible controls and restores video-area focus; Back with controls hidden follows the app's fullscreen exit hierarchy. Dedicated media keys remain available in both states. Text-entry controls retain their editing keys and handle Back before fullscreen navigation.

## Safe navigation change checklist

- Add synthetic cases for movement from index zero in each direction, row edges, and incomplete final rows in home grids; test adjacent title movement, held-key throttling and release, endpoint behavior, page jumps, and focus restoration separately.
- Keep explicit home-grid and web title-grid column helpers aligned with CSS breakpoints and test compact and wide values.
- Keep Tizen title-list CSS single-column with a bounded viewport; preserve web's responsive title grid.
- Update React selection and DOM focus together; scroll the newly focused tile into view.
- Check paired Continue Watching movement, top-edge tab/sort transitions, bottom-edge pagination, TV Left/Right page transitions and focus restoration, Settings focus visibility, and Back after changing browse movement.
- Run `npm run check` and smoke-test web keyboard and TV remote navigation with a synthetic catalogue.
