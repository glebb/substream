# UI refresh implementation plan

## Goal

Make Substream feel like a cohesive streaming application across desktop web, compact web, and Samsung Tizen while preserving the existing keyboard and TV-remote navigation model.

The refresh should improve visual hierarchy, spacing, card identity, dialogs, settings, and player controls. It must not change catalogue behavior, playback behavior, focus order, Back behavior, or the meaning of stored provider data.

## Current-state findings

- The dark, high-contrast foundation is appropriate for both browser and TV viewing.
- The yellow focus treatment is clearly visible from TV distance, but selected and focused states can look too similar.
- The library heading consumes too much vertical space, particularly on compact screens and inside the player flow.
- Category and title cards are functional but visually flat. Provider prefixes can also make category names repetitive and difficult to scan.
- The two-column compact category grid is too narrow for realistic provider names.
- Continue Watching renders the resume and remove actions as equally prominent tiles rather than as one related item.
- Settings actions lack grouping, and destructive actions need clearer separation.
- Resume and confirmation dialogs are semantically modal but do not look visually modal.
- Playback is appropriately restrained, but the surrounding header and undifferentiated control buttons compete with the video.
- The catalogue currently has no poster or cover-image field, so the first iteration should not depend on external artwork.

## Design principles

1. Preserve strong focus visibility at TV distance.
2. Use yellow only for active keyboard or remote focus; use blue for selection and primary actions.
3. Keep content readable without artwork by using typography, spacing, borders, metadata chips, and restrained gradients.
4. Keep all focusable controls in their current logical order unless the navigation helpers and tests are intentionally updated in the same change.
5. Avoid effects that are unreliable on older Tizen browser engines, including `backdrop-filter`. Do not introduce a dependency on CSS `aspect-ratio` for AVPlay.
6. Respect `prefers-reduced-motion` and keep focus movement immediate.

## Navigation invariants

These constraints apply to every implementation phase:

- Do not reorder focusable elements or their React refs merely for visual layout.
- Do not hide a focusable control with CSS while it remains in a remote-navigation control list.
- Keep the wide home grid at four logical columns unless `browseGridColumnCount` and its tests are changed at the same time.
- Keep the compact home grid column count synchronized between `app.css` and `browseGridColumnCount`.
- Keep the Tizen title list single-column.
- Preserve `TITLE_LIST_PAGE_STRIDE` and the existing Tizen Left/Right page-boundary behavior.
- Preserve Settings-to-tabs, tabs-to-grid, grid-to-tabs, Sort-to-title, title-to-pagination, and player control transitions.
- Preserve the existing Back hierarchy for confirmations, resume choice, settings, player fullscreen, player, groups, and loading states.
- Keep selected item state, DOM focus, and the item scrolled into view synchronized.

## Phase 1: visual foundation

This phase should be presentation-only and should not alter grid geometry, DOM order, refs, or event handlers.

### 1.1 Page and typography hierarchy

- Reduce the maximum library heading size and tighten its bottom margin.
- Use a consistent content width and safe-area padding for desktop and 1080p TV.
- Reduce vertical padding on compact web so the first useful content appears sooner.
- Establish consistent heading, supporting-text, and metadata sizes.
- Keep the Substream eyebrow, but reduce its visual distance from the page title.

### 1.2 Color and surface system

- Retain the near-black/navy background.
- Introduce a small set of explicit surface levels for page, panel, card, hover/selected, and focused states.
- Add subtle one-pixel borders to cards and panels so adjacent dark surfaces remain distinguishable.
- Reserve blue for primary actions and selected tabs.
- Reserve yellow for active focus and use red/pink only for destructive actions.
- Improve muted-text contrast without making secondary text compete with titles.

### 1.3 Buttons and tabs

- Add primary, secondary, quiet, and danger button treatments.
- Make Settings and Back actions visually secondary.
- Render the selected browse tab as a blue pill or blue-underlined state.
- Layer the yellow focus ring on top of the selected state rather than replacing its meaning.
- Keep focus outlines thick enough for TV viewing and outside the control bounds so text does not shift.

### 1.4 Cards

- Add subtle tonal gradients or accent strips to category cards.
- Improve title/metadata spacing and clamp exceptionally long labels without changing accessible names.
- Render years, content type, and episode identifiers as quiet metadata chips where space permits.
- Keep card dimensions and logical column counts unchanged in this phase.
- Preserve the current strong yellow focused-card treatment for Tizen, with only small adjustments to scale and shadow to prevent overlap.

### 1.5 Loading and empty states

- Align skeleton colors and radii with the refreshed cards.
- Present empty states as deliberate panels with a concise heading and supporting copy.
- Avoid motion beyond the existing reduced-motion-safe skeleton treatment.

### Phase 1 acceptance criteria

- No changes to `remote-navigation.ts` are required.
- All focusable controls remain in the same DOM order.
- The active tab and active focus are visually distinguishable.
- The first focused tile is unmistakable at 1920x1080 from TV distance.
- Desktop and compact layouts have no horizontal overflow.
- `npm run check` passes.

## Phase 2: screen-specific refinement

### 2.1 Library header

- Keep the brand and library title in a compact left-aligned block.
- Keep Settings on the right for desktop and TV.
- On compact web, place Settings in a stable compact header position instead of allowing it to form a large standalone row.
- Do not change the Settings button ref or its directional transition to the selected tab.

### 2.2 Provider category names

- Add a view-only formatter that removes repeated collection prefixes such as `Movies: Movies:` when they add no useful information.
- Do not mutate group names, IDs, evidence, or stored catalogue records.
- Preserve the original full group name in the accessible label or supplementary text where useful for debugging.
- Add unit tests for repeated prefixes, legitimate single prefixes, punctuation, and unknown group formats.

### 2.3 Continue Watching

- Make each title and its remove action read visually as one pair.
- Give the resume tile the dominant width and make Remove a smaller quiet-danger action.
- Add a progress indicator based on saved current time and duration.
- Preserve the existing interleaved focus order: Resume, Remove, Resume, Remove.
- Keep the grid's logical column count consistent with the remote-navigation helper.
- Ensure long episode titles do not push the remove control out of alignment.

### 2.4 Settings

- Place settings content inside a panel with clear sections:
  - Navigation and playlist
  - OpenSubtitles
  - Local catalogue data
  - Danger zone
- Keep Back to library first in focus order.
- Show whether an OpenSubtitles API key is configured without displaying the key.
- Provide `Add OpenSubtitles API key` or `Change OpenSubtitles API key` in this section.
- Keep key removal available as a distinct `Remove saved API key` action with confirmation; do not describe it broadly as clearing all subtitle settings.
- Keep per-title subtitle timing separate from API-key management. If a global timing-reset action is added later, label and confirm it separately.
- Style clear/reset actions according to severity without changing their handlers.
- Keep status messages adjacent to the action group that produced them.

### 2.5 Resume and confirmation dialogs

- Render both as centered modal panels over a fixed dimmed backdrop.
- Do not rely on `backdrop-filter`.
- Keep the current dialog control order and refs.
- Keep focus trapped by the existing action-row navigation logic.
- Ensure the panel fits inside a 390px viewport and remains readable at 1920x1080.
- Preserve Back-to-cancel behavior.

### 2.6 Player and subtitles

- Reduce the library header's prominence while a title is open.
- Keep the video surface dominant and retain the clear focus outline around the video area.
- Style playback controls as a coherent toolbar while preserving their current order.
- Keep playback status visually separate from actionable buttons.
- Place subtitle timing, search, credentials, and results in a lower-contrast panel below playback.
- When no OpenSubtitles API key exists, show a compact `Set up OpenSubtitles API key` action in the player and reveal the masked key input and Save action from there.
- When an OpenSubtitles API key already exists, show no API-key setup, change, or removal control in the player. Existing keys are managed only from main Settings.
- Do not offer key removal from the player.
- Update the player control list and subtitle-result focus-index calculation to account for the setup control being absent when a key exists. Add coverage ensuring focus moves directly from subtitle search controls to the first result in that state.
- Keep fullscreen overlays minimal, readable, and compatible with Tizen AVPlay.
- Preserve the relative order of the remaining player controls and keep `playerControls()` synchronized with every conditionally rendered control.

### Phase 2 acceptance criteria

- Settings, resume choice, and confirmation screens retain their current focus behavior and Back behavior.
- Continue Watching retains the existing remote order while reading visually as paired items.
- Provider name formatting is view-only and covered by synthetic tests.
- The player shows API-key setup only when no key exists; configured-key management is available from main Settings.
- Player focus skips the absent API-key control safely when a key exists, and fullscreen behavior remains unchanged.
- No playlist URL, subtitle credential, signed media URL, or private provider data appears in tests or screenshots.
- `npm run check` passes.

## Phase 3: compact-web breakpoint

The compact layout needs a deliberate one-column category mode below approximately 520px. This is the one visual change that directly affects navigation geometry.

### Implementation

- Add a narrow breakpoint below the existing 800px compact breakpoint.
- Use one category column below the narrow breakpoint.
- Replace the current binary compact-grid calculation with an explicit layout mode or column-count input.
- Keep title browsing at one column for compact web.
- Do not change the wide four-column home grid, the existing two-column intermediate layout, or the Tizen title list.

### Required navigation tests

- Narrow one-column movement from the first, middle, and last item.
- Up at the first category returns to the selected tab.
- Down advances exactly one item in the one-column grid.
- Left and Right stop at one-column row edges.
- The last item scrolls into view without horizontal movement.
- Resizing across narrow, compact, and wide breakpoints does not leave focus on the wrong item.

### Phase 3 acceptance criteria

- Category names no longer wrap into cramped two-word columns at 390px.
- CSS columns and navigation columns match at every breakpoint.
- No horizontal overflow occurs at 320px, 390px, 800px, or 1920px.
- `npm run check` passes.

## Optional later work: artwork

Poster artwork should be a separate data and caching project rather than part of the initial refresh.

Before adding it:

- Extend the platform/provider adapter rather than placing provider logic in `src/core`.
- Define placeholder, loading, failure, and offline behavior.
- Confirm memory and storage limits on target Tizen models.
- Avoid exposing signed or credential-bearing artwork URLs.
- Keep every title usable when artwork is missing.

## Files expected to change

- `src/app/app.css`
  - Visual tokens, spacing, typography, cards, buttons, dialogs, settings, player panels, and responsive styles.
- `src/app/App.tsx`
  - Small presentation wrappers/classes, view-only formatted labels, progress styling inputs, and modal backdrops.
- `src/app/remote-navigation.ts`
  - Only when introducing the narrow one-column home-grid breakpoint.
- `src/app/remote-navigation.test.ts`
  - Breakpoint and movement coverage for any navigation geometry change.
- `src/app/browse.ts` or a new view-formatting module under `src/app`
  - Provider group display-name formatting if it does not belong in the component.
- Corresponding synthetic unit tests under `src/app`.
- `docs/navigation.md`
  - Document the narrow layout if Phase 3 changes the grid contract.
- `docs/verification.md`
  - Add the visual and focus smoke-test matrix.

No code in `src/core` should gain browser, React, Node, or Tizen dependencies.

## Verification matrix

### Automated

- Run `npm run check` after each phase.
- Add synthetic unit tests for display-name formatting.
- Add navigation cases for every new grid geometry.
- Keep existing Back, action-row, title-list stride, page-boundary, and legacy Tizen key tests passing.

### Desktop web

Test at 1440x900 and 1920x1080:

- Settings to selected tab and back.
- Recent, Movies, and Series tab switching.
- Four-column category navigation, including incomplete final rows.
- Two-column title navigation, Sort, Back to groups, and pagination.
- Continue Watching resume/remove pairs.
- Resume and confirmation dialogs.
- Player, fullscreen, aspect mode, info, subtitle timing, subtitle search, and Back.

### Compact web

Test at 390x844 and 320x568:

- Header and tabs fit without horizontal overflow.
- Category names remain readable.
- Grid navigation matches the rendered column count.
- Dialog actions wrap without changing logical focus order.
- Player controls and subtitle forms remain reachable.

### Samsung Tizen

Test at 1920x1080 with the remote:

- Focus remains visible from Settings through tabs and category cards.
- Four-column category movement matches the rendered grid.
- Title browsing remains a single-column list with the fixed eight-title vertical stride.
- Left/Right page transitions restore focus at the correct end.
- Sort and pagination boundaries behave as documented.
- Back exits confirmations, settings, fullscreen, player, and group screens in order.
- AVPlay maintains its display rectangle in normal and fullscreen modes.
- No focused control is clipped after `scrollIntoView`.

## Delivery sequence

1. Capture baseline screenshots for desktop, compact web, and 1080p TV-sized browser views using synthetic or credential-safe content.
2. Implement Phase 1 as a CSS-focused change and run the full automated suite.
3. Manually smoke-test keyboard and remote focus before proceeding.
4. Implement Phase 2 one screen at a time, verifying navigation after each screen.
5. Implement the Phase 3 breakpoint together with its navigation helper and tests.
6. Repeat the full verification matrix and compare final screenshots with the baseline.
7. Record any intentional visual or navigation-contract changes in `docs/navigation.md` and `docs/verification.md`.

## Definition of done

- The library, settings, dialogs, title list, player, and subtitle tools share one consistent visual system.
- Desktop, compact web, and Tizen layouts are legible and balanced.
- Focus, selection, and danger states are visually distinct.
- Keyboard and remote navigation match the rendered layout at every breakpoint.
- No private credentials or signed URLs are exposed.
- All automated checks pass and the manual verification matrix is complete.
