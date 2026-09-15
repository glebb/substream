# Browse navigation

Browse focus has one invariant: the selected item index, the DOM-focused control, and the rendered collection must refer to the same item. Directional movement calculates a destination from the current index and item count; it then updates the index and focuses and scrolls that control in the same interaction. Navigation must not infer layout by parsing computed CSS values, which differ across browser engines.

Recent and category grids use four columns on wide screens, two on compact screens, and one below the narrow `520px` breakpoint. These values are paired with the breakpoints in `src/app/app.css` through `browseGridColumnCount` in `src/app/remote-navigation.ts`. The narrow mode applies to home/category cards only; title browsing remains a one-column list on compact web and Tizen.

## Continue Watching pairs

Continue Watching is a paired control list in the DOM: Resume, Remove, then the next title's Resume and Remove. It intentionally does not use generic grid movement. Up and Down move to the adjacent title while preserving Resume or Remove; Left and Right move only within that title's pair. Up from either control in the first pair returns to the selected browse tab. This behavior is shared by web arrow keys and the Tizen remote.

## TV compact title-list rules

On Tizen, title browsing is a single-column compact list. Left and Right move exactly one title backward or forward. At the first title, Left opens the previous page and restores focus to its last title; at the last title, Right opens the next page and restores focus to its first title. Up and Down move by a fixed view stride of eight titles, clamped to the first or last title when fewer than eight remain. The next focused title scrolls into view naturally. Only Up at the first title returns to Sort; only Down at the last title moves to pagination. Previous/Next buttons keep their existing behavior.

The eight-title stride is centralized as `TITLE_LIST_PAGE_STRIDE` and used by the pure `titleListNavigationTarget` helper. Horizontal page transitions use `titleListPageBoundaryTarget`; async page loads restore focus at the appropriate end. Keep Tizen title layout single-column; do not derive this stride from grid columns. Web retains its responsive two-column title grid on wide screens and one-column list on compact screens, with matching grid navigation. Recent and Movies/Series category cards remain responsive grids.

At the top edge, Up returns from a home grid to the selected Recent / Movies / Series tab. In the narrow one-column home grid, Down advances exactly one item and Left/Right stop at each row edge; the final item remains vertically reachable and is scrolled into view. Settings remains above the tab row; Back continues to follow the active screen hierarchy.

## Settings and player controls

Settings uses the same persistent yellow remote-focus treatment as browse tiles and player controls. Focus follows the current control through conditional API-key setup and confirmation dialogs; do not rely on the older Tizen browser's native `:focus` rendering. Settings keeps Back to library first in focus order.

On web, Space toggles playback when the video area is active or while fullscreen. On Tizen, the Action/Enter key does the same. Text-entry controls keep their normal editing behavior outside fullscreen.

## Safe navigation change checklist

- Add synthetic cases for movement from index zero in each direction, row edges, and incomplete final rows in home grids; test title-list single-step movement, stride clamping, true endpoints, and adjacent-page transitions separately.
- Keep explicit home-grid and web title-grid column helpers aligned with CSS breakpoints and test compact and wide values.
- Keep Tizen title-list CSS single-column and the page stride fixed in the named helper; preserve web's responsive title grid.
- Update React selection and DOM focus together; scroll the newly focused tile into view.
- Check paired Continue Watching movement, top-edge tab/sort transitions, bottom-edge pagination, TV Left/Right page transitions and focus restoration, Settings focus visibility, and Back after changing browse movement.
- Run `npm run check` and smoke-test web keyboard and TV remote navigation with a synthetic catalogue.
