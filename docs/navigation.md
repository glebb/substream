# Keyboard and remote navigation

The yellow focus highlight identifies the control Enter activates. Selection, DOM focus, and the rendered item must stay synchronized; movement must not infer layout from computed CSS.

## Home and Live TV

| View | Arrows | Enter | Back / Escape / Samsung Return |
| --- | --- | --- | --- |
| Home | Move between Live TV, Video-On-Demand, the local-file action when supported, and Settings | Open selected action | Stay home |
| Live categories/channels | Up/Down one row; Up from first row reaches header; in channels, Left reaches Categories and Right reaches Main menu; in categories, either reaches Main menu | Open category or tune channel | Channels → categories → home |
| Live player | Up/Down previous/next channel; windowed Left/Right moves between controls | Activate focused control | Stop playback and return to channels |

Live playback starts fullscreen with controls hidden. Channel changes stop at list boundaries. Windowed controls include fullscreen, previous/next, retry on error, and Back to channels. Browser live-buffer controls appear only when a buffer is available. Browser-native fullscreen exit also returns to channels unless the app requested that exit. Live playback does not use the VOD seek/pause key behavior.

## VOD browsing

- Category cards use four columns on wide screens, three on TVs at 1400px or below, two on compact screens, and one below 520px. Web title lists use two columns on wide screens and one on compact screens.
- TV category and title lists share a bounded viewport that fills the space below the header and above pagination. Short category lists use larger rows. Title cards retain four columns and their poster size. Up/Down moves one row; held keys are throttled. A fresh Up in the first row reaches Sort; a fresh Down in the last row reaches pagination. Repeated keys at the endpoints stay in the list.
- In desktop and TV profiles, Up from the first title row reaches Sort or Refresh; another Up reaches the previous action, and Right reaches Main menu. Down reverses that path and restores the selected title. Sort stays a navigation control until OK/Enter opens its selector; arrows change the draft option, OK applies it, and Back cancels it. Async list refreshes preserve focus on these controls. A fresh key press works even if the preceding key release was lost.
- In the TV profile, Left/Right moves within the title grid; pagination controls change page. Back restores the prior page, title focus, and list scroll.
- Both desktop and TV expose Favourites, Recent (Continue Watching), Movies, Series and Search. Left/Right on browse tabs changes collection while retaining tab focus. Down enters its first item, search field, or empty-state action.
- Search uses Enter/OK to begin text editing in both desktop and TV profiles. Enter/OK or Back restores the search control; Up/Down leaves editing for the Search tab or Refresh, while Left/Right edits text. Down from the search control reaches Refresh and then the selected result. Up from the first result row reverses that path through Refresh, the search control, the Search tab and the header. Left/Right moves across the search controls; Right from Refresh reaches Main menu. Results use four columns on wide and medium TV screens, two on compact screens and one below 520px. Search runs against the device catalogue or provider cache without companion pairing.
- Continue Watching uses Resume/Remove pairs: Up/Down changes title while retaining the action; Left/Right changes action within that title. Up from the first pair reaches the selected tab.
- The Samsung red key toggles the focused group's favourite state. Browser/touch users have a favourite button.

Keep `browseGridColumnCount` and title-grid helpers in `src/app/remote-navigation.ts` aligned with `src/app/app.css`. Focus/scroll helpers must scroll only the bounded TV list rather than moving the header or page.

## VOD player and editing

| Fullscreen state | Arrows | TV OK / Enter | Back |
| --- | --- | --- | --- |
| Controls hidden | Left/Right seek 60 seconds; Up/Down reveal controls | Toggle playback | Exit fullscreen |
| Controls visible | Navigate controls | Activate focused control | Hide controls |

The main row includes playback, restart, fullscreen, subtitles, and Subtitles & more. If previous-session cleanup is blocked, Restart becomes Retry; a new player waits for successful cleanup. The advanced panel holds aspect, subtitle search, size, timing, and information. Back closes that panel first and restores its opener's focus. Dedicated media keys remain available; web Space toggles playback from the video area or fullscreen.

Details and windowed VOD playback use only the header’s previous-view control; action rows do not duplicate it. Down from the header enters the episode selector or playback action on details, and the video area in windowed playback.

Every screen places Main menu at the right of its header, with the previous view immediately to its left when applicable. Up from any browse tab or the first content control reaches that header; Left/Right moves between its actions and Down returns to content. Episode selection uses the same actions inside its dialog. Settings opens on TV connection. In a supported TV profile its enable checkbox controls the optional app-level companion listener. Settings and episode selection use explicit remote focus. TV editable controls require Enter to begin editing; Back and directional exit paths restore navigation. Browser controls retain native editing. Text editing handles its keys before player shortcuts. Settings confirmations keep focus within their current controls.

## When changing navigation

Use synthetic tests for row/page boundaries, incomplete grids, repeat throttling, paired actions, conditional Settings controls, editing, and focus restoration. Run `npm run check`, then follow the keyboard-only and physical-remote checks in [verification.md](verification.md).
