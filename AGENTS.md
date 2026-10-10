# Project

Samsung Tizen, LG webOS and browser IPTV live TV and VOD player. The shared core is platform-independent TypeScript; browser, Tizen and webOS integrations must sit behind adapters.

# Commands

- `npm run check`: typecheck and unit tests.
- `npm run package:webos`: build and audit a clean LG `.ipk`.
- `npm run package:webos:personal`: private LG package using `.env` defaults.
- `npm run deploy <registered-LG-device>`: build the personal LG package, install and launch; `npm run deploy` uses `LG_WEBOS_DEVICE` in `.env`. Tizen targets route through the existing signing workflow.
- `npm run inspect:m3u`: fetch the private playlist configured in `.env` and print a credential-safe summary.

# Safety

- Never print or commit `.env`, playlist URLs, OpenSubtitles credentials, tokens, or signed media URLs.
- Sanitize network errors before presenting them.
- Keep real deployment domains, IPs, SSH identities/destinations, production inventories and backup/migration records in Git-ignored `.local/deployment/`. Use synthetic example hostnames in committed templates, docs and tests. Do not copy private local deployment notes into source or release archives.
- Local LG device selection (`LG_WEBOS_DEVICE`) and companion host override (`LG_WEBOS_LOCAL_IP`, the Mac's LAN address) belong in ignored `.env` as requested by the user. CLI-managed SSH keys remain outside the repository. Do not embed LG deployment settings in application assets or expose `.env` to `ares-*` tools; those tools receive only the runtime environment allowlist.
- Tests must use synthetic fixtures, never the user's real playlist.

# Mandatory client credential boundary

- Follow `docs/client-credential-policy.md`. This is a hard product requirement, not an implementation preference. Do not remove, weaken or bypass it without the user's explicit authorization to change this specific policy; ordinary feature/fix/deployment requests do not authorize an exception.
- User-entered provider/playlist credentials, OpenSubtitles credentials and TMDb API keys/tokens must remain stored on the client device. Send them directly from that client only to their intended provider/API for authentication and use.
- Never upload, synchronize, proxy, log, include in telemetry/crash reports, or persist these credentials through Substream hosting/access services, the existing bot service, companion services, or subtitle relays. Do not add server-side credential settings, credential forwarding, or a CORS/mixed-content workaround that violates this boundary.
- Keep service-specific Google login, access grants and companion/relay authentication separate from provider/API credentials. Independently configured private relay credentials and isolated development tooling are not permission to collect client credentials in shipped apps.
- Review changes to settings, storage, transport, optional integrations, logging and deployment against this policy. Credential-routing changes require synthetic regression checks of destinations and payloads. Document HTTP integrity limits honestly; never describe local browser storage as a secret vault or promise an absolute security guarantee.

# Architecture

- Code in `src/core` must not depend on browser, React, Node, Tizen or webOS globals.
- Shared screens use runtime ports and interaction profiles; platform detection and concrete player selection belong in bootstrap/adapters. See `docs/cross-platform-architecture.md`.
- Preserve entries that cannot be confidently classified; label them `unknown` rather than discarding them.
- Classification decisions must include evidence so provider-specific rules can be debugged later.

# Tizen CSS compatibility

- The Tizen 3 browser is Chromium 47. Treat it as the CSS baseline for every UI change.
- Never use `gap` for layout spacing: Chromium 47 ignores flexbox `gap`. Use explicit margins on the relevant children instead, including the movie/series details poster, copy, and action buttons.
- Do not make a screen depend on unsupported modern CSS such as Grid, custom properties, `min()`, `max()`, `clamp()`, `inset`, logical flex alignment (`start`/`end`), or `:focus-visible`. A progressive enhancement may use them only when the preceding legacy flex-and-margin rules provide the complete same layout on Tizen.
- Use `top`/`right`/`bottom`/`left` for full-screen positioning and `flex-start`/`flex-end` for flex alignment. Keep ordinary `:focus` styling separate from optional `:focus-visible` styling, because old browsers can discard a selector list containing an unknown pseudo-class.
- Check the Tizen/Chromium-47 preview after CSS changes, especially for spacing and wrapping in focusable TV layouts.

# LG webOS compatibility

- The current LG target is webOS 25 / Chromium 120; this does not relax the Chromium 47 baseline for shared CSS.
- Keep `PalmSystem`, webOS detection, platform Back and playback lifecycle code in `src/platform/webos` and bootstrap. Screens use runtime ports.
- Companion pairing and receiver commands are supported in the LG runtime. LG still has no local-file picker and no Samsung subtitle relay; do not infer those capabilities from the TV interaction profile.
- Separate clean and private personal artifacts. Follow [LG setup](webos/README.md), [architecture](docs/cross-platform-architecture.md) and [device verification](docs/verification.md) when changing the port.
