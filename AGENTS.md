# Project

Samsung Tizen IPTV live TV and VOD player. The shared core is platform-independent TypeScript; browser and Tizen integrations must sit behind adapters.

# Commands

- `npm run check`: typecheck and unit tests.
- `npm run inspect:m3u`: fetch the private playlist configured in `.env` and print a credential-safe summary.

# Safety

- Never print or commit `.env`, playlist URLs, OpenSubtitles credentials, tokens, or signed media URLs.
- Sanitize network errors before presenting them.
- Tests must use synthetic fixtures, never the user's real playlist.

# Architecture

- Code in `src/core` must not depend on browser, React, Node, or Tizen globals.
- Shared screens use runtime ports and interaction profiles; platform detection and concrete player selection belong in bootstrap/adapters. See `docs/cross-platform-architecture.md`.
- Preserve entries that cannot be confidently classified; label them `unknown` rather than discarding them.
- Classification decisions must include evidence so provider-specific rules can be debugged later.

# Tizen CSS compatibility

- The Tizen 3 browser is Chromium 47. Treat it as the CSS baseline for every UI change.
- Never use `gap` for layout spacing: Chromium 47 ignores flexbox `gap`. Use explicit margins on the relevant children instead, including the movie/series details poster, copy, and action buttons.
- Do not make a screen depend on unsupported modern CSS such as Grid, custom properties, `min()`, `max()`, `clamp()`, `inset`, logical flex alignment (`start`/`end`), or `:focus-visible`. A progressive enhancement may use them only when the preceding legacy flex-and-margin rules provide the complete same layout on Tizen.
- Use `top`/`right`/`bottom`/`left` for full-screen positioning and `flex-start`/`flex-end` for flex alignment. Keep ordinary `:focus` styling separate from optional `:focus-visible` styling, because old browsers can discard a selector list containing an unknown pseudo-class.
- Check the Tizen/Chromium-47 preview after CSS changes, especially for spacing and wrapping in focusable TV layouts.
