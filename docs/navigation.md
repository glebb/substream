# Keyboard and remote navigation

The yellow focus highlight identifies the control Enter activates. Selection, DOM focus, and the rendered item must stay synchronized; movement must not infer layout from computed CSS.

## Home and Live TV

| View | Arrows | Enter | Back / Escape / Samsung Return |
| --- | --- | --- | --- |
| Home | Move between Live TV and Video-On-Demand | Open selected section | Stay home |
| Live categories/channels | Up/Down one row; Left/Right ten rows; Up from first row reaches header | Open category or tune channel | Channels → categories → home |
| Live player | Up/Down previous/next channel; windowed Left/Right moves between controls | Activate focused control | Stop playback and return to channels |

Live playback starts fullscreen with controls hidden. Channel changes stop at list boundaries. Windowed controls include fullscreen, previous/next, retry on error, and Back to channels. Browser live-buffer controls appear only when a buffer is available. Browser-native fullscreen exit also returns to channels unless the app requested that exit. Live playback does not use the VOD seek/pause key behavior.

## VOD browsing

- Category cards use four columns on wide screens, two on compact screens, and one below 520px. Web title lists use two columns on wide screens and one on compact screens.
- Tizen title lists use a bounded single-column viewport. Up/Down moves one title; held keys are throttled. A fresh Up at the first title reaches Sort; a fresh Down at the last reaches pagination. Repeated keys at the endpoints stay in the list.
- On Tizen, Left/Right changes page, focusing the last title when going left and the first when going right. Back restores the prior page, title focus, and list scroll.
- Left/Right on browse tabs changes collection while retaining tab focus. Down enters its first item, search field, or empty-state action.
- Continue Watching uses Resume/Remove pairs: Up/Down changes title while retaining the action; Left/Right changes action within that title. Up from the first pair reaches the selected tab.
- The Samsung red key toggles the focused group's favourite state. Browser/touch users have a favourite button.

Keep `browseGridColumnCount` and title-grid helpers in `src/app/remote-navigation.ts` aligned with `src/app/app.css`. Focus/scroll helpers must scroll only the bounded TV list rather than moving the header or page.

## VOD player and editing

| Fullscreen state | Arrows | Tizen Enter | Back |
| --- | --- | --- | --- |
| Controls hidden | Left/Right seek 60 seconds; Up/Down reveal controls | Toggle playback | Exit fullscreen |
| Controls visible | Navigate controls | Activate focused control | Hide controls |

The main row includes playback, restart, fullscreen, subtitles, and Subtitles & more. The advanced panel holds aspect, subtitle search, size, timing, and information. Back closes that panel first and restores its opener's focus. Dedicated media keys remain available; web Space toggles playback from the video area or fullscreen.

Settings and episode selection use explicit remote focus. TV editable controls require Enter to begin editing; Back and directional exit paths restore navigation. Browser controls retain native editing. Text editing handles its keys before player shortcuts. Settings confirmations keep focus within their current controls.

## When changing navigation

Use synthetic tests for row/page boundaries, incomplete grids, repeat throttling, paired actions, conditional Settings controls, editing, and focus restoration. Run `npm run check`, then follow the keyboard-only and physical-remote checks in [verification.md](verification.md).
