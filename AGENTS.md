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
- Preserve entries that cannot be confidently classified; label them `unknown` rather than discarding them.
- Classification decisions must include evidence so provider-specific rules can be debugged later.
